# Ephemeral storage bounds (#403, #408)

The two Beluga charts declare disk `emptyDir.sizeLimit` and container (including init)
`resources.requests/limits.ephemeral-storage` for all rendered Deployments, StatefulSets,
DaemonSets and Jobs. The current default/full/SSO union has 38 workloads, 52 containers,
no DaemonSets and **no `medium: Memory` emptyDirs**. CronJobs are also covered by the checker.
The [security render gate](../scripts/ci/check-k8s-security-baseline.py) rejects missing,
zero/negative bounds and requests above limits; Memory-only volumes are exempt. There is
no storage exception allowlist for standard rendered workloads. #408 additionally checks
CNPG/Flink CR inputs and admission defaults in chart-owned namespaces. Separately owned
system namespaces remain explicit exceptions below. Existing runtime-security debt remains
independently ratcheted.

## Budget basis and consequences

This is a declared bound, **not a hard filesystem quota or proof of scheduling capacity**.
Each container limit covers the sum of the disk emptyDir limits it mounts plus at least
128Mi for stdout logs and the writable layer. Shared volumes are counted conservatively
in each writer's budget; their use is also charged against the pod's aggregate limit.
Requests reserve a smaller measured working set or a conservative unmeasured floor, not
all possible simultaneous volume growth. Init requests are phase-dependent (Airflow's
home copy requests 2Gi); CPU/memory sizing is unchanged. Cluster/node placement and
nodefs/imagefs headroom still need live measurements; the sum of possible limits can
exceed the incident node's 19GB root filesystem. Kubelet detection is periodic and
storage/filesystem accounting must be supported. A container restart retains emptyDir;
pod replacement clears it. Controllers replace evicted long-running pods; Jobs may need
retry or hook re-sync according to their existing backoff policy.

- Configuration, CA/truststore and PID/socket bundles: 8–16Mi against observed 8–228KiB;
  Keycloak's 3,304KiB Quarkus build gets 256Mi for rebuilds. Its data/tmp get 128Mi each.
- Python dependencies: Superset 256Mi versus 54,280KiB; generator 32Mi versus 2,432KiB.
  Superset tmp gets 512Mi versus 78,692KiB, SeaweedFS tmp 256Mi versus 40,052KiB;
  other tmp volumes use 64–512Mi depending on API, JVM or installation work.
- APISIX logs: 256Mi versus 8KiB; each nginx body/proxy/FastCGI/uWSGI/SCGI buffer gets
  64Mi. Manager nginx cache gets 64Mi versus 24KiB. Excess can interrupt the single
  gateway/control pod and user traffic; no automatic notification pipeline is added.
- Trino: 2Gi per data/spill volume against coordinator 1,464KiB (worker not sampled),
  tmp 256Mi, truststore 16Mi. Eviction drops running queries and transient spill.
- OpenSearch: unmeasured demo search data gets 2Gi; existing config/log/tmp bounds stay
  64Mi/1Gi/512Mi. Eviction **loses the emptyDir search index** and interrupts this single
  database until OpenMetadata reindexes it. OpenMetadata's existing log/tmp budgets and
  migration limits stay bounded; neither full-profile workload was sampled.
- SeaweedFS, LDAP, etcd, VictoriaMetrics and Grafana keep their PVCs. Exceeding scratch,
  writable-layer or stdout limits can still interrupt their single replica. No PVC,
  replica count, image, probe or permission was changed.

## Airflow log retention and the 2GiB observation

The supplied snapshot labels **2,009,600KiB as `airflow-home`**. In the chart that volume
mounts `/home/airflow`, populated by copying the image's `.local` packages (the earlier
image inspection recorded about 1.9G). It is not a per-directory log measurement.
`airflow-state` mounts `/opt/airflow` and was only 532KiB in the same snapshot. Log growth
must be checked by directory live rather than inferred from the volume name.

The home limit remains **4Gi**, above the approximately 1.92GiB observed; state stays 2Gi,
tmp gets 512Mi and CA gets 8Mi. Main request/limit is **2304Mi/7Gi**. Explicit
`AIRFLOW_HOME=/opt/airflow`, `[logging] base_log_folder=/opt/airflow/logs` and
`dag_processor_child_process_log_directory=/opt/airflow/logs/dag_processor` put task and
DAG-processor file logs in the bounded state volume. The existing single LocalExecutor
pod starts two image `/clean-logs` processes covering `/opt/airflow/logs` and defensive
`/home/airflow/logs` cleanup. `AIRFLOW__LOG_RETENTION_DAYS=3` and
`AIRFLOW__LOG_CLEANUP_FREQUENCY_MINUTES=15` configure the **official Docker helper**,
not a core `[logging]` retention option. The existing supervisor's `wait -n` observes
helper termination as well as Airflow service failure.

