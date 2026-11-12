# CDC replication-slot WAL retention

English | [한국어](cdc-slot-wal-retention-ko.md)

Applies to Debezium 3.6.1.Final, CNPG 1.30.0 and PostgreSQL 17.6 (pins in
[VERSIONS.md](../../VERSIONS.md)). This change was checked offline only; the incident
observations below come from the preserved 2026-11-12 evidence, not a new live run.

## Prevention and rollout

`shop-cdc` keeps slot `beluga_shop_slot` and explicitly names the existing default
publication `dbz_publication`. With `publication.autocreate.mode=filtered`, Debezium
updates an existing publication from `table.include.list`. The list now includes
`public.cdc_heartbeat` alongside orders/customers; with this mode, excluding that
table also excludes its writes from pgoutput. `heartbeat.interval.ms=10000` and
`heartbeat.action.query` UPSERT id=1 in shop so idle business tables do not pin
the shared instance's WAL. The CHECK constraint bounds the live table to one row;
autovacuum still needs to reclaim dead tuple versions.

The seed Job creates the table as the existing connector user/table owner
`beluga_admin`, and explicitly grants SELECT (snapshot/conflict reads), INSERT and
UPDATE there. No sequence privilege is needed. The generated `db-roles.sql` body
is unchanged. Registration remains idempotent `PUT /connectors/shop-cdc/config`,
in Sync wave 1 after the wave 0 seed Job, including on existing deployments.
PUT acceptance is not proof of task health: check task RUNNING and publication membership.

Two GitOps KafkaTopics in `03-cdc-heartbeat-topics.yaml` provide
`cdc.shop.public.cdc_heartbeat` (table CDC) and `__debezium-heartbeat.cdc.shop`
(Debezium heartbeat record, prefix explicitly configured). Each has one partition,
RF1, one-day delete retention and hourly segment rolling. Their creation does not
depend on broker/Connect auto-create defaults. Existing business-topic auto-creation
is unchanged. Flink SQL uses exact orders/customers/events topic names, so neither
heartbeat topic enters Iceberg jobs.

`max_slot_wal_keep_size=1GB` budgets slot retention against the declared 5Gi PGDATA
PVC, CNPG's default `wal_keep_size=512MB` and PostgreSQL's default `max_wal_size=1GB`.
These are overlapping retention constraints, not additive reservations. The limit
acts at checkpoints, can invalidate a lagging slot (`wal_status=lost`), and requires
a reviewed re-snapshot rather than risking node-wide eviction. It is not a hard
disk quota: checkpoint overshoot, failed WAL archiving, database growth and other
volumes can still fill the node. Recalculate after storage/traffic changes.

**Before syncing this fix to an incident cluster, recover Kafka and drain the
existing slot below 1GiB.** Applying the cap while 22GB is retained can invalidate
the slot at the next checkpoint. If catch-up is impossible without heartbeat,
use a reviewed, phased GitOps rollout (schema/topics/connector first, cap after
catch-up); do not apply the cap blindly. ArgoCD self-heal requires source-controlled
changes. A seed ConfigMap change needs a rerun seed hook, and connector PUT reloads
the connector. Verify both actually ran; the hook caveat below was observed live.

## Second cause: Connect logs on nodefs

The incident had two disk consumers. In addition to retained WAL on imagefs,
Connect's `/kafka/logs` emptyDir occupied the **19GB root filesystem (nodefs)**.
Hourly `connect-service.log.YYYY-MM-DD-HH` files had no retention/size cap:
normally ~68KB/hour, but Kafka reconnect WARN stack traces and Metadata INFO churn
grew to ~1GB/hour, 10.9GB on November 11. Removing rotated logs reduced nodefs usage
from 83% to 28%; healthy imagefs did not imply healthy nodefs. See preserved
[log evidence](../../research/incidents/2026-11-12-cdc-slot-wal-disk-pressure/raw/09-connect-log-growth.txt).

`debezium-connect-logging` now mounts console-only `log4j.properties` at
`/kafka/config/log4j.properties` (read-only subPath). NetworkClient, Metadata and
FetchSessionHandler are ERROR: this suppresses repeated reconnect WARN/INFO, not
a numeric messages/second rate limit, and reduces diagnostics during outages.
Restore WARN/INFO temporarily through GitOps when needed. Stdout relies on kubelet
container-log rotation; its actual settings and filesystem accounting need live confirmation.
The Pod checksum changes with the file to trigger rollout; an already deployed
ConfigMap-only edit instead requires an explicit authorized rollout restart.

