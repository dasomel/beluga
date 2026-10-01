#!/usr/bin/env python3
"""Rendered Kubernetes security baseline ratchet and inventory (Issue #125).

Renders both charts the same way `make validate` does (KUBECONFIG=/dev/null,
default values) and statically reports, without mutating anything:

- namespace NetworkPolicy default-deny (ingress/egress) coverage;
- Service/Ingress/ApisixRoute/ApisixTls exposure (declared hosts, Service
  types other than the implicit ClusterIP);
- Pod-template workload runtime security posture (runAsNonRoot,
  allowPrivilegeEscalation, readOnlyRootFilesystem, seccompProfile,
  capability drop, privileged/hostNetwork/hostPID/hostIPC, hostPath volumes)
  for the standard PodSpec-owning kinds (Deployment/StatefulSet/DaemonSet/
  Job/CronJob);
- best-effort outbound-hostname candidates referenced literally in rendered
  manifests (URLs whose host is not cluster-local), for the egress-dependency
  inventory the Change Package needs.

Existing gaps are pinned below and may only shrink. This gate does not prove
live connectivity, operator-generated Pod security, AppArmor mode, or runtime
egress destinations assembled from configuration.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML is required; install the pinned CI requirements (see requirements-ci.txt)",
          file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
CHARTS = ("beluga-platform", "beluga-data")
NETWORKPOLICY_BASELINE = Path(__file__).with_name("networkpolicy-baseline.yaml")

# D1: Reuse issue #11's reviewed NetworkPolicy baseline for workload namespaces;
# cert-manager has no standard PodSpec workload, so issue #11 intentionally does
# not cover it. This one extra namespace exception remains visible until its
# default-deny is rolled out with live traffic evidence (issue #125).
EXTRA_DEFAULT_DENY_BASELINE = {"cert-manager"}

# D2: Pin current pre-rollout gaps by (kind, namespace, name) and exact
# container set. The extra kind key prevents same-name workload collisions;
# remove it only if an equivalent identity check replaces this ratchet.
# Runtime hardening needs a live rollout (T-012); existing gaps are not approval.
NONROOT_RO_GAPS = {"runAsNonRoot not true", "readOnlyRootFilesystem not true"}
RUNTIME_BASELINE = {
    ("Deployment", "platform-system", "apisix"): {"container apisix: readOnlyRootFilesystem not true"},
    ("Deployment", "iam", "keycloak"): {"container keycloak: readOnlyRootFilesystem not true"},
    # 이슈 #117: seccomp/allowPrivilegeEscalation/drop ALL은 적용 완료 — 남은 것은
    # 쓰기 경로 실측이 필요한 readOnlyRootFilesystem과 이미지 UID 확인이 필요한 runAsNonRoot.
    ("Deployment", "orchestration", "airflow-webserver"): {
        f"container {name}: {gap}" for name in ("airflow", "build-ca-bundle (init)")
        for gap in NONROOT_RO_GAPS
    },
    ("Deployment", "analytics", "superset"): {
        f"container {name}: {gap}"
        for name in ("superset", "install-authlib (init)", "build-ca-bundle (init)")
        for gap in NONROOT_RO_GAPS
    } | {"container install-authlib (init): capabilities.drop does not include ALL"},
    ("Job", "streaming", "flink-sql-submit"): {f"container submit-sql: {gap}" for gap in NONROOT_RO_GAPS},
}

# D3: Namespace PSA labels are currently absent everywhere; the frozen set
# prevents new unlabeled namespaces and becomes stale as labels are added.
PSA_BASELINE = frozenset({"platform-system", "iam", "cert-manager", "database", "storage",
                          "streaming", "lakehouse", "analytics", "orchestration", "governance"})

# D4: Only the documented APISIX gateway is an accepted direct Service.
# grafana-external is a known NodePort debt (T-014, owner dasomel, review 2026-10-29).
SERVICE_BASELINE = {("platform-system", "apisix-gateway", "LoadBalancer"),
                    ("platform-system", "grafana-external", "NodePort")}

# Kinds whose `spec.template.spec` (or `spec.jobTemplate.spec.template.spec` for
# CronJob) is a standard Kubernetes PodSpec we can statically evaluate.
POD_TEMPLATE_KINDS = ("Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob")

# Operator-managed custom resources seen in this repository that also own pod
# scheduling but do not expose a standard `spec.template.spec` PodSpec in a
# uniform place (Strimzi Kafka, Flink operator, CloudNativePG). These are
# listed as "needs manual review" rather than silently skipped.
CUSTOM_WORKLOAD_KINDS = ("Kafka", "KafkaNodePool", "FlinkDeployment", "Cluster")

# Hostnames that are not an outbound dependency: cluster-internal DNS, the
# platform's single documented internal domain (AGENTS.md domain registry),
# and loopback/placeholder values that show up in examples or comments.
INTERNAL_HOST_SUFFIXES = (".svc.cluster.local", ".svc", ".local.beluga.internal")
INTERNAL_HOST_EXACT = {"localhost", "127.0.0.1", "kubernetes.default"}

URL_RE = re.compile(r"https?://([A-Za-z0-9_.-]+)(?::\d+)?")


def render(chart: str) -> str:
    result = subprocess.run(
        ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart)],
        capture_output=True, text=True, check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    return result.stdout


def documents(manifest: str, chart: str) -> list[dict]:
    result = []

    def add(resource):
        if not isinstance(resource, dict) or "kind" not in resource:
            raise ValueError(f"{chart}: rendered document is not a resource mapping")
        if resource["kind"] == "List":
            for item in resource.get("items", []):
                add(item)
            return
        resource["_chart"] = chart
        result.append(resource)

    for document in yaml.safe_load_all(manifest):
        if document is not None:
            add(document)
    return result


def pod_spec(resource: dict) -> dict | None:
    kind = resource.get("kind")
    if kind == "Job":
        return resource.get("spec", {}).get("template", {}).get("spec")
    if kind == "CronJob":
        return (resource.get("spec", {}).get("jobTemplate", {}).get("spec", {})
                .get("template", {}).get("spec"))
    if kind in ("Deployment", "StatefulSet", "DaemonSet"):
        return resource.get("spec", {}).get("template", {}).get("spec")
    return None


def container_findings(pod: dict, container: dict, init: bool) -> dict:
    pod_sc = pod.get("securityContext") or {}
    sc = container.get("securityContext") or {}
    run_as_non_root = sc.get("runAsNonRoot", pod_sc.get("runAsNonRoot"))
    seccomp = sc.get("seccompProfile") or pod_sc.get("seccompProfile") or {}
    caps = sc.get("capabilities") or {}
    drops = {str(item).upper() for item in (caps.get("drop") or [])}
    # D7: Restricted permits only NET_BIND_SERVICE in add; report each other
    # value as a gap. Retire this local check only with equivalent PSA validation.
    disallowed_adds = sorted({str(item).upper() for item in (caps.get("add") or [])}
                             - {"NET_BIND_SERVICE"})
    return {
        "name": container.get("name"),
        "init": init,
        "runAsNonRoot": run_as_non_root is True,
        "allowPrivilegeEscalation": sc.get("allowPrivilegeEscalation"),
        "allowPrivilegeEscalationDenied": sc.get("allowPrivilegeEscalation") is False,
        "readOnlyRootFilesystem": sc.get("readOnlyRootFilesystem") is True,
        "seccompRuntimeDefault": seccomp.get("type") in ("RuntimeDefault", "Localhost"),
        "capabilitiesDropAll": "ALL" in drops,
        "disallowedCapabilitiesAdd": disallowed_adds,
        "privileged": sc.get("privileged") is True,
    }


def workload_findings(resources: list[dict]) -> tuple[list[dict], list[dict]]:
    workloads, needs_manual_review = [], []
    for resource in resources:
        kind = resource.get("kind")
        meta = resource.get("metadata", {})
        identity = {"chart": resource["_chart"], "kind": kind,
                    "namespace": meta.get("namespace", "default"), "name": meta.get("name")}
        if kind in CUSTOM_WORKLOAD_KINDS:
            needs_manual_review.append({**identity,
                                        "reason": "operator-managed pod template; not a standard PodSpec"})
            continue
        if kind not in POD_TEMPLATE_KINDS:
            continue
        spec = pod_spec(resource)
        if spec is None:
            continue
        containers = [container_findings(spec, c, False) for c in spec.get("containers", [])]
        containers += [container_findings(spec, c, True) for c in spec.get("initContainers", [])]
        host_paths = [v.get("name") for v in spec.get("volumes", []) if "hostPath" in v]
        workloads.append({
            **identity,
            "hostNetwork": spec.get("hostNetwork") is True,
            "hostPID": spec.get("hostPID") is True,
            "hostIPC": spec.get("hostIPC") is True,
            "hostPathVolumes": host_paths,
            "containers": containers,
            "gaps": container_gaps(containers, spec, host_paths),
        })
    return workloads, needs_manual_review


def container_gaps(containers: list[dict], spec: dict, host_paths: list[str]) -> list[str]:
    gaps = []
    if spec.get("hostNetwork") is True:
        gaps.append("hostNetwork:true")
    if spec.get("hostPID") is True:
        gaps.append("hostPID:true")
    if spec.get("hostIPC") is True:
        gaps.append("hostIPC:true")
    if host_paths:
        gaps.append(f"hostPath volumes: {host_paths}")
    for c in containers:
        label = f"container {c['name']}" + (" (init)" if c["init"] else "")
        if not c["runAsNonRoot"]:
            gaps.append(f"{label}: runAsNonRoot not true")
        if not c["allowPrivilegeEscalationDenied"]:
            gaps.append(f"{label}: allowPrivilegeEscalation not explicitly false")
        if not c["readOnlyRootFilesystem"]:
            gaps.append(f"{label}: readOnlyRootFilesystem not true")
        if not c["seccompRuntimeDefault"]:
            gaps.append(f"{label}: seccompProfile not RuntimeDefault/Localhost")
        if not c["capabilitiesDropAll"]:
            gaps.append(f"{label}: capabilities.drop does not include ALL")
        for capability in c["disallowedCapabilitiesAdd"]:
            gaps.append(f"{label}: capabilities.add includes {capability} "
                        "(only NET_BIND_SERVICE allowed)")
        if c["privileged"]:
            gaps.append(f"{label}: privileged:true")
    return gaps


def network_policy_coverage(resources: list[dict]) -> dict:
    coverage: dict[str, dict] = {}
    for resource in resources:
        if resource.get("kind") != "NetworkPolicy":
            continue
        namespace = resource.get("metadata", {}).get("namespace", "default")
        spec = resource.get("spec", {})
        entry = coverage.setdefault(namespace, {"policies": [], "defaultDenyIngress": False,
                                                  "defaultDenyEgress": False})
        entry["policies"].append(resource.get("metadata", {}).get("name"))
        selector = spec.get("podSelector")
        is_all_pods = selector == {} or (isinstance(selector, dict)
                                         and not selector.get("matchLabels")
                                         and not selector.get("matchExpressions"))
        # Kubernetes defaults omitted policyTypes to Ingress, plus Egress only
        # when egress rules exist. Empty egress does not imply Egress isolation.
        types = set(spec["policyTypes"]) if spec.get("policyTypes") else (
            {"Ingress", "Egress"} if spec.get("egress") else {"Ingress"})
        if is_all_pods and "Ingress" in types and not spec.get("ingress"):
            entry["defaultDenyIngress"] = True
        if is_all_pods and "Egress" in types and not spec.get("egress"):
            entry["defaultDenyEgress"] = True
    return coverage


def namespace_inventory(resources: list[dict], np_coverage: dict) -> list[dict]:
    declared = {}
    referenced = {}
    for resource in resources:
        meta = resource.get("metadata", {})
        if meta.get("namespace"):
            referenced.setdefault(meta["namespace"], resource["_chart"])
        if resource.get("kind") == "Namespace":
            declared[meta.get("name")] = resource
    namespaces = []
    # D6: A rendered resource can target a namespace without a Namespace
    # manifest. Inventory those references as unlabeled (one entry per name)
    # until an equivalent namespace-existence gate replaces this check.
    for name in sorted(declared.keys() | referenced.keys()):
        resource = declared.get(name)
        labels = (resource.get("metadata", {}).get("labels", {}) or {}) if resource else {}
        cov = np_coverage.get(name, {"policies": [], "defaultDenyIngress": False, "defaultDenyEgress": False})
        namespaces.append({
            "chart": resource["_chart"] if resource else referenced[name],
            "namespace": name,
            "podSecurityLabels": {k: v for k, v in labels.items() if k.startswith("pod-security.kubernetes.io/")},
            "networkPolicies": cov["policies"],
            "defaultDenyIngress": cov["defaultDenyIngress"],
            "defaultDenyEgress": cov["defaultDenyEgress"],
        })
    return namespaces


def exposure_inventory(resources: list[dict]) -> list[dict]:
    exposures = []
    for resource in resources:
        kind = resource.get("kind")
        meta = resource.get("metadata", {})
        identity = {"chart": resource["_chart"], "kind": kind,
                    "namespace": meta.get("namespace", "default"), "name": meta.get("name")}
        if kind == "Service":
            svc_type = resource.get("spec", {}).get("type", "ClusterIP")
            if svc_type != "ClusterIP":
                exposures.append({**identity, "serviceType": svc_type,
                                  "note": "non-ClusterIP Service: reachable without going through the "
                                          "gateway/Ingress path"})
        elif kind == "Ingress":
            hosts = [r.get("host") for r in resource.get("spec", {}).get("rules", []) if r.get("host")]
            exposures.append({**identity, "hosts": hosts})
        elif kind == "ApisixRoute":
            hosts = []
            for rule in resource.get("spec", {}).get("http", []):
                hosts.extend(rule.get("match", {}).get("hosts", []))
            exposures.append({**identity, "hosts": sorted(set(hosts))})
        elif kind == "ApisixTls":
            hosts = resource.get("spec", {}).get("hosts", [])
            exposures.append({**identity, "hosts": hosts})
    return exposures


def is_internal_host(host: str) -> bool:
    host = host.lower()
    if host in INTERNAL_HOST_EXACT:
        return True
    return any(host.endswith(suffix) for suffix in INTERNAL_HOST_SUFFIXES)


def egress_candidates(manifest: str) -> list[str]:
    """Best-effort external-hostname literals from rendered manifests.

    Single-label hosts (no dot) are dropped: in this repository they are
    always same-namespace short names used in a literal `http://name:port`
    (e.g. `discovery.uri=http://trino:8080`), never a real external host, and
    an unterminated regex match can also truncate a Korean-comment sentence
    down to one bare word. This is a starting list for human triage, not a
    verified egress allow-list: it does not distinguish a runtime `curl`/JDBC
    URL (e.g. the Flink JAR fetch from repo1.maven.org) from a documentation
    link left in a comment, and it cannot see hosts assembled at runtime from
    a Secret/ConfigMap value.
    """
    hosts = set()
    for match in URL_RE.finditer(manifest):
        # Trailing dots show up when the regex's char class runs into a
        # non-ASCII character right after a mid-sentence "..." (a Korean
        # comment cut off mid-URL); strip them before judging "has a dot".
        host = match.group(1).rstrip(".")
        if "." not in host or re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
            continue
        if not is_internal_host(host):
            hosts.add(host)
    return sorted(hosts)


def build_report(resources: list[dict], manifests: dict[str, str]) -> dict:
    np_coverage = network_policy_coverage(resources)
    namespaces = namespace_inventory(resources, np_coverage)
    workloads, needs_manual_review = workload_findings(resources)
    exposures = exposure_inventory(resources)
    egress = sorted({h for m in manifests.values() for h in egress_candidates(m)})

    namespaces_without_default_deny = [
        n["namespace"] for n in namespaces
        if not (n["defaultDenyIngress"] and n["defaultDenyEgress"])
    ]
    workloads_with_gaps = [w for w in workloads if w["gaps"]]

    return {
        "schemaVersion": 1,
        "sourceOfTruth": "dasomel/openforge#77 (docs/kubernetes-zero-trust-security-baseline.md), profile: production",
        "scope": "default helm template render of both charts; static declarations only, no live cluster",
        "charts": list(CHARTS),
        "summary": {
            "namespaces": len(namespaces),
            "namespacesWithoutDefaultDenyBoth": len(namespaces_without_default_deny),
            "namespacesWithoutDefaultDenyBothList": sorted(namespaces_without_default_deny),
            "workloadsScanned": len(workloads),
            "workloadsWithRuntimeGaps": len(workloads_with_gaps),
            "customWorkloadsNeedingManualReview": len(needs_manual_review),
            "nonClusterIpOrIngressExposures": len(exposures),
            "egressCandidateHostCount": len(egress),
        },
        "namespaces": namespaces,
        "workloadsWithGaps": workloads_with_gaps,
        "customWorkloadsNeedingManualReview": needs_manual_review,
        "exposures": exposures,
        "egressCandidateHosts": egress,
    }


def egress_preflight_errors(resources: list[dict], coverage: dict) -> list[str]:
    """Catch declared download commands stranded behind default-deny egress."""
    # D5: Rendering cannot prove rollout order, DNS resolution, image pulls, or
    # arbitrary runtime URLs. It can reject the known Maven/PyPI command pattern
    # when a namespace's egress deny is declared without matching Cilium FQDN
    # allows. The runbook must still stage and verify allows before activating deny.
    required: dict[str, set[str]] = {}
    for resource in resources:
        spec = pod_spec(resource)
        if not spec:
            continue
        ns = resource.get("metadata", {}).get("namespace", "default")
        if not coverage.get(ns, {}).get("defaultDenyEgress"):
            continue
        commands = " ".join(str(value) for container in
                            (spec.get("containers") or []) + (spec.get("initContainers") or [])
                            for field in ("command", "args") for value in container.get(field, []))
        if "repo1.maven.org" in commands:
            required.setdefault(ns, set()).add("repo1.maven.org")
        if re.search(r"\b(?:uv\s+)?pip\s+install\b", commands):
            required.setdefault(ns, set()).update(("pypi.org", "files.pythonhosted.org"))
    allowed: dict[str, set[str]] = {}
    for resource in resources:
        if resource.get("kind") != "CiliumNetworkPolicy":
            continue
        ns = resource.get("metadata", {}).get("namespace", "default")
        for rule in resource.get("spec", {}).get("egress", []):
            for destination in rule.get("toFQDNs", []):
                if destination.get("matchName"):
                    allowed.setdefault(ns, set()).add(destination["matchName"])
    return [f"namespace {ns}: missing FQDN egress allow for {host} before default-deny"
            for ns, hosts in sorted(required.items())
            for host in sorted(hosts - allowed.get(ns, set()))]


def gate_errors(report: dict, networkpolicy_baseline: set[str], resources: list[dict]) -> list[str]:
    """Fail on new static gaps and stale exceptions; preserve inventory detail."""
    errors = []
    namespaces = {n["namespace"]: n for n in report["namespaces"]}
    allowed_np = networkpolicy_baseline | EXTRA_DEFAULT_DENY_BASELINE
    actual_np = set(report["summary"]["namespacesWithoutDefaultDenyBothList"])
    for ns in sorted(actual_np - allowed_np):
        errors.append(f"namespace {ns}: missing full default-deny and absent from baseline")
    for ns in sorted(allowed_np - actual_np):
        errors.append(f"namespace {ns}: stale default-deny baseline entry")

    actual_psa = {ns for ns, n in namespaces.items() if any(
        n["podSecurityLabels"].get(f"pod-security.kubernetes.io/{mode}") != "restricted"
        for mode in ("enforce", "audit", "warn"))}
    for ns in sorted(actual_psa - PSA_BASELINE):
        errors.append(f"namespace {ns}: missing restricted PSA labels")
    for ns in sorted(PSA_BASELINE - actual_psa):
        errors.append(f"namespace {ns}: stale PSA baseline entry")

    actual_runtime = {(w["kind"], w["namespace"], w["name"]): set(w["gaps"])
                      for w in report["workloadsWithGaps"]}
    for key in sorted(actual_runtime.keys() | RUNTIME_BASELINE.keys()):
        new = actual_runtime.get(key, set()) - RUNTIME_BASELINE.get(key, set())
        stale = RUNTIME_BASELINE.get(key, set()) - actual_runtime.get(key, set())
        if new:
            errors.append(f"workload {key}: new runtime gaps: {sorted(new)}")
        if stale:
            errors.append(f"workload {key}: stale runtime baseline: {sorted(stale)}")

    services = {(e["namespace"], e["name"], e["serviceType"])
                for e in report["exposures"] if e["kind"] == "Service"}
    for service in sorted(services - SERVICE_BASELINE):
        errors.append(f"new non-ClusterIP Service: {service}")
    for service in sorted(SERVICE_BASELINE - services):
        errors.append(f"stale Service baseline: {service}")
    errors.extend(egress_preflight_errors(resources, network_policy_coverage(resources)))
    return errors


def strict_gap_count(report: dict) -> int:
    summary = report["summary"]
    return summary["namespacesWithoutDefaultDenyBoth"] + summary["workloadsWithRuntimeGaps"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--strict", action="store_true",
                        help="also exit 1 while any gap remains, even a baselined one (target-state check)")
    args = parser.parse_args(argv)

    resources: list[dict] = []
    manifests: dict[str, str] = {}
    for chart in CHARTS:
        try:
            manifest = render(chart)
        except subprocess.CalledProcessError as exc:
            print(f"FAIL: helm template {chart} exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
            return 1
        manifests[chart] = manifest
        try:
            resources.extend(documents(manifest, chart))
        except (ValueError, yaml.YAMLError) as exc:
            print(f"FAIL: {chart}: could not parse rendered manifest: {exc}", file=sys.stderr)
            return 1

    if not resources:
        print("FAIL: no resources rendered from either chart", file=sys.stderr)
        return 1

    try:
        baseline_doc = yaml.safe_load(NETWORKPOLICY_BASELINE.read_text(encoding="utf-8"))
        networkpolicy_baseline = {item["namespace"] for item in baseline_doc["namespaces"]}
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError) as exc:
        print(f"FAIL: cannot read NetworkPolicy baseline: {exc}", file=sys.stderr)
        return 1
    report = build_report(resources, manifests)
    errors = gate_errors(report, networkpolicy_baseline, resources)
    print(json.dumps(report, indent=2, sort_keys=True))
    print(
        f"\nSECURITY BASELINE: "
        f"{report['summary']['namespacesWithoutDefaultDenyBoth']}/{report['summary']['namespaces']} "
        f"namespaces missing full default-deny, "
        f"{report['summary']['workloadsWithRuntimeGaps']}/{report['summary']['workloadsScanned']} "
        f"workloads have a runtime-security gap, "
        f"{report['summary']['customWorkloadsNeedingManualReview']} operator-managed workloads need manual "
        f"review, {report['summary']['nonClusterIpOrIngressExposures']} non-ClusterIP exposure(s), "
        f"{report['summary']['egressCandidateHostCount']} candidate external hostname(s).",
        file=sys.stderr,
    )
    for error in errors:
        print(f"FAIL: {error}", file=sys.stderr)
    if args.strict and strict_gap_count(report):
        errors.append(f"--strict: {strict_gap_count(report)} gap(s) remain")
        print(f"FAIL: --strict: {strict_gap_count(report)} gap(s) remain", file=sys.stderr)
    if errors:
        return 1
    print("PASS: rendered security baseline ratchet", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
