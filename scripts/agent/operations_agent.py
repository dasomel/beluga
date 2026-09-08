#!/usr/bin/env python3
"""Beluga Operations Agent read-only execution boundary.

The PoC deliberately exposes only fixed read-only Kubernetes inspections. Mutating,
external-egress, and privileged tool classes are represented in policy so they can be
classified and evidenced, but they fail closed before subprocess execution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

SCHEMA_VERSION = "beluga-agent-evidence/v1"
CANONICALIZATION_VERSION = "beluga-json-c14n/v1"
TOOL_CONTRACT_VERSION = "beluga-operations-tools/v1"
DEFAULT_POLICY = Path(__file__).resolve().parents[2] / "configs" / "operations-agent-policy.json"

# Commands are code-owned and argument arrays are fixed. Policy can enable/disable a known tool,
# but it cannot inject shell fragments or arbitrary kubectl arguments.
TOOL_COMMANDS: dict[str, tuple[str, ...]] = {
    "cluster.nodes": ("kubectl", "get", "nodes", "-o", "json"),
    "cluster.pods": ("kubectl", "get", "pods", "-A", "-o", "json"),
    "cluster.events": ("kubectl", "get", "events", "-A", "-o", "json"),
    "gitops.applications": (
        "kubectl",
        "get",
        "applications.argoproj.io",
        "-n",
        "argocd",
        "-o",
        "json",
    ),
}


class AgentPolicyError(RuntimeError):
    pass


@dataclass(frozen=True)
class ResolvedInvocation:
    resolution_id: str
    policy_version: str
    tool: str
    tool_contract_version: str
    target: str
    normalized_arguments: dict[str, Any]
    canonicalization_version: str
    invocation_digest: str


@dataclass(frozen=True)
class AuthorizationDecision:
    decision: str
    reason: str
    risk_class: str
    approval_required: bool


@dataclass
class ExecutionEvidence:
    schema_version: str
    correlation_id: str
    resolution_id: str
    invocation_digest: str
    policy_version: str
    tool: str
    tool_contract_version: str
    target: str
    risk_class: str
    approval_required: bool
    authorization_decision: str
    authorization_reason: str
    canonicalization_version: str
    started_at: str
    completed_at: str | None = None
    execution_status: str = "not-executed"
    exit_code: int | None = None
    stdout_sha256: str | None = None
    stdout_bytes: int | None = None
    stderr_sha256: str | None = None
    stderr_bytes: int | None = None
    findings: dict[str, Any] | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_policy(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != "beluga-agent-policy/v1":
        raise AgentPolicyError("unsupported-policy-schema")
    if data.get("mode") != "read-only-poc":
        raise AgentPolicyError("unsupported-policy-mode")
    if not str(data.get("policyVersion", "")).strip():
        raise AgentPolicyError("policy-version-required")
    tools = data.get("tools")
    if not isinstance(tools, dict) or not tools:
        raise AgentPolicyError("tool-policy-required")
    return data


def resolve_invocation(policy: dict[str, Any], tool: str, correlation_id: str) -> ResolvedInvocation:
    if not correlation_id.strip():
        raise AgentPolicyError("correlation-id-required")
    if tool not in policy["tools"]:
        raise AgentPolicyError("unknown-tool")

    target = "kube-context:beluga"
    normalized_arguments: dict[str, Any] = {}
    resolution_id = f"resolution:{correlation_id}:{tool}"
    digest_input = {
        "policy_version": policy["policyVersion"],
        "tool": tool,
        "tool_contract_version": TOOL_CONTRACT_VERSION,
        "target": target,
        "normalized_arguments": normalized_arguments,
        "canonicalization_version": CANONICALIZATION_VERSION,
    }
    digest = f"sha256:{sha256_text(canonical_json(digest_input))}"
    return ResolvedInvocation(
        resolution_id=resolution_id,
        policy_version=policy["policyVersion"],
        tool=tool,
        tool_contract_version=TOOL_CONTRACT_VERSION,
        target=target,
        normalized_arguments=normalized_arguments,
        canonicalization_version=CANONICALIZATION_VERSION,
        invocation_digest=digest,
    )


def authorize(policy: dict[str, Any], invocation: ResolvedInvocation) -> AuthorizationDecision:
    spec = policy["tools"].get(invocation.tool)
    if not isinstance(spec, dict):
        return AuthorizationDecision("deny", "tool-policy-missing", "unknown", True)

    risk_class = str(spec.get("riskClass", "unknown"))
    approval_required = bool(spec.get("approvalRequired", True))
    executable = bool(spec.get("executable", False))

    if risk_class != "read-only-diagnostic":
        return AuthorizationDecision(
            "deny",
            "non-read-only-tool-disabled-in-poc",
            risk_class,
            approval_required,
        )
    if approval_required:
        return AuthorizationDecision("deny", "unexpected-approval-requirement", risk_class, True)
    if not executable:
        return AuthorizationDecision("deny", "tool-disabled-by-policy", risk_class, False)
    if invocation.tool not in TOOL_COMMANDS:
        return AuthorizationDecision("deny", "tool-command-not-implemented", risk_class, False)

    return AuthorizationDecision("allow", "read-only-tool-allowed", risk_class, False)


def validate_kubeconfig(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise AgentPolicyError("kubeconfig-not-found")

    shared = (Path.home() / ".kube" / "config").resolve()
    if resolved == shared:
        raise AgentPolicyError("shared-kubeconfig-refused")
    return resolved


def pod_findings(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("items", [])
    if not isinstance(items, list):
        return {"pods": 0, "unhealthy": 0, "reasons": {"invalid-payload": 1}}

    reasons: dict[str, int] = {}
    unhealthy = 0
    for pod in items:
        if not isinstance(pod, dict):
            continue
        status = pod.get("status", {})
        phase = status.get("phase")
        pod_unhealthy = phase in {"Failed", "Unknown"}
        if pod_unhealthy:
            reasons[str(phase)] = reasons.get(str(phase), 0) + 1

        for container in status.get("containerStatuses", []) or []:
            waiting = ((container or {}).get("state") or {}).get("waiting") or {}
            reason = waiting.get("reason")
            if reason and reason not in {"ContainerCreating", "PodInitializing"}:
                pod_unhealthy = True
                reasons[str(reason)] = reasons.get(str(reason), 0) + 1

        for condition in status.get("conditions", []) or []:
            if (
                condition.get("type") == "PodScheduled"
                and condition.get("status") == "False"
                and condition.get("reason")
            ):
                pod_unhealthy = True
                reason = str(condition["reason"])
                reasons[reason] = reasons.get(reason, 0) + 1

        if pod_unhealthy:
            unhealthy += 1

    return {"pods": len(items), "unhealthy": unhealthy, "reasons": reasons}


def summarize(tool: str, stdout: str) -> dict[str, Any] | None:
    if tool != "cluster.pods":
        return None
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return {"parse_error": True}
    return pod_findings(payload)


def execute_read_only(
    invocation: ResolvedInvocation,
    decision: AuthorizationDecision,
    kubeconfig: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> ExecutionEvidence:
    evidence = ExecutionEvidence(
        schema_version=SCHEMA_VERSION,
        correlation_id=invocation.resolution_id.split(":", 2)[1],
        resolution_id=invocation.resolution_id,
        invocation_digest=invocation.invocation_digest,
        policy_version=invocation.policy_version,
        tool=invocation.tool,
        tool_contract_version=invocation.tool_contract_version,
        target=invocation.target,
        risk_class=decision.risk_class,
        approval_required=decision.approval_required,
        authorization_decision=decision.decision,
        authorization_reason=decision.reason,
        canonicalization_version=invocation.canonicalization_version,
        started_at=utc_now(),
    )

    if decision.decision != "allow":
        evidence.execution_status = "denied-before-executor"
        evidence.completed_at = utc_now()
        return evidence

    resolved_kubeconfig = validate_kubeconfig(kubeconfig)
    command = [*TOOL_COMMANDS[invocation.tool], "--context", "beluga", "--request-timeout=15s"]
    env = os.environ.copy()
    env["KUBECONFIG"] = str(resolved_kubeconfig)

    completed = runner(
        command,
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    evidence.completed_at = utc_now()
    evidence.exit_code = completed.returncode
    evidence.stdout_sha256 = sha256_text(stdout)
    evidence.stdout_bytes = len(stdout.encode("utf-8"))
    evidence.stderr_sha256 = sha256_text(stderr)
    evidence.stderr_bytes = len(stderr.encode("utf-8"))
    evidence.execution_status = "succeeded" if completed.returncode == 0 else "failed"
    evidence.findings = summarize(invocation.tool, stdout) if completed.returncode == 0 else None
    return evidence


def write_evidence(path: Path | None, evidence: ExecutionEvidence) -> None:
    text = json.dumps(asdict(evidence), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if path is None:
        sys.stdout.write(text)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    sys.stdout.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Beluga Operations Agent read-only PoC")
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list-tools")

    for name in ("plan", "run"):
        command = sub.add_parser(name)
        command.add_argument("--tool", required=True)
        command.add_argument("--correlation-id", required=True)
        command.add_argument("--kubeconfig", type=Path)
        command.add_argument("--evidence-out", type=Path)

    args = parser.parse_args(argv)
    try:
        policy = load_policy(args.policy)
        if args.command == "list-tools":
            sys.stdout.write(json.dumps(policy["tools"], indent=2, sort_keys=True) + "\n")
            return 0

        invocation = resolve_invocation(policy, args.tool, args.correlation_id)
        decision = authorize(policy, invocation)
        if args.command == "plan":
            sys.stdout.write(
                json.dumps(
                    {
                        "invocation": asdict(invocation),
                        "authorization": asdict(decision),
                    },
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                + "\n"
            )
            return 0 if decision.decision == "allow" else 3

        if args.kubeconfig is None:
            raise AgentPolicyError("explicit-kubeconfig-required")
        evidence = execute_read_only(invocation, decision, args.kubeconfig)
        write_evidence(args.evidence_out, evidence)
        return 0 if evidence.execution_status == "succeeded" else 4
    except (AgentPolicyError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"operations-agent: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
