#!/usr/bin/env python3
"""Generate and drift-check declared-state platform asset inventory (Issue #42).

Emits structured operational asset records (workloads, custom resources,
container images cross-referenced with VERSIONS.md, and PVCs / storage assets)
from `helm template` of both charts (beluga-platform, beluga-data) with KUBECONFIG=/dev/null.

This inventory covers declared-state assets only and does not query live cluster state.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML is required; install the pinned CI requirements", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[1]
CHARTS = ("beluga-platform", "beluga-data")
# D1: Render the deployment profile and each independent Strimzi gate, plus
# their combined state. Extra Helm calls cost time; add profiles here when a
# new values gate affects asset identity.
PROFILES = {
    "default": [],
    "48GB+": ["--set", "openmetadata.enabled=true", "--set", "trino.workerEnabled=true"],
    "oauth": ["--set", "strimzi.oauthListener=true"],
    "acl": ["--set", "strimzi.aclAuthorizer=true"],
    "external": ["--set", "strimzi.externalListenerEnabled=true"],
    "all-enabled": ["--set", "openmetadata.enabled=true", "--set", "trino.workerEnabled=true",
                    "--set", "strimzi.oauthListener=true", "--set", "strimzi.aclAuthorizer=true",
                    "--set", "strimzi.externalListenerEnabled=true"],
}
DOC_EN = REPO_ROOT / "docs" / "platform-asset-inventory.md"
DOC_KO = REPO_ROOT / "docs" / "platform-asset-inventory-ko.md"
VERSIONS_PATH = REPO_ROOT / "VERSIONS.md"

IMAGE_ROW_RE = re.compile(r"`([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)`")


def render_chart(chart: str, extra_args: list[str] | None = None) -> list[dict]:
    """Render a Helm chart with KUBECONFIG=/dev/null and parse documents with source annotations."""
    command = ["helm", "template", chart, str(REPO_ROOT / "gitops" / "charts" / chart)]
    if extra_args:
        command.extend(extra_args)
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    docs = []
    current_source = f"{chart}/templates"
    for block in result.stdout.split("\n---"):
        source_match = re.search(r"# Source:\s*([^\n]+)", block)
        if source_match:
            current_source = source_match.group(1).strip()
        parsed = yaml.safe_load(block)
        if parsed and isinstance(parsed, dict) and "kind" in parsed:
            parsed["_chart"] = chart
            parsed["_source"] = current_source
            docs.append(parsed)
    return docs


def parse_versions(path: Path) -> dict[str, dict[str, str]]:
    """Parse component version metadata and image mappings from VERSIONS.md."""
    versions = {}
    if not path.is_file():
        return versions

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or cells[0] in ("컴포넌트", "") or set(cells[0]) <= {"-", ":"}:
            continue
        if set(cells[1]) <= {"-", ":"}:
            continue

        component = cells[0]
        version_cell = cells[1]
        license_cell = cells[3]
        notes_cell = cells[4] if len(cells) > 4 else ""

        matches = list(IMAGE_ROW_RE.finditer(cells[2] + " " + notes_cell))
        for index, match in enumerate(matches):
            # Notes may mention another component's image (Flink runtime in the
            # operator row). Only a compatible tag can inherit this row's pin.
            tag = match.group(2)
            if tag != version_cell and not tag.startswith(version_cell + "-"):
                continue
            row_comp = "Flink Runtime" if component == "Flink K8s Operator" and index else component
            image_tag = f"{match.group(1)}:{match.group(2)}"
            versions[image_tag] = {
                "component": row_comp,
                "version": version_cell,
                "repo": match.group(1),
                "tag": match.group(2),
                "license": license_cell,
                "notes": notes_cell,
            }
    return versions


def extract_workload_images(resource: dict) -> list[str]:
    """Extract all container images from standard Pod templates or custom workload specs."""
    images = []
    spec = resource.get("spec", {})
    if resource.get("kind") == "CronJob":
        pod_spec = spec.get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec", {})
        for container in pod_spec.get("initContainers", []) + pod_spec.get("containers", []):
            if "image" in container:
                images.append(container["image"])
    elif "template" in spec:
        pod_spec = spec["template"].get("spec", {})
        for container in pod_spec.get("initContainers", []) + pod_spec.get("containers", []):
            if "image" in container:
                images.append(container["image"])
    elif resource.get("kind") == "FlinkDeployment":
        if spec.get("image"):
            images.append(spec["image"])
    elif resource.get("kind") == "Cluster":
        if spec.get("imageName"):
            images.append(spec["imageName"])
    return images


def extract_workloads(documents: list[dict]) -> list[dict]:
    """Inventory all declared workloads (Deployments, StatefulSets, Jobs, CronJobs, FlinkDeployment)."""
    workloads = []
    workload_kinds = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "FlinkDeployment"}

    for doc in documents:
        kind = doc.get("kind")
        if kind not in workload_kinds:
            continue

        meta = doc.get("metadata", {})
        name = meta.get("name", "unnamed")
        namespace = meta.get("namespace", "default")
        spec = doc.get("spec", {})
        chart = doc.get("_chart", "unknown")
        source = doc.get("_source", "")

        replicas = "1"
        if kind == "Deployment" or kind == "StatefulSet":
            replicas = str(spec.get("replicas", 1))
        elif kind == "Job":
            replicas = "Run-to-completion (1)"
        elif kind == "FlinkDeployment":
            replicas = "Operator-managed (JobManager + TaskManager)"

        images = list(dict.fromkeys(extract_workload_images(doc)))

        workloads.append({
            "id": f"{kind}/{namespace}/{name}",
            "name": name,
            "kind": kind,
            "namespace": namespace,
            "chart": chart,
            "replicas": replicas,
            "images": images,
            "source": source,
        })

    return sorted(workloads, key=lambda w: (w["namespace"], w["kind"], w["name"]))


def extract_custom_resources(documents: list[dict]) -> list[dict]:
    """Inventory all declared Kubernetes custom resources (CRDs)."""
    custom_kinds = {
        "ApisixGlobalRule": ("apisix.apache.org/v2", "APISIX Ingress Controller"),
        "ApisixRoute": ("apisix.apache.org/v2", "APISIX Ingress Controller"),
        "ApisixTls": ("apisix.apache.org/v2", "APISIX Ingress Controller"),
        "ApisixUpstream": ("apisix.apache.org/v2", "APISIX Ingress Controller"),
        "Certificate": ("cert-manager.io/v1", "cert-manager"),
        "ClusterIssuer": ("cert-manager.io/v1", "cert-manager"),
        "Cluster": ("postgresql.cnpg.io/v1", "CloudNativePG Operator"),
        "ScheduledBackup": ("postgresql.cnpg.io/v1", "CloudNativePG Operator"),
        "Kafka": ("kafka.strimzi.io/v1", "Strimzi Kafka Operator"),
        "KafkaNodePool": ("kafka.strimzi.io/v1", "Strimzi Kafka Operator"),
        "KafkaUser": ("kafka.strimzi.io/v1", "Strimzi Kafka Operator"),
        "FlinkDeployment": ("flink.apache.org/v1beta1", "Flink Kubernetes Operator"),
    }
    core_groups = {"", "apps", "batch", "networking.k8s.io", "rbac.authorization.k8s.io",
                   "policy", "storage.k8s.io", "coordination.k8s.io", "autoscaling",
                   "admissionregistration.k8s.io", "apiextensions.k8s.io", "scheduling.k8s.io"}

    custom_resources = []
    for doc in documents:
        kind = doc.get("kind")
        api_version = doc.get("apiVersion", "v1")
        api_group = api_version.split("/", 1)[0] if "/" in api_version else ""
        if api_group in core_groups:
            continue

        meta = doc.get("metadata", {})
        name = meta.get("name", "unnamed")
        namespace = meta.get("namespace", "cluster-scoped" if kind == "ClusterIssuer" else "default")
        _, operator = custom_kinds.get(kind, (api_version, f"Uncategorized ({api_group})"))
        chart = doc.get("_chart", "unknown")
        source = doc.get("_source", "")

        custom_resources.append({
            "id": f"{kind}/{namespace}/{name}",
            "name": name,
            "kind": kind,
            "apiVersion": api_version,
            "namespace": namespace,
            "operator": operator,
            "chart": chart,
            "source": source,
        })

    return sorted(custom_resources, key=lambda c: (c["namespace"], c["kind"], c["name"]))


def extract_image_inventory(documents: list[dict], versions: dict[str, dict[str, str]]) -> list[dict]:
    """Inventory unique images across declared resources and cross-reference with VERSIONS.md."""
    image_usage: dict[str, dict] = {}

    for doc in documents:
        images = extract_workload_images(doc)
        kind = doc.get("kind")
        meta = doc.get("metadata", {})
        name = meta.get("name", "unnamed")
        namespace = meta.get("namespace", "default")
        consumer = f"{kind}/{namespace}/{name}"
        source = doc.get("_source", "")

        for image in images:
            if image not in image_usage:
                version_info = versions.get(image, {})
                image_usage[image] = {
                    "image": image,
                    "component": version_info.get("component", "Unmapped / Internal Tool"),
                    "version": version_info.get("version", "Unmapped"),
                    "license": version_info.get("license", "Unmapped"),
                    "notes": version_info.get("notes", ""),
                    "consumers": set(),
                    "sources": set(),
                    "profiles": set(),
                }
            image_usage[image]["consumers"].add(consumer)
            image_usage[image]["sources"].add(source)
            image_usage[image]["profiles"].add(doc["_profile"])

    inventory = []
    for image, data in sorted(image_usage.items(), key=lambda x: x[1]["component"].casefold()):
        inventory.append({
            "image": image,
            "component": data["component"],
            "version": data["version"],
            "license": data["license"],
            "notes": data["notes"],
            "consumers": sorted(data["consumers"]),
            "sources": sorted(data["sources"]),
            "profiles": sorted(data["profiles"]),
        })

    return inventory


def extract_storage_assets(documents: list[dict]) -> list[dict]:
    """Inventory all declared PersistentVolumeClaims, volume claim templates, and cluster storage."""
    storage_assets = []

    for doc in documents:
        kind = doc.get("kind")
        meta = doc.get("metadata", {})
        name = meta.get("name", "unnamed")
        namespace = meta.get("namespace", "default")
        source = doc.get("_source", "")

        if kind == "PersistentVolumeClaim":
            spec = doc.get("spec", {})
            requests = spec.get("resources", {}).get("requests", {})
            capacity = requests.get("storage", "unspecified")
            storage_assets.append({
                "name": name,
                "type": "Standalone PVC",
                "namespace": namespace,
                "capacity": capacity,
                "source": source,
                "consumer": f"Deployment/{namespace}/{name.replace('-data', '').replace('-config', '')}",
            })
        elif kind == "StatefulSet":
            for vct in doc.get("spec", {}).get("volumeClaimTemplates", []):
                vct_meta = vct.get("metadata", {})
                vct_name = vct_meta.get("name", "unnamed")
                vct_spec = vct.get("spec", {})
                capacity = vct_spec.get("resources", {}).get("requests", {}).get("storage", "unspecified")
                storage_assets.append({
                    "name": f"{name} ({vct_name})",
                    "type": "StatefulSet VolumeClaimTemplate",
                    "namespace": namespace,
                    "capacity": capacity,
                    "source": source,
                    "consumer": f"StatefulSet/{namespace}/{name}",
                })
        elif kind == "Cluster":
            # CloudNativePG Cluster storage
            storage_spec = doc.get("spec", {}).get("storage", {})
            capacity = storage_spec.get("size", "unspecified")
            storage_assets.append({
                "name": f"{name}-storage",
                "type": "CNPG Cluster Managed Storage",
                "namespace": namespace,
                "capacity": capacity,
                "source": source,
                "consumer": f"Cluster/{namespace}/{name}",
            })
        elif kind == "KafkaNodePool":
            # Strimzi KafkaNodePool storage
            pool_storage = doc.get("spec", {}).get("storage", {})
            vols = pool_storage.get("volumes", [])
            capacity = vols[0].get("size", "5Gi") if vols else "unspecified"
            storage_assets.append({
                "name": f"kafka-{name}-jbod",
                "type": "Strimzi KafkaNodePool Storage",
                "namespace": namespace,
                "capacity": capacity,
                "source": source,
                "consumer": f"KafkaNodePool/{namespace}/{name}",
            })

    return sorted(storage_assets, key=lambda s: (s["namespace"], s["name"]))


def merge_assets(assets: list[dict], key: str) -> list[dict]:
    """Collapse the same asset across renders while retaining profile membership."""
    merged = {}
    for asset in assets:
        identity = asset[key] if key == "id" else (asset["namespace"], asset["type"], asset["name"])
        if identity not in merged:
            merged[identity] = {**asset, "profiles": set()}
            if "images" in asset:
                merged[identity]["images"] = set(asset["images"])
        merged[identity]["profiles"].add(asset["profile"])
        if "images" in asset:
            merged[identity]["images"].update(asset["images"])
    for asset in merged.values():
        asset.pop("profile", None)
        asset["profiles"] = sorted(asset["profiles"])
        if "images" in asset:
            asset["images"] = sorted(asset["images"])
    return sorted(merged.values(), key=lambda asset: (asset["namespace"], asset.get("kind", ""), asset["name"]))


def source_link(source: str) -> str:
    """Turn Helm's chart-relative Source annotation into a repository link."""
    return f"[`{source}`](../gitops/charts/{source})"


