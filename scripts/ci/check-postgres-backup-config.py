#!/usr/bin/env python3
"""Offline static validation gate for CloudNativePG PostgreSQL backup configuration (Issue #46).

Issue #46 requirements:
  "Define backup classes, retention periods, and recovery windows for ... PostgreSQL"
  "Protect backup repositories from routine modification/deletion"

This check enforces offline, fail-closed assertions on rendered Helm manifests:
1. Cluster resource (postgres-main in namespace database):
   - spec.backup is present and non-empty.
   - spec.backup.barmanObjectStore is present with destinationPath (s3://...) and endpointURL.
   - s3Credentials are provided via secretKeyRef (accessKeyId and secretAccessKey must be
     mappings containing non-empty 'name' and 'key' referencing a Secret, never inline plaintext).
   - WAL archiving is configured (spec.backup.barmanObjectStore.wal.compression) with an
     approved compression algorithm for Point-in-Time Recovery (PITR).
   - retentionPolicy is declared as a valid, non-empty duration matching CNPG's specification
     (^[1-9][0-9]*[dwm]$).
2. ScheduledBackup resource:
   - Present in the same namespace and targeting the postgres-main Cluster.
   - spec.backupOwnerReference is set to 'self' to tie backup object lifecycles to the schedule.
   - spec.schedule contains a valid cron expression (supporting standard 5-field cron or
     robfig/cron 6-field format with seconds).
3. Built-in negative self-tests run on every invocation to prove fail-closed enforcement.
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

RETENTION_PATTERN = re.compile(r"^[1-9][0-9]*[dwm]$")
ALLOWED_WAL_COMPRESSION = frozenset({"gzip", "bzip2", "lz4", "snappy", "xz", "zstd"})
ALLOWED_BACKUP_OWNER_REFS = frozenset({"self", "cluster", "none"})


class UniqueLoader(yaml.SafeLoader):
    """Reject duplicate YAML keys instead of silently overwriting fields."""


def unique_mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if key in result:
            raise ValueError(f"duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def parse_manifests(manifest_text: str) -> list[dict[str, Any]]:
    """Parse a multi-document YAML stream into resource dicts."""
    resources: list[dict[str, Any]] = []
    for doc in yaml.load_all(manifest_text, Loader=UniqueLoader):
        if not doc:
            continue
        if doc.get("kind") == "List":
            resources.extend(doc.get("items", []))
        elif isinstance(doc, dict) and "kind" in doc and "metadata" in doc:
            resources.append(doc)
    return resources


def _is_valid_cron_field(field: str, min_val: int, max_val: int) -> bool:
    if field == "*":
        return True
    if "/" in field:
        parts = field.split("/")
        if len(parts) != 2:
            return False
        base, step = parts
        if not step.isdigit() or int(step) <= 0:
            return False
        if base != "*" and not _is_valid_cron_field(base, min_val, max_val):
            return False
        return True
    if "," in field:
        parts = field.split(",")
        return all(_is_valid_cron_field(p, min_val, max_val) for p in parts)
    if "-" in field:
        parts = field.split("-")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            start, end = int(parts[0]), int(parts[1])
            return min_val <= start <= end <= max_val
        return False
    if field.isdigit():
        return min_val <= int(field) <= max_val
    return False


def validate_cron_expression(expr: str) -> tuple[bool, str]:
    # 리뷰 실측(이슈 #46): CNPG ScheduledBackup.spec.schedule은 robfig/cron 파서를 쓰며
    # 이는 Kubernetes CronJob과 달리 초 필드가 필수인 6필드 형식만 받는다. 5필드
    # Kubernetes 스타일 식을 관대하게 허용하면 CNPG가 실제로 거부하거나(필드 개수 불일치)
    # 의도와 다른 일정으로 해석하는 값을 이 게이트가 통과시키게 된다.
    if not isinstance(expr, str) or not expr.strip():
        return False, "cron expression must be a non-empty string"
    tokens = expr.strip().split()
    if len(tokens) != 6:
        return False, f"CNPG ScheduledBackup requires a 6-field robfig/cron expression (seconds minutes hours dom month dow), got {len(tokens)} field(s)"
    ranges = [(0, 59), (0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]

    for token, (min_v, max_v) in zip(tokens, ranges):
        if not _is_valid_cron_field(token, min_v, max_v):
            return False, f"invalid field '{token}' for range {min_v}-{max_v}"
    return True, ""


def _wave(resource: dict[str, Any]) -> int:
    raw = resource.get("metadata", {}).get("annotations", {}).get("argocd.argoproj.io/sync-wave", "0")
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{resource.get('kind')}/{resource.get('metadata', {}).get('name')} has non-integer sync-wave {raw!r}")


def validate_bucket_provisioning(resources: list[dict[str, Any]], destination_path: str) -> dict[str, Any]:
    """Issue #5: the bucket named in destinationPath must be created at deploy time.

    barman-cloud tries CreateBucket when the bucket is missing; the backup identity (correctly)
    has no Admin, so a never-created bucket means ContinuousArchiving=False forever.
    """
    bucket = destination_path[len("s3://"):].strip("/").split("/", 1)[0]
    cluster = next(
        r for r in resources
        if r.get("kind") == "Cluster" and r.get("metadata", {}).get("name") == "postgres-main"
    )
    jobs = [
        r for r in resources
        if r.get("kind") == "Job"
        and isinstance(r.get("spec", {}).get("template", {}).get("spec"), dict)
        and any(
            bucket in " ".join(c.get("args", [])) and "-X PUT" in " ".join(c.get("args", []))
            for c in r["spec"]["template"]["spec"].get("containers", [])
        )
    ]
    if not jobs:
        raise ValueError(f"no Job provisions bucket {bucket!r} (PUT) - archiving would fail with CreateBucket AccessDenied")
    job = jobs[0]
    jname = job["metadata"]["name"]
    ann = job["metadata"].get("annotations", {})
    if ann.get("argocd.argoproj.io/hook") != "Sync":
        raise ValueError(f"Job/{jname} must be an ArgoCD Sync hook")
    if "BeforeHookCreation" not in ann.get("argocd.argoproj.io/hook-delete-policy", ""):
        raise ValueError(f"Job/{jname} must use hook-delete-policy BeforeHookCreation (repeat-sync safe)")
    if _wave(job) > _wave(cluster):
        raise ValueError(f"Job/{jname} sync-wave must not be later than the CNPG Cluster's")

    # Least privilege: only the provisioner holds Admin on the bucket; the backup writer never does.
    identities = None
    for r in resources:
        if r.get("kind") == "ConfigMap" and r.get("metadata", {}).get("name") == "seaweedfs-s3-identities-template":
            identities = json.loads(r["data"]["identities.json"])["identities"]
    if identities is None:
        raise ValueError("seaweedfs-s3-identities-template ConfigMap not found")
    admins = [i["name"] for i in identities if f"Admin:{bucket}" in i.get("actions", [])]
    if len(admins) != 1:
        raise ValueError(f"exactly one identity must hold Admin:{bucket}, got {admins}")
    for i in identities:
        if i["name"] == "postgres-backup-service" and any(a.startswith("Admin") for a in i["actions"]):
            raise ValueError("postgres-backup-service must not hold Admin (bucket-create) actions")
    return {"job": f"{job['metadata'].get('namespace')}/{jname}", "bucket": bucket, "adminIdentity": admins[0]}


def validate_postgres_backup(resources: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate CNPG Cluster backup configuration and ScheduledBackup resources.

    Returns a summary dict on success, or raises ValueError with a diagnostic.
    """
    clusters = [
        r for r in resources
        if r.get("apiVersion", "").startswith("postgresql.cnpg.io/")
        and r.get("kind") == "Cluster"
        and r.get("metadata", {}).get("name") == "postgres-main"
    ]
    if not clusters:
        raise ValueError("Cluster 'postgres-main' not found in rendered manifests")

    cluster = clusters[0]
    ns = cluster.get("metadata", {}).get("namespace", "database")
    spec = cluster.get("spec")
    if not isinstance(spec, dict):
        raise ValueError("Cluster 'postgres-main' is missing spec")

    backup = spec.get("backup")
    if not isinstance(backup, dict) or not backup:
        raise ValueError("Cluster 'postgres-main' has missing or empty spec.backup")

    # 1. BarmanObjectStore validation
    barman = backup.get("barmanObjectStore")
    if not isinstance(barman, dict) or not barman:
        raise ValueError("Cluster 'postgres-main' has missing or empty spec.backup.barmanObjectStore")

    destination_path = barman.get("destinationPath")
    if not isinstance(destination_path, str) or not destination_path.startswith("s3://"):
        raise ValueError(
            f"destinationPath must be a non-empty s3:// URI, got: {destination_path!r}"
        )

    endpoint_url = barman.get("endpointURL")
    if not isinstance(endpoint_url, str) or not (
        endpoint_url.startswith("http://") or endpoint_url.startswith("https://")
    ):
        raise ValueError(
            f"endpointURL must be a valid http(s) URL, got: {endpoint_url!r}"
        )

    # 2. Secret hygiene: credentials MUST come from secretKeyRef (no inline plaintext)
    s3_creds = barman.get("s3Credentials")
    if not isinstance(s3_creds, dict) or not s3_creds:
        raise ValueError("spec.backup.barmanObjectStore is missing s3Credentials")

    for cred_field in ("accessKeyId", "secretAccessKey"):
        ref = s3_creds.get(cred_field)
        if isinstance(ref, str):
            raise ValueError(
                f"s3Credentials.{cred_field} contains inline plaintext credential; "
                "must reference a Secret via name and key"
            )
        if not isinstance(ref, dict):
            raise ValueError(
                f"s3Credentials.{cred_field} must be a dict referencing a Secret"
            )
        ref_name = ref.get("name")
        ref_key = ref.get("key")
        if not isinstance(ref_name, str) or not ref_name.strip():
            raise ValueError(f"s3Credentials.{cred_field}.name must be a non-empty string")
        if not isinstance(ref_key, str) or not ref_key.strip():
            raise ValueError(f"s3Credentials.{cred_field}.key must be a non-empty string")

    # 3. WAL archiving validation (required for PITR)
    wal = barman.get("wal")
    if not isinstance(wal, dict) or not wal:
        raise ValueError("spec.backup.barmanObjectStore is missing wal archiving configuration")

    wal_compression = wal.get("compression")
    if wal_compression not in ALLOWED_WAL_COMPRESSION:
        raise ValueError(
            f"wal.compression must be one of {sorted(ALLOWED_WAL_COMPRESSION)}, got: {wal_compression!r}"
        )

    # 4. Retention policy validation
    # 리뷰 실측(이슈 #46): CNPG 1.30에서 retentionPolicy는 spec.backup의 직계 필드이고
    # barmanObjectStore 밑은 정의되지 않은 필드라 CRD가 거부한다. barman.get(...)을
    # 대체값으로 허용하면 최상위 값을 지우고 중첩시킨 실수를 이 게이트가 통과시키게
    # 되므로, 잘못 배치된 값이 있으면 그 자체로 실패시킨다(대체 경로로 구제하지 않는다).
    if "retentionPolicy" in barman:
        raise ValueError(
            "retentionPolicy must not be nested under spec.backup.barmanObjectStore "
            "(CNPG 1.30 defines it directly under spec.backup; the nested field is unknown "
            "to the CRD and will be rejected)"
        )
    retention = backup.get("retentionPolicy")
    if not isinstance(retention, str) or not retention.strip():
        raise ValueError("spec.backup.retentionPolicy must be set")
    if not RETENTION_PATTERN.match(retention.strip()):
        raise ValueError(
            f"retentionPolicy must match CNPG duration format '^[1-9][0-9]*[dwm]$' (e.g. '30d'), got: {retention!r}"
        )

    # 5. ScheduledBackup resource validation
    scheduled_backups = [
        r for r in resources
        if r.get("apiVersion", "").startswith("postgresql.cnpg.io/")
        and r.get("kind") == "ScheduledBackup"
        and r.get("metadata", {}).get("namespace", "database") == ns
        and r.get("spec", {}).get("cluster", {}).get("name") == "postgres-main"
    ]
    if not scheduled_backups:
        raise ValueError(
            f"No ScheduledBackup found in namespace '{ns}' targeting Cluster 'postgres-main'"
        )

    sched_resource = scheduled_backups[0]
    sched_name = sched_resource.get("metadata", {}).get("name", "unknown")
    sched_spec = sched_resource.get("spec", {})

    owner_ref = sched_spec.get("backupOwnerReference")
    if owner_ref != "self":
        raise ValueError(
            f"ScheduledBackup/{sched_name} backupOwnerReference must be 'self', got: {owner_ref!r}"
        )

    schedule = sched_spec.get("schedule")
    valid_cron, cron_err = validate_cron_expression(schedule)
    if not valid_cron:
        raise ValueError(f"ScheduledBackup/{sched_name} schedule is invalid: {cron_err}")

    method = sched_spec.get("method", "barmanObjectStore")
    if method != "barmanObjectStore":
        raise ValueError(
            f"ScheduledBackup/{sched_name} method must be 'barmanObjectStore', got: {method!r}"
        )

    bucket_provisioning = validate_bucket_provisioning(resources, destination_path)

    return {
        "cluster": f"{ns}/postgres-main",
        "bucketProvisioning": bucket_provisioning,
        "destinationPath": destination_path,
        "endpointURL": endpoint_url,
        "credentials": {
            "accessKeyIdSecret": s3_creds["accessKeyId"]["name"],
            "accessKeyIdKey": s3_creds["accessKeyId"]["key"],
            "secretAccessKeySecret": s3_creds["secretAccessKey"]["name"],
            "secretAccessKeyKey": s3_creds["secretAccessKey"]["key"],
        },
        "walCompression": wal_compression,
        "retentionPolicy": retention,
        "scheduledBackup": {
            "name": sched_name,
            "schedule": schedule,
            "backupOwnerReference": owner_ref,
            "method": method,
        },
    }


