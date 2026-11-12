#!/usr/bin/env python3
"""Rendered Kubernetes security baseline ratchet and inventory (Issue #125).

Renders both charts the same way `make validate` does (KUBECONFIG=/dev/null,
default values) and statically reports, without mutating anything:
Storage bounds additionally cover profile-full, sso and profile-full+sso renders,
CNPG/Flink CR inputs and chart-owned namespace LimitRange defaults/order. CRD
acceptance and operator-generated Pod resources still require live confirmation.

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
import copy
import json
import os
import re
import subprocess
import sys
from decimal import Decimal
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
# argocd (D-MSSO-16): bootstrap-owned, the chart renders only a get-only Role/RoleBinding there (no workload),
# so it appears as a referenced namespace; its policy/PSA rollout belongs to the bootstrap, not this chart.
EXTRA_DEFAULT_DENY_BASELINE = {"cert-manager", "argocd"}

# D2: Pin current pre-rollout gaps by (kind, namespace, name) and exact
# container set. The extra kind key prevents same-name workload collisions;
# remove it only if an equivalent identity check replaces this ratchet.
# Runtime hardening needs a live rollout (T-012); existing gaps are not approval.
NONROOT_RO_GAPS = {"runAsNonRoot not true", "readOnlyRootFilesystem not true"}
RUNTIME_BASELINE = {
    # 이슈 #117: seccomp/allowPrivilegeEscalation/drop ALL과 readOnlyRootFilesystem은 적용 완료 —
    # 남은 것은 이미지 UID 확인이 필요한 runAsNonRoot뿐(superset install-authlib는 root + drop ALL 갭).
    ("Deployment", "orchestration", "airflow-webserver"): {
        f"container {name}: runAsNonRoot not true" for name in ("airflow", "build-ca-bundle (init)")
    },
    ("Deployment", "analytics", "superset"): {
        f"container {name}: runAsNonRoot not true"
        for name in ("superset", "install-authlib (init)", "build-ca-bundle (init)")
    } | {"container install-authlib (init): capabilities.drop does not include ALL"},
    # #125 T-012: runAsNonRoot(9999=이미지의 flink) 해소, #117: readOnlyRootFilesystem도 적용 — 갭 없음.
}

# D3: Namespace PSA labels are currently absent everywhere; the frozen set
# prevents new unlabeled namespaces and becomes stale as labels are added.
PSA_BASELINE = frozenset({"platform-system", "iam", "cert-manager", "database", "storage",
                          "streaming", "lakehouse", "analytics", "orchestration", "governance", "argocd"})

# D4: Only the documented APISIX gateway is an accepted direct Service.
# The grafana-external NodePort debt (T-014) was removed by issue #366 (ClusterIP `grafana` behind the gateway).
SERVICE_BASELINE = {("platform-system", "apisix-gateway", "LoadBalancer")}

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
INTERNAL_HOST_SUFFIXES = (".svc.cluster.local", ".svc", ".local.beluga.internal", ".kakao.beluga.internal")
INTERNAL_HOST_EXACT = {"localhost", "127.0.0.1", "kubernetes.default"}

URL_RE = re.compile(r"https?://([A-Za-z0-9_.-]+)(?::\d+)?")


def render(chart: str, extra_args: tuple[str, ...] = ()) -> str:
    result = subprocess.run(
        ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart), *extra_args],
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


def storage_bytes(value) -> Decimal:
    """Kubernetes storage quantity; reject absent, negative or malformed declarations."""
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]|[eE][+-]?[0-9]+)?",
                         str(value), re.ASCII)
    if not match:
        return Decimal(0)
    number, suffix = Decimal(match[1]), match[2] or ""
    if suffix.endswith("i"):
        return number * 1024 ** (("Ki", "Mi", "Gi", "Ti", "Pi", "Ei").index(suffix) + 1)
    if re.fullmatch(r"[eE][+-]?[0-9]+", suffix):
        return number * Decimal(10) ** int(suffix[1:])
    exponent = {"n": -9, "u": -6, "m": -3, "k": 3, "M": 6, "G": 9,
                "T": 12, "P": 15, "E": 18}.get(suffix, 0)
    return number * Decimal(10) ** exponent


def storage_errors(resources: list[dict]) -> list[str]:
    """Fail closed on disk emptyDir and per-container storage declarations, including Jobs."""
    # D-ES-CHECK-1 (#403): inspect every standard PodSpec and init container, not
    # just Connect; cost: all profiles must render; escape hatch: update budgets
    # from measurements, never baseline an unbounded volume. Memory is charged
    # to RAM and exempt here. This declaration gate cannot prove kubelet eviction.
    errors = []
    for resource in resources:
        pod = pod_spec(resource)
        if pod is None:
            continue
        meta = resource.get("metadata", {})
        label = f"{resource['kind']}/{meta.get('namespace', 'default')}/{meta.get('name')}"
        disk_volumes = [v for v in pod.get("volumes") or []
                        if "emptyDir" in v and (v["emptyDir"] or {}).get("medium") != "Memory"]
        for volume in disk_volumes:
            if storage_bytes((volume["emptyDir"] or {}).get("sizeLimit")) <= 0:
                errors.append(f"{label}: emptyDir {volume.get('name')} needs positive sizeLimit")
        if not disk_volumes:
            continue
        for container in (pod.get("initContainers") or []) + (pod.get("containers") or []):
            res = container.get("resources") or {}
            request = storage_bytes((res.get("requests") or {}).get("ephemeral-storage"))
            limit = storage_bytes((res.get("limits") or {}).get("ephemeral-storage"))
            if request <= 0 or limit <= 0 or request > limit:
                errors.append(f"{label}/{container.get('name')}: positive ephemeral-storage "
                              "request <= limit required")
    return errors


# D-ES-CHECK-2: only these charts' workload namespaces receive admission defaults.
# Cost: explicit ownership inventory; escape hatch: update with namespace ownership changes.
OWNED_NAMESPACES = {
    "beluga-platform": {"platform-system", "iam"},
    "beluga-data": {"database", "storage", "streaming", "lakehouse", "analytics",
                    "orchestration", "governance"},
}
EXCLUDED_STORAGE_NAMESPACES = {"argocd", "metallb-system", "cilium", "cert-manager",
                               "cnpg-system", "kube-system"}
WAVE = "argocd.argoproj.io/sync-wave"


def resource_storage_errors(res: dict, label: str) -> list[str]:
    request = storage_bytes((res.get("requests") or {}).get("ephemeral-storage"))
    limit = storage_bytes((res.get("limits") or {}).get("ephemeral-storage"))
    return ([f"{label}: positive ephemeral-storage request <= limit required"]
            if request <= 0 or limit <= 0 or request > limit else [])


def operator_storage_errors(resources: list[dict]) -> list[str]:
    """Check declared CR inputs, without claiming generated Pod/CRD validation."""
    errors = []
    for resource in resources:
        kind, spec = resource.get("kind"), resource.get("spec", {})
        label = f"{kind}/{resource.get('metadata', {}).get('name')}"
        if kind == "Cluster" and resource.get("apiVersion", "").startswith("postgresql.cnpg.io/"):
            errors.extend(resource_storage_errors(spec.get("resources") or {}, label))
            volumes = spec.get("ephemeralVolumesSizeLimit") or {}
            for name in ("shm", "temporaryData"):
                if storage_bytes(volumes.get(name)) <= 0:
                    errors.append(f"{label}: positive ephemeralVolumesSizeLimit.{name} required")
            if storage_bytes(volumes.get("shm")) < storage_bytes(
                    (spec.get("resources", {}).get("limits") or {}).get("memory")):
                errors.append(f"{label}: shm must allow the container memory limit for parallel queries")
            if storage_bytes(volumes.get("temporaryData")) > storage_bytes(
                    (spec.get("resources", {}).get("limits") or {}).get("ephemeral-storage")):
                errors.append(f"{label}: temporaryData exceeds container storage limit")
        if kind != "FlinkDeployment":
            continue
        templates = [("shared", spec.get("podTemplate") or {})]
        templates += [(role, spec[role]["podTemplate"]) for role in ("jobManager", "taskManager")
                      if "podTemplate" in (spec.get(role) or {})]
        for role, template in templates:
            pod = template.get("spec") or {}
            main = next((c for c in pod.get("containers") or []
                         if c.get("name") == "flink-main-container"), None)
            if main is None:
                errors.append(f"{label}/{role}: flink-main-container required")
                continue
            errors.extend(resource_storage_errors(main.get("resources") or {}, f"{label}/{role}"))
            # Reuse disk volume/init-container checks even when the current CR declares no volumes.
            synthetic = {"kind": "Deployment", "metadata": {"name": f"{label}/{role}"},
                         "spec": {"template": {"spec": pod}}}
            errors.extend(storage_errors([synthetic]))
    return errors


def limitrange_errors(resources: list[dict]) -> list[str]:
    errors = []
    for chart, owned in OWNED_NAMESPACES.items():
        docs = [r for r in resources if r.get("_chart") == chart]
        namespaces = {r["metadata"]["name"]: r for r in docs if r.get("kind") == "Namespace"}
        for ns in sorted(owned):
            ranges = [r for r in docs if r.get("kind") == "LimitRange"
                      and r.get("metadata", {}).get("namespace") == ns]
            if len(ranges) != 1:
                errors.append(f"{chart}/{ns}: expected exactly one storage LimitRange")
                continue
            lr = ranges[0]
            limits = lr.get("spec", {}).get("limits") or []
            expected = [{"type": "Container", "default": {"ephemeral-storage": "1Gi"},
                         "defaultRequest": {"ephemeral-storage": "32Mi"}}]
            if limits != expected:
                errors.append(f"{chart}/{ns}: LimitRange must have only storage defaults 32Mi/1Gi")
            wave = int(lr["metadata"].get("annotations", {}).get(WAVE, 0))
            namespace = namespaces.get(ns)
            if namespace is None or int(namespace["metadata"].get("annotations", {}).get(WAVE, 0)) >= wave:
                errors.append(f"{chart}/{ns}: Namespace must precede LimitRange")
            workloads = [r for r in docs if r.get("metadata", {}).get("namespace") == ns
                         and r.get("kind") in POD_TEMPLATE_KINDS + CUSTOM_WORKLOAD_KINDS]
            if any(int(r["metadata"].get("annotations", {}).get(WAVE, 0)) <= wave for r in workloads):
                errors.append(f"{chart}/{ns}: LimitRange must precede workloads/hooks")
    for r in resources:
        if r.get("kind") != "LimitRange":
            continue
        ns = r.get("metadata", {}).get("namespace")
        if ns in EXCLUDED_STORAGE_NAMESPACES or ns not in OWNED_NAMESPACES.get(r.get("_chart"), set()):
            errors.append(f"{ns}: LimitRange outside chart namespace ownership")
    return errors


def operator_storage_self_test() -> None:
    res = {"requests": {"ephemeral-storage": "64Mi"},
           "limits": {"ephemeral-storage": "1280Mi", "memory": "512Mi"}}
    cluster = {"kind": "Cluster", "apiVersion": "postgresql.cnpg.io/v1", "spec": {
        "resources": res, "ephemeralVolumesSizeLimit": {"shm": "512Mi", "temporaryData": "1Gi"}}}
    pod = {"spec": {"containers": [{"name": "flink-main-container", "resources": res}],
                    "volumes": [{"name": "scratch", "emptyDir": {"sizeLimit": "1Gi"}}]}}
    flink = {"kind": "FlinkDeployment", "spec": {"podTemplate": pod,
             "jobManager": {"podTemplate": pod}, "taskManager": {"podTemplate": pod}}}
    if operator_storage_errors([cluster, flink]):
        raise AssertionError("bounded CR fixtures rejected")
    mutations = [
        (cluster, ("spec", "ephemeralVolumesSizeLimit", "shm"), None),
        (cluster, ("spec", "ephemeralVolumesSizeLimit", "shm"), "64Mi"),
        (cluster, ("spec", "ephemeralVolumesSizeLimit", "temporaryData"), "0"),
        (cluster, ("spec", "ephemeralVolumesSizeLimit", "temporaryData"), "2Gi"),
        (cluster, ("spec", "resources", "requests", "ephemeral-storage"), None),
        (cluster, ("spec", "resources", "limits", "ephemeral-storage"), "0"),
        (flink, ("spec", "podTemplate"), None),
        (flink, ("spec", "podTemplate", "spec", "volumes", 0, "emptyDir", "sizeLimit"), None),
    ]
    for role in (None, "jobManager", "taskManager"):
        prefix = ("spec",) + ((role,) if role else ()) + ("podTemplate", "spec", "containers", 0, "resources")
        mutations.extend((flink, prefix + (section, "ephemeral-storage"), value)
                         for section, value in (("requests", None), ("limits", "0"), ("requests", "2Gi")))
    for fixture, path, value in mutations:
        bad = copy.deepcopy(fixture)
        target = bad
        for key in path[:-1]:
            target = target[key]
        if value is None:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        if not operator_storage_errors([bad]):
            raise AssertionError(f"invalid CR fixture accepted: {path}")
    fixtures = []
    for chart, owned in OWNED_NAMESPACES.items():
        for ns in owned:
            fixtures += [
                {"_chart": chart, "kind": "Namespace", "metadata": {"name": ns, "annotations": {WAVE: "-5"}}},
                {"_chart": chart, "kind": "LimitRange", "metadata": {"namespace": ns, "annotations": {WAVE: "-4"}},
                 "spec": {"limits": [{"type": "Container", "default": {"ephemeral-storage": "1Gi"},
                                      "defaultRequest": {"ephemeral-storage": "32Mi"}}]}},
                {"_chart": chart, "kind": "Job", "metadata": {"namespace": ns, "annotations": {WAVE: "-2"}}},
            ]
    if limitrange_errors(fixtures):
        raise AssertionError("valid namespace/default/order fixtures rejected")
    for i, fixture in enumerate(fixtures):
        if fixture["kind"] != "LimitRange":
            continue
        for mutation in ("missing", "cpu", "late", "early", "duplicate"):
            bad = copy.deepcopy(fixtures)
            if mutation == "missing":
                del bad[i]
            elif mutation == "duplicate":
                bad.append(copy.deepcopy(bad[i]))
            elif mutation == "cpu":
                bad[i]["spec"]["limits"][0]["default"]["cpu"] = "1"
            else:
                bad[i]["metadata"]["annotations"][WAVE] = "-2" if mutation == "late" else "-5"
            if not limitrange_errors(bad):
                raise AssertionError(f"invalid LimitRange fixture accepted: {mutation}")
    for ns in EXCLUDED_STORAGE_NAMESPACES | {"new-unowned"}:
        if not limitrange_errors(fixtures + [{"kind": "LimitRange", "_chart": "beluga-data",
                                             "metadata": {"namespace": ns}}]):
            raise AssertionError(f"excluded namespace accepted: {ns}")
    print("PASS: CR storage and namespace LimitRange self-tests (bounds, overrides, ownership, ordering)",
          file=sys.stderr)


def connect_storage_errors(resources: list[dict]) -> list[str]:
    """Keep the incident-specific mount contract as well as the general bounds."""
    deployments = [r for r in resources if r.get("kind") == "Deployment"
                   and r.get("metadata", {}).get("namespace") == "streaming"
                   and r.get("metadata", {}).get("name") == "debezium-connect"]
    if len(deployments) != 1:
        return ["debezium-connect: expected exactly one streaming Deployment"]
    pod = pod_spec(deployments[0]) or {}
    errors = storage_errors(deployments)
    scratch = {v.get("name") for v in pod.get("volumes") or []
               if "emptyDir" in v and (v["emptyDir"] or {}).get("medium") != "Memory"}
    if not {"kafka-logs", "tmp"} <= scratch:
        errors.append("debezium-connect: kafka-logs and tmp must be bounded disk emptyDirs")
    connect = next((c for c in pod.get("containers") or [] if c.get("name") == "connect"), None)
    if connect is None:
        errors.append("debezium-connect: connect container missing")
    elif not any(m.get("name") == "kafka-logs" and m.get("mountPath") == "/kafka/logs"
                 for m in connect.get("volumeMounts") or []):
        errors.append("debezium-connect/connect: kafka-logs volume must mount at /kafka/logs")
    return errors


def connect_storage_self_test() -> None:
    fixture = yaml.safe_load("""
