# CDC replication-slot WAL retention

English | [한국어](cdc-slot-wal-retention-ko.md)

Applies to Debezium 3.6.1.Final, CNPG 1.30.0 and PostgreSQL 17.6 (pins in
[VERSIONS.md](../../VERSIONS.md)). No live recovery was performed for this change.

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
changes. A seed ConfigMap change takes effect through the rerun seed hook, and
connector PUT reloads the connector; no Deployment restart is needed for these.

## Detection (read-only)

Run `bash tests/29-cdc-slot-wal-retention.sh` with a working repo-local kubeconfig
or explicit KUBECONFIG. It isolates that config and checks heartbeat settings, a
positive WAL cap, an active pgoutput/shop slot, retained WAL <1GiB, DiskPressure=False
and every node's nodefs/imagefs free space >=20% (containerfs also if reported).
It prints retained bytes, confirmed_flush_lsn and filesystem bytes/percent. Missing
data or access fails closed. It requires pod exec and nodes/proxy read access;
it grants no RBAC. `CDC_WAL_MAX_BYTES` and `NODE_FS_MIN_FREE_PERCENT` override
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

## Evidence limits and upstream basis

- [Debezium 3.6 PostgreSQL connector](https://debezium.io/documentation/reference/3.6/connectors/postgresql.html): filtered publication, heartbeat query and topic naming.
- [CNPG v1.30.0 configuration source](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/pkg/postgres/configuration.go): `max_slot_wal_keep_size` is absent from the fixed/blocked parameter map; `wal_keep_size` defaults to 512MB. Source inspection supports configurability; deployed webhook acceptance and applied value still need live verification.
- [PostgreSQL 17 replication configuration](https://www.postgresql.org/docs/17/runtime-config-replication.html): checkpoint-time slot retention semantics.

Still live-only: seed privileges/Job ordering, existing publication update, pgoutput
heartbeat emission, topic readiness, task/offset flush, advancing confirmed_flush_lsn
while business tables are idle, CNPG acceptance/reload, checkpoint reclamation,
nodes/proxy access and Kafka/Flink continuity. Static renders prove none of these.