The pinned [3.3.0 configuration source](https://github.com/apache/airflow/blob/3.3.0/airflow-core/src/airflow/config_templates/config.yml),
[Dockerfile](https://github.com/apache/airflow/blob/3.3.0/Dockerfile) and
[log groomer](https://github.com/apache/airflow/blob/3.3.0/scripts/docker/clean-logs.sh)
were inspected: the image installs `/clean-logs`; it removes aged `*.log` files by mtime
and prunes empty directories. Core `delete_local_logs` applies after remote upload;
this chart has no remote log sink, so enabling that option alone would not solve retention.
Static rendering, environment wiring and `bash -n` were verified locally; the actual
image helper, effective config, cleanup and task-log UI were **not executed live**.
An actively written/open file or a burst inside three days can still exceed a bound,
evict the **single LocalExecutor pod**, interrupt tasks and erase local logs. Retention
is not a byte quota. Follow up with remote logging or revise budgets from measured rates.

## Declared workload inventory

All values below are binary quantities; container entries are `name=request/limit`,
`init:` identifies init containers. Observed max is the largest individual volume in the
provided 2026-11-12 colima sample, not a pod total, peak history or new measurement.
"not sampled" is not zero. Connect's sample is post-incident; its earlier unbounded
log directory reached 10.9GB (issue #401), not 4KiB.

| Workload | Disk emptyDir (sizeLimit) | Container ephemeral request/limit | Live observed max |
|---|---|---|---|
| `Deployment/analytics/superset` | pylibs=256Mi, tmp=512Mi, superset-home=128Mi, ca-bundle=8Mi | superset=256Mi/1280Mi; init:install-authlib=192Mi/1Gi; init:build-ca-bundle=16Mi/256Mi | 78,692KiB (tmp) |
| `Deployment/analytics/trino-coordinator` | data-volume=2Gi, tmp=256Mi, truststore-volume=16Mi | trino=128Mi/2560Mi; init:build-truststore=16Mi/256Mi | 3,092KiB (tmp) |
| `Deployment/analytics/trino-worker` | data-volume=2Gi, tmp=256Mi | trino=128Mi/2560Mi | not sampled |
| `Deployment/governance/openmetadata` | truststore-volume=16Mi, tmp=512Mi, openmetadata-logs=1Gi | openmetadata=128Mi/2Gi; init:reseed-security-config=64Mi/1664Mi; init:build-truststore=32Mi/768Mi | not sampled |
| `Deployment/governance/opensearch` | opensearch-data=2Gi, opensearch-config=64Mi, opensearch-logs=1Gi, tmp=512Mi | opensearch=256Mi/4Gi; init:copy-opensearch-config=16Mi/256Mi | not sampled |
| `Deployment/iam/keycloak` | keycloak-data=128Mi, tmp=128Mi, quarkus-build=256Mi | keycloak=64Mi/768Mi; init:init-quarkus=32Mi/384Mi | 3,304KiB (quarkus-build) |
| `Deployment/iam/opa` | — | opa=32Mi/256Mi | not sampled |
| `Deployment/iam/openfga` | — | openfga=32Mi/256Mi; init:wait-for-database=16Mi/256Mi; init:migrate=16Mi/256Mi | not sampled |
| `Deployment/iam/openldap` | ldap-run=16Mi, tmp=64Mi | openldap=16Mi/256Mi | 12KiB (ldap-run) |
| `Deployment/lakehouse/lakekeeper` | — | lakekeeper=32Mi/256Mi | not sampled |
| `Deployment/orchestration/airflow-webserver` | ca-bundle=8Mi, airflow-home=4Gi, airflow-state=2Gi, tmp=512Mi | airflow=2304Mi/7Gi; init:build-ca-bundle=16Mi/256Mi; init:copy-airflow-home=2Gi/4608Mi | 2,009,600KiB (airflow-home) |
| `Deployment/platform-system/apisix` | conf-rw=16Mi, apisix-logs=256Mi, tmp=128Mi, client-body-temp=64Mi, proxy-temp=64Mi, fastcgi-temp=64Mi, uwsgi-temp=64Mi, scgi-temp=64Mi | apisix=64Mi/1Gi; init:init-conf=16Mi/256Mi | 60KiB (conf-rw) |
| `Deployment/platform-system/apisix-etcd` | — | etcd=32Mi/256Mi | not sampled |
| `Deployment/platform-system/apisix-ingress-controller` | conf-rw=16Mi | ingress-controller=32Mi/256Mi; init:wait-for-apisix-admin=16Mi/256Mi | 8KiB (conf-rw) |
| `Deployment/platform-system/grafana` | tmp=64Mi | grafana=32Mi/256Mi | 4KiB (tmp) |
| `Deployment/platform-system/manager-domain-api` | tmp=64Mi | domain-api=32Mi/256Mi | 4KiB (tmp) |
| `Deployment/platform-system/manager-web` | nginx-conf=8Mi, nginx-cache=64Mi, nginx-run=8Mi | web=16Mi/256Mi | 24KiB (nginx-cache) |
| `Deployment/streaming/clickstream-gen` | pylibs=32Mi, tmp=128Mi | producer=32Mi/384Mi | 2,432KiB (pylibs) |
| `Deployment/streaming/debezium-connect` | kafka-logs=256Mi, tmp=128Mi | connect=128Mi/512Mi | 4KiB (tmp) |
| `Job/analytics/superset-dashboard-import` | — | import=16Mi/256Mi | not sampled |
| `Job/database/db-roles-setup` | — | setup-roles=16Mi/256Mi | not sampled |
| `Job/database/shop-seed` | — | seed=16Mi/256Mi | not sampled |
| `Job/governance/openmetadata-migration` | tmp=256Mi, openmetadata-logs=256Mi | openmetadata-migration=64Mi/768Mi | not sampled |
| `Job/iam/keycloak-clients` | — | keycloak-clients=16Mi/256Mi | not sampled |
| `Job/iam/keycloak-group-mapper` | — | mapper=16Mi/256Mi | not sampled |
| `Job/iam/keycloak-ldap-federation` | — | keycloak-ldap-federation=16Mi/256Mi | not sampled |
| `Job/iam/keycloak-role-migration` | — | keycloak-role-migration=16Mi/256Mi | not sampled |
| `Job/iam/keycloak-users` | — | keycloak-users=16Mi/256Mi | not sampled |
| `Job/iam/openldap-init` | — | openldap-init=16Mi/256Mi | not sampled |
| `Job/lakehouse/lakekeeper-bootstrap` | tmp=64Mi | bootstrap=16Mi/256Mi | not sampled |
| `Job/lakehouse/lakekeeper-migrate` | — | migrate=16Mi/256Mi | not sampled |
| `Job/platform-system/internal-ca-distribution` | — | distribute=16Mi/256Mi | not sampled |
| `Job/platform-system/manager-db-migrate` | tmp=64Mi | migrate=16Mi/256Mi | not sampled |
| `Job/storage/postgres-backup-bucket` | tmp=64Mi | create-bucket=16Mi/256Mi | not sampled |
| `Job/streaming/debezium-register-shop` | tmp=64Mi | register=16Mi/256Mi | not sampled |
| `Job/streaming/flink-sql-submit` | rendered-sql-files=16Mi, flink-log=512Mi, tmp=256Mi | submit-sql=128Mi/1Gi | not sampled |
| `StatefulSet/platform-system/victoria-metrics` | — | victoria-metrics=32Mi/256Mi | not sampled |
| `StatefulSet/storage/seaweedfs` | identities=8Mi, tmp=256Mi | master-volume-s3=64Mi/512Mi; init:render-s3-identities=16Mi/256Mi | 40,052KiB (tmp) |

## Operator and task pods bounded in #408

The supplied **2026-11-13 colima kubelet `/stats/summary`** observations below are
pod totals (disk emptyDir + logs + writable layer), unlike the older volume samples.
They are single observations supplied by the owner, not new measurements or peaks.
No live cluster was accessed for this change.

| Source / supplied observation | Declared bounds and consequence |
|---|---|
| `postgres-main-1` 60.4MiB, `manager-db-1` 56.9MiB; scratch-data about 57MiB | Both CNPG `Cluster.spec.resources`: 64Mi/1280Mi ephemeral request/limit; `ephemeralVolumesSizeLimit.temporaryData: 1Gi` leaves ample scratch headroom plus 256Mi for logs/layer. Exceeding a bound can evict/restart a **single-instance database**; PVC data remains. |
| CNPG rollout | Both clusters are single-instance: changing `resources`/`ephemeralVolumesSizeLimit` changes the pod spec, so the operator recreates the only instance. Expect a short outage of postgres-main and manager-db at sync and a Debezium reconnect; verify with `tests/29` afterwards. |
| CNPG Memory shm: postgres-main 12MiB | `ephemeralVolumesSizeLimit.shm`: postgres-main **1536Mi**, manager-db **512Mi**, equal to their existing memory limits. Neither CR configures `shared_buffers` (PostgreSQL default 128MB). Main shared buffers and dynamic parallel-query shared memory are distinct; sizing shm from the observed 12MiB or shared_buffers alone can cause ENOSPC. Allowing the entire memory budget avoids an earlier arbitrary shm ceiling. Tmpfs is charged to RAM as used, is not disk ephemeral storage, does not reserve that capacity, and can still cause OOM at the unchanged memory limit. Effective settings must be confirmed live. |
| Flink JM 40.4MiB, TMs 57.9/46.4MiB | Shared `podTemplate` main container **128Mi/2Gi**, inherited by JM/TM; no role-specific templates or emptyDirs are declared here. `io.tmp.dirs` and `state.backend`/RocksDB are not configured: default local tmp/artifacts use this generous budget; HA/checkpoints remain on S3. Operator-generated volumes still require live inspection. CPU/memory `jobManager.resource` and `taskManager.resource` are unchanged; operator merge must preserve the storage keys. Eviction interrupts work and requires job recovery. |
| dbt and maintenance KPOs: unmeasured short-lived runs | dbt ephemeral **64Mi/1Gi**; Python Trino client ephemeral **16Mi/256Mi**. No CPU/memory requests or limits are added (unmeasured; a guessed memory limit would add an OOM-kill failure mode). Only the existing read-only CA ConfigMap is mounted; no emptyDirs need a sizeLimit. dbt image source creates/chowns `/opt/beluga/dbt` to UID 10001, runs as dbt, and the DAG sets no read-only root securityContext. Thus project `target/`, `logs/` and `/tmp` remain writable by source inspection; paths, environment, volumes and behavior were not changed. Eviction fails/retries the task under its existing policy. |
| Kafka brokers 6–7MiB (data on PVC); entity operator 41.1MiB; Flink operator 11.8MiB | Namespace admission defaults below. The pinned Strimzi 1.1.0 CRD schema is not vendored and support for arbitrary ephemeral-storage resource keys / pod-template tmp limits cannot be established offline. No speculative `KafkaNodePool`/`Kafka` field or PVC change was made. |

The CNPG operator is pinned to **1.30.0** in VERSIONS.md, but no CRD schema is vendored.
The CNPG field declarations above are **to confirm live against the installed CRD
(`kubectl explain cluster.spec.ephemeralVolumesSizeLimit`)**; offline Helm rendering
cannot validate upstream CRD acceptance or reconciliation.

## Namespace admission defaults (owner decision, 2026-11-13)

One `LimitRange` per chart-owned namespace sets **only** Container
`defaultRequest.ephemeral-storage: 32Mi` and `default.ephemeral-storage: 1Gi`.
No CPU/memory default, min, max or ratio is added. The 1Gi limit is over 16 times
the largest supplied unbounded chart-namespace pod observation (~60MiB); 32Mi is a
small scheduling reservation, not a predicted peak. A legitimate larger writer
without explicit limits can be evicted: give that workload an explicit measured budget.

- beluga-data: `database`, `storage`, `streaming`, `lakehouse`, `analytics`,
  `orchestration`, `governance`.
- beluga-platform: `platform-system`, `iam`.
- Namespaces wave **-5**, LimitRanges wave **-4**, before the earliest chart workloads/
  hooks (-2 in data, -1 in platform). Namespace creation therefore precedes admission
  defaults even on first install. No cross-Application ordering is implied.

Admission affects **only newly created pods and missing container fields**, not
running pods. On their next replacement, Kafka brokers (including generated init
containers), entity-operator containers, Strimzi operator and Flink operator in
`streaming` receive defaults where missing. CNPG-generated init/auxiliary containers
may also receive defaults if their operator omits explicit keys. CNPG database main
containers, Flink JM/TM main containers and both KPOs instead use the explicit budgets
above **if the installed operators preserve the CR inputs**; if they do not, their
missing fields receive defaults. This is a projected list from configuration and the
supplied snapshot, not an inventory of currently admitted live containers.

Static request calculation (default/SSO and full/SSO-full): standard pod scheduling
uses max(sum of app requests, largest init request), multiplied by replicas; includes
both CNPG instances, a conservative JM + two TMs, Kafka pool defaults, **all rendered
Jobs concurrently**, and both KPOs. Full totals **4,960Mi** (base **4,384Mi**). Adding a
conservative envelope of **100 additional defaulted containers = 3,200Mi** for upstream
operators/generated init/entity containers yields **8,160Mi = 8.556GB** (base 7.952GB),
below the supplied **18.7GB allocatable**. The 100 is a capacity scenario, not a measured
container count. It shows these small defaults fit aggregate disk request capacity;
it does not prove actual placement, other workloads, node pressure or filesystem space.
The CPU/memory sizing generator intentionally does not account for storage defaults.

## Documented namespace exceptions and open follow-ups

Owner decision **2026-11-13 (b)** limits this rollout to the nine chart-owned workload
namespaces. Leave the following separately owned namespaces **unbounded by this change**;
do not patch live pods or change `scripts/gitops/01-argocd-bootstrap.sh`.

| Excluded owner / namespace | Supplied observation and remaining source |
|---|---|
| ArgoCD / `argocd` | About **250MiB + 226MiB** in the supplied pod observations (not peaks). Older volume maximum 231,080KiB. Bootstrap/upstream PodSpec patches must bound scratch and containers in a separate decision. |
| MetalLB / `metallb-system` | About **119MiB**; older FRR volumes metrics 64,668KiB, frr-status 56,540KiB, frr-tmp 140KiB plus config/sockets. Bound the installed chart/FRR-K8s Deployment separately. |
| Cilium / `kube-system` (or its separately owned installation namespace) | About **10MiB**; Cilium policy CRs do not bound agent disk. Use installation chart/PodSpec resources and volume support. |
| cert-manager / `cert-manager` | No supplied pod-total measurement; chart only references/declares this external operator namespace, not ownership of its workloads. No LimitRange. |
| CNPG operator / `cnpg-system` | No supplied pod-total measurement (older controller scratch 4KiB); distinct from the two now-bounded database Clusters. No LimitRange. |
| System components / `kube-system` | No supplied aggregate measurement; includes separately installed metrics-server (older tmp-dir 12KiB). No LimitRange. |

**OpenSearch-on-emptyDir durability** remains open: its existing 2Gi data bound can
lose the index on eviction and needs durable storage/reindex planning. **Airflow remote
logging** remains open; local retention above is not durable storage or a byte quota.

## Hook revision ordering (#408)

The ordinary hook-revision ConfigMaps now follow every rendered Sync hook:
**beluga-data wave 2 > max hook wave 1**, **beluga-platform wave 6 > max hook wave 5**.
Sync-phase hooks and ordinary resources share wave ordering; earlier waves must succeed/
be healthy before the revision is applied. On a hook-only change, a failed earlier hook
should leave the revision out of sync so the next full sync retries, instead of recording
success prematurely. The checker asserts this against rendered hooks for every profile
and rejects equal/earlier-wave fixtures. Actual ArgoCD health and failed-hook/re-sync
behavior are **to confirm live**; this does not add automatic retries of failed syncs.

## To confirm live

- Effective node ephemeral allocatable, placement/requests, nodefs/imagefs accounting and
  steady/burst rates; bounds do not reserve their whole size or guarantee 20% free disk.
- Airflow actual `/clean-logs`, effective log paths and per-directory usage, aged-file
  removal over an interval, recent/active task logs in the UI, helper shutdown behavior.
- Controlled over-limit eviction/replacement in a disposable test workload, retained PVC
  data, service recovery and OpenSearch reindex; no production fault is authorized here.
- Installed CNPG CRD: `kubectl explain cluster.spec.ephemeralVolumesSizeLimit` and
  `cluster.spec.resources`; field retention, generated Pod disk budgets/emptyDirs,
  effective shared_buffers, parallel-query shm growth and unchanged memory limits.
- Flink generated JM/TM Pod resources after operator merging (CPU/memory retained,
  ephemeral keys preserved), generated artifact volumes, actual local tmp/state paths.
- Strimzi/other streaming operators' admitted containers, generated init/sidecars,
  defaults on replacement, actual counts and per-node summed requests vs allocatable.
- First-install Namespace → LimitRange → workloads, no defaults in excluded namespaces;
  existing pods stay unchanged until replacement.
- Hook-only change + controlled failed hook: revision remains OutOfSync, next full sync
  re-executes hooks, successful completion advances revision; full-profile budgets.
- Separately owned operator pods above, and alert collection/evaluation/notification.
