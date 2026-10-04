#!/usr/bin/env python3
"""Ratchet rendered-manifest Trivy HIGH findings for Issue #117."""
from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

BASELINE_PATH = Path(__file__).resolve().parent / "trivy-high-baseline.yaml"
KEY_FIELDS = ("rule", "chart", "kind", "namespace", "name", "container")
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod"}

# D1 (#117): freeze the initial finding keys in code as well as YAML. This
# makes adding a YAML exception alone insufficient; reducing debt requires
# removing keys and updating this digest in the same reviewed script change.
# Escape hatch: delete resolved keys and update this digest after a real scan.
FROZEN_BASELINE_SHA256 = "1aabb737cbf482b68edd8da991f630b60765d8ec972f3df2b954d6b7bb2068d6"


def key_id(key: dict[str, str]) -> str:
    return json.dumps([key[field] for field in KEY_FIELDS], separators=(",", ":"))


def baseline_digest(entries: list[dict[str, Any]]) -> str:
    payload = "\n".join(sorted(key_id(entry) for entry in entries))
    return hashlib.sha256(payload.encode()).hexdigest()


def load_baseline(path: Path = BASELINE_PATH) -> list[dict[str, Any]]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
        raise ValueError("baseline must contain a findings list")
    entries = data["findings"]
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or any(not isinstance(entry.get(f), str) or not entry[f] for f in KEY_FIELDS):
            raise ValueError("each finding needs non-empty rule, chart, kind, namespace, name, and container")
        if not isinstance(entry.get("reason"), str) or not entry["reason"].strip():
            raise ValueError("each finding needs a non-empty reason")
        ident = key_id(entry)
        if ident in seen:
            raise ValueError(f"duplicate baseline finding: {ident}")
        seen.add(ident)
    return entries


def _resources(path: Path) -> list[dict[str, Any]]:
    found = []
    for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")):
        if isinstance(doc, dict) and isinstance(doc.get("kind"), str):
            found.append(doc)
    return found


def _workload_container(resource: dict[str, Any], container: str) -> bool:
    kind = resource.get("kind")
    spec = resource.get("spec") or {}
    if kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}:
        pod = ((spec.get("template") or {}).get("spec") or {})
    elif kind == "CronJob":
        pod = (((spec.get("jobTemplate") or {}).get("spec") or {}).get("template") or {}).get("spec") or {}
    elif kind == "Pod":
        pod = spec
    else:
        return False
    return any(c.get("name") == container for c in (pod.get("containers") or []) + (pod.get("initContainers") or []) if isinstance(c, dict))


def finding_key(misconf: dict[str, Any], target: str, rendered_root: Path) -> dict[str, str]:
    """Map Trivy's cause metadata and resource message to its rendered workload."""
    message = str(misconf.get("Message") or "")
    path = rendered_root / target
    explicit = re.search(r"\b(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod)\s+'([^']+)'", message, re.I)
    if not explicit:
        explicit = re.search(r"\b(deployment|statefulset|daemonset|job|cronjob|pod)\s+([\w.-]+)\s+in\s+[\w.-]+\s+namespace\b", message, re.I)
    resources = _resources(path)
    selected: dict[str, Any] | None = None
    if explicit:
        kind, name = explicit.group(1).lower(), explicit.group(2)
        selected = next((r for r in resources if str(r.get("kind", "")).lower() == kind and (r.get("metadata") or {}).get("name") == name), None)
    else:
        container_match = re.search(r"\bcontainer\s+([\w.-]+)\s+in\s+([\w.-]+)\s+namespace\b", message, re.I)
        if container_match:
            container, namespace = container_match.groups()
            same_namespace = [r for r in resources if (r.get("metadata") or {}).get("namespace", "default") == namespace]
            # KSV-0118 reports a pod-level rule using the workload name in its
            # message. Never infer ownership from an arbitrary resource name.
            selected = next((r for r in same_namespace if r.get("kind") in WORKLOAD_KINDS and (r.get("metadata") or {}).get("name") == container), None)
            if selected is None:
                selected = next((r for r in same_namespace if r.get("kind") in WORKLOAD_KINDS and _workload_container(r, container)), None)
    if selected is None:
        raise ValueError(f"cannot map Trivy finding to rendered resource: {target}: {message}")
    meta = selected.get("metadata") or {}
    rule = str(misconf.get("ID") or "")
    container = "__pod__"
    container_match = re.search(r"Container\s+'([^']+)'\s+of\s+(?:Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod)", message, re.I)
    if container_match:
        container = container_match.group(1)
    elif rule != "KSV-0118":
        # Some Trivy messages omit the container. Resolve a unique cause line
        # container name; ambiguity fails closed rather than hiding findings.
        lines = (((misconf.get("CauseMetadata") or {}).get("Code") or {}).get("Lines") or [])
        names = {m.group(1) for line in lines if isinstance(line, dict) and (m := re.search(r"-\s*name:\s*([\w.-]+)", str(line.get("Content") or "")))}
        if len(names) == 1:
            container = names.pop()
    chart = next((part for part in Path(target).parts if part in {"beluga-platform", "beluga-data"}), "plain")
    return {"rule": rule, "chart": chart, "kind": str(selected["kind"]), "namespace": str(meta.get("namespace") or "default"), "name": str(meta.get("name") or ""), "container": container, "target": target}