def profile_label(asset: dict) -> str:
    profiles = asset["profiles"]
    return "default" if "default" in profiles else "Conditional: " + ", ".join(profiles)


def build_inventory(repo_root: Path = REPO_ROOT) -> dict:
    """Build complete declared-state asset inventory dictionary."""
    all_docs = []
    for profile, args in PROFILES.items():
        for chart in CHARTS:
            for doc in render_chart(chart, args):
                doc["_profile"] = profile
                all_docs.append(doc)
    versions = parse_versions(repo_root / "VERSIONS.md")

    workloads = merge_assets([
        {**asset, "profile": doc["_profile"]}
        for doc in all_docs for asset in extract_workloads([doc])
    ], "id")
    custom_resources = merge_assets([
        {**asset, "profile": doc["_profile"]}
        for doc in all_docs for asset in extract_custom_resources([doc])
    ], "id")
    images = extract_image_inventory(all_docs, versions)
    storage = merge_assets([
        {**asset, "profile": doc["_profile"]}
        for doc in all_docs for asset in extract_storage_assets([doc])
    ], "name")

    return {
        "scope": "declared-state static inventory; no live cluster connection",
        "charts": list(CHARTS),
        "profiles": list(PROFILES),
        "summary": {
            "workloads": len(workloads),
            "customResources": len(custom_resources),
            "images": len(images),
            "storageAssets": len(storage),
        },
        "workloads": workloads,
        "customResources": custom_resources,
        "images": images,
        "storage": storage,
    }


