#!/usr/bin/env python3
"""NetworkPolicy coverage ratchet gate (Issue #11).

Triage for #11 found that the rendered charts leave several workload namespaces
(iam, database, lakehouse, orchestration, streaming, analytics) with zero
NetworkPolicy of any kind, while governance/storage/platform-system already carry
at least one. This gate is a RATCHET ONLY: it does not add default-deny policies to
the uncovered namespaces (that needs live cluster traffic validation and is #11's
follow-up), it only prevents further drift.

Two rules, evaluated against `helm template` output for every deployed values combo
(see COMBOS below):

1. Every namespace that renders a workload (Deployment/StatefulSet/DaemonSet/Job/
   CronJob) must have >=1 NetworkPolicy, unless it is listed in
   networkpolicy-baseline.yaml with a reason and an issue reference. The baseline is
   a ratchet: a namespace that gains coverage must be removed from it (stale entries
   fail), and a namespace that loses coverage without being (re-)baselined fails too.
2. Any NetworkPolicy literally named `default-deny-all` (the naming convention
   `gitops/charts/beluga-data/templates/00b-network-baseline.yaml` already
   establishes for governance/storage) must keep the true default-deny shape:
   `podSelector: {}`, `policyTypes` including `Ingress`, and no ingress rules. This
   is checked unconditionally (not baseline-gated) so an already-adopted default-deny
   cannot be silently weakened. Namespaces whose only policy is narrower (e.g.
   platform-system's pod-scoped `apisix-admin-restrict`) are not held to this shape;
   reality shows that pattern is not used everywhere, so rule 1's "has >=1 policy"
   is all that is required there.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = Path(__file__).resolve().parent / "networkpolicy-baseline.yaml"
CHARTS = ("beluga-platform", "beluga-data")
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}
DEFAULT_DENY_NAME = "default-deny-all"

# Deployed values combos. beluga-data's flags mirror scripts/common/env.sh's RAM
# profile switch (BELUGA_PROFILE >= 48 flips both together) and are applied exactly
# this way by scripts/gitops/01-argocd-bootstrap.sh. beluga-platform takes neither
# flag today but is rendered in both combos anyway, so a future platform-side
# namespace gated by them is not silently skipped by this gate.
COMBOS: tuple[tuple[str, dict[str, str]], ...] = (
    ("default (BELUGA_PROFILE < 48)", {"openmetadata.enabled": "false", "trino.workerEnabled": "false"}),
    ("48/64GB profile", {"openmetadata.enabled": "true", "trino.workerEnabled": "true"}),
)


def documents(manifest_text: str) -> list[dict]:
    """Parse `helm template` stdout into a flat list of resource mappings."""
    result: list[dict] = []

    def add(resource) -> None:
        if not isinstance(resource, dict):
            raise ValueError("rendered document must be a resource mapping")
        if resource.get("kind") == "List":
            for item in resource.get("items", []):
                add(item)
            return
        result.append(resource)

    for doc in yaml.safe_load_all(manifest_text):
        if doc is not None:
            add(doc)
    return result


def workload_namespaces(resources: list[dict]) -> set[str]:
    namespaces = set()
    for resource in resources:
        if resource.get("kind") in WORKLOAD_KINDS:
            namespaces.add(resource.get("metadata", {}).get("namespace", "default"))
    return namespaces


def networkpolicies_by_namespace(resources: list[dict]) -> dict[str, list[dict]]:
    by_ns: dict[str, list[dict]] = {}
    for resource in resources:
        if resource.get("kind") != "NetworkPolicy":
            continue
        ns = resource.get("metadata", {}).get("namespace", "default")
        by_ns.setdefault(ns, []).append(resource)
    return by_ns


def is_default_deny_ingress(netpol: dict) -> bool:
    spec = netpol.get("spec") or {}
    if spec.get("podSelector") != {}:
        return False
    policy_types = spec.get("policyTypes") or []
    if "Ingress" not in policy_types:
        return False
    return not spec.get("ingress")


def evaluate_combo(resources: list[dict]) -> tuple[set[str], set[str], list[tuple[str, str]]]:
    """Return (workload_namespaces, uncovered_namespaces, default_deny_violations)."""
    workloads = workload_namespaces(resources)
    netpols = networkpolicies_by_namespace(resources)
    uncovered = {ns for ns in workloads if not netpols.get(ns)}
    violations = []
    for ns, policies in netpols.items():
        for policy in policies:
            name = policy.get("metadata", {}).get("name")
            if name == DEFAULT_DENY_NAME and not is_default_deny_ingress(policy):
                violations.append((ns, name))
    return workloads, uncovered, violations


def load_baseline(path: Path) -> dict[str, dict]:
    if not path.is_file():
        raise ValueError(f"baseline file not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = data.get("namespaces")
    if not isinstance(entries, list):
        raise ValueError(f"{path.name}: top-level 'namespaces' must be a list")

    baseline: dict[str, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"{path.name}: each baseline entry must be a mapping")
        namespace = entry.get("namespace")
        reason = entry.get("reason")
        issue = entry.get("issue")
        if not isinstance(namespace, str) or not namespace:
            raise ValueError(f"{path.name}: baseline entry missing non-empty 'namespace'")
        if namespace in baseline:
            raise ValueError(f"{path.name}: duplicate baseline entry for namespace '{namespace}'")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"{path.name}: baseline entry '{namespace}' missing non-empty 'reason'")
        if not isinstance(issue, int) or isinstance(issue, bool) or issue <= 0:
            raise ValueError(f"{path.name}: baseline entry '{namespace}' missing positive integer 'issue'")
        baseline[namespace] = {"reason": reason, "issue": issue}
    return baseline


def check_coverage(combos: list[tuple[str, list[dict]]], baseline: dict[str, dict]) -> tuple[list[str], dict]:
    """combos: list of (label, resources) already rendered/parsed for one values combo."""
    errors: list[str] = []
    all_workloads: set[str] = set()
    uncovered_in: dict[str, set[str]] = {}

    for label, resources in combos:
        workloads, uncovered, violations = evaluate_combo(resources)
        all_workloads |= workloads
        for ns in uncovered:
            uncovered_in.setdefault(ns, set()).add(label)
        for ns, name in violations:
            errors.append(
                f"namespace '{ns}': NetworkPolicy '{name}' no longer matches the default-deny-all shape "
                f"(podSelector {{}}, policyTypes including Ingress, no ingress rules) in combo '{label}' "
                "-- an adopted default-deny cannot be weakened"
            )

    gap_namespaces = set(uncovered_in)

    for ns in sorted(gap_namespaces):
        if ns not in baseline:
            combos_str = ", ".join(sorted(uncovered_in[ns]))
            errors.append(
                f"namespace '{ns}' has workloads with zero NetworkPolicy coverage in combo(s): {combos_str}, "
                f"and is not listed in {BASELINE_PATH.name} (either add a baseline entry with reason+issue, "
                "or apply default-deny after cluster traffic validation)"
            )

    for ns in sorted(baseline):
        if ns not in gap_namespaces:
            errors.append(
                f"stale baseline entry '{ns}': namespace now has NetworkPolicy coverage in every deployed "
                f"combo; remove it from {BASELINE_PATH.name} (ratchet only tightens)"
            )

    covered = sorted(all_workloads - gap_namespaces)
    report = {"covered": covered, "baselined": sorted(baseline), "gaps": sorted(gap_namespaces)}
    return errors, report


def _resource(kind: str, namespace: str, name: str, spec: dict | None = None) -> dict:
    return {
        "apiVersion": "v1",
        "kind": kind,
        "metadata": {"name": name, "namespace": namespace},
        "spec": spec or {},
    }


def self_test() -> None:
    """Built-in positive/negative fixtures; run on every gate invocation (no `helm` needed)."""
    deploy_iam = _resource("Deployment", "iam", "keycloak")
    deploy_storage = _resource("StatefulSet", "storage", "seaweedfs")
    deploy_platform = _resource("Deployment", "platform-system", "apisix")

    good_default_deny = _resource(
        "NetworkPolicy", "storage", DEFAULT_DENY_NAME,
        {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
    )
    empty_ingress_default_deny = _resource(
        "NetworkPolicy", "storage", DEFAULT_DENY_NAME,
        {"podSelector": {}, "policyTypes": ["Ingress", "Egress"], "ingress": []},
    )
    weakened_default_deny = _resource(
        "NetworkPolicy", "storage", DEFAULT_DENY_NAME,
        {"podSelector": {}, "policyTypes": ["Ingress"], "ingress": [{"from": []}]},
    )
    scoped_policy = _resource(
        "NetworkPolicy", "platform-system", "apisix-admin-restrict",
        {"podSelector": {"matchLabels": {"app": "apisix"}}, "policyTypes": ["Ingress"], "ingress": [{"from": []}]},
    )

    # 1. Baseline correctly documents an uncovered namespace -> passes, reported as a gap.
    combos = [("default", [deploy_iam, deploy_storage, good_default_deny])]
    baseline = {"iam": {"reason": "needs cluster validation", "issue": 11}}
    errors, report = check_coverage(combos, baseline)
    if errors:
        raise ValueError(f"self-test baseline-covers-gap unexpectedly failed: {errors}")
    if report["gaps"] != ["iam"] or report["covered"] != ["storage"]:
        raise ValueError(f"self-test baseline-covers-gap report mismatch: {report}")

    # 2. Same render, no baseline entry -> new gap must fail closed.
    errors, _ = check_coverage(combos, {})
    if not any("is not listed in" in error for error in errors):
        raise ValueError(f"self-test undocumented-gap did not fail as expected: {errors}")

    # 3. Namespace is fully covered but still baselined -> stale entry must fail (ratchet tightens).
    combos_covered = [("default", [deploy_iam, deploy_storage, good_default_deny,
                                    _resource("NetworkPolicy", "iam", "iam-default-deny",
                                              {"podSelector": {}, "policyTypes": ["Ingress"]})])]
    errors, _ = check_coverage(combos_covered, baseline)
    if not any("stale baseline entry" in error for error in errors):
        raise ValueError(f"self-test stale-baseline did not fail as expected: {errors}")

    # 4. A namespace whose only policy is narrower than default-deny-all still counts as covered
    #    (reality: platform-system's apisix-admin-restrict is pod-scoped, not namespace-wide).
    combos_scoped = [("default", [deploy_platform, scoped_policy])]
    errors, report = check_coverage(combos_scoped, {})
    if errors:
        raise ValueError(f"self-test scoped-policy-is-coverage unexpectedly failed: {errors}")
    if report["covered"] != ["platform-system"]:
        raise ValueError(f"self-test scoped-policy-is-coverage report mismatch: {report}")

    # 5. A default-deny-all policy with an explicit empty ingress list is still a true default-deny.
    combos_empty = [("default", [deploy_storage, empty_ingress_default_deny])]
    errors, _ = check_coverage(combos_empty, {})
    if errors:
        raise ValueError(f"self-test empty-ingress-list-is-default-deny unexpectedly failed: {errors}")

    # 6. A default-deny-all policy that gained ingress rules is a regression, baseline or not.
    combos_weak = [("default", [deploy_storage, weakened_default_deny])]
    errors, _ = check_coverage(combos_weak, {"storage": {"reason": "irrelevant", "issue": 11}})
    if not any("no longer matches the default-deny-all shape" in error for error in errors):
        raise ValueError(f"self-test weakened-default-deny did not fail as expected: {errors}")

    # 7. Baseline schema validation: missing reason, missing issue, duplicate namespace.
    with tempfile.TemporaryDirectory(prefix="beluga-networkpolicy-baseline-") as tmpdir:
        path = Path(tmpdir) / "networkpolicy-baseline.yaml"
        schema_cases = [
            ("namespaces:\n  - namespace: iam\n    issue: 11\n", "non-empty 'reason'"),
            ("namespaces:\n  - namespace: iam\n    reason: x\n", "positive integer 'issue'"),
            ("namespaces:\n  - namespace: iam\n    reason: x\n    issue: 0\n", "positive integer 'issue'"),
            (
                "namespaces:\n  - namespace: iam\n    reason: x\n    issue: 11\n"
                "  - namespace: iam\n    reason: y\n    issue: 11\n",
                "duplicate baseline entry",
            ),
            ("namespaces: not-a-list\n", "must be a list"),
        ]
        for content, expected_diagnostic in schema_cases:
            path.write_text(content, encoding="utf-8")
            try:
                load_baseline(path)
            except ValueError as error:
                if expected_diagnostic not in str(error):
                    raise ValueError(f"self-test schema case unexpected message: {error}") from error
            else:
                raise ValueError(f"self-test schema case unexpectedly accepted: {content!r}")

        path.write_text("namespaces:\n  - namespace: iam\n    reason: x\n    issue: 11\n", encoding="utf-8")
        if load_baseline(path) != {"iam": {"reason": "x", "issue": 11}}:
            raise ValueError("self-test valid baseline schema did not round-trip")

    print(f"Self-tests OK: {len(schema_cases) + 6} ratchet fixtures accepted/rejected as expected.",
          file=sys.stderr)


def render_combo(values: dict[str, str]) -> list[dict]:
    resources: list[dict] = []
    env = {**os.environ, "KUBECONFIG": os.devnull}
    for chart in CHARTS:
        cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart)]
        for key, value in values.items():
            cmd.extend(["--set", f"{key}={value}"])
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
        resources.extend(documents(result.stdout))
    return resources


def main() -> int:
    try:
        self_test()
    except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
        print(f"NetworkPolicy coverage self-test FAIL: {error}", file=sys.stderr)
        return 1

    try:
        baseline = load_baseline(BASELINE_PATH)
        combos = [(label, render_combo(values)) for label, values in COMBOS]
        errors, report = check_coverage(combos, baseline)
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except (OSError, ValueError, yaml.YAMLError) as exc:
        print(f"FAIL: NetworkPolicy coverage: {exc}", file=sys.stderr)
        return 1

    print("=== NetworkPolicy coverage ratchet (Issue #11) ===")
    print(f"Covered namespaces ({len(report['covered'])}): {', '.join(report['covered']) or '(none)'}")
    print(f"Baselined known-uncovered namespaces ({len(report['baselined'])}):")
    for ns in report["baselined"]:
        entry = baseline[ns]
        print(f"  - {ns}: {entry['reason']} (issue #{entry['issue']})")

    if errors:
        print()
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    print("\nOK: every workload namespace has NetworkPolicy coverage or a documented baseline "
          "exception; no default-deny-all regressions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