Defense in depth: `kafka-logs` 256Mi (normally unused with console-only logging),
`tmp` 128Mi, ephemeral-storage request 128Mi and limit 512Mi. This budgets 384Mi
for emptyDirs plus 128Mi for runtime logs/writable layers, small relative to 19GB
nodefs. The request reserves scheduling budget, not disk space. Kubelet periodically
evicts a Pod exceeding limits; these are **not synchronous filesystem quotas** and
cannot guarantee node-wide pressure is impossible. Reassess after measured traffic
or storage changes. The existing read-only root filesystem stays enabled.

If the image ignores the mounted log config and the file appender stays active, the
bound still holds but the Pod hits `kafka-logs` 256Mi / ephemeral-storage 512Mi and is
evicted and recreated repeatedly (about every 15 minutes at the observed ~1GB/hour
outage rate). This is the accepted failure mode (D-LOG-4): one Pod restarts instead of the
whole node losing nodefs. Treat repeated Connect evictions (`kubectl -n streaming get
events`) as a signal that the logging config was not applied; fix the config, do not raise limits.

Offline basis: the [upstream 3.6 entrypoint](https://github.com/debezium/container-images/blob/main/connect-base/3.6/docker-entrypoint.sh)
loads `/kafka/config/log4j.properties`, rewrites `KAFKA_LOG4J_OPTS`, uses
`CONNECT_LOG4J_LOGGERS` for the root logger, and translates `CONNECT_LOG4J_*` / `LOG_LEVEL`
by editing that file. The [3.6 properties](https://github.com/debezium/container-images/blob/main/connect-base/3.6/log4j.properties)
use **Log4j 1 properties syntax**, with stdout plus DailyRollingFileAppender.
The mounted file avoids env-driven edits to a read-only mount. This source and the
incident filenames/pattern agree; the actual pinned `quay.io/debezium/connect:3.6.1.Final`
layers could not be inspected here (Docker socket denied, registry DNS unavailable).
Do not infer its exact logging implementation/JAR version from the source branch.
Before closing rollout, confirm the image's entrypoint/config contract, successful
startup, console output, applied logger levels and no new files through an outage
and an hourly rollover. Also confirm kubelet rotation and per-Pod eviction accounting.

## Detection (read-only)

Run `bash tests/29-cdc-slot-wal-retention.sh` with a working repo-local kubeconfig
or explicit KUBECONFIG. It isolates that config and checks heartbeat settings, a
positive WAL cap, an active pgoutput/shop slot, retained WAL <1GiB, `/kafka/logs`
allocated usage <=200MiB on **every** Connect pod (including old rolling-update pods), DiskPressure=False
and every node's nodefs/imagefs free space >=20% (containerfs also if reported).
It prints log bytes, retained bytes, confirmed_flush_lsn and filesystem bytes/percent. Missing
data or access fails closed. It requires pod exec and nodes/proxy read access;
it grants no RBAC. `CDC_WAL_MAX_BYTES`, `CONNECT_LOG_MAX_BYTES` and `NODE_FS_MIN_FREE_PERCENT` override
thresholds only for an explicitly justified environment.

VictoriaMetrics does not currently scrape CNPG's exporter (9187/default
`cnpg_pg_replication_slots_*`) or node filesystem metrics. There is no CNPG custom
query ConfigMap, rule evaluator, routed alerts or dashboard provisioning convention.
This test is registered in run-all but is a point-in-time signal; operators must
schedule it externally if notifications are needed. Automated monitoring remains open.

## Recovery (operator only, changes require incident authorization)

1. Preserve Events, node disk usage, connector status and slot LSNs before cleanup.
   **Do not drop or advance the slot, reset Connect offsets, or delete pg_wal files.**
   A small shop DB does not imply small WAL: all databases share the WAL directory.
2. Free safe, unrelated disk space or expand the node/volume under the incident
   plan. Preserve PostgreSQL/Kafka data and required WAL. Confirm nodefs and imagefs
   headroom and DiskPressure clearance; let Kafka reschedule and become ready.
3. Confirm Connect and shop-cdc task RUNNING. Check the heartbeat query's privileges,
   `pg_publication_tables` membership for all three tables in `dbz_publication`,
   and both heartbeat topics. Run the read-only test; record failures rather than
   changing thresholds to pass.
4. Query the primary repeatedly (e.g. 30–60 seconds apart) until
   `confirmed_flush_lsn` advances and retained bytes decrease. Do not issue a
   checkpoint with an over-cap lagging slot just to reclaim space.

   ```sql
   SELECT slot_name, active, wal_status, restart_lsn, confirmed_flush_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
   FROM pg_replication_slots WHERE slot_name = 'beluga_shop_slot';
   SELECT schemaname, tablename FROM pg_publication_tables
   WHERE pubname = 'dbz_publication';
   SHOW max_slot_wal_keep_size;
   ```

5. Once caught up and safely below the cap, an authorized PostgreSQL operator
   executes `CHECKPOINT;` on the primary. Verify actual pg_wal/node free-space
   reclamation and archiver health; `wal_keep_size` retains some WAL normally.
6. If `wal_status=lost` or required WAL is already unavailable, stop the automatic
   recovery attempt. Re-snapshot/reconcile downstream state under a separate
   approved recovery plan; `snapshot.mode=when_needed` is configured but does not
   prove safe recovery of a lost existing slot. Do not silently drop it. Verify
   orders/customers data continuity and all Flink jobs after recovery.

For all commands use an isolated config, never the shared current-context:

```bash
umask 077
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
kubectl --kubeconfig .kube/config config view --minify --flatten > "$CHECK_DIR/kubeconfig"
export KUBECONFIG="$CHECK_DIR/kubeconfig"
PRIMARY="$(kubectl -n database get cluster postgres-main -o jsonpath='{.status.currentPrimary}')"
# Run the SELECTs above with psql -X -v ON_ERROR_STOP=1 -U postgres -d shop
# inside: kubectl -n database exec "$PRIMARY" -c postgres -- psql ...
```

With that isolated config, inspect Connect logs without printing connector secrets:

```bash
kubectl -n streaming exec deploy/debezium-connect -c connect -- du -sk /kafka/logs
kubectl -n streaming exec deploy/debezium-connect -c connect -- \
  find /kafka/logs -maxdepth 1 -type f -name 'connect-service.log.20??-??-??-??' -ls
```

For authorized emergency cleanup, preserve timestamped samples and sizes first,
then delete **only closed hourly log files**, never Kafka data, offsets or pg_wal:

```bash
kubectl -n streaming exec deploy/debezium-connect -c connect -- \
  find /kafka/logs -maxdepth 1 -type f -name 'connect-service.log.20??-??-??-??' -delete
bash tests/29-cdc-slot-wal-retention.sh
```

The active `connect-service.log` is excluded. Cleanup is temporary until GitOps
rolls out console logging; Pod replacement removes its old emptyDir and local logs.

## ArgoCD hook-only changes and recovery

Issue #404 established the discriminator: **a hook resource is invisible to the
ArgoCD diff; check that a hook-only change makes the app OutOfSync**. Hooks do run
on a full sync. The WAL fix changed only hooks, leaving the Application `Synced`;
the controller logged `Skipping auto-sync: application status is Synced`, so no
full automated sync started. The earlier “no more tasks” result followed a mixed
partial sync, which skips hooks; it did not show that full sync cannot run them.

Both charts now emit a regular `<chart>-hook-revision` ConfigMap with per-hook
SHA-256 checksums of the rendered manifests (including values and included files).
Hook-only changes therefore produce a tracked diff and trigger a full automated
sync. `scripts/ci/check-hook-revisions.py` checks coverage and sensitivity offline;
this change still needs live confirmation of OutOfSync → auto-sync → hook completion.

**Never patch an Application's `operation` while an automated sync may be in
flight.** Mixing manual resource selection into it creates a partial sync that
skips hooks. After the reviewed commit is published, use refresh only:

```bash
kubectl -n argocd annotate application beluga-data argocd.argoproj.io/refresh=hard --overwrite
```

Refresh requests comparison; it is not proof of hook execution. Inspect operation
results and Job logs, then confirm connector/task state and LSN advancement.

The verified workaround was to render the two Jobs from the **main-branch chart**
with `gitops/values/sso.yaml` and run seed first, then registration (~17:57Z November 11).
The resulting connector/task were RUNNING, publication included cdc_heartbeat,
and idle-shop flush LSN advanced. [Recorded verification](../../research/incidents/2026-11-12-cdc-slot-wal-disk-pressure/raw/08-post-fix-verification.txt).
The following historical emergency procedure requires explicit incident authorization
and coordination after any active automated sync finishes. It uses fresh names so
completed Jobs/finalizers are not reused. Review a current main SHA and the actual
Application values first (add its profile/domain overlays when applicable).
Use the isolated config/`CHECK_DIR` above; do not print the full connector config.

```bash
MAIN_REV="$(git rev-parse origin/main)"  # review this main revision before executing
git archive "$MAIN_REV" gitops/charts/beluga-data gitops/values/sso.yaml | tar -x -C "$CHECK_DIR"
KUBECONFIG=/dev/null helm template "$CHECK_DIR/gitops/charts/beluga-data" \
  -f "$CHECK_DIR/gitops/values/sso.yaml" > "$CHECK_DIR/main-jobs.yaml"
```

Extract only the reviewed Jobs:

```bash
python3 - "$CHECK_DIR" <<'PY'
import pathlib, sys, time, yaml
root = pathlib.Path(sys.argv[1])
docs = [d for d in yaml.safe_load_all((root / 'main-jobs.yaml').read_text()) if d]
for name, ns in [('shop-seed', 'database'), ('debezium-register-shop', 'streaming')]:
    jobs = [d for d in docs if d.get('kind') == 'Job'
            and d['metadata'].get('namespace') == ns and d['metadata']['name'] == name]
    assert len(jobs) == 1, name
    job = jobs[0]
    job['metadata']['name'] = name + '-recovery-' + str(int(time.time()))
    job['metadata'].pop('annotations', None)  # standalone recovery copy, no Argo hooks
    (root / (name + '.yaml')).write_text(yaml.safe_dump(job))
PY
(
  set -eu
  for job in shop-seed debezium-register-shop; do
    kubectl create -f "$CHECK_DIR/$job.yaml"
    kubectl wait --for=condition=complete --timeout=600s -f "$CHECK_DIR/$job.yaml"
  done
  bash tests/29-cdc-slot-wal-retention.sh
)
```

Stop on seed failure; inspect Job status/logs before retrying. Also verify task RUNNING,
publication membership and repeated LSN advancement as above. The revision
ConfigMap fixes the sync trigger; actual hook completion remains a live check.

## Evidence limits and upstream basis

- [Debezium 3.6 PostgreSQL connector](https://debezium.io/documentation/reference/3.6/connectors/postgresql.html): filtered publication, heartbeat query and topic naming.
- [CNPG v1.30.0 configuration source](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/pkg/postgres/configuration.go): `max_slot_wal_keep_size` is absent from the fixed/blocked parameter map; `wal_keep_size` defaults to 512MB. Source inspection supports configurability; deployed webhook acceptance and applied value still need live verification.
- [PostgreSQL 17 replication configuration](https://www.postgresql.org/docs/17/runtime-config-replication.html): checkpoint-time slot retention semantics.

Still live-only: seed privileges/Job ordering, existing publication update, pgoutput
heartbeat emission, topic readiness, task/offset flush, advancing confirmed_flush_lsn
while business tables are idle, CNPG acceptance/reload, checkpoint reclamation,
nodes/proxy access and Kafka/Flink continuity. Static renders prove none of these.

## Alerts (issue #408)

Declared in `files/observability/rules/` of the platform chart; live verification
is still required. In Grafana (`https://grafana.<baseDomain>`, existing SSO), view
VictoriaMetrics data source-managed rules and the Alertmanager datasource for
active alerts/silences. Rules are edited in GitOps, not Grafana. Default receiver
is null: **no external notification is sent**; owner must choose a channel.

| Alert | Trigger / hold | Initial response |
|---|---|---|
| NodeRootFilesystemLow | root free <20% warning/10m, <12% critical/2m | Inspect nodefs, Connect/stdout logs, image GC; avoid unreviewed deletion |
| DataFilesystemLow | backing data FS free <20%/10m, <12%/2m | Inspect PGDATA/WAL and other local-path consumers; this is not PVC quota |
| ReplicationSlotRetainedWALHigh | >512MiB warning/10m, >900MiB critical/2m | Inspect Kafka/Connect, heartbeat and slot progress before 1GiB checkpoint cap |
| ReplicationSlotInactive | active=0 /15m | Check consumer health; do not drop slots to silence alerts |
| PgWalDirectoryLarge | pg_wal size >2GiB /10m | Check all slots, checkpoint and archive progress |
| WalArchiveBacklog | archive ready files >20 /15m | Check CNPG archiver, backup S3/credentials without logging secrets |
| ScrapeTargetDown | up=0 /10m | Check target, SD, RBAC, network and kubelet CA/SAN |
| Watchdog | vector(1) /1m | Must be firing in vmalert and present in Alertmanager; absence is not health |

Run read-only `bash tests/31-alerting-pipeline.sh` after deployment and >1m warmup.
This checks every node/both CNPG clusters and the `beluga_shop_slot` metric, then
rule evaluation and Watchdog delivery. It does not induce faults, restart workloads,
or test external delivery. Keep `tests/29-cdc-slot-wal-retention.sh` for direct
nodefs/imagefs/Connect log checks. cAdvisor root and volume available metrics cannot
attribute all pod ephemeral usage; PodEphemeralStorageHigh is intentionally absent.
If direct kubelet TLS fails, fix serving CA/SAN/network/token webhook configuration;
do not skip certificate verification or grant nodes/proxy without review.
