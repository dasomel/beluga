# Beluga #117 SecurityContext Analysis (HIGH Scan Hardening)

> 원본 스냅샷(2026-09-10 작성, `mdp/` 루트에서 이관 2026-10-15). 이후 머지된 #117 관련 변경은 반영되지 않았다 — 현재 상태는 이슈 #117와 main을 기준으로 확인한다.

## Summary table: workload | file | bucket | KSV ids

| Workload | File | Bucket | KSV IDs |
|---|---|---|---|
| `internal-ca-distribution` | `gitops/charts/beluga-platform/templates/internal-ca-distribution.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `keycloak-clients` | `gitops/charts/beluga-platform/templates/keycloak-clients.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `keycloak-group-mapper` | `gitops/charts/beluga-platform/templates/keycloak-group-mapper.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `keycloak-ldap-federation` | `gitops/charts/beluga-platform/templates/keycloak-ldap-federation.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `keycloak-role-migration` | `gitops/charts/beluga-platform/templates/keycloak-role-migration.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `keycloak-users` | `gitops/charts/beluga-platform/templates/keycloak-users.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `opa` | `gitops/charts/beluga-platform/templates/opa.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `openfga` | `gitops/charts/beluga-platform/templates/openfga.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `apisix-ingress-controller` | `gitops/charts/beluga-platform/templates/apisix-gateway.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (5) |
| `shop-seed` | `gitops/charts/beluga-data/templates/02b-shop-seed.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `db-roles-setup` | `gitops/charts/beluga-data/templates/02c-db-roles.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `lakekeeper-migrate` | `gitops/charts/beluga-data/templates/04-lakekeeper.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `lakekeeper` | `gitops/charts/beluga-data/templates/04-lakekeeper.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `superset-dashboard-import` | `gitops/charts/beluga-data/templates/15-superset-import.yaml` | SAFE-NOW | KSV-0014, KSV-0118 (3) |
| `seaweedfs` | `gitops/charts/beluga-data/templates/01-seaweedfs.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (5) |
| `debezium-connect` | `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (3) |
| `debezium-register-shop` | `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (3) |
| `trino-coordinator` | `gitops/charts/beluga-data/templates/06-trino.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (5) |
| `lakekeeper-bootstrap` | `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (3) |
| `flink-sql-submit` | `gitops/charts/beluga-data/templates/14-flink-jobs.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (3) |
| `apisix` | `gitops/charts/beluga-platform/templates/apisix-gateway.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (4) |
| `apisix-etcd` | `gitops/charts/beluga-platform/templates/apisix-infra.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (3) |
| `keycloak` | `gitops/charts/beluga-platform/templates/keycloak.yaml` | NEEDS-VOLUME | KSV-0014, KSV-0118 (3) |
| `clickstream-gen` | `gitops/charts/beluga-data/templates/13-clickstream-gen.yaml` | RISKY | KSV-0014, KSV-0118 (3) |
| `airflow-webserver` | `gitops/charts/beluga-data/templates/07-airflow.yaml` | RISKY | KSV-0014, KSV-0118 (5) |
| `superset` | `gitops/charts/beluga-data/templates/08-superset.yaml` | RISKY | KSV-0014, KSV-0118 (6) |

## SAFE-NOW (the recommended first increment — list exact YAML to add per workload)

These 14 workloads (44 findings) perform no disk writes and run non-root without extra volumes.

Add to Pod `.spec.template.spec`:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: <UID>
```
Add to all containers `.containers[].securityContext`:
```yaml
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
```

