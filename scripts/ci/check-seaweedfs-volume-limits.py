#!/usr/bin/env python3
"""Offline static gate for SeaweedFS volume limits (Issue #5, 2026-10-07 live defect).

Defect: `weed server` shipped with defaults (-volume.max=8). All 8 slots were already used
(~12MB of data), so a NEW bucket (beluga-postgres-backups) could not get volumes:
master `volume.grow ... created 0: Not enough data nodes found!` -> client `PutObject InternalError`
-> CNPG ContinuousArchiving=False. A first error (missing bucket) had hidden this second cause.

Rendered-manifest assertions on StatefulSet/seaweedfs (flag names verified against the
SeaweedFS 4.41 sources: weed/command/server.go, weed/command/scaffold/master.toml):
1. `-volume.max=N` is explicit and > 0 (0 = "auto from free disk", misleading on local-path).
2. `-master.volumeSizeLimitMB=M` is explicit, 1..30000.
3. env WEED_MASTER_VOLUME_GROWTH_COPY_1=G is explicit and >= 1 (master.toml
   [master.volume_growth] copy_1; replication 000 grows G volumes per new collection; default 7).
4. Nominal capacity N x M MiB <= the PVC request (local-path does not enforce quota).
5. Slot demand fits: LEGACY_VOLUMES + (known buckets + FUTURE_BUCKETS) x G <= N, where known
   buckets are the `Verb:bucket` names in the S3 identities ConfigMap.
Negative fixtures run on every invocation.
"""
from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CHART_PATH = REPO_ROOT / "gitops" / "charts" / "beluga-data"

PROFILES: dict[str, list[str]] = {
    "32": [],
    "48": ["--set", "openmetadata.enabled=true,trino.workerEnabled=true"],
    "64": ["--set", "openmetadata.enabled=true,trino.workerEnabled=true"],
}

# Assumptions (Proposed; see 01-seaweedfs.yaml comment). Change them together with the template.
LEGACY_VOLUMES = 8  # live 2026-10-07: volumes already created before this fix keep occupying slots
FUTURE_BUCKETS = 3  # headroom for buckets not yet in the repo
MAX_VOLUME_SIZE_LIMIT_MB = 30000  # `weed server` fatals above this
GROWTH_ENV = "WEED_MASTER_VOLUME_GROWTH_COPY_1"
UNITS_MIB = {"Mi": 1, "Gi": 1024, "Ti": 1024 * 1024}


def parse_manifests(text: str) -> list[dict[str, Any]]:
    return [d for d in yaml.safe_load_all(text) if isinstance(d, dict) and "kind" in d]


def _flag(args: list[str], name: str) -> str | None:
    found = [a.split("=", 1)[1] for a in args if a.startswith(f"-{name}=") and "=" in a]
    if len(found) > 1:
        raise ValueError(f"flag -{name} given more than once: {found}")
    return found[0] if found else None


def _int(value: str | None, what: str) -> int:
    if value is None:
        raise ValueError(f"{what} must be set explicitly (defaults are not accepted)")
    if not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError(f"{what} must be a non-negative integer, got {value!r}")
    return int(value)


def _mib(quantity: str) -> int:
    m = re.fullmatch(r"([0-9]+)(Mi|Gi|Ti)", str(quantity))
    if not m:
        raise ValueError(f"unsupported PVC size {quantity!r} (use Mi/Gi/Ti)")
    return int(m.group(1)) * UNITS_MIB[m.group(2)]


