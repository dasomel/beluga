# Ephemeral storage bounds (#403)

The two Beluga charts declare disk `emptyDir.sizeLimit` and container (including init)
`resources.requests/limits.ephemeral-storage` for all rendered Deployments, StatefulSets,
DaemonSets and Jobs. The current default/full/SSO union has 38 workloads, 52 containers,
no DaemonSets and **no `medium: Memory` emptyDirs**. CronJobs are also covered by the checker.
The [security render gate](../scripts/ci/check-k8s-security-baseline.py) rejects missing,
zero/negative bounds and requests above limits; Memory-only volumes are exempt. There is
no storage exception allowlist. Existing runtime-security debt remains independently ratcheted.

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

## Out of scope and follow-up mechanisms

These pods are generated by separately installed upstream components or operator CRs,
not standard PodSpecs rendered by these two charts. Do not patch their live pods.

| Owner / observed volumes | Follow-up source that can bound them |
|---|---|
| ArgoCD repo/dex/controller/server/applicationset; max 231,080KiB (`var-files` / `static-files`) | Bootstrap-owned upstream install/Kustomize PodSpec patches: `volumes[].emptyDir.sizeLimit` and every container's ephemeral requests/limits. No ArgoCD operator CR is used here. |
| MetalLB FRR-K8s; metrics 64,668KiB, frr-status 56,540KiB, frr-tmp 140KiB plus sockets/config/reloader | Upstream MetalLB/FRR-K8s chart values for container resources; version-specific template/Kustomize volume patch if the chart exposes no sizeLimit. MetalLB address-pool/BGP CRs do not set pod scratch limits. |
| CNPG `postgres-main` / `manager-db`; scratch-data 58,120 / 58,116KiB; **Memory** shm 12,036 / 1,056KiB | `Cluster.spec.ephemeralVolumesSizeLimit.temporaryData` / `.shm`, plus `Cluster.spec.resources` ephemeral requests/limits. Alternatively `spec.ephemeralVolumeSource.volumeClaimTemplate` for temporary disk, mutually exclusive with temporaryData. Operator controller scratch (4KiB) belongs to its installation Deployment. [CNPG 1.30](https://cloudnative-pg.io/docs/1.30/cluster_conf/#ephemeral-volumes). |
| Cilium agent tmp 656KiB; metrics-server tmp-dir 12KiB | Separately installed chart/manifests: resource values and supported volume overrides, otherwise owned PodSpec patches; CiliumNetworkPolicy cannot bound agent disk. |
| Strimzi-managed Kafka pools/brokers and entity operator (not sampled) | `KafkaNodePool.spec.resources`, Kafka entity-operator component resources and pod-template `tmpDirSizeLimit`; ephemeral data storage uses `storage.sizeLimit` when applicable, without changing existing PVCs. Check the pinned CRD support/medium for each generated volume, including additional template volumes. [Strimzi API](https://strimzi.io/docs/operators/1.1.0/configuring.html). |
| Flink operator / generated Flink pods; flink-artifacts-volume and user-artifacts-volume each 4KiB | Separate operator Helm values and `FlinkDeployment.spec.podTemplate` (or jobManager/taskManager podTemplate): emptyDir sizeLimit and container resource overrides; check merge behavior in the pinned CRD. |

## To confirm live

- Effective node ephemeral allocatable, placement/requests, nodefs/imagefs accounting and
  steady/burst rates; bounds do not reserve their whole size or guarantee 20% free disk.
- Airflow actual `/clean-logs`, effective log paths and per-directory usage, aged-file
  removal over an interval, recent/active task logs in the UI, helper shutdown behavior.
- Controlled over-limit eviction/replacement in a disposable test workload, retained PVC
  data, service recovery and OpenSearch reindex; no production fault is authorized here.
- Hook Job completion/retries and full-profile bootstrap within budgets.
- Separately owned operator pods above, and alert collection/evaluation/notification.