kind: Deployment
metadata: {name: debezium-connect, namespace: streaming}
spec:
  template:
    spec:
      containers:
        - name: connect
          resources:
            requests: {ephemeral-storage: 128Mi}
            limits: {ephemeral-storage: 512Mi}
          volumeMounts:
            - {name: kafka-logs, mountPath: /kafka/logs}
      volumes:
        - {name: kafka-logs, emptyDir: {sizeLimit: 256Mi}}
        - {name: tmp, emptyDir: {sizeLimit: 128Mi}}
""")
    if connect_storage_errors([fixture]) or not connect_storage_errors([]):
        raise AssertionError("Connect storage positive/missing Deployment fixture failed")
    cases = [
        ("volumes", 0, "emptyDir", "sizeLimit", None),
        ("volumes", 1, "emptyDir", "sizeLimit", "0Mi"),
        ("volumes", 1, "emptyDir", "sizeLimit", "-1Mi"),
        ("containers", 0, "resources", "limits", "ephemeral-storage", None),
        ("containers", 0, "resources", "limits", "ephemeral-storage", "0"),
        ("containers", 0, "resources", "requests", "ephemeral-storage", None),
        ("containers", 0, "resources", "requests", "ephemeral-storage", "1Gi"),
        ("containers", 0, "volumeMounts", None),
        ("containers", 0, "volumeMounts", 0, "mountPath", "/tmp"),
    ]
    for *path, value in cases:
        bad = copy.deepcopy(fixture)
        target = pod_spec(bad)
        for key in path[:-1]:
            target = target[key]
        if value is None:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        if not connect_storage_errors([bad]):
            raise AssertionError(f"Connect storage negative fixture accepted: {path}")
    bad = copy.deepcopy(fixture)
    pod_spec(bad)["volumes"].append({"name": "new-scratch", "emptyDir": {}})
    if not connect_storage_errors([bad]):
        raise AssertionError("Connect storage new unbounded emptyDir fixture accepted")
    print("PASS: Connect storage self-test (1 positive, 10 negative fixtures)", file=sys.stderr)


def storage_self_test() -> None:
    fixture = yaml.safe_load("""