def scan_keys(report: dict[str, Any], rendered_root: Path) -> dict[str, dict[str, str]]:
    keys: dict[str, dict[str, str]] = {}
    for result in report.get("Results") or []:
        target = str(result.get("Target") or "")
        for finding in result.get("Misconfigurations") or []:
            if finding.get("Severity") != "HIGH":
                continue
            key = finding_key(finding, target, rendered_root)
            keys[key_id(key)] = key
    return keys


def compare(report: dict[str, Any], rendered_root: Path, baseline: list[dict[str, Any]], expected_digest: str = FROZEN_BASELINE_SHA256) -> list[str]:
    errors: list[str] = []
    if expected_digest != "GENERATE_AFTER_SCAN" and baseline_digest(baseline) != expected_digest:
        errors.append("baseline changed outside the frozen ratchet ceiling; update is required in checker code")
    expected = {key_id(entry): entry for entry in baseline}
    actual = scan_keys(report, rendered_root)
    for ident in sorted(actual.keys() - expected.keys()):
        errors.append(f"new HIGH finding: {actual[ident]}")
    for ident in sorted(expected.keys() - actual.keys()):
        errors.append(f"stale baseline finding: {expected[ident]}")
    return errors


def run_self_tests() -> None:
    with tempfile.TemporaryDirectory(prefix="beluga-trivy-ratchet-") as temp:
        root = Path(temp)
        manifest = root / "workload.yaml"
        manifest.write_text("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo\n  namespace: test\nspec:\n  template:\n    spec:\n      containers:\n      - name: demo\n      - name: sidecar\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: service-only\n  namespace: test\n", encoding="utf-8")
        key = {"rule": "KSV-0014", "chart": "plain", "kind": "Deployment", "namespace": "test", "name": "demo", "container": "demo", "target": "workload.yaml"}
        baseline = [{**key, "reason": "fixture debt"}]
        finding = {"ID": key["rule"], "Severity": "HIGH", "Message": "Container 'demo' of Deployment 'demo' should set readOnlyRootFilesystem"}
        report = {"Results": [{"Target": "workload.yaml", "Misconfigurations": [finding]}]}
        if compare(report, root, baseline, baseline_digest(baseline)):
            raise ValueError("self-test identical rerun should pass")
        renamed = {**report, "Results": [{"Target": "renamed.yaml", "Misconfigurations": [finding]}]}
        (root / "renamed.yaml").write_text(manifest.read_text(encoding="utf-8"), encoding="utf-8")
        if compare(renamed, root, baseline, baseline_digest(baseline)):
            raise ValueError("self-test template rename should preserve finding identity")
        sidecar = {**finding, "Message": "Container 'sidecar' of Deployment 'demo' should set readOnlyRootFilesystem"}
        if not any("new HIGH finding" in error for error in compare({"Results": [{"Target": "workload.yaml", "Misconfigurations": [finding, sidecar]}]}, root, baseline, baseline_digest(baseline))):
            raise ValueError("self-test additional container finding should fail")
        service_only = root / "service-only.yaml"
        service_only.write_text("apiVersion: v1\nkind: Service\nmetadata:\n  name: demo\n  namespace: test\n", encoding="utf-8")
        try:
            finding_key({"ID": "KSV-0118"}, "service-only.yaml", root)
        except ValueError:
            pass
        else:
            raise ValueError("self-test Service must never be attributed as workload")
        extra = {**finding, "ID": "KSV-0118"}
        if not any("new HIGH finding" in error for error in compare({"Results": [{"Target": "workload.yaml", "Misconfigurations": [finding, extra]}]}, root, baseline, baseline_digest(baseline))):
            raise ValueError("self-test new finding should fail")
        if not any("stale baseline finding" in error for error in compare({"Results": []}, root, baseline, baseline_digest(baseline))):
            raise ValueError("self-test stale entry should fail")


def main() -> int:
    try:
        run_self_tests()
        baseline = load_baseline()
        report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/trivy-high.json")
        rendered_root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("rendered")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        errors = compare(report, rendered_root, baseline)
        if errors:
            print("Trivy HIGH ratchet FAIL:")
            print("\n".join(f"- {error}" for error in errors))
            return 1
        print(f"Trivy HIGH ratchet PASS: {len(baseline)} baselined findings; self-tests passed")
        return 0
    except (OSError, ValueError, yaml.YAMLError, json.JSONDecodeError) as error:
        print(f"Trivy HIGH ratchet ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