def _make_valid_fixture() -> list[dict[str, Any]]:
    cluster = {
        "apiVersion": "postgresql.cnpg.io/v1",
        "kind": "Cluster",
        "metadata": {"name": "postgres-main", "namespace": "database"},
        "spec": {
            "backup": {
                "barmanObjectStore": {
                    "destinationPath": "s3://beluga-postgres-backups/",
                    "endpointURL": "http://seaweedfs-s3.storage.svc.cluster.local:8333",
                    "s3Credentials": {
                        "accessKeyId": {"name": "postgres-backup-s3-credential", "key": "access-key"},
                        "secretAccessKey": {"name": "postgres-backup-s3-credential", "key": "secret-key"},
                    },
                    "wal": {"compression": "gzip"},
                },
                "retentionPolicy": "30d",
            }
        },
    }
    scheduled = {
        "apiVersion": "postgresql.cnpg.io/v1",
        "kind": "ScheduledBackup",
        "metadata": {"name": "postgres-main-backup", "namespace": "database"},
        "spec": {
            "cluster": {"name": "postgres-main"},
            "backupOwnerReference": "self",
            "method": "barmanObjectStore",
            "schedule": "0 0 2 * * *",
        },
    }
    job = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": "postgres-backup-bucket",
            "namespace": "storage",
            "annotations": {
                "argocd.argoproj.io/hook": "Sync",
                "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation",
                "argocd.argoproj.io/sync-wave": "0",
            },
        },
        "spec": {"template": {"spec": {"containers": [{
            "name": "create-bucket",
            "command": ["/bin/sh", "-c"],
            "args": ['curl -s -X PUT "http://s3/beluga-postgres-backups" --aws-sigv4 x'],
        }]}}},
    }
    identities = {"identities": [
        {"name": "postgres-backup-service",
         "actions": ["Read:beluga-postgres-backups", "Write:beluga-postgres-backups", "List:beluga-postgres-backups"]},
        {"name": "postgres-backup-provisioner", "actions": ["Admin:beluga-postgres-backups"]},
    ]}
    cm = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "seaweedfs-s3-identities-template", "namespace": "storage"},
        "data": {"identities.json": json.dumps(identities)},
    }
    return [cluster, scheduled, job, cm]


