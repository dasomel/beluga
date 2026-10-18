#!/usr/bin/env python3
"""Static render contract for the Beluga Manager audit DB (ADR-0009 rollout 3, D-MSSO-11a).

Asserts on the rendered beluga-platform chart (default domain and Kakao overlay):
1. CNPG Cluster platform-system/manager-db exists with database `manager`, owner `manager_owner`
   (bootstrap secret manager-db-owner) and a managed role `manager_writer` (login, passwordSecret
   manager-db-writer).
2. ConfigMap manager-db-migrations holds every files/manager-db/migrations/*.sql, byte for byte, and
   Job manager-db-migrate mounts it and applies them in lexical order with ON_ERROR_STOP.
3. domain-api env names/values match the shared contract (host, port, db, password/CA files, user from
   the writer Secret, SSO_WRITE_ENABLED).
4. No password literal appears in the rendered output of the audit DB resources.
Built-in negative self-tests prove the checks fail closed.
"""
from __future__ import annotations

import copy
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CHART = REPO_ROOT / "gitops" / "charts" / "beluga-platform"
MIGRATIONS = CHART / "files" / "manager-db" / "migrations"
SSO_VALUES = REPO_ROOT / "gitops" / "values" / "sso.yaml"
KAKAO_DOMAIN = REPO_ROOT / "gitops" / "values" / "domain-kakao.yaml"
NS = "platform-system"
DB_HOST = "manager-db-rw.platform-system.svc.cluster.local"

RENDERS: list[tuple[str, list[str]]] = [
    ("default", ["-f", str(SSO_VALUES)]),
    ("kakao", ["-f", str(CHART / "values.yaml"), "-f", str(CHART / "values-kakao.yaml"),
               "-f", str(SSO_VALUES), "-f", str(KAKAO_DOMAIN)]),
]

EXPECTED_ENV: dict[str, str] = {
    "MANAGER_DB_HOST": DB_HOST,
    "MANAGER_DB_PORT": "5432",
    "MANAGER_DB_NAME": "manager",
    "MANAGER_DB_PASSWORD_FILE": "/var/run/secrets/manager-db/password",
    "MANAGER_DB_SSL_CA_FILE": "/var/run/secrets/manager-db-ca/ca.crt",
    "SSO_WRITE_ENABLED": "true",
}


def render(extra: list[str]) -> list[dict[str, Any]]:
    out = subprocess.run(["helm", "template", str(CHART), *extra], check=True,
                         capture_output=True, text=True).stdout
    return [d for d in yaml.safe_load_all(out) if isinstance(d, dict)]


def find(docs: list[dict[str, Any]], kind: str, name: str) -> dict[str, Any]:
    for d in docs:
        meta = d.get("metadata", {})
        if d.get("kind") == kind and meta.get("name") == name and meta.get("namespace") == NS:
            return d
    raise ValueError(f"{kind} {NS}/{name} not rendered")


