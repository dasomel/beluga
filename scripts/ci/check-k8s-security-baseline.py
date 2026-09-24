#!/usr/bin/env python3
"""Read-only Kubernetes security baseline inventory (Issue #125).

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

This is an inventory report against dasomel/openforge#77's production profile,
not a pass/fail gate: the repository has not adopted the baseline yet (that is
the point of the associated Change Package,
docs/change/125-k8s-security-baseline/CHANGE.md), so `main()` exits non-zero
only on a structural failure (chart fails to render, a document cannot be
parsed) and exits 0 while still printing every gap it found. It does not talk
to a live cluster, a host firewall, an LSM, or a service mesh, and it cannot
see egress destinations that are only assembled at runtime (e.g. built from a
Secret/ConfigMap value) — see the per-function docstrings/comments below for
the specific heuristics and their known false-positive/false-negative shapes.

Not wired into `make lint`/`make validate`: unlike the other scripts/ci/*.py
gates, this one is expected to report real gaps today, so making it part of
the enforcement path would either fail CI on unimplemented work or require
suppressing genuine findings. Run it directly:

    python3 scripts/ci/check-k8s-security-baseline.py
"""
from __future__ import annotations

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
    return {
        "name": container.get("name"),
        "init": init,
        "runAsNonRoot": run_as_non_root is True,
        "allowPrivilegeEscalation": sc.get("allowPrivilegeEscalation"),
        "allowPrivilegeEscalationDenied": sc.get("allowPrivilegeEscalation") is False,
        "readOnlyRootFilesystem": sc.get("readOnlyRootFilesystem") is True,
        "seccompRuntimeDefault": seccomp.get("type") in ("RuntimeDefault", "Localhost"),
        "capabilitiesDropAll": "ALL" in drops,
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
        is_all_pods = spec.get("podSelector") == {}
        types = set(spec.get("policyTypes") or [])
        if is_all_pods and "Ingress" in types and not spec.get("ingress"):
            entry["defaultDenyIngress"] = True
        if is_all_pods and "Egress" in types and not spec.get("egress"):
            entry["defaultDenyEgress"] = True
    return coverage


def namespace_inventory(resources: list[dict], np_coverage: dict) -> list[dict]:
    namespaces = []
    for resource in resources:
        if resource.get("kind") != "Namespace":
            continue
        name = resource.get("metadata", {}).get("name")
        labels = resource.get("metadata", {}).get("labels", {}) or {}
        cov = np_coverage.get(name, {"policies": [], "defaultDenyIngress": False, "defaultDenyEgress": False})
        namespaces.append({
            "chart": resource["_chart"],
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


def main() -> int:
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

    report = build_report(resources, manifests)
    print(json.dumps(report, indent=2, sort_keys=True))
    print(
        f"\nINVENTORY (read-only, not a gate): "
        f"{report['summary']['namespacesWithoutDefaultDenyBoth']}/{report['summary']['namespaces']} "
        f"namespaces missing full default-deny, "
        f"{report['summary']['workloadsWithRuntimeGaps']}/{report['summary']['workloadsScanned']} "
        f"workloads have a runtime-security gap, "
        f"{report['summary']['customWorkloadsNeedingManualReview']} operator-managed workloads need manual "
        f"review, {report['summary']['nonClusterIpOrIngressExposures']} non-ClusterIP exposure(s), "
        f"{report['summary']['egressCandidateHostCount']} candidate external hostname(s).",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