def self_test() -> int:
    """Run built-in negative and positive fixtures to prove fail-closed detection."""
    base = _make_valid_fixture()

    # 1. Positive baseline fixture must pass
    summary = validate_postgres_backup(base)
    assert summary["retentionPolicy"] == "30d", "positive fixture failed"

    negative_cases: list[tuple[str, Any]] = []

    # Missing spec.backup
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]
    negative_cases.append(("missing spec.backup", c))

    # Empty spec.backup
    c = copy.deepcopy(base)
    c[0]["spec"]["backup"] = {}
    negative_cases.append(("empty spec.backup", c))

    # Missing barmanObjectStore
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]["barmanObjectStore"]
    negative_cases.append(("missing barmanObjectStore", c))

    # Invalid destinationPath
    c = copy.deepcopy(base)
    c[0]["spec"]["backup"]["barmanObjectStore"]["destinationPath"] = "http://not-an-s3-uri"
    negative_cases.append(("invalid destinationPath", c))

    # Missing endpointURL
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]["barmanObjectStore"]["endpointURL"]
    negative_cases.append(("missing endpointURL", c))

    # Inline plaintext accessKeyId
    c = copy.deepcopy(base)
    c[0]["spec"]["backup"]["barmanObjectStore"]["s3Credentials"]["accessKeyId"] = "PLAINTEXT_KEY_ID"
    negative_cases.append(("inline plaintext accessKeyId", c))

    # Inline plaintext secretAccessKey
    c = copy.deepcopy(base)
    c[0]["spec"]["backup"]["barmanObjectStore"]["s3Credentials"]["secretAccessKey"] = "PLAINTEXT_SECRET"
    negative_cases.append(("inline plaintext secretAccessKey", c))

    # Missing key in secretKeyRef
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]["barmanObjectStore"]["s3Credentials"]["accessKeyId"]["key"]
    negative_cases.append(("missing secretKeyRef key", c))

    # Missing wal archiving
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]["barmanObjectStore"]["wal"]
    negative_cases.append(("missing wal archiving", c))

    # Invalid wal compression
    c = copy.deepcopy(base)
    c[0]["spec"]["backup"]["barmanObjectStore"]["wal"]["compression"] = "7zip"
    negative_cases.append(("invalid wal compression", c))

    # Missing retentionPolicy
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]["retentionPolicy"]
    negative_cases.append(("missing retentionPolicy", c))

    # retentionPolicy nested under barmanObjectStore instead of spec.backup (CNPG rejects
    # this as an unknown field - reviewer-found gap: the gate must not treat it as a
    # valid alternate location)
    c = copy.deepcopy(base)
    del c[0]["spec"]["backup"]["retentionPolicy"]
    c[0]["spec"]["backup"]["barmanObjectStore"]["retentionPolicy"] = "30d"
    negative_cases.append(("retentionPolicy nested under barmanObjectStore", c))

    # Invalid retentionPolicy format (e.g. non-duration, negative, zero)
    for bad_ret in ("invalid", "-10d", "0d", "30days", "1y"):
        c = copy.deepcopy(base)
        c[0]["spec"]["backup"]["retentionPolicy"] = bad_ret
        negative_cases.append((f"invalid retentionPolicy '{bad_ret}'", c))

    # Missing ScheduledBackup
    c = copy.deepcopy(base)
    c = [c[0]]
    negative_cases.append(("missing ScheduledBackup", c))

    # ScheduledBackup targeting different cluster
    c = copy.deepcopy(base)
    c[1]["spec"]["cluster"]["name"] = "other-cluster"
    negative_cases.append(("ScheduledBackup targeting different cluster", c))

    # ScheduledBackup with wrong backupOwnerReference
    c = copy.deepcopy(base)
    c[1]["spec"]["backupOwnerReference"] = "none"
    negative_cases.append(("wrong backupOwnerReference", c))

    # ScheduledBackup with invalid cron schedule
    for bad_cron in ("every day", "0 2 *", "0 0 2 * * * * *", "* * * * * 99",
                     # Reviewer-found gap: a well-formed 5-field Kubernetes CronJob
                     # expression must still fail - CNPG's ScheduledBackup uses
                     # robfig/cron, which requires 6 fields (seconds included).
                     "0 2 * * *"):
        c = copy.deepcopy(base)
        c[1]["spec"]["schedule"] = bad_cron
        negative_cases.append((f"invalid cron '{bad_cron}'", c))

    # Issue #5: bucket never provisioned (the 2026-10-04 production outage)
    c = copy.deepcopy(base)
    del c[2]
    negative_cases.append(("missing bucket-provisioning Job", c))

    c = copy.deepcopy(base)
    c[2]["spec"]["template"]["spec"]["containers"][0]["args"] = ["echo noop"]
    negative_cases.append(("Job does not PUT the bucket", c))

    c = copy.deepcopy(base)
    c[2]["metadata"]["annotations"]["argocd.argoproj.io/hook"] = "PostSync"
    negative_cases.append(("bucket Job not a Sync hook", c))

    c = copy.deepcopy(base)
    c[2]["metadata"]["annotations"]["argocd.argoproj.io/hook-delete-policy"] = "HookSucceeded"
    negative_cases.append(("bucket Job without BeforeHookCreation", c))

    c = copy.deepcopy(base)
    c[2]["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] = "5"
    negative_cases.append(("bucket Job ordered after the Cluster", c))

    c = copy.deepcopy(base)
    ids = json.loads(c[3]["data"]["identities.json"])
    ids["identities"][0]["actions"].append("Admin:beluga-postgres-backups")
    c[3]["data"]["identities.json"] = json.dumps(ids)
    negative_cases.append(("backup writer holds Admin", c))

    c = copy.deepcopy(base)
    ids = json.loads(c[3]["data"]["identities.json"])
    ids["identities"][1]["actions"] = ["Read:beluga-postgres-backups"]
    c[3]["data"]["identities.json"] = json.dumps(ids)
    negative_cases.append(("no identity can create the bucket", c))

    for desc, fixture in negative_cases:
        try:
            validate_postgres_backup(fixture)
            raise AssertionError(f"Negative fixture '{desc}' unexpectedly passed")
        except ValueError:
            pass

    return len(negative_cases)


def main() -> int:
    try:
        rejected_count = self_test()
        print(
            f"Postgres backup config self-test: {rejected_count} negative fixtures rejected; positive fixtures passed.",
            file=sys.stderr,
        )

        all_summaries = {}
        for profile, extra_args in PROFILES.items():
            cmd = ["helm", "template", str(CHART_PATH)] + extra_args
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                env={**os.environ, "KUBECONFIG": os.devnull},
            )
            resources = parse_manifests(proc.stdout)
            summary = validate_postgres_backup(resources)
            all_summaries[profile] = summary

        print(
            "OK: CloudNativePG postgres-main backup configuration verified across all profiles."
        )
        print(json.dumps(all_summaries, indent=2))
        return 0

    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except (ValueError, KeyError, TypeError, AssertionError, yaml.YAMLError) as exc:
        print(f"FAIL: postgres backup config validation: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