def validate_seaweedfs_volume_limits(resources: list[dict[str, Any]]) -> dict[str, Any]:
    sts = next((r for r in resources if r.get("kind") == "StatefulSet" and r["metadata"]["name"] == "seaweedfs"), None)
    if sts is None:
        raise ValueError("StatefulSet/seaweedfs not found")
    containers = sts["spec"]["template"]["spec"].get("containers", [])
    srv = next((c for c in containers if "server" in c.get("command", [])), None)
    if srv is None:
        raise ValueError("no `weed server` container in StatefulSet/seaweedfs")
    args = srv["command"] + srv.get("args", [])

    vmax = _int(_flag(args, "volume.max"), "-volume.max")
    if vmax < 1:
        raise ValueError("-volume.max=0 means auto-from-free-disk (misleading on local-path); set an explicit positive count")
    size_mb = _int(_flag(args, "master.volumeSizeLimitMB"), "-master.volumeSizeLimitMB")
    if not 1 <= size_mb <= MAX_VOLUME_SIZE_LIMIT_MB:
        raise ValueError(f"-master.volumeSizeLimitMB must be 1..{MAX_VOLUME_SIZE_LIMIT_MB}, got {size_mb}")
    env = {e["name"]: e.get("value") for e in srv.get("env", []) if "name" in e}
    growth = _int(env.get(GROWTH_ENV), f"env {GROWTH_ENV}")
    if growth < 1:
        raise ValueError(f"{GROWTH_ENV} must be >= 1")

    pvcs = sts["spec"].get("volumeClaimTemplates", [])
    pvc = next((p for p in pvcs if p["metadata"]["name"] == "seaweedfs-data"), None)
    if pvc is None:
        raise ValueError("volumeClaimTemplate seaweedfs-data not found")
    pvc_mib = _mib(pvc["spec"]["resources"]["requests"]["storage"])
    capacity = vmax * size_mb
    if capacity > pvc_mib:
        raise ValueError(f"nominal capacity {vmax} x {size_mb}MiB = {capacity}MiB exceeds PVC {pvc_mib}MiB")

    cm = next((r for r in resources if r.get("kind") == "ConfigMap"
               and r["metadata"]["name"] == "seaweedfs-s3-identities-template"), None)
    if cm is None:
        raise ValueError("seaweedfs-s3-identities-template ConfigMap not found")
    buckets: set[str] = set()
    for ident in json.loads(cm["data"]["identities.json"])["identities"]:
        for action in ident.get("actions", []):
            if ":" in action:
                buckets.add(action.split(":", 1)[1])
    if not buckets:
        raise ValueError("no buckets found in S3 identities")
    demand = LEGACY_VOLUMES + (len(buckets) + FUTURE_BUCKETS) * growth
    if demand > vmax:
        raise ValueError(
            f"slot demand {LEGACY_VOLUMES} legacy + ({len(buckets)} buckets + {FUTURE_BUCKETS} future) x {growth} "
            f"= {demand} exceeds -volume.max={vmax}"
        )
    return {"volumeMax": vmax, "volumeSizeLimitMB": size_mb, "growthCopy1": growth,
            "nominalCapacityMiB": capacity, "pvcMiB": pvc_mib, "buckets": sorted(buckets), "slotDemand": demand}


def _valid_fixture() -> list[dict[str, Any]]:
    idents = {"identities": [
        {"name": "a", "actions": ["Read:beluga-lake", "Write:beluga-lake"]},
        {"name": "b", "actions": ["Admin:beluga-postgres-backups"]},
    ]}
    sts = {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": "seaweedfs"},
           "spec": {"template": {"spec": {"containers": [{
               "name": "master-volume-s3",
               "command": ["weed", "server", "-s3", "-dir=/data", "-volume.max=16", "-master.volumeSizeLimitMB=256"],
               "env": [{"name": GROWTH_ENV, "value": "1"}]}]}},
               "volumeClaimTemplates": [{"metadata": {"name": "seaweedfs-data"},
                                         "spec": {"resources": {"requests": {"storage": "5Gi"}}}}]}}
    cm = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "seaweedfs-s3-identities-template"},
          "data": {"identities.json": json.dumps(idents)}}
    return [sts, cm]