kind: Deployment
metadata: {name: storage-fixture, namespace: fixture}
spec:
  template:
    spec:
      containers:
        - name: main
          resources:
            requests: {ephemeral-storage: 16Mi}
            limits: {ephemeral-storage: 256Mi}
          volumeMounts: [{name: tmp, mountPath: /tmp}]
      volumes: [{name: tmp, emptyDir: {sizeLimit: 64Mi}}]
""")
    positives = negatives = 0
    for kind in POD_TEMPLATE_KINDS:
        resource = copy.deepcopy(fixture)
        resource["kind"] = kind
        if kind == "CronJob":
            resource["spec"] = {"jobTemplate": {"spec": resource["spec"]}}
        if storage_errors([resource]):
            raise AssertionError(f"{kind}: bounded fixture rejected")
        positives += 1
        pod = pod_spec(resource)
        for invalid in (None, "0Mi", "-1Mi", "bad"):
            bad = copy.deepcopy(resource)
            pod_spec(bad)["volumes"][0]["emptyDir"] = {} if invalid is None else {"sizeLimit": invalid}
            if not storage_errors([bad]):
                raise AssertionError(f"{kind}: unbounded/invalid sizeLimit accepted: {invalid}")
            negatives += 1
        memory = copy.deepcopy(resource)
        pod_spec(memory)["volumes"][0]["emptyDir"] = {"medium": "Memory"}
        del pod_spec(memory)["containers"][0]["resources"]
        if storage_errors([memory]):
            raise AssertionError(f"{kind}: Memory-only fixture rejected")
        positives += 1
        # Both main and init writers must have valid request/limit pairs.
        pod["initContainers"] = [copy.deepcopy(pod["containers"][0])]
        for key in ("containers", "initContainers"):
            for section, value in (("limits", None), ("requests", None),
                                   ("limits", "0"), ("requests", "1Gi")):
                bad = copy.deepcopy(resource)
                res = pod_spec(bad)[key][0]["resources"][section]
                if value is None:
                    del res["ephemeral-storage"]
                else:
                    res["ephemeral-storage"] = value
                if not storage_errors([bad]):
                    raise AssertionError(f"{kind}/{key}: invalid {section} accepted: {value}")
                negatives += 1
        mixed = copy.deepcopy(resource)
        pod_spec(mixed)["volumes"].append({"name": "shm", "emptyDir": {"medium": "Memory"}})
        if storage_errors([mixed]):
            raise AssertionError(f"{kind}: mixed disk/Memory fixture rejected")
        positives += 1
    for value, expected in (("1.5Gi", 1610612736), ("2G", 2000000000),
                            ("1e6", 1000000), ("1048576", 1048576)):
        if storage_bytes(value) != expected:
            raise AssertionError(f"storage quantity {value} parsed incorrectly")
    print(f"PASS: workload storage self-test ({positives} positive, {negatives} negative fixtures)",
          file=sys.stderr)


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
    errors.extend(storage_errors(resources))
    errors.extend(operator_storage_errors(resources))
    errors.extend(limitrange_errors(resources))
    errors.extend(connect_storage_errors(resources))
    return errors


def strict_gap_count(report: dict) -> int:
    summary = report["summary"]
    return summary["namespacesWithoutDefaultDenyBoth"] + summary["workloadsWithRuntimeGaps"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--strict", action="store_true",
                        help="also exit 1 while any gap remains, even a baselined one (target-state check)")
    args = parser.parse_args(argv)

    connect_storage_self_test()
    storage_self_test()
    operator_storage_self_test()

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
    storage_profiles = {
        "sso": ("-f", str(REPO_ROOT / "gitops/values/sso.yaml")),
        "full": ("-f", str(REPO_ROOT / "gitops/values/profile-full.yaml")),
        "full+sso": ("-f", str(REPO_ROOT / "gitops/values/profile-full.yaml"),
                     "-f", str(REPO_ROOT / "gitops/values/sso.yaml")),
    }
    profile_errors = []
    for profile, values in storage_profiles.items():
        try:
            rendered = [r for chart in CHARTS for r in documents(render(chart, values), chart)]
        except (subprocess.CalledProcessError, ValueError, yaml.YAMLError) as exc:
            print(f"FAIL: storage profile {profile}: {exc}", file=sys.stderr)
            return 1
        profile_errors.extend(f"{profile}: {error}" for error in
                              storage_errors(rendered) + connect_storage_errors(rendered)
                              + operator_storage_errors(rendered) + limitrange_errors(rendered))
    report = build_report(resources, manifests)
    errors = gate_errors(report, networkpolicy_baseline, resources) + profile_errors
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