def check(docs: list[dict[str, Any]], migration_files: dict[str, str]) -> None:
    if not migration_files:
        raise ValueError("no files/manager-db/migrations/*.sql found")

    spec = find(docs, "Cluster", "manager-db")["spec"]
    init = spec.get("bootstrap", {}).get("initdb", {})
    if init.get("database") != "manager" or init.get("owner") != "manager_owner" \
            or init.get("secret", {}).get("name") != "manager-db-owner":
        raise ValueError("Cluster manager-db initdb must be database=manager owner=manager_owner secret=manager-db-owner")
    roles = {r.get("name"): r for r in spec.get("managed", {}).get("roles", [])}
    writer = roles.get("manager_writer")
    if not writer or not writer.get("login") or writer.get("ensure") != "present" \
            or writer.get("passwordSecret", {}).get("name") != "manager-db-writer":
        raise ValueError("Cluster manager-db must manage role manager_writer (login, ensure present, passwordSecret manager-db-writer)")

    cm = find(docs, "ConfigMap", "manager-db-migrations").get("data", {})
    for name, text in migration_files.items():
        if cm.get(name, "").rstrip("\n") != text.rstrip("\n"):
            raise ValueError(f"ConfigMap manager-db-migrations does not carry {name} verbatim")
    if set(cm) != set(migration_files):
        raise ValueError("ConfigMap manager-db-migrations has files that are not in files/manager-db/migrations")

    job = find(docs, "Job", "manager-db-migrate")
    pod = job["spec"]["template"]["spec"]
    if not any(v.get("configMap", {}).get("name") == "manager-db-migrations" for v in pod.get("volumes", [])):
        raise ValueError("Job manager-db-migrate does not mount ConfigMap manager-db-migrations")
    script = "\n".join(pod["containers"][0].get("command", []))
    if "ON_ERROR_STOP=1" not in script or "/migrations/*.sql" not in script or "| sort" not in script:
        raise ValueError("Job manager-db-migrate must apply /migrations/*.sql sorted with ON_ERROR_STOP=1")
    env = {e["name"]: e for e in pod["containers"][0].get("env", [])}
    if env.get("PGHOST", {}).get("value") != DB_HOST or env.get("PGSSLMODE", {}).get("value") != "verify-full":
        raise ValueError("Job manager-db-migrate must connect to the rw FQDN with sslmode=verify-full")
    if "secretKeyRef" not in env.get("PGPASSWORD", {}).get("valueFrom", {}):
        raise ValueError("Job manager-db-migrate PGPASSWORD must come from a secretKeyRef")

    dep = find(docs, "Deployment", "manager-domain-api")
    cenv = {e["name"]: e for e in dep["spec"]["template"]["spec"]["containers"][0].get("env", [])}
    for k, v in EXPECTED_ENV.items():
        if cenv.get(k, {}).get("value") != v:
            raise ValueError(f"domain-api env {k} must be {v!r}, got {cenv.get(k)!r}")
    ref = cenv.get("MANAGER_DB_USER", {}).get("valueFrom", {}).get("secretKeyRef", {})
    if ref.get("name") != "manager-db-writer" or ref.get("key") != "username":
        raise ValueError("domain-api MANAGER_DB_USER must come from Secret manager-db-writer key username")

    # The CNPG CA Secret also holds ca.key: every volume of Job and Deployment must project ca.crt only.
    for label, pod_spec in (("Job manager-db-migrate", pod), ("Deployment manager-domain-api", dep["spec"]["template"]["spec"])):
        for vol in pod_spec.get("volumes", []):
            sources = [vol] + vol.get("projected", {}).get("sources", [])
            for src in sources:
                sec = src.get("secret")
                if not sec or sec.get("secretName", sec.get("name")) != "manager-db-ca":
                    continue
                keys = [i.get("key") for i in sec.get("items") or []]
                if keys != ["ca.crt"]:
                    raise ValueError(f"{label} volume {vol.get('name')} must project only ca.crt of manager-db-ca "
                                     f"(items required, ca.key forbidden), got items={keys!r}")

    # No password literal: rendered audit DB resources must not carry any Secret or a literal PGPASSWORD/password value.
    for d in docs:
        if d.get("kind") == "Secret" and d.get("metadata", {}).get("name", "").startswith("manager-db-"):
            raise ValueError(f"Secret {d['metadata']['name']} must not be rendered (bootstrap creates it)")
    for e in [*env.values(), *cenv.values()]:
        if "PASSWORD" in e["name"] and "value" in e and not e["name"].endswith("_FILE"):
            raise ValueError(f"password env {e['name']} must not carry a literal value")


def self_test(docs: list[dict[str, Any]], files: dict[str, str]) -> None:
    def mutated(fn) -> list[dict[str, Any]]:
        c = copy.deepcopy(docs)
        fn(c)
        return c

    def drop_role(c):
        find(c, "Cluster", "manager-db")["spec"]["managed"]["roles"] = []

    def bad_env(c):
        for e in find(c, "Deployment", "manager-domain-api")["spec"]["template"]["spec"]["containers"][0]["env"]:
            if e["name"] == "MANAGER_DB_HOST":
                e["value"] = "x"

    def drop_cm(c):
        find(c, "ConfigMap", "manager-db-migrations")["data"] = {}

    def literal_pw(c):
        find(c, "Job", "manager-db-migrate")["spec"]["template"]["spec"]["containers"][0]["env"].append(
            {"name": "PGPASSWORD", "value": "hunter2"})

    def ca_whole_secret(c):
        for v in find(c, "Job", "manager-db-migrate")["spec"]["template"]["spec"]["volumes"]:
            if v.get("secret", {}).get("secretName") == "manager-db-ca":
                v["secret"].pop("items", None)

    def ca_key_projected(c):
        for v in find(c, "Deployment", "manager-domain-api")["spec"]["template"]["spec"]["volumes"]:
            if v.get("secret", {}).get("secretName") == "manager-db-ca":
                v["secret"]["items"].append({"key": "ca.key", "path": "ca.key"})

    for name, fn in (("no managed role", drop_role), ("CA Secret mounted whole", ca_whole_secret),
                     ("ca.key projected", ca_key_projected), ("wrong env", bad_env), ("empty configmap", drop_cm),
                     ("literal password", literal_pw)):
        try:
            check(mutated(fn), files)
        except ValueError:
            continue
        raise SystemExit(f"self-test failed: '{name}' mutation was not detected")


def main() -> int:
    files = {p.name: p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS.glob("*.sql"))}
    for label, extra in RENDERS:
        docs = render(extra)
        try:
            check(docs, files)
        except ValueError as exc:
            print(f"FAIL [{label}]: {exc}", file=sys.stderr)
            return 1
        if label == "default":
            self_test(docs, files)
        print(f"PASS [{label}]: manager-db render contract ({len(files)} migration file(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
