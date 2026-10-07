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
4. Retention-driven demand: retention days (rendered CNPG Cluster spec.backup.retentionPolicy)
   x measured daily backup volume + current WAL backlog must fit in the nominal capacity N x M
   with CAPACITY_HEADROOM, and in volume slots.
5. Slot demand, pool shared by ALL buckets (backups and beluga-lake fail together when it runs out):
   demand(g) = LEGACY + ceil(LAKE_EXTRA/g)*g + max(g, backup volumes)
               + max(FUTURE_BUCKETS, other new buckets in the repo) x g
   honoured env : demand(G)  <= N          env ignored : demand(7) <= N
   Buckets added to the repo consume the FUTURE_BUCKETS headroom first (no double count); only
   buckets beyond the headroom raise the demand, which then forces a re-review of the limits.
Deliberately NOT asserted: nominal capacity <= PVC request. local-path does not enforce PVC
quota and volumeClaimTemplates are immutable on a StatefulSet; the real bound is the host disk
(owner decision: monitor host disk or set a real quota). The PVC size is only reported.
Negative fixtures run on every invocation.
"""
from __future__ import annotations

import copy
import math
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

# Assumptions (Proposed; mirrored in the 01-seaweedfs.yaml comment - change them together).
# Live measurements 2026-10-07 (read-only, reviewer): WAL gzip segment ~0.42MB, ~135 segments/day,
# base backup ~40MB/day, backlog 445 segments while archiving was failing.
LEGACY_VOLUMES = 8  # volumes existing before this fix; 7 pinned by the default collection's growth
WAL_MB_PER_DAY = 0.42 * 135
BASE_BACKUP_MB_PER_DAY = 40
WAL_BACKLOG_MB = 445 * 0.42
LAKE_EXTRA_VOLUMES = 2  # assumed growth of beluga-lake beyond its legacy volumes
FUTURE_BUCKETS = 3  # modelled non-backup new buckets (headroom; repo buckets consume it first)
DEFAULT_GROWTH = 7  # SeaweedFS 4.41 master.volume_growth.copy_1 default
CAPACITY_HEADROOM = 2  # nominal capacity must be >= 2 x modelled data
BACKUP_BUCKET = "beluga-postgres-backups"
LEGACY_BUCKETS = frozenset({"beluga-lake"})  # already own legacy volumes
RETENTION_DAYS = {"d": 1, "w": 7, "m": 30}
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
    env = {e["name"]: e.get("value") for e in (srv.get("env") or []) if "name" in e}
    growth = _int(env.get(GROWTH_ENV), f"env {GROWTH_ENV} (container env missing or lacks it)")
    if growth < 1:
        raise ValueError(f"{GROWTH_ENV} must be >= 1")

    pvc = next((p for p in sts["spec"].get("volumeClaimTemplates", []) if p["metadata"]["name"] == "seaweedfs-data"), None)
    if pvc is None:
        raise ValueError("volumeClaimTemplate seaweedfs-data not found")
    pvc_mib = _mib(pvc["spec"]["resources"]["requests"]["storage"])
    capacity = vmax * size_mb

    cluster = next((r for r in resources if r.get("kind") == "Cluster" and r["metadata"]["name"] == "postgres-main"), None)
    if cluster is None:
        raise ValueError("CNPG Cluster postgres-main not found (retention drives the volume demand)")
    ret = str(cluster["spec"].get("backup", {}).get("retentionPolicy", ""))
    m = re.fullmatch(r"([1-9][0-9]*)([dwm])", ret)
    if not m:
        raise ValueError(f"CNPG retentionPolicy {ret!r} not parseable; the volume model needs it")
    days = int(m.group(1)) * RETENTION_DAYS[m.group(2)]
    backup_mb = days * (WAL_MB_PER_DAY + BASE_BACKUP_MB_PER_DAY) + WAL_BACKLOG_MB
    backup_vols = math.ceil(backup_mb / size_mb)
    lake_mb = LAKE_EXTRA_VOLUMES * size_mb
    if capacity < CAPACITY_HEADROOM * (backup_mb + lake_mb):
        raise ValueError(
            f"nominal capacity {vmax} x {size_mb}MiB = {capacity}MiB < {CAPACITY_HEADROOM} x modelled data "
            f"({backup_mb:.0f}MiB backup over {days}d + {lake_mb}MiB lake)")

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
    new_buckets = sorted(buckets - LEGACY_BUCKETS)
    # The backup bucket needs backup_vols volumes over time; every other new bucket 1 growth step.
    # Honoured: growth G per first allocation. Ignored: default 7 per first allocation.
    others = [b for b in new_buckets if b != BACKUP_BUCKET]
    backup_new = BACKUP_BUCKET in new_buckets

    def demand(g: int) -> int:
        lake = math.ceil(LAKE_EXTRA_VOLUMES / g) * g  # one growth step allocates g volumes at once
        total = LEGACY_VOLUMES + lake + max(FUTURE_BUCKETS, len(others)) * g
        return total + (max(g, backup_vols) if backup_new else 0)
    honoured = demand(growth)
    ignored = demand(DEFAULT_GROWTH)
    if honoured > vmax:
        raise ValueError(f"slot demand (env honoured, G={growth}) {honoured} exceeds -volume.max={vmax}")
    if ignored > vmax:
        raise ValueError(f"slot demand (env ignored, default growth {DEFAULT_GROWTH}) {ignored} exceeds -volume.max={vmax}")
    return {"volumeMax": vmax, "volumeSizeLimitMB": size_mb, "growthCopy1": growth,
            "nominalCapacityMiB": capacity, "pvcRequestMiB(not enforced by local-path)": pvc_mib,
            "retentionDays": days, "modelledBackupMiB": round(backup_mb), "backupVolumes": backup_vols,
            "buckets": sorted(buckets), "slotDemandHonoured": honoured, "slotDemandEnvIgnored": ignored,
            "alertThresholdVolumes(Proposed 75%)": math.floor(vmax * 0.75)}


def _valid_fixture() -> list[dict[str, Any]]:
    idents = {"identities": [
        {"name": "a", "actions": ["Read:beluga-lake", "Write:beluga-lake"]},
        {"name": "b", "actions": ["Admin:beluga-postgres-backups"]},
    ]}
    sts = {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": "seaweedfs"},
           "spec": {"template": {"spec": {"containers": [{
               "name": "master-volume-s3",
               "command": ["weed", "server", "-s3", "-dir=/data", "-volume.max=48", "-master.volumeSizeLimitMB=1024"],
               "env": [{"name": GROWTH_ENV, "value": "1"}]}]}},
               "volumeClaimTemplates": [{"metadata": {"name": "seaweedfs-data"},
                                         "spec": {"resources": {"requests": {"storage": "5Gi"}}}}]}}
    cm = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "seaweedfs-s3-identities-template"},
          "data": {"identities.json": json.dumps(idents)}}
    cluster = {"apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster", "metadata": {"name": "postgres-main"},
               "spec": {"backup": {"retentionPolicy": "30d"}}}
    return [sts, cm, cluster]


def self_test() -> int:
    base = _valid_fixture()
    ok = validate_seaweedfs_volume_limits(base)
    assert (ok["slotDemandHonoured"], ok["slotDemandEnvIgnored"], ok["backupVolumes"]) == (17, 43, 4), ok
    cases: list[tuple[str, list[dict[str, Any]]]] = []

    def mut(desc, fn):
        c = copy.deepcopy(base)
        fn(c)
        cases.append((desc, c))

    def sub(c, old, new):
        cmd = c[0]["spec"]["template"]["spec"]["containers"][0]["command"]
        cmd[cmd.index(old)] = new

    def env(c):
        return c[0]["spec"]["template"]["spec"]["containers"][0]

    mut("no explicit -volume.max (the 2026-10-07 defect)",
        lambda c: env(c)["command"].remove("-volume.max=48"))
    mut("-volume.max=0 (auto)", lambda c: sub(c, "-volume.max=48", "-volume.max=0"))
    mut("-volume.max=8 (default)", lambda c: sub(c, "-volume.max=48", "-volume.max=8"))
    mut("-volume.max=32 fits honoured but not the env-ignored worst case (43)",
        lambda c: sub(c, "-volume.max=48", "-volume.max=32"))
    mut("no explicit -master.volumeSizeLimitMB",
        lambda c: env(c)["command"].remove("-master.volumeSizeLimitMB=1024"))
    mut("size limit above weed's fatal bound",
        lambda c: sub(c, "-master.volumeSizeLimitMB=1024", "-master.volumeSizeLimitMB=99999"))
    mut("capacity below 2x modelled retention data (48 x 64MiB)",
        lambda c: (sub(c, "-master.volumeSizeLimitMB=1024", "-master.volumeSizeLimitMB=64")))
    mut("no env block at all (empty env: clear message, not TypeError)", lambda c: env(c).pop("env"))
    mut("env empty list", lambda c: env(c).update(env=[]))
    mut("growth 14 x headroom exceeds max", lambda c: env(c)["env"][0].update(value="14"))
    mut("growth 0", lambda c: env(c)["env"][0].update(value="0"))

    def many_buckets(c):
        ids = json.loads(c[1]["data"]["identities.json"])
        ids["identities"].append({"name": "x", "actions": [f"Read:new-bucket-{i}" for i in range(20)]})
        c[1]["data"]["identities.json"] = json.dumps(ids)
    def one_more(c):  # one extra repo bucket consumes headroom: must still pass
        ids = json.loads(c[1]["data"]["identities.json"])
        ids["identities"].append({"name": "y", "actions": ["Read:one-more-bucket"]})
        c[1]["data"]["identities.json"] = json.dumps(ids)
    c1 = copy.deepcopy(base); one_more(c1)
    assert validate_seaweedfs_volume_limits(c1)["slotDemandEnvIgnored"] == 43, "headroom double-counted"
    mut("20 new buckets push slot demand over -volume.max", many_buckets)
    mut("retention grown to 12m (slots/capacity)", lambda c: c[2]["spec"]["backup"].update(retentionPolicy="12m"))
    mut("retentionPolicy missing", lambda c: c[2]["spec"]["backup"].pop("retentionPolicy"))
    mut("CNPG Cluster missing", lambda c: c.pop(2))
    mut("PVC template missing", lambda c: c[0]["spec"].pop("volumeClaimTemplates"))
    cases.append(("StatefulSet missing", [base[1], base[2]]))

    for desc, fixture in cases:
        try:
            validate_seaweedfs_volume_limits(fixture)
        except ValueError:
            continue
        raise AssertionError(f"negative fixture {desc!r} unexpectedly passed")
    # explicit positive: a PVC smaller than nominal capacity is an accepted, documented decision
    big = copy.deepcopy(base)
    big[0]["spec"]["volumeClaimTemplates"][0]["spec"]["resources"]["requests"]["storage"] = "1Gi"
    validate_seaweedfs_volume_limits(big)
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
