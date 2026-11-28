# Flink HA Broken Checkpoint Handle Runbook

English | [한국어](flink-ha-broken-checkpoint-ko.md)

## Scope and incident context

This runbook covers the failure mode recorded in [issue #412](https://github.com/dasomel/beluga/issues/412) (measured on the Colima single-node lab on 2026-11-14 KST after a hard host power loss on 2026-11-13 ~01:43 KST) and the alerts declared in [ADR-0011](../adr/0011-alerting-vmalert-alertmanager.md) (`D-ALERT-21`).

When the host or storage layer loses power mid-write, SeaweedFS filer metadata can record a Flink HA checkpoint state handle whose backing volume chunk was not durable on disk (**inferred**: consistent with writes acknowledged before volume needle flush at the power cut). On restart, the Flink JobManager attempts to read the broken `completedCheckpoint*` handle from `s3a://beluga-lake/flink-system/ha/flink-cluster/`, fails with an `IOException` / `ConnectionClosedException`, and enters an indefinite `CrashLoopBackOff` with 0 `RUNNING` jobs.

## Symptoms and alerts

### Alerts (`gitops/charts/beluga-platform/files/observability/rules/pipeline.yml`)

| Alert | Expression | Window / Severity | Meaning |
|---|---|---|---|
| `FlinkNoRunningJobs` | `up{job="flink"} == 0 or absent(flink_jobmanager_numRunningJobs{job="flink"}) or flink_jobmanager_numRunningJobs{job="flink"} < 1` | `5m` / `critical` | JobManager Prometheus endpoint (`:9249` via `Service/flink-cluster-metrics`) is unreachable/down or reports 0 `RUNNING` jobs |
| `FlinkJobManagerRestarting` | `changes(container_start_time_seconds{job="kubelet-resource",namespace="streaming",container="flink-main-container"}[15m]) >= 2 or resets(flink_jobmanager_Status_JVM_CPU_Time{job="flink"}[15m]) >= 2` | `5m` / `warning` | Flink container start timestamp changed or JobManager JVM uptime reset at least twice within 15 minutes |
| `FlinkCheckpointsStalled` | `changes(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink"}[10m]) == 0` | `5m` / `critical` | A reported job completed no checkpoint for 10m. Iceberg sinks commit only on checkpoints, so its table stops receiving data while the job still looks `RUNNING` (D-ALERT-29) |
| `FlinkCheckpointsFailing` | `changes(flink_jobmanager_job_numberOfFailedCheckpoints{job="flink"}[15m]) >= 3` | `5m` / `warning` | The job's failed-checkpoint counter changed at least 3 times in 15m; commits are delayed and a stall may follow. VictoriaMetrics counts a new series' first sample as a change, so within 15m of a resubmission or JobManager restart two real failures suffice |
| `FlinkJobMissing` | `absent(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink",job_name="<name>"})` for each expected SQL job, only while `up{job="flink"} == 1` | `10m` / `critical` | An expected SQL job has no per-job series (FAILED, CANCELED or never resubmitted) while the JobManager is scraped (D-ALERT-30) |

### Log signatures (measured in #412)

In `kubectl -n streaming logs -l app=flink-cluster,component=jobmanager`:

```text
org.apache.flink.util.FlinkException: Could not retrieve checkpoint 11593 from state handle under checkpointID-0000000000000011593. This indicates that the retrieved state handle is broken. Try cleaning the state handle store.
...
Caused by: org.apache.http.ConnectionClosedException: Premature end of Content-Length delimited message body (expected: 6,640; received: 0)
```

reading `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint7747805683f9`. In the 2026-11-13 incident, the JobManager crash-looped for ~18 hours (43 restarts) while no streaming job ran.

## Diagnosis (read-only first)

Isolate a kubeconfig before running any `kubectl` command (never mutate shared `~/.kube/config`; on Colima, use the isolated tunnel kubeconfig described in [colima-single-node.md](../colima-single-node.md)):

```bash
kubectl --kubeconfig .kube/config config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
```

### 1. Inspect Flink pods and JobManager logs

```bash
kubectl -n streaming get flinkdeployment,pods -o wide
kubectl -n streaming logs -l app=flink-cluster,component=jobmanager --tail=200
kubectl -n streaming logs -l app=flink-cluster,component=jobmanager --previous --tail=200 || true
```

Note every `checkpointID-<19-digit-seq>` key and `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint*` path reported as broken.

### 2. Inspect Kubernetes HA ConfigMaps in namespace `streaming`

With `high-availability.type: kubernetes` (`gitops/charts/beluga-data/templates/05-flink-operator.yaml:28-30`), Flink stores HA metadata in ConfigMaps in namespace `streaming`:

- `flink-cluster-cluster-config-map`: holds cluster-level leader election entries and `jobGraph-<jobid>` references pointing to `s3a://beluga-lake/flink-system/ha/flink-cluster/jobGraph*`.
- `flink-cluster-<jobid>-config-map` (one ConfigMap per submitted job — three in Beluga's session cluster: `beluga-events_sessionization`, `beluga-cdc_orders`, `beluga-cdc_customers`): holds `checkpointID-<19-digit-seq>` keys (serialized state handles pointing to `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint*`), `counter`, and job-manager leader keys.

List the HA ConfigMaps and their keys (read-only):

```bash
for cm in $(kubectl -n streaming get configmap -o name | grep -E '^configmap/flink-cluster-'); do
  echo "=== ${cm} ==="
  kubectl -n streaming get "${cm}" -o jsonpath='{.data}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(sorted(d.keys())))'
done
```

### 3. Verify SeaweedFS chunk integrity (`weed shell` `fs.verify`)

Verify whether the backing SeaweedFS volume chunks under `/buckets` (`beluga-lake/flink-system/ha/flink-cluster/` and `beluga-lake/flink-system/checkpoints/`) are readable:

```bash
kubectl -n storage exec seaweedfs-0 -- sh -c 'printf "fs.verify /buckets\n" | weed shell'
```

In the 2026-11-14 #412 measurement, `fs.verify /buckets` scanned 24,577 files and reported 4 files failing with `not found, at volume server`: three `flink-system/ha/flink-cluster/completedCheckpoint*` state handles (one per job) and one `flink-system/checkpoints/fa8ed8f8…/chk-11593/_metadata` file written at the moment of the power loss. No Iceberg data or metadata file failed verification in that incident.

### 4. Checkpoints stalled or failing (`FlinkCheckpointsStalled` / `FlinkCheckpointsFailing`, D-ALERT-29)

The job can still be `RUNNING`; its Iceberg table simply stops receiving commits. Read-only checks:
list the jobs, read the checkpoint counts and the failure message of non-completed attempts (the
REST history keeps only the last 10 attempts, about 5 minutes at the 30s interval),
check backpressure on each vertex, then look for checkpoint, S3 or Iceberg commit warnings and
errors in the TaskManager logs (routine INFO commit lines are filtered out):

```bash
B=/api/v1/namespaces/streaming/services/flink-cluster-rest:8081/proxy
kubectl get --raw "$B/jobs/overview" | python3 -c 'import json,sys; [print(j["jid"], j["name"], j["state"]) for j in json.load(sys.stdin)["jobs"]]'
J=<jid of the alerted job_name>
kubectl get --raw "$B/jobs/$J/checkpoints" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["counts"]); f = (d.get("latest") or {}).get("failed"); print("latest failed:", f and (f["id"], (f.get("failure_message") or "")[:200])); [print(h["id"], h["status"], h.get("failure_message", "")[:200]) for h in d["history"] if h["status"] != "COMPLETED"]'
for V in $(kubectl get --raw "$B/jobs/$J" | python3 -c 'import json,sys; print(" ".join(v["id"] for v in json.load(sys.stdin)["vertices"]))'); do
  kubectl get --raw "$B/jobs/$J/vertices/$V/backpressure" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), d.get("backpressureLevel"))'
done
kubectl -n streaming logs -l component=taskmanager --prefix --tail=5000 | grep -E " (WARN|ERROR) " \
  | grep -iE "checkpoint|S3|Commit|Iceberg|timeout|refresh|ExpiredSignature" | grep -v "Not authorized: invalid_client" | tail -40
# Token-refresh noise (see below) is counted separately:
kubectl -n streaming logs -l component=taskmanager --prefix --since=15m --tail=-1 | grep -c " WARN .*Not authorized: invalid_client"
# The JobManager logs checkpoint trigger, expiry and decline messages:
kubectl -n streaming logs deploy/flink-cluster --tail=5000 | grep -iE "(fail|expired|declin)[a-z]* .*checkpoint|checkpoint.*(fail|expired|declin)" | tail -20
```

Known noise while it keeps its rhythm: `WARN org.apache.iceberg.util.Tasks - Retrying task after
failure: Not authorized: invalid_client`, with `OAuth2Util.refreshToken` in the stack. The Iceberg
1.7.1 client refreshes its Lakekeeper/signer token (client credentials, `expires_in=300`) by an
RFC 8693 token exchange shortly before expiry. The first attempt carries only the current bearer
token, so Keycloak answers `invalid_client`, and Iceberg retries it five times (five WARN lines).
It then repeats the token exchange with the client's Basic credentials, which succeeds only while
Keycloak client `flink` has `standard.token.exchange.enabled=true`. Measured 2026-11-28: one
five-line burst per auth session every 4-5 minutes (about 25 lines per cycle across both
TaskManagers; the count command above returns 75-100 for 15 minutes, i.e. three
to four cycles; it scales with the number of auth sessions, so with TaskManagers and jobs), no
`Failed to clean up on failure` ERROR, every checkpoint completing.

Treat it as the cause, together with failing or stalled checkpoints, when any of these holds: an
`ERROR org.apache.iceberg.util.Tasks - Failed to clean up on failure` appears (the Basic-credential
exchange was rejected too, e.g. `Standard token exchange is not enabled`; Iceberg then schedules
no further refresh); the regular bursts stop; Lakekeeper or the S3 signer
returns 401/`ExpiredSignature`; or client `flink` lacks `standard.token.exchange.enabled`. That
is the recorded incident in [`keycloak-clients.yaml` step 5b](../../gitops/charts/beluga-platform/templates/keycloak-clients.yaml), where a
client-credentials token request still succeeds, so a working client-credentials request does
not rule this out.

Typical causes and where they lead: a failure message about S3/SeaweedFS (check `storage`
pods and diagnosis step 3, `fs.verify`); Lakekeeper/Iceberg commit conflicts (check `lakehouse`
logs; a concurrent `iceberg_table_maintenance` run can conflict briefly); checkpoint timeouts with
`high` backpressure, as the REST API reports levels `ok`/`low`/`high` (slow sink or Kafka
catch-up); or a job stuck restarting (see the HA steps above). Data is not lost while Kafka still
retains the uncommitted offsets: the sources resume from their committed group offsets, and the
topics they read (`cdc.shop.public.orders`, `cdc.shop.public.customers`, `events.clickstream`)
keep 7 days (declared KafkaTopics with `retention.ms` 604800000, D-KT-1). Past that, the `earliest`
reset leaves a silent gap, so escalate well within 7 days or if the cause is unclear. Recovery
that discards state needs approval as below.

## Recovery procedure (state-discarding; requires owner/operator approval)

> [!WARNING]
> Removing `checkpointID-*` keys from `flink-cluster-<jobid>-config-map` is a **state-discarding recovery** when no older readable checkpoint handle remains in the ConfigMap. Obtain explicit operator/owner approval before mutating cluster ConfigMaps, retain all ConfigMap YAML backups, and never delete `jobGraph-*`, `counter`, or arbitrary keys.

Execute the exact steps performed in [issue #412](https://github.com/dasomel/beluga/issues/412):

### Step 1: Back up all three `flink-cluster-<jobid>-config-map` ConfigMaps

```bash
BACKUP_DIR="/tmp/flink-ha-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"
for cm in $(kubectl -n streaming get configmap -o name | grep -E '^configmap/flink-cluster-[0-9a-f]{32}-config-map$'); do
  name="${cm#configmap/}"
  kubectl -n streaming get configmap "${name}" -o yaml > "${BACKUP_DIR}/${name}.yaml"
  echo "Backed up ${BACKUP_DIR}/${name}.yaml"
done
```

### Step 2: Remove the broken `checkpointID-…` key from each affected ConfigMap

For each `flink-cluster-<jobid>-config-map` whose `checkpointID-<seq>` key points to an unreadable `completedCheckpoint*` object (confirmed via the JobManager exception log and/or `fs.verify /buckets`), remove only that `checkpointID-<seq>` key while preserving all other entries:

```bash
# Replace <jobid> and checkpointID-0000000000000011593 with the exact job ID and key from diagnosis:
kubectl -n streaming patch configmap "flink-cluster-<jobid>-config-map" \
  --type=json -p='[{"op":"remove","path":"/data/checkpointID-0000000000000011593"}]'
```

### Step 3: Delete the JobManager pod so it is recreated cleanly

```bash
kubectl -n streaming delete pod -l app=flink-cluster,component=jobmanager
kubectl -n streaming rollout status deployment/flink-cluster --timeout=180s
```

## Data guarantees lost when restarting without state

When the broken `checkpointID-…` handle is removed and no readable retained checkpoint remains, the JobManager logs `restored: 0` and restarts each job from its saved `jobGraph` without Flink state:

1. **Kafka source offset resumption (measured in repo and #350/#412 live runs)**:
   - All three SQL pipelines (`gitops/charts/beluga-data/files/flink-sql/{cdc_customers,cdc_orders,events_sessionization}.sql`) configure `'scan.startup.mode' = 'group-offsets'`, `'properties.auto.offset.reset' = 'earliest'`, and fixed per-job consumer groups (`flink-cdc-customers-group`, `flink-cdc-orders-group`, `flink-events-sessionization-group`; enforced by `tests/13-flink-sql-idempotent.sh:91-98`).
   - When a job restarts with no Flink checkpoint state (`restored: 0`), the Flink Kafka source resumes from the last offset committed to Kafka for that consumer group (committed on prior completed checkpoints) rather than re-reading the topic from `earliest-offset`.
2. **End-to-end Iceberg delivery across the recovery gap (inferred)**:
   - **Inferred** (not directly measured by an automated fault-injection test in this repo): **exactly-once delivery to Iceberg is not guaranteed across a state-discarding recovery gap.**
   - **Inferred**: Any Kafka records after the last consumer-group offset committed to Kafka (including records that were processed or committed in a two-phase Iceberg transaction whose HA checkpoint handle was lost, or buffered in in-memory operator state) are re-read from the Kafka group offset, while any un-checkpointed in-memory state is lost:
     - `lakekeeper.lake.customers` (`cdc_customers.sql:46-56`) and `lakekeeper.lake.orders` (`cdc_orders.sql:47-58`) declare `PRIMARY KEY (...) NOT ENFORCED` with `'write.upsert.enabled' = 'true'`. **Inferred**: replaying tail CDC events from the last committed Kafka group offset overwrites existing primary keys idempotently.
     - `lakekeeper.lake.events_enriched` (`events_sessionization.sql:52-61`) declares `PRIMARY KEY (user_id, window_start) NOT ENFORCED` **without** `'write.upsert.enabled' = 'true'` (append-only sink). **Inferred**: replaying tail clickstream events between the last Kafka-committed group offset and an already-committed Iceberg snapshot can produce duplicate rows across the gap, and any in-flight operator state from the discarded checkpoint is lost.

## Post-recovery verification

1. **Verify JobManager, TaskManagers, and all 3 `RUNNING` jobs**:
   ```bash
   kubectl -n streaming get pods -l app=flink-cluster
   JM_POD="$(kubectl -n streaming get pod -l app=flink-cluster,component=jobmanager -o jsonpath='{.items[0].metadata.name}')"
   kubectl -n streaming exec "${JM_POD}" -- curl -sf http://localhost:8081/jobs/overview
   ```
   Confirm `beluga-events_sessionization`, `beluga-cdc_orders`, and `beluga-cdc_customers` all report `"state":"RUNNING"`.

2. **Verify new checkpoints are completing (`counts.completed > 0`)**:
   checkpoint interval is `30s` (`05-flink-operator.yaml:13`). Wait at least 30–60s and inspect `/jobs/<jid>/checkpoints`:
   ```bash
   for jid in $(kubectl -n streaming exec "${JM_POD}" -- curl -sf http://localhost:8081/jobs | python3 -c 'import json,sys; print(" ".join(j["id"] for j in json.load(sys.stdin)["jobs"]))'); do
     echo "=== job ${jid} ==="
     kubectl -n streaming exec "${JM_POD}" -- curl -sf "http://localhost:8081/jobs/${jid}/checkpoints" | python3 -c 'import json,sys; c=json.load(sys.stdin)["counts"]; print(c)'
   done
   ```

3. **Run the streaming-to-Iceberg and alerting verification scripts**:
   ```bash
   KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash tests/03-stream-iceberg.sh
   KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash tests/31-alerting-pipeline.sh
   ```

## Why raising `state.checkpoints.num-retained` alone does not help

In Apache Flink 1.20 (`org.apache.flink.runtime.checkpoint.DefaultCompletedCheckpointStore.recover()`), HA recovery reads **every** `checkpointID-*` state handle stored in `flink-cluster-<jobid>-config-map` and invokes `retrieveCompletedCheckpoint(checkpointStateHandle)` on each handle to reconstruct the in-memory `completedCheckpoints` queue before picking the latest checkpoint.

If **any** retained `checkpointID-*` entry points to a truncated or missing S3 object in `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint*`, `retrieveCompletedCheckpoint` throws an exception and aborts recovery immediately — Flink does **not** ignore a corrupt newest handle and fall back to `checkpointID-(N-1)`. Consequently, raising `state.checkpoints.num-retained` alone leaves the broken newest handle in the ConfigMap and still crash-loops the JobManager until the broken handle is cleaned or custom/upstream recovery tolerance is introduced.

## Prevention: synchronous Flink storage writes (#412)

**Measured (repository/render):** `01a-seaweedfs-flink-fsync.yaml` runs an idempotent
`fs.configure -locationPrefix=... -fsync -apply` Sync hook at wave 1, after wave-0
`lakekeeper-bootstrap` has created the lake bucket. The default location is
`/buckets/beluga-lake/flink-system/`, derived from the same `flink.storage.bucket`
and `flink.storage.systemPrefix` values as HA and checkpoint paths. It prints
`fs.configure` and fails unless that exact location has `fsync: true`.
FlinkDeployment remains wave 0, so this is independent of Flink recovery and has
an initial-install window before the hook succeeds; it does not fix an existing
broken handle. Do not declare prevention active until the hook completes.

**Inferred (durability effect):** fsync makes each matching PUT wait for a disk
sync, narrowing the acknowledged-but-not-durable volume-write window. It does
not guarantee survival of filesystem/device/VM failure, atomicity between filer
metadata and volume data, or repair existing missing needles. It does not make
Flink tolerate a broken HA handle; use the recovery steps above if one remains.
`D-FSYNC-1` limits the default to Flink control state to avoid forcing disk syncs
on Iceberg data PUTs. Escape hatch: add templated absolute bucket locations to
`seaweedfs.fsyncPrefixes`; the Flink location is mandatory. Removing a list entry
does not delete its already-applied SeaweedFS rule; review explicit removal
separately. No cluster-wide fsync or storage version change is introduced.

**Measured (repository inspection):** SeaweedFS runs `weed server -dir=/data` with
`seaweedfs-data` PVC mounted at `/data`; the chart supplies no `filer.toml` or
explicit filer-store path. **Inferred, not verified offline:** `fs.configure`
stores its configuration as the filer entry `/etc/seaweedfs/filer.conf` (not a
container-local config file), and the embedded filer store should persist on
the PVC. The actual embedded-store directory and persistence must be confirmed
on the deployed 4.41 instance; the PVC mount alone does not prove either.

**To confirm live (not run by this change):** verify the hook completes and its
logs show the exact location with `fsync: true`; run
`KUBECONFIG=<isolated-config> bash tests/09-seaweedfs-authz-live.sh`. After an
operator-approved SeaweedFS pod restart, rerun that assertion **before another
ArgoCD sync can reapply the rule**, and inspect the filer store location. Check
new Flink checkpoints and recovery separately; static gates do not prove
power-loss durability. The hook reuses the repository's SeaweedFS 4.41 image tag;
a verified digest is absent locally and still needs to be supplied.