def self_test() -> int:
    base = _valid_fixture()
    assert validate_seaweedfs_volume_limits(base)["slotDemand"] == 13, "positive fixture failed"
    cases: list[tuple[str, list[dict[str, Any]]]] = []

    def cmd(c):  # container command of the fixture copy
        return c[0]["spec"]["template"]["spec"]["containers"][0]["command"]

    c = copy.deepcopy(base); cmd(c).remove("-volume.max=16")
    cases.append(("no explicit -volume.max (the 2026-10-07 defect)", c))
    c = copy.deepcopy(base); cmd(c)[cmd(c).index("-volume.max=16")] = "-volume.max=0"
    cases.append(("-volume.max=0 (auto)", c))
    c = copy.deepcopy(base); cmd(c)[cmd(c).index("-volume.max=16")] = "-volume.max=8"
    cases.append(("-volume.max=8 (default, slot demand 13 > 8)", c))
    c = copy.deepcopy(base); cmd(c)[cmd(c).index("-volume.max=16")] = "-volume.max=24"
    cases.append(("capacity 24 x 256MiB > 5Gi PVC", c))
    c = copy.deepcopy(base); cmd(c).remove("-master.volumeSizeLimitMB=256")
    cases.append(("no explicit -master.volumeSizeLimitMB", c))
    c = copy.deepcopy(base); cmd(c)[cmd(c).index("-master.volumeSizeLimitMB=256")] = "-master.volumeSizeLimitMB=30000"
    cases.append(("size limit 30000 (capacity > PVC)", c))
    c = copy.deepcopy(base); cmd(c)[cmd(c).index("-master.volumeSizeLimitMB=256")] = "-master.volumeSizeLimitMB=99999"
    cases.append(("size limit above weed's fatal bound", c))
    c = copy.deepcopy(base); del c[0]["spec"]["template"]["spec"]["containers"][0]["env"]
    cases.append(("no explicit volume growth count (default 7)", c))
    c = copy.deepcopy(base); c[0]["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = "7"
    cases.append(("growth 7 x 5 buckets exceeds max", c))
    c = copy.deepcopy(base); c[0]["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = "0"
    cases.append(("growth 0", c))
    c = copy.deepcopy(base)
    ids = json.loads(c[1]["data"]["identities.json"])
    ids["identities"].append({"name": "x", "actions": [f"Read:new-bucket-{i}" for i in range(4)]})
    c[1]["data"]["identities.json"] = json.dumps(ids)
    cases.append(("4 new buckets push slot demand over -volume.max", c))
    c = copy.deepcopy(base); c[0]["spec"]["volumeClaimTemplates"][0]["spec"]["resources"]["requests"]["storage"] = "1Gi"
    cases.append(("PVC shrunk below nominal capacity", c))
    c = copy.deepcopy(base); del c[0]["spec"]["volumeClaimTemplates"]
    cases.append(("PVC template missing", c))
    cases.append(("StatefulSet missing", [base[1]]))

    for desc, fixture in cases:
        try:
            validate_seaweedfs_volume_limits(fixture)
        except ValueError:
            continue
        raise AssertionError(f"negative fixture {desc!r} unexpectedly passed")
    return len(cases)


def main() -> int:
    try:
        n = self_test()
        print(f"SeaweedFS volume-limit self-test: {n} negative fixtures rejected; positive fixture passed.", file=sys.stderr)
        out = {}
        for profile, extra in PROFILES.items():
            proc = subprocess.run(["helm", "template", str(CHART_PATH)] + extra, capture_output=True, text=True,
                                  check=True, env={**os.environ, "KUBECONFIG": os.devnull})
            out[profile] = validate_seaweedfs_volume_limits(parse_manifests(proc.stdout))
        print("OK: SeaweedFS volume limits are explicit and consistent across all profiles.")
        print(json.dumps(out, indent=2))
        return 0
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except (ValueError, KeyError, TypeError, AssertionError, yaml.YAMLError) as exc:
        print(f"FAIL: SeaweedFS volume limits: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