def render_markdown_en(inventory: dict) -> str:
    """Render the official English declared-state platform asset inventory."""
    lines = [
        "# Beluga Platform Asset Inventory & Lifecycle Governance",
        "",
        "English | [한국어](platform-asset-inventory-ko.md)",
        "",
        "This document establishes the declared-state operational platform asset inventory for the Beluga data platform, fulfilling the baseline requirements of [Issue #42](https://github.com/dasomel/beluga/issues/42) (\"Establish platform asset inventory and lifecycle governance\").",
        "",
        "> [!IMPORTANT]",
        "> **Declared-State Scope Disciplinary Invariant**",
        "> This inventory is a **declared-state baseline** from GitOps Helm manifests rendered with `KUBECONFIG=/dev/null` across the profiles below and [VERSIONS.md](../VERSIONS.md). It covers workloads, custom resources, container images, and declared storage. Live cluster state and image support/EOL dates are not assessed; lifecycle means declared pin only. Runtime reconciliation and EOL review require separate evidence.",
        "> Profiles: `default` (32GB), `48GB+` (`openmetadata.enabled=true`, `trino.workerEnabled=true`), `oauth` (`strimzi.oauthListener=true`), `acl` (`strimzi.aclAuthorizer=true`), `external` (`strimzi.externalListenerEnabled=true`), and `all-enabled` (all flags true). Reproducibility checks are scoped to CI-pinned Helm v3.16.4; local Helm versions may render differently.",
        "",
        "---",
        "",
        "## 1. Workloads Inventory",
        "",
        f"A total of {len(inventory['workloads'])} distinct declared workloads are rendered across the listed profiles. `Conditional` means absent from the default profile.",
        "",
        "| Workload (Stable Identifier) | Kind | Namespace | Chart | Declared Replicas / Mode | Images | Profile | Declared Source |",
        "|---|---|---|---|---|---|---|---|",
    ]

    for w in inventory["workloads"]:
        images_str = "<br>".join(f"`{img}`" for img in w["images"]) if w["images"] else "-"
        lines.append(
            f"| `{w['id']}` | {w['kind']} | `{w['namespace']}` | `{w['chart']}` | {w['replicas']} | {images_str} | {profile_label(w)} | {source_link(w['source'])} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 2. Custom Resources & Operator Managed Assets",
        "",
        f"A total of {len(inventory['customResources'])} distinct custom resources are declared across the listed profiles.",
        "",
        "| Custom Resource Identifier | Kind | API Version | Namespace | Controlling Operator | Profile | Declared Source |",
        "|---|---|---|---|---|---|---|",
    ])

    for cr in inventory["customResources"]:
        lines.append(
            f"| `{cr['id']}` | {cr['kind']} | `{cr['apiVersion']}` | `{cr['namespace']}` | {cr['operator']} | {profile_label(cr)} | {source_link(cr['source'])} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 3. Container Images & Version Source of Truth",
        "",
        f"All {len(inventory['images'])} distinct container images from the listed profiles appear below. Matching expected versions come from [VERSIONS.md](../VERSIONS.md); `Unmapped` means no matching row pin.",
        "",
        "| Component | Declared Image Tag | Expected Version in VERSIONS.md | License | Lifecycle | Profile | Consumer Workloads |",
        "|---|---|---|---|---|---|---|",
    ])

    for img in inventory["images"]:
        consumers_str = ", ".join(f"`{c.split('/')[-1]}`" for c in img["consumers"][:3])
        if len(img["consumers"]) > 3:
            consumers_str += f" (+{len(img['consumers']) - 3} more)"
        status = "Declared pin only; EOL not assessed"
        lines.append(
            f"| **{img['component']}** | `{img['image']}` | `{img['version']}` | {img['license']} | {status} | {profile_label(img)} | {consumers_str} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 4. Persistent Storage Assets & Volume Claims",
        "",
        f"A total of {len(inventory['storage'])} persistent volume claims, volume claim templates, and operator-managed cluster storage specifications are cataloged.",
        "",
        "| Asset Name | Storage Type | Namespace | Declared Capacity | Consumer Workload | Profile | Declared Source |",
        "|---|---|---|---|---|---|---|",
    ])

    for st in inventory["storage"]:
        lines.append(
            f"| `{st['name']}` | {st['type']} | `{st['namespace']}` | `{st['capacity']}` | `{st['consumer']}` | {profile_label(st)} | {source_link(st['source'])} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 5. Profile-Gated & Conditional Workloads",
        "",
        "These identifiers are derived from rendered manifests; the Profile column above records each gate:",
        "",
        *[f"- `{asset['id']}` — {profile_label(asset)} ({source_link(asset['source'])})"
          for asset in inventory["workloads"] + inventory["customResources"]
          if "default" not in asset["profiles"]],
        "",
        "---",
        "",
        "## 6. Lifecycle Governance & Operational Policies",
        "",
        "### A. Version Pinning and Immutability Invariant",
        "- All deployed images MUST specify an explicit version tag or immutable SHA256 digest; the `:latest` tag is forbidden in platform manifests (enforced by `scripts/ci/check-image-tag-immutability.py`).",
        "- Component versions and license compliance are strictly governed by [VERSIONS.md](../VERSIONS.md) and [policies/license-policy.yaml](../policies/license-policy.yaml) (enforced by `scripts/ci/check-version-consistency.py` and `scripts/ci/check-license-policy.py`).",
        "",
        "### B. Asset Onboarding & Offboarding Lifecycle",
        "1. **Onboarding**: Introducing a new platform asset requires: (1) Registering the component version and license in `VERSIONS.md`; (2) Declaring the Helm chart template with dedicated labels, resource limits, and NetworkPolicy; (3) Adding ApisixRoute and TLS Certificate if exposed externally; (4) Updating and verifying this asset inventory via `python3 scripts/generate_platform_asset_inventory.py --check`.",
        "2. **Offboarding / Deprecation**: Deprecating or removing an asset requires: (1) Annotating the deprecation in `VERSIONS.md`; (2) Removing the Helm chart manifest; (3) Decommissioning associated PVCs and secrets; (4) Regenerating this inventory.",
        "",
        "---",
        "",
        "## 7. Issue #42 Acceptance Status",
        "",
        "| Acceptance Criterion | Status | Implementation Evidence |",
        "|---|---|---|",
        "| **Criterion 1**: Critical assets are inventoried with stable identifiers. | **Complete** | Documented in this file (`docs/platform-asset-inventory.md` / `docs/platform-asset-inventory-ko.md`) with `<kind>/<namespace>/<name>` stable identifiers. |",
        "| **Criterion 2**: Inventory can be generated from a clean deployment and compared with Git declarations. | **Static complete** | Generated from the listed Helm profiles with `KUBECONFIG=/dev/null`; `make validate` checks drift. Live cluster reconciliation remains unverified. |",
        "| **Criterion 3**: Unsupported/EOL assets are flagged. | **Open** | Declared pins are listed; EOL/support dates are not assessed by this generator. |",
        "| **Criterion 4**: Asset ownership and lifecycle status are visible. | **Partial** | Namespace and operator are listed; lifecycle is declared pin only, with EOL unassessed. |",
        "| **Criterion 5**: Release inventory is retained as an operational artifact. | **Complete** | Maintained as version-controlled operational documents in `docs/platform-asset-inventory.md` and `docs/platform-asset-inventory-ko.md`, checked continuously in CI; each release also ships `platform-asset-inventory.{json,md}` in its attested evidence bundle (`docs/development.md`, Release evidence). No owner, EOL or retention-period data is included. |",
        "",
    ])

    return "\n".join(lines)


