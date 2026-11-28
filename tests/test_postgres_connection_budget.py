"""Offline postgres-main connection budget (D-PGCONN-1).

Measured 2026-11-28: with max_connections=100, OpenFGA (30, its default) and the OpenMetadata
server (34; OM 1.13.3 defaults to a HikariCP pool of up to 100) left the openmetadata-migration
Sync hook no slots, so every beluga-data sync stalled. Guard:
- postgres-main max_connections is raised explicitly,
- the big pools carry explicit caps (OM server AND migration Job via the shared env helper, OpenFGA server),
- the worst case of those pools fits inside half of the shared limit. OpenMetadata's Flowable workflow
  engine keeps a second pool the Hikari env does not cap (measured 14 on the server pod; the migration
  context opens unpooled DriverManager connections), so each OM container is budgeted Hikari + Flowable.
"""
from pathlib import Path
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
FULL = ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
OM_MAX, OM_MIN, OPENFGA_MAX, OPENFGA_IDLE = 20, 5, 10, 5
FLOWABLE_ALLOWANCE = 20  # uncapped second OM pool (measured 14), budgeted per OM container


def render(chart, *extra):
    cmd = ["helm", "template", str(ROOT / "gitops/charts" / chart), *extra]
    return [d for d in yaml.safe_load_all(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout) if d]


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
        spec = doc["spec"]["template"]["spec"]
        for container in spec.get("initContainers", []) + spec["containers"]:
            env = env_of(container)
            if "DB_HOST" not in env:
                continue
            assert env.get("DB_CONNECTION_POOL_MAX_SIZE") == str(OM_MAX), (doc["metadata"]["name"], container["name"])
            for key in ("DB_CONNECTION_POOL_MIN_SIZE", "DB_CONNECTION_POOL_MIN_IDLE", "DB_CONNECTION_POOL_INITIAL_SIZE"):
                assert env.get(key) == str(OM_MIN), (doc["metadata"]["name"], container["name"], key)
            # Init containers finish before the pod's main container starts, so only main containers add up.
            if container in spec["containers"]:
                om_worst += OM_MAX + FLOWABLE_ALLOWANCE

    platform = render("beluga-platform", *FULL)
    openfga = next(d for d in platform if d["kind"] == "Deployment" and d["metadata"]["name"] == "openfga")
    server = next(c for c in openfga["spec"]["template"]["spec"]["containers"] if "OPENFGA_DATASTORE_URI" in env_of(c))
    for container in [server]:  # `openfga migrate` takes no pool flags
        env = env_of(container)
        assert env.get("OPENFGA_DATASTORE_MAX_OPEN_CONNS") == str(OPENFGA_MAX), container["name"]
        assert env.get("OPENFGA_DATASTORE_MAX_IDLE_CONNS") == str(OPENFGA_IDLE), container["name"]

    # OM server + migration Job (each Hikari cap + Flowable allowance, counted as concurrent) + OpenFGA must
    # use at most half of the shared limit; the rest is for Keycloak, Lakekeeper, Airflow, Debezium and the
    # superuser-reserved slots (all measured small and lazily opened).
    capped = om_worst + OPENFGA_MAX
    assert capped * 2 <= max_connections, (capped, max_connections)
    print(f"PASS: max_connections={max_connections}; OM server+migration (Hikari+Flowable) + OpenFGA worst case {capped}")


if __name__ == "__main__":
    main()
