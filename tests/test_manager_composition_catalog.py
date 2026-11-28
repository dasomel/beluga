"""Offline contract: Manager's "current composition" catalog names real workloads (D-MCOMP-1).

`manager/packages/web/src/views/platformComposition.ts` maps each platform component to the
`<namespace>` + `Kind/name` of the workloads that implement it. A typo there would not fail
any web test: the component would just read "not observed". This test checks every catalog
workload against what actually deploys it:
- workloads rendered by the beluga-platform / beluga-data charts (full profile), or
- workloads created by an operator for a CR the charts render (Flink, Strimzi), or
- workloads installed by `scripts/gitops/01-argocd-bootstrap.sh` (operators, Argo CD).
"""
from pathlib import Path
import re
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "manager/packages/web/src/views/platformComposition.ts"
FULL = ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]

# Workloads that exist only because of a rendered CR (operator-created) or the bootstrap script.
# Each entry names the evidence that must be present, so the allowlist cannot go stale silently.
OPERATOR_OR_BOOTSTRAP = {
    ("streaming", "Deployment/flink-cluster"): ("cr", "FlinkDeployment", "flink-cluster"),
    ("streaming", "Deployment/beluga-kafka-entity-operator"): ("cr", "Kafka", "beluga-kafka"),
    # bootstrap evidence: an install line for the component followed by its target namespace.
    ("streaming", "Deployment/strimzi-cluster-operator"): ("bootstrap", r"strimzi-cluster-operator-[0-9.]+\.yaml[\s\S]{0,300}?-n streaming"),
    ("streaming", "Deployment/flink-kubernetes-operator"): ("bootstrap", r"helm upgrade --install flink-kubernetes-operator[\s\S]{0,300}?--namespace streaming"),
    ("argocd", "Deployment/argocd-server"): ("bootstrap", r"argoproj/argo-cd/[^/]+/manifests/install\.yaml[\s\S]{0,200}?kubectl apply[^\n]*-n argocd"),
    ("argocd", "StatefulSet/argocd-application-controller"): ("bootstrap", r"argoproj/argo-cd/[^/]+/manifests/install\.yaml[\s\S]{0,200}?kubectl apply[^\n]*-n argocd"),
    ("argocd", "Deployment/argocd-repo-server"): ("bootstrap", r"argoproj/argo-cd/[^/]+/manifests/install\.yaml[\s\S]{0,200}?kubectl apply[^\n]*-n argocd"),
}


def catalog_entries():
    source = CATALOG.read_text()
    block = source[source.index("export const COMPOSITION_COMPONENTS"):source.index("export const COMPOSITION_FLOWS")]
    entries = []
    for line in block.splitlines():
        if "{ id: '" not in line:
            continue
        cid = re.search(r"id: '([^']+)'", line).group(1)
        namespace = re.search(r"namespace: '([^']+)'", line).group(1)
        workloads = re.findall(r"'((?:Deployment|StatefulSet)/[^']+)'", re.search(r"workloads: \[([^\]]*)\]", line).group(1))
        entries.append((cid, namespace, workloads))
    assert len(entries) >= 15, f"catalog parse found only {len(entries)} entries"
    return entries


def render(chart):
    out = subprocess.run(["helm", "template", str(ROOT / "gitops/charts" / chart), *FULL], capture_output=True, text=True, check=True).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def main():
    docs = render("beluga-platform") + render("beluga-data")
    rendered = {(d["metadata"].get("namespace"), f"{d['kind']}/{d['metadata']['name']}") for d in docs if d["kind"] in ("Deployment", "StatefulSet")}
    crs = {(d["kind"], d["metadata"]["name"]) for d in docs}
    bootstrap = (ROOT / "scripts/gitops/01-argocd-bootstrap.sh").read_text()
    checked = 0
    for cid, namespace, workloads in catalog_entries():
        for ref in workloads:
            key = (namespace, ref)
            if key in rendered:
                checked += 1
                continue
            evidence = OPERATOR_OR_BOOTSTRAP.get(key)
            assert evidence, f"composition component {cid}: {namespace}/{ref} is neither rendered by the charts nor allowlisted"
            if evidence[0] == "cr":
                assert (evidence[1], evidence[2]) in crs, f"{cid}: allowlisted via {evidence[1]}/{evidence[2]}, which the charts no longer render"
            else:
                assert re.search(evidence[1], bootstrap), f"{cid}: bootstrap install of {namespace}/{ref} not found in 01-argocd-bootstrap.sh"
            checked += 1
    print(f"PASS: {checked} composition workloads map to rendered charts, rendered CRs or the bootstrap script")


if __name__ == "__main__":
    main()