def render_markdown_ko(inventory: dict) -> str:
    """Render the official Korean declared-state platform asset inventory."""
    lines = [
        "# Beluga 플랫폼 자산 인벤토리 및 수명주기 거버넌스",
        "",
        "[English](platform-asset-inventory.md) | 한국어",
        "",
        "본 문서는 [이슈 #42](https://github.com/dasomel/beluga/issues/42) (\"Establish platform asset inventory and lifecycle governance\")의 기본 요구사항을 충족하며, Beluga 데이터 플랫폼의 선언적 상태(declared-state) 운영 자산 인벤토리를 정의합니다.",
        "",
        "> [!IMPORTANT]",
        "> **선언적 상태 범위 규율 (Declared-State Scope Disciplinary Invariant)**",
        "> 본 인벤토리는 아래 프로파일의 GitOps Helm 매니페스트(`KUBECONFIG=/dev/null`)와 [VERSIONS.md](../VERSIONS.md)로부터 생성한 **선언적 상태 기준선**입니다. 워크로드, 커스텀 리소스, 컨테이너 이미지와 선언된 스토리지를 기록합니다. 라이브 클러스터 상태와 이미지 지원 종료(EOL)는 평가하지 않았습니다. 수명주기 표시는 선언된 버전 핀만 뜻합니다.",
        "> 프로파일: `default`(32GB), `48GB+`(`openmetadata.enabled=true`, `trino.workerEnabled=true`), `oauth`(`strimzi.oauthListener=true`), `acl`(`strimzi.aclAuthorizer=true`), `external`(`strimzi.externalListenerEnabled=true`), `all-enabled`(모든 플래그 활성). 재현성 검사는 CI 고정 Helm v3.16.4 범위이며 로컬 Helm 버전에 따라 렌더 결과가 다를 수 있습니다.",
        "",
        "---",
        "",
        "## 1. 워크로드 인벤토리 (Workloads Inventory)",
        "",
        f"프로파일 전체에서 고유한 선언 워크로드 총 {len(inventory['workloads'])}개가 렌더링됩니다. `Conditional`은 기본 프로파일에 없는 자산을 뜻합니다.",
        "",
        "| 워크로드 (안정 식별자) | 종류 (Kind) | 네임스페이스 | 차트 | 선언된 복제본 / 실행 모드 | 컨테이너 이미지 | 프로파일 | 선언 매니페스트 출처 |",
        "|---|---|---|---|---|---|---|---|",
    ]

    for w in inventory["workloads"]:
        images_str = "<br>".join(f"`{img}`" for img in w["images"]) if w["images"] else "-"
        lines.append(
            f"| `{w['id']}` | {w['kind']} | `{w['namespace']}` | `{w['chart']}` | {w['replicas']} | {images_str} | {profile_label(w)} | {source_link(w['source'])} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 2. 커스텀 리소스 및 오퍼레이터 관리 자산 (Custom Resources & Operators)",
        "",
        f"프로파일 전체에서 고유한 커스텀 리소스 총 {len(inventory['customResources'])}개가 선언되어 있습니다.",
        "",
        "| 커스텀 리소스 식별자 | 종류 (Kind) | API 버전 | 네임스페이스 | 제어 오퍼레이터 | 프로파일 | 선언 매니페스트 출처 |",
        "|---|---|---|---|---|---|---|",
    ])

    for cr in inventory["customResources"]:
        lines.append(
            f"| `{cr['id']}` | {cr['kind']} | `{cr['apiVersion']}` | `{cr['namespace']}` | {cr['operator']} | {profile_label(cr)} | {source_link(cr['source'])} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 3. 컨테이너 이미지 및 버전 단일 진실 원천 (Container Images & VERSIONS.md)",
        "",
        f"프로파일 전체에서 선언된 고유 컨테이너 이미지 {len(inventory['images'])}개를 기록합니다. [VERSIONS.md](../VERSIONS.md)의 버전 핀이 일치하지 않으면 `Unmapped`로 표시합니다.",
        "",
        "| 컴포넌트 | 선언된 이미지 태그 | VERSIONS.md 기대 버전 | 라이선스 | 수명주기 | 프로파일 | 소비 워크로드 |",
        "|---|---|---|---|---|---|---|",
    ])

    for img in inventory["images"]:
        consumers_str = ", ".join(f"`{c.split('/')[-1]}`" for c in img["consumers"][:3])
        if len(img["consumers"]) > 3:
            consumers_str += f" (+{len(img['consumers']) - 3}개 추가)"
        status = "선언된 핀만 확인; EOL 미평가"
        lines.append(
            f"| **{img['component']}** | `{img['image']}` | `{img['version']}` | {img['license']} | {status} | {profile_label(img)} | {consumers_str} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 4. 영구 스토리지 자산 및 볼륨 클레임 (PVC & Storage Assets)",
        "",
        f"총 {len(inventory['storage'])}개의 영구 볼륨 클레임(PVC), 볼륨 클레임 템플릿(VCT) 및 오퍼레이터 관리 클러스터 스토리지 사양이 등록되어 있습니다.",
        "",
        "| 자산명 | 스토리지 종류 | 네임스페이스 | 선언 용량 | 소비 워크로드 | 프로파일 | 선언 매니페스트 출처 |",
        "|---|---|---|---|---|---|---|",
    ])

    for st in inventory["storage"]:
        lines.append(
            f"| `{st['name']}` | {st['type']} | `{st['namespace']}` | `{st['capacity']}` | `{st['consumer']}` | {profile_label(st)} | {source_link(st['source'])} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 5. 프로파일 조건부 워크로드 (Profile-Gated & Conditional Workloads)",
        "",
        "다음 식별자는 렌더된 매니페스트에서 생성했으며, 위 프로파일 열에 조건이 표시됩니다:",
        "",
        *[f"- `{asset['id']}` — {profile_label(asset)} ({source_link(asset['source'])})"
          for asset in inventory["workloads"] + inventory["customResources"]
          if "default" not in asset["profiles"]],
        "",
        "---",
        "",
        "## 6. 수명주기 거버넌스 및 운영 규율 (Lifecycle Governance Policies)",
        "",
        "### A. 버전 고정 및 불변성 규율",
        "- 모든 배포 이미지는 명시적인 버전 태그 또는 불변 SHA256 다이제스트를 지정해야 하며 `:latest` 태그는 엄격히 금지됩니다 (`scripts/ci/check-image-tag-immutability.py`에 의해 강제).",
        "- 컴포넌트 버전 및 라이선스 준수 여부는 [VERSIONS.md](../VERSIONS.md) 및 [policies/license-policy.yaml](../policies/license-policy.yaml)에 의해 통제됩니다 (`scripts/ci/check-version-consistency.py` 및 `scripts/ci/check-license-policy.py`에 의해 강제).",
        "",
        "### B. 자산 온보딩 및 오프보딩 수명주기 절차",
        "1. **온보딩(신규 등록)**: 새로운 플랫폼 자산 추가 시: (1) `VERSIONS.md`에 컴포넌트 버전 및 라이선스 등록; (2) 전용 라벨, 리소스 상한, NetworkPolicy가 포함된 Helm 매니페스트 작성; (3) 외부 노출 필요 시 ApisixRoute 및 TLS Certificate 등록; (4) `python3 scripts/generate_platform_asset_inventory.py --check`를 통한 인벤토리 갱신 및 검증.",
        "2. **오프보딩(폐기/삭제)**: 자산 폐기 시: (1) `VERSIONS.md`에 지원 종료 및 폐기 이력 기록; (2) Helm 매니페스트 삭제; (3) 잔여 PVC 및 Secret 정리; (4) 인벤토리 재생성.",
        "",
        "---",
        "",
        "## 7. 이슈 #42 인수 조건 충족 현황 (Acceptance Status)",
        "",
        "| 인수 조건 (Acceptance Criterion) | 상태 (Status) | 구현 증거 (Implementation Evidence) |",
        "|---|---|---|",
        "| **기준 1**: Critical assets are inventoried with stable identifiers. (핵심 자산 안정 식별자 인벤토리화) | **완료 (Complete)** | 본 문서(`docs/platform-asset-inventory.md` / `docs/platform-asset-inventory-ko.md`)에 `<kind>/<namespace>/<name>` 안정 식별자로 체계적 인벤토리화. |",
        "| **기준 2**: Inventory can be generated from a clean deployment and compared with Git declarations. (클린 배포 생성 및 Git 선언 대사) | **정적 검증 완료** | 명시된 Helm 프로파일을 `KUBECONFIG=/dev/null`로 렌더하고 `make validate`에서 드리프트 확인. 라이브 클러스터 대사는 미검증. |",
        "| **기준 3**: Unsupported/EOL assets are flagged. (미지원/EOL 자산 식별) | **미완료** | 선언된 핀은 기록하지만 EOL/지원 종료일은 평가하지 않음. |",
        "| **기준 4**: Asset ownership and lifecycle status are visible. (자산 소유권 및 수명주기 가시화) | **일부 완료** | 네임스페이스와 오퍼레이터를 표시하며 수명주기는 선언된 핀만 확인; EOL 미평가. |",
        "| **기준 5**: Release inventory is retained as an operational artifact. (릴리스 인벤토리 운영 산출물 보존) | **완료 (Complete)** | `docs/platform-asset-inventory.md` 및 `docs/platform-asset-inventory-ko.md`로 버전 관리되며 CI에서 지속 검증; 릴리스마다 `platform-asset-inventory.{json,md}`가 attest된 증적 번들에 포함됨(`docs/development.md` Release evidence). 소유자, EOL, 보존 기간 데이터는 포함하지 않음. |",
        "",
    ])

    return "\n".join(lines)


