"""Offline contract: Superset keeps its metadata in a dedicated Postgres database (D-SSDB-1).

Measured 2026-11-28: superset_config.py never read SQLALCHEMY_DATABASE_URI, so Superset ran on
its default SQLite file in an emptyDir and lost users, roles and user-made charts/dashboards on
every pod replacement. The env also pointed at beluga_meta, which is Airflow's metadata DB and
already holds Airflow's FAB ab_* tables (name clash with Superset's FAB tables).
"""
from pathlib import Path
import re
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]


def render(*extra):
    cmd = ["helm", "template", str(ROOT / "gitops/charts/beluga-data"), *extra]
    return [d for d in yaml.safe_load_all(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout) if d]


def main():
    full = ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
    for name, extra in {"default": [], "full": full}.items():
        docs = render(*extra)
        config = next(d for d in docs if d["kind"] == "Secret" and d["metadata"]["name"] == "superset-config")
        source = config["stringData"]["superset_config.py"]
        assert re.search(r'^SQLALCHEMY_DATABASE_URI = os\.environ\["SQLALCHEMY_DATABASE_URI"\]$', source, re.M), name
        compile(source, "superset_config.py", "exec")

        deploy = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "superset")
        spec = deploy["spec"]["template"]["spec"]
        app = next(c for c in spec["containers"] if c["name"] == "superset")
        uri = next(e["value"] for e in app["env"] if e["name"] == "SQLALCHEMY_DATABASE_URI")
        assert uri.startswith("postgresql+psycopg2://") and uri.endswith("/superset"), (name, uri)
        assert "/beluga_meta" not in uri, name  # Airflow's DB
        installer = next(c for c in spec["initContainers"] if c["name"] == "install-authlib")
        assert re.search(r"'psycopg2-binary==\d+\.\d+\.\d+'", installer["command"][-1]), name  # pinned driver

        # The DB must be created by the CNPG operator: the db-roles-setup hook runs as beluga_admin, which has
        # no CREATEDB (measured: "permission denied to create database"), and initdb runs on fresh clusters only.
        dbs = [d for d in docs if d["kind"] == "Database" and d["spec"]["name"] == "superset"]
        assert len(dbs) == 1, name
        spec = dbs[0]["spec"]
        assert dbs[0]["apiVersion"] == "postgresql.cnpg.io/v1" and dbs[0]["metadata"]["namespace"] == "database", name
        assert spec["owner"] == "beluga_admin" and spec["cluster"] == {"name": "postgres-main"}, name
        assert spec.get("ensure", "present") == "present" and spec["databaseReclaimPolicy"] == "retain", name
        roles = next(d for d in docs if d["kind"] == "Job" and d["metadata"]["name"] == "db-roles-setup")
        assert "CREATE DATABASE superset" not in roles["spec"]["template"]["spec"]["containers"][0]["command"][-1], name
        # D-SSDB-2: the dashboard import runs only after Superset is Ready on the new pod.
        probe = app.get("readinessProbe", {}).get("httpGet", {})
        assert probe.get("path") == "/health" and probe.get("port") in ("http", 8088), (name, probe)
        assert "livenessProbe" not in app, name
        importer = next(d for d in docs if d["kind"] == "Job" and d["metadata"]["name"] == "superset-dashboard-import")
        wave = lambda d: int((d["metadata"].get("annotations") or {}).get("argocd.argoproj.io/sync-wave", "0"))
        assert importer["metadata"]["annotations"]["argocd.argoproj.io/hook"] == "Sync", name
        assert wave(importer) > wave(deploy), (name, wave(importer), wave(deploy))
        print(f"PASS: {name}: Superset reads its Postgres URI, uses a dedicated 'superset' DB created by the CNPG operator on fresh and existing clusters")


if __name__ == "__main__":
    main()