Exact `<UID>` mapping:
- `internal-ca-distribution`, `keycloak-clients`, `keycloak-group-mapper`, `keycloak-ldap-federation`, `keycloak-role-migration`, `keycloak-users`, `superset-dashboard-import`: Python stdlib HTTP scripts -> `runAsUser: 10001`.
- `shop-seed`, `db-roles-setup`: Non-interactive psql scripts -> `runAsUser: 26`.
- `lakekeeper-migrate`, `lakekeeper`: Rust distroless binary -> `runAsUser: 65532`.
- `opa`, `openfga`: In-memory static Go daemons -> `runAsUser: 1000`.
- `apisix-ingress-controller`: Image defaults to 65532; init writes to `/conf-rw` emptyDir -> `runAsUser: 65532`.

## NEEDS-VOLUME (path list per workload)

These 9 workloads (32 findings) crash on read-only rootfs without `emptyDir` mounts:
- `seaweedfs` (`01-seaweedfs.yaml`): `/tmp` — writes glog files and socket `/tmp/seaweedfs-master-grpc-*.sock` (crashes fatally without `/tmp`).
- `debezium-register-shop` (`03-strimzi-kafka.yaml`): `/tmp` — L221 writes `curl -s -o /tmp/resp`.
- `debezium-connect` (`03-strimzi-kafka.yaml`): `/kafka/logs`, `/tmp` — Kafka Connect log4j logs and JVM hsperfdata.
- `trino-coordinator` (`06-trino.yaml`): `/data/trino`, `/tmp` — writes query logs, node state, spills to `/data/trino`, and JVM scratch in `/tmp`.
- `lakekeeper-bootstrap` (`12-lakekeeper-bootstrap.yaml`): `/tmp` — L46 runs `mktemp -d` to create `s3.netrc` and `warehouse.json`.
- `flink-sql-submit` (`14-flink-jobs.yaml`): `/opt/flink/lib`, `/tmp` — L65-71 downloads 4 connector JARs via `curl -o /opt/flink/lib/...`.
- `apisix` (`apisix-gateway.yaml`): `/usr/local/apisix/logs`, `/tmp` — Nginx writes `error.log`, `access.log`, `nginx.pid`.
- `apisix-etcd` (`apisix-infra.yaml`): `/var/etcd/data` PVC requires Pod `fsGroup: 10001` when switching off root.
- `keycloak` (`keycloak.yaml`): `/opt/keycloak/data`, `/tmp` — Quarkus augmentation and Infinispan local cache state.

## RISKY / NOT-OURS (one line each, why)

- `clickstream-gen` (`13-clickstream-gen.yaml`): RISKY — L35 runs `pip install kafka-python-ng==2.2.2` at boot as root into system site-packages; read-only rootfs or non-root aborts entrypoint.
- `airflow-webserver` (`07-airflow.yaml`): RISKY — L150 runs `pip install` at boot; `airflow standalone` generates credentials and logs in `/opt/airflow`.
- `superset` (`08-superset.yaml`): RISKY — `install-authlib` init container mandates `runAsUser: 0` (L95) for `uv pip install`; main container writes reload caches.
- Operator CRs (`02-cnpg.yaml`, `03-strimzi-kafka.yaml` Kafka/NodePool, `05-flink-operator.yaml`): NOT-OURS / OPERATOR-MANAGED — Pod specs are controlled by upstream operators; Trivy skipped them, and hardening requires operator CR fields.

## Gate advice: can sast.yml HIGH exit-code go to 1 after the SAFE-NOW increment? If not, what remains blocking?

**No. `exit-code` must remain `0`.**
SAFE-NOW resolves 44 of 90 HIGH findings. Setting `exit-code: 1` breaks CI on the remaining 46 findings across 9 `NEEDS-VOLUME` (32 findings) and 3 `RISKY` workloads (14 findings).

Remaining blockers:
1. 9 `NEEDS-VOLUME` workloads require `emptyDir` mounts and cluster verification avoiding SSA volume collisions (#117, #109).
2. 3 `RISKY` workloads (`airflow`, `superset`, `clickstream-gen`) cannot be fixed by YAML alone while executing runtime `pip install` or requiring root. They need pre-built images or file-scoped `.trivyignore.yaml` exceptions.