def check_relative_links(content: str, doc_path: Path) -> list[str]:
    """Reject generated Markdown links whose local repository targets do not exist."""
    errors = []
    for target in re.findall(r"\]\(([^)]+)\)", content):
        if "://" in target or target.startswith("#"):
            continue
        relative = target.split("#", 1)[0]
        if not (REPO_ROOT / "docs" / relative).is_file():
            errors.append(f"Broken relative link in {doc_path}: {target}")
    return errors


def check_drift(doc_en_path: Path = DOC_EN, doc_ko_path: Path = DOC_KO,
                inventory: dict | None = None) -> list[str]:
    """Check if committed inventory documents have drifted from generated content."""
    inventory = inventory if inventory is not None else build_inventory()
    expected_en = render_markdown_en(inventory)
    expected_ko = render_markdown_ko(inventory)

    errors = check_relative_links(expected_en, doc_en_path) + check_relative_links(expected_ko, doc_ko_path)
    if not doc_en_path.is_file():
        errors.append(f"Missing English inventory doc: {doc_en_path}")
    else:
        actual_en = doc_en_path.read_text(encoding="utf-8")
        errors.extend(check_relative_links(actual_en, doc_en_path))
        if actual_en != expected_en:
            diff = list(difflib.unified_diff(
                actual_en.splitlines(),
                expected_en.splitlines(),
                fromfile=str(doc_en_path),
                tofile="generated-en",
                lineterm="",
            ))
            errors.append(f"Drift detected in {doc_en_path}:\n" + "\n".join(diff[:20]))

    if not doc_ko_path.is_file():
        errors.append(f"Missing Korean inventory doc: {doc_ko_path}")
    else:
        actual_ko = doc_ko_path.read_text(encoding="utf-8")
        errors.extend(check_relative_links(actual_ko, doc_ko_path))
        if actual_ko != expected_ko:
            diff = list(difflib.unified_diff(
                actual_ko.splitlines(),
                expected_ko.splitlines(),
                fromfile=str(doc_ko_path),
                tofile="generated-ko",
                lineterm="",
            ))
            errors.append(f"Drift detected in {doc_ko_path}:\n" + "\n".join(diff[:20]))

    return errors


