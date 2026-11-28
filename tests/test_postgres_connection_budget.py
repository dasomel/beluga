"""Offline postgres-main connection budget (D-PGCONN-1).

Measured 2026-11-28: with max_connections=100, OpenFGA (30, its default) and the OpenMetadata
server (34; OM 1.13.3 defaults to a HikariCP pool of up to 100) left the openmetadata-migration
Sync hook no slots, so every beluga-data sync stalled. Guard:
- postgres-main max_connections is raised explicitly,
- the big pools carry explicit caps (OM server AND migration Job, OpenFGA run AND migrate),
- the declared worst case of those capped pools fits well inside the shared limit.
"""
from pathlib import Path
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
FULL = ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
OM_MAX, OM_MIN, OPENFGA_MAX, OPENFGA_IDLE = 20, 5, 10, 5


def render(chart, *extra):
    cmd = ["helm", "template", str(ROOT / "gitops/charts" / chart), *extra]
    return [d for d in yaml.safe_load_all(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout) if d]


def pod_containers(doc):
    spec = doc["spec"]["template"]["spec"]
    return spec.get("initContainers", []) + spec["containers"]


def env_of(container):
    return {e["name"]: e.get("value") for e in container.get("env", [])}


def main():
    data = render("beluga-data", *FULL)
    cluster = next(d for d in data if d["kind"] == "Cluster" and d["metadata"]["name"] == "postgres-main")
    max_connections = int(cluster["spec"]["postgresql"]["parameters"]["max_connections"])
    assert max_connections >= 200, max_connections

    om_users = [(d["kind"], d["metadata"]["name"]) for d in data
                if d["kind"] in ("Deployment", "Job") and d["metadata"]["name"] in ("openmetadata", "openmetadata-migration")]
    assert sorted(om_users) == [("Deployment", "openmetadata"), ("Job", "openmetadata-migration")], om_users
    om_worst = 0
    for doc in data:
        if (doc["kind"], doc["metadata"]["name"]) not in om_users:
            continue
        for container in pod_containers(doc):
            env = env_of(container)
            if "DB_HOST" not in env:
                continue
            assert env.get("DB_CONNECTION_POOL_MAX_SIZE") == str(OM_MAX), (doc["metadata"]["name"], container["name"])
            for key in ("DB_CONNECTION_POOL_MIN_SIZE", "DB_CONNECTION_POOL_MIN_IDLE", "DB_CONNECTION_POOL_INITIAL_SIZE"):
                assert env.get(key) == str(OM_MIN), (doc["metadata"]["name"], container["name"], key)
            om_worst += OM_MAX

    platform = render("beluga-platform", *FULL)
    openfga = next(d for d in platform if d["kind"] == "Deployment" and d["metadata"]["name"] == "openfga")
    fga = [c for c in pod_containers(openfga) if "OPENFGA_DATASTORE_URI" in env_of(c)]
    assert len(fga) == 2, [c["name"] for c in fga]  # migrate init container + server
    for container in fga:
        env = env_of(container)
        assert env.get("OPENFGA_DATASTORE_MAX_OPEN_CONNS") == str(OPENFGA_MAX), container["name"]
        assert env.get("OPENFGA_DATASTORE_MAX_IDLE_CONNS") == str(OPENFGA_IDLE), container["name"]

    # Every OM container with DB env (server, its reseed init container, migration Job) plus OpenFGA, all at
    # their caps and counted as concurrent (conservative), must use at most half of the shared limit. The
    # rest is left for Keycloak, Lakekeeper, Airflow, Debezium and the superuser-reserved slots.
    capped = om_worst + OPENFGA_MAX
    assert capped * 2 <= max_connections, (capped, max_connections)
    print(f"PASS: max_connections={max_connections}; capped OM server+migration+OpenFGA worst case {capped}")


if __name__ == "__main__":
    main()