def write_documents(doc_en_path: Path = DOC_EN, doc_ko_path: Path = DOC_KO) -> None:
    """Generate and write both English and Korean inventory docs to disk."""
    inventory = build_inventory()
    expected_en = render_markdown_en(inventory)
    expected_ko = render_markdown_ko(inventory)
    link_errors = check_relative_links(expected_en, doc_en_path) + check_relative_links(expected_ko, doc_ko_path)
    if link_errors:
        raise ValueError("\n".join(link_errors))

    doc_en_path.write_text(expected_en, encoding="utf-8")
    doc_ko_path.write_text(expected_ko, encoding="utf-8")
    print(f"Wrote English platform asset inventory: {doc_en_path}")
    print(f"Wrote Korean platform asset inventory: {doc_ko_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--write", action="store_true", help="Generate and write docs to disk")
    parser.add_argument("--check", action="store_true", help="Check committed docs for drift against generated output")
    parser.add_argument("--json", action="store_true", help="Print structured inventory JSON to stdout")
    args = parser.parse_args()

    if args.json:
        inventory = build_inventory()
        print(json.dumps(inventory, indent=2, ensure_ascii=False))
        return 0

    if args.write:
        write_documents()
        return 0

    if args.check:
        helm_version = subprocess.run(["helm", "version", "--short"], capture_output=True,
                                      text=True, check=True).stdout.strip()
        print(f"Helm: {helm_version} (CI pin: v3.16.4; reproducibility check scoped to CI pin)")
        errors = check_drift()
        if errors:
            print("FAIL: platform asset inventory drift detected:", file=sys.stderr)
            for err in errors:
                print(err, file=sys.stderr)
            return 1
        print("OK: platform asset inventory docs match declared Helm charts and VERSIONS.md (no drift).")
        return 0

    # Default action: write documents
    write_documents()
    return 0


if __name__ == "__main__":
    sys.exit(main())
