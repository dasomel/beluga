# Data Lifecycle Policy (Proposal)

English | [한국어](data-lifecycle-policy-ko.md)

Refs issue #18 ("Define data retention, purge, and Iceberg lifecycle policies").

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, or config is changed by this document. Every value below is
> either (a) an upstream default or documented example with a citation (`[S#]`, see [Sources](#sources), accessed
> 2026-10-07), or (b) explicitly marked **"no official recommendation"** and left to the owner. Where Beluga's
> current value is stated it was read from this repository at the commit this document was written against.
> The owner may override any proposal; remaining numbers the owner must pick are collected in
> [Owner decisions](#owner-decisions).

Component versions follow [`VERSIONS.md`](../VERSIONS.md): Kafka 4.3.0 (Strimzi 1.1.0), Debezium 3.6.1.Final,
PostgreSQL 17.6 (CNPG 1.30.0), SeaweedFS 4.41, Lakekeeper v0.13.1, Flink 1.20.0, Trino 483, Airflow 3.3.0, OpenMetadata 1.13.3.
Upstream values were read from the docs for those versions where a versioned page exists (Kafka 4.3, Trino 483, PostgreSQL 17,
Flink 1.20, CNPG v1.30.0, Lakekeeper v0.13.1 tag). Iceberg, OpenMetadata, and SeaweedFS pages are unversioned/`latest`;
re-verify against the pinned version before implementing.

## 1. Retention classes

The classes are the ones required by issue #18. "Period" is intentionally not filled in here: no upstream project recommends
a business retention period, so the numbers are owner decisions (D1, D11). The existing declared targets in
[`policies/data-standards.yaml`](../policies/data-standards.yaml) (`P365D` for customers/orders, `P90D` for `events_enriched`)
are targets only; [`data-standards.md`](data-standards.md) states physical enforcement is not implied.

| Class | Meaning | Beluga stores | Deletion trigger |
|---|---|---|---|
| raw | Landing/ingest copy, replayable from source | Kafka CDC/clickstream topics, Iceberg `raw/` prefix | Age (time/size) |
| curated | Analytics-ready managed tables | Iceberg `curated/` and `lake.*` tables, catalog + OpenMetadata metadata | Policy period, or approved purge |
| temporary | Scratch, rewrite, checkpoint | `tmp/` prefix, Flink checkpoints | Age, automatic |
| audit | Evidence of access/changes/purges | PostgreSQL logs (pgaudit not deployed), purge audit records | Fixed period, legal hold aware |
| backup | Recovery copies | CNPG Barman base backups + WAL in SeaweedFS `beluga-postgres-backups` | Backup retention window |

Prefix convention (`raw/`, `curated/`, `tmp/`) comes from `12-lakekeeper-bootstrap.yaml`; it is documented-only today and
SeaweedFS identities are bucket-scoped, not prefix-scoped (same file, header comment).

## 2. Policy matrix: class x store

Column key: **Upstream value** is the cited default/example (not necessarily a recommendation unless stated);
**Proposal** is what this document suggests the owner adopt; **Beluga today** is verified from the repo;
**Config key** is what would implement it. "NOR" = "no official recommendation".

### 2.1 Kafka (Strimzi, Kafka 4.3.0)

| Class | Setting | Upstream value | Source | Proposal | Beluga today | Gap | Config key |
|---|---|---|---|---|---|---|---|
| raw (CDC/clickstream) | Time retention | `retention.ms` default 604800000 (7 days) | S1 | Keep upstream default unless D1 says otherwise. NOR for a CDC-specific period | Not set. No `KafkaTopic` CRs; topics are auto-created by Debezium/producers with broker defaults (`03-strimzi-kafka.yaml` sets no `log.retention.*`) | Not explicit or declarative | `KafkaTopic.spec.config.retention.ms` [S24] (or broker `log.retention.hours`, default 168 [S2]) |
| raw | Size retention | `retention.bytes` default -1 (no limit, per partition) | S1 | NOR. Owner picks per-partition cap if disk is a constraint | Not set (unlimited) | No size guard | `retention.bytes` |
| raw (CDC keyed) | Compaction | `cleanup.policy` default `delete`; `compact` keeps latest value per key; `delete,compact` allowed | S1 | Debezium states its PostgreSQL events "are designed to work with Kafka log compaction" and emits a tombstone after a delete; it does not recommend a policy. NOR; see D2 | Not set (`delete`) | None if D2 = keep `delete` | `cleanup.policy` |
| raw (compacted) | Compaction tuning | `min.cleanable.dirty.ratio` 0.5; `delete.retention.ms` 86400000 (1 day); `min.compaction.lag.ms` 0; `segment.ms` 604800000 | S1 | Only relevant if D2 = compact. Upstream notes `delete.retention.ms` bounds how long a consumer starting from offset 0 has to finish its read before tombstones can disappear. NOR for a number | Not set | n/a | same keys |
| all | Retention check cadence | `log.retention.check.interval.ms` 300000 (5 min) | S2 | Keep default | Default | None | broker config |
| consumers | Offsets | `offsets.retention.minutes` 10080 (7 days) | S2 | Keep default | Default | None | broker config |

Notes: Debezium topic auto-creation can set `topic.creation.default.cleanup.policy` / `retention.ms` per connector [S23]; today the
`shop-cdc` connector (`03-strimzi-kafka.yaml`, `topic.prefix: cdc.shop`) sets none. Replication factor is 1 everywhere
(`default.replication.factor: 1`), so Kafka retention is not a durability guarantee in this single-broker profile.

### 2.2 Iceberg tables (Trino 483 + Airflow DAG; Lakekeeper v0.13.1 as catalog)

| Class | Setting | Upstream value | Source | Proposal | Beluga today | Gap | Config key |
|---|---|---|---|---|---|---|---|
| curated/raw | Snapshot expiry age | Table default `history.expire.max-snapshot-age-ms` = 432000000 (5 days); Spark procedure default `older_than` 5 days; Trino `retention_threshold` must be >= `iceberg.expire-snapshots.min-retention` (default `7d`) | S4, S5, S6 | Keep 7d: it is the Trino catalog minimum and equals the existing DAG value. Longer is the owner's call (D3). Iceberg says "regularly expiring snapshots is recommended" | `iceberg_maintenance` DAG, hourly: `expire_snapshots(retention_threshold => '7d')` on **`events_enriched` only** (`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`) | `customers`, `orders` never expired | `ALTER TABLE ... EXECUTE expire_snapshots(retention_threshold => '7d')` or table property `history.expire.max-snapshot-age-ms` |
| curated | Minimum snapshots kept | `history.expire.min-snapshots-to-keep` default 1; `retain_last` default 1 (both Trino and Spark) | S4, S5, S6 | NOR for a larger number (D3) | Not set (default 1) | Recovery window is time-only | `retain_last` / `history.expire.min-snapshots-to-keep` |
| curated | Orphan file removal | Iceberg `older_than` default 3 days; Trino `retention_threshold` must be >= `iceberg.remove-orphan-files.min-retention` (default `7d`); Lakekeeper `default-older-than-ms` 604800000 (7d) with a 24h floor | S3, S5, S6, S7 | Use 7d (Trino and Lakekeeper default; longer than Iceberg's 3d, so safer). Run after expire (S7) | **No executable job, DAG, or script invokes `remove_orphan_files`** (observed by searching `gitops/ tests/ scripts/ Makefile .github/`; the search excluded these new policy docs, which mention it) | Failed-write orphans accumulate | `ALTER TABLE ... EXECUTE remove_orphan_files(retention_threshold => '7d')` |
| curated | Metadata file cleanup | `write.metadata.delete-after-commit.enabled` default false; `write.metadata.previous-versions-max` default 100 (Iceberg). Lakekeeper: delete-after-commit enabled by default since v0.10.0, keeps current + up to previous-versions-max | S4, S7 | Keep Lakekeeper behaviour (v0.13.1). Untracked metadata files need orphan removal (S3) | Not set per table; Lakekeeper default applies | None (orphan job covers untracked) | table properties above |
| curated | Small-file/manifest compaction | Iceberg lists compaction and manifest rewrite as optional maintenance | S3 | NOR for cadence | DAG runs Trino `optimize` hourly on `events_enriched` and `orders` | `customers` not compacted | `ALTER TABLE ... EXECUTE optimize` |
| curated | Snapshot refs (tags/branches) | `history.expire.max-ref-age-ms` default `Long.MAX_VALUE` (forever); `main` never expires | S4 | Use tags as the legal-hold mechanism (see 4). | Not used | n/a | `history.expire.max-ref-age-ms` |
| curated | Catalog-side automatic expiry/orphan queues | Lakekeeper `enable-expire-snapshots` default false; `enable-remove-orphan-files` default false; both documented with the "Lakekeeper Plus" badge and Plus requires a license | S7, S10 | Do not rely on them in the Apache-2.0 image (VERSIONS.md); keep Trino/Airflow as the executor. Verify before changing | Not configured | n/a | `/management/v1/warehouse/{id}/task-queue/{expire_snapshots,remove_orphan_files}/config` |
| curated | Soft deletion of dropped tables | Lakekeeper warehouse soft-deletion: dropped tables stay recoverable until an expiration delay fixed at drop time. Default delay: not stated on the pages read. `push-s3-delete-disabled` default true | S8, S9 | NOR for the delay (D7). See invariant in 3 | Bootstrap warehouse payload has no soft-deletion setting (`12-lakekeeper-bootstrap.yaml`) | Dropped tables are not soft-deleted | warehouse `delete-profile` (exact key not shown on the pages read; confirm in the v0.13.1 management OpenAPI) |
| temporary | Rewrite/scratch data | No Iceberg guidance for a `tmp/` prefix | n/a | NOR. See object-storage row | `tmp/` is a documented convention only | No expiry | S3 lifecycle (2.3) |
| curated | Test-time guard on cleanup | Trino rejects a threshold below the configured minimum | S6 | Do not lower either `min-retention` (this is the enforcement of the invariant) | Both left at default `7d` (`06-trino.yaml` sets neither) | None | `iceberg.expire-snapshots.min-retention`, `iceberg.remove-orphan-files.min-retention` |

### 2.3 Object storage (SeaweedFS 4.41)

| Class | Setting | Upstream capability | Source | Proposal | Beluga today | Gap | Config key |
|---|---|---|---|---|---|---|---|
| temporary | Prefix expiry | S3 `PutBucketLifecycleConfiguration` supported (`Expiration.Days/Date`, `NoncurrentVersionExpiration`, `AbortIncompleteMultipartUpload`, prefix/tag/size filters). **Transition rules rejected** (no storage classes) | S12, S14 | Use only for `tmp/` and incomplete multipart uploads. NOR for a day count (D6) | No lifecycle config | No scratch/multipart cleanup | bucket lifecycle on `beluga-lake` |
| curated/raw | Table data | The Iceberg table data must **not** be expired by bucket lifecycle (Beluga design rule, not an upstream statement): objects are referenced by snapshots and removed only by Iceberg expire/orphan jobs | n/a | Add a verification test that no lifecycle rule matches `raw/` or `curated/` | None | n/a | n/a |
| backup | Backup bucket | Same API. CNPG deletes old backups itself via retention (see 2.5). A bucket rule must not be shorter than it (Beluga design rule) | S12, S19 | No bucket rule; keep CNPG as the only deleter | None | n/a | n/a |
| audit/backup | Immutability | S3 Object Lock supported: Governance and Compliance modes, `Get/PutObjectRetention`, legal hold | S13 | Candidate for backup/audit buckets and legal hold. **Precondition: Object Lock can only be enabled when a bucket is created, not added later [S13]. The existing `beluga-postgres-backups` bucket would need migration to a new bucket created with Object Lock** (versioning is enabled automatically [S13]: a plain delete then only adds a delete marker and older versions persist, so storage keeps growing unless non-current versions are expired, see the backup retention row and tests). Requires choosing mode (D10). Not verified on 4.41; treat as to-be-tested | Not enabled | No WORM | bucket Object Lock |
| all | SeaweedFS native TTL | Per-file TTL via volume TTL (`?ttl=3m`) and `fs.configure -ttl` | S15 | Not recommended for table data (same reasoning as above) | Not used | n/a | n/a |

### 2.4 Flink checkpoints (Flink 1.20.0)

| Class | Setting | Upstream value | Source | Proposal | Beluga today | Gap | Config key |
|---|---|---|---|---|---|---|---|
| temporary | Retained completed checkpoints | `execution.checkpointing.num-retained` default 1 | S11 | NOR for a different number (D8). Keep 1 unless restore-from-older is required | Not set (default). Only `execution.checkpointing.interval: 30s` and `mode: EXACTLY_ONCE` (`05-flink-operator.yaml`, `flink-sql/*.sql`) | None functionally | `execution.checkpointing.num-retained` |
| temporary | Externalized retention on cancel | `execution.checkpointing.externalized-checkpoint-retention` default `NO_EXTERNALIZED_CHECKPOINTS`; other values `DELETE_ON_CANCELLATION`, `RETAIN_ON_CANCELLATION`; docs warn retained externalized checkpoints must be cleaned manually | S11 | NOR. If `RETAIN_ON_CANCELLATION` is chosen, a cleanup job is required (D8) | Not set; no `execution.checkpointing.dir` either (default none) | Checkpoint storage path undeclared in repo | same keys + `execution.checkpointing.dir` |

Iceberg sinks commit only on checkpoints (comment in `05-flink-operator.yaml`), so checkpoint interval + commit time feed the orphan-age invariant in 3.

### 2.5 PostgreSQL (CNPG 1.30.0 / PostgreSQL 17.6)

| Class | Setting | Upstream value | Source | Proposal | Beluga today | Gap | Config key |
|---|---|---|---|---|---|---|---|
| backup | Backup retention | CNPG 1.30 docs: `spec.backup.retentionPolicy` is **deprecated** and will be removed; use the retention feature of the backup plugin (Barman Cloud plugin). No default period is given | S19 | Keep 30d until D10; plan migration to the plugin's retention If the bucket moves to Object Lock/versioning (see 2.3), add a lifecycle rule `NoncurrentVersionExpiration` (and `ExpiredObjectDeleteMarker`) [S12] whose days are not shorter than the Object Lock retention, since CNPG deletes only add delete markers on a versioned bucket (inference from S13/S12; to be tested). | `retentionPolicy: "30d"` + daily `ScheduledBackup` `0 0 2 * * *` + WAL archive (`02-cnpg.yaml`) | Uses a deprecated field | plugin retention (see S19) |
| audit | pgaudit retention | pgAudit writes to the standard PostgreSQL log; its README documents no retention setting | S18 | Retention = log rotation/shipping policy, outside the extension | pgaudit not configured (`02-cnpg.yaml`) | No audit trail in PostgreSQL | n/a |
| audit/operational | Server log rotation | `log_rotation_age` default 24h; `log_rotation_size` default 10MB; `log_truncate_on_rotation` documented with a 7-day example (`log_filename = server_log.%a`, age 1440) | S16 | Use the documented 7-day example only as a mechanism sample; NOR for a period (D9) | Not set | n/a | `log_*` parameters in `spec.postgresql.parameters` |
| audit/operational | Time-based table cleanup | PostgreSQL docs: dropping or detaching a partition is much faster than bulk `DELETE` | S17 | Partition large audit/operational tables by time; drop/detach per period. NOR for the period | No such tables yet | n/a | declarative partitioning DDL |

### 2.6 Catalog metadata (Lakekeeper, OpenMetadata 1.13.3)

| Class | Setting | Upstream behaviour | Source | Proposal | Beluga today | Gap | Config key |
|---|---|---|---|---|---|---|---|
| curated | Deleted dataset must not stay discoverable (OpenMetadata) | Soft delete gives read-only access to the asset; hard delete removes it permanently; soft-deleted assets can be restored. The Iceberg connector option "Mark Deleted Tables" (default On): a table no longer present in the source is soft-deleted in OpenMetadata, only for schemas the agent scans | S20, S21 | Soft delete alone leaves a (read-only) asset; for purge the owner needs hard delete (D12). Whether soft-deleted assets are hidden from search is not stated on the pages read: verify by test | No OpenMetadata ingestion config in repo (`11-openmetadata.yaml` has no deletion settings) | Reconciliation undefined | ingestion `markDeletedTables`; API `hardDelete` |
| curated | Lakekeeper catalog entry | Soft-deleted tables are kept until expiry; warehouses/namespaces cannot be dropped while soft-deleted children exist | S8 | Include in purge procedure order (4) | n/a | n/a | n/a |

## 3. Iceberg safety invariant

Cleanup must never violate the minimum recovery window, and orphan removal must never race an in-flight write.

1. **I1 (recovery window).** `expire_snapshots` threshold >= the documented minimum recovery window R. Trino enforces a floor through `iceberg.expire-snapshots.min-retention` (default 7d) and fails the procedure otherwise [S6]. Proposal: R = 7d (equal to the Trino floor and today's DAG), owner may raise it (D3). Never lower the Trino floor to make a job pass.
2. **I2 (orphan age).** `remove_orphan_files` age must exceed the longest write/commit duration. Iceberg: removing orphans "with a retention interval shorter than the time expected for any write to complete" is dangerous and "might corrupt the table"; default 3 days [S3]. Lakekeeper refuses < 24h at task pickup unless the check is explicitly disabled [S7]. Proposal: 7d (Trino/Lakekeeper default). Also `orphan age >= I1 age` so that a file referenced by a still-recoverable snapshot is never judged orphan (Beluga design rule, derived from S3 and S7 "run orphan removal after expire").
3. **I3 (order).** expire_snapshots, then remove_orphan_files [S7]. Existing DAG order is optimize, then expire; orphan job must be appended after expire.
4. **I4 (soft deletion interaction; per engine).** Lakekeeper docs: with soft deletion enabled, `push-s3-delete-disabled` (default true) pushes `s3.delete-enabled=false` to clients, and this "affects all file deletion operations, including maintenance procedures like `expire_snapshots`"; the documented override (`s3.delete-enabled=true`) is shown only for a Spark/Iceberg-library client [S8, S9]. So it applies to clients that read that Iceberg FileIO property (Spark and other Iceberg-library S3FileIO clients). Trino 483 deletes through its own file-system layer (`ForwardingFileIo` over `TrinoFileSystem`), and no Trino Iceberg doc page read mentions `s3.delete-enabled` [S6], so Trino-run `expire_snapshots`/`remove_orphan_files` are **not documented to be blocked** by it. This is a source reading, **not verified at runtime**: add a test (section 5) that runs both procedures through Trino against a soft-deletion warehouse before enabling D7. Any Spark-based maintenance would need the documented override.
5. **I5 (no bucket lifecycle on table data).** See 2.3 (Beluga design rule).
6. **I6 (idempotent, observable).** Iceberg procedures are re-runnable; Trino `remove_orphan_files` returns `processed_manifests_count`, `active_files_count`, `scanned_files_count`, `deleted_files_count`, `deleted_bytes` [S6]. The DAG should log these metrics and fail on Trino's retention-too-short error rather than retrying with a smaller value.

## 4. Legal hold and purge approval (design only)

Nothing here is implemented; it is a principle for the later implementation.

- **Hold before delete.** Any purge, expiry, or bucket-level deletion must check a hold registry first. A held dataset is excluded from expire/orphan/drop.
- **Possible holding mechanisms, all upstream-documented:** Iceberg snapshot tags/branches are kept by default forever (`history.expire.max-ref-age-ms` = `Long.MAX_VALUE`, only `main` is age-limited by snapshots) [S4]; Lakekeeper "protection" rejects standard delete calls on a protected entity [S8]; SeaweedFS Object Lock (legal hold / retention) [S13]. Which one(s) to use is D10. **An Iceberg tag only controls snapshot expiry; it does not block `DROP TABLE`**, so a tag must never be the sole hold: the hold design also needs a separate drop-blocking control, namely Lakekeeper protection [S8] or removal of the drop permission in the authorization backend (OpenFGA; mechanism not verified in the docs read), and the purge job must check it in step 1.
- **Approved purge = two-person, recorded, repeatable.** A purge request names dataset + reason + approver; an idempotent job runs these steps in order, because Trino's `expire_snapshots`/`remove_orphan_files` need an existing table and their metrics are unobtainable after the drop [S6]: (1) verify no hold, including the drop-blocking control; (2) record an inventory while the table exists (snapshot list, file/byte counts); (3) run `expire_snapshots` then `remove_orphan_files` while the table exists, only with thresholds >= the recovery window (I1/I2; these procedures cannot go below the Trino minimum and do not remove the current snapshot's files) and keep their output metrics [S6]; (4) drop the table with plain `DROP TABLE` in Trino: Trino 483 has no `PURGE` clause (grammar is `DROP TABLE [ IF EXISTS ] table_name`) [S25], and its REST catalog implementation calls the catalog's purge-table operation on every drop (Trino 483 source, `TrinoRestCatalog.dropTable` -> `purgeTable`) [S26], so Lakekeeper receives `purgeRequested`; the equivalent without Trino is the Lakekeeper/Iceberg REST `dropTable` call with `purgeRequested=true` [S8]. With Lakekeeper soft deletion enabled, Lakekeeper keeps the table and files recoverable until the expiration delay and removes them afterwards [S8]; clients that delete files themselves on a purge (the Spark `PURGE` hazard) must not be used [S8]; (5) verify absence: Lakekeeper table list, Trino `SHOW TABLES`, and no objects left under the table location in SeaweedFS (after the soft-delete delay if enabled); (6) OpenMetadata hard delete [S20]. **Audit is written first and updated, not written last, as a state machine:** `approved` (who, what, why, approver) before step 1; `executing` while steps 1-4 run, becoming `failed(step N)` with the error if any step fails (steps 1-3 failing therefore leave `failed`, never `executed`); `executed` right after the drop in step 4 (step-2 inventory, step-3 counts, drop result); `verified` only after ALL verification steps succeed, that is step 5 (after any soft-delete delay) and step 6 (OpenMetadata hard delete) [S20]; a failure in step 5 or 6 records `failed(step N)` and leaves the dataset marked not verified. Resume rule: the job restarts from the last recorded state. `failed(step N)` retries step N, except `failed(step 4)`. `executing` (the process died mid-run) and `failed(step 4)` (the drop may have succeeded server-side with the response lost) are both resolved by checking whether the table still exists, and step 4 is retried only if it does: if it is gone, step 4 is treated as done, `executed` is recorded and the job continues at step 5; if it still exists, the job resumes at the first step not yet confirmed (for `failed(step 4)`, it retries the drop). `executed` continues at step 5. Steps 1-3, 5 and 6 are safe to repeat (thresholded procedures, read-only checks, hard delete of an already-absent asset treated as success); step 4 is not idempotent (a second plain `DROP TABLE` fails once the table is gone), which is why resume checks existence first rather than re-running it.
- Purge audit entries belong to the `audit` class and are themselves not purged by the same job.

## 5. Verification-test ideas (acceptance criteria)

Mapped to issue #18 acceptance criteria. These are ideas; none is implemented here. Existing test style: `tests/*.sh`, `scripts/ci/check-*.py`.

| Criterion | Test idea | Level |
|---|---|---|
| Every persistent data class has a retention policy | Extend `check-data-standards.py`-style static check: every class in section 1 has a row with a value or an explicit "owner decision pending"; fail if a store in `VERSIONS.md` has none | static |
| Jobs idempotent and observable | Run the maintenance DAG task twice on a seeded table; second run reports `deleted_files_count = 0` and no error; DAG logs the procedure metrics | cluster |
| Iceberg cleanup respects the recovery window | Static: assert DAG thresholds >= documented R and orphan age >= R. Runtime: attempt `expire_snapshots(retention_threshold => '1d')` and assert Trino's "shorter than the minimum retention" error | static + cluster |
| Orphan safety | Start a slow write, run orphan removal, assert the in-flight file survives; assert files younger than the threshold are kept | cluster |
| No bucket lifecycle on table data | Static + runtime: `GetBucketLifecycleConfiguration` on `beluga-lake` has no rule whose prefix matches `raw/` or `curated/` | static + runtime |
| Deleted datasets not discoverable | Drop a test table; assert absent from Lakekeeper list, Trino `SHOW TABLES`, and OpenMetadata search; separately assert the soft-delete visibility behaviour (not documented upstream) | cluster |
| Purge auditable and repeatable | Run purge job twice; assert one audit record per intended change and a no-op second run | cluster |
| Kafka retention declared | Describe topic configs via `kafka-configs.sh`; assert `retention.ms`/`cleanup.policy` equal the declared value for each CDC topic | cluster |
| Backup retention | Assert CNPG `Backup` objects older than the window are gone and WAL needed for the oldest kept backup remains; on a versioned/Object Lock bucket also call `ListObjectVersions` and pass per object, not per bucket, with versions and delete markers judged separately. Non-current versions: a version may exist until the time it became non-current + the rule's `NoncurrentDays` (SeaweedFS counts from the PUT or delete that demoted it [S12]; an overwrite of the same key demotes the previous version earlier than any delete, and a backup deleted on day 30 with `NoncurrentDays=30` legitimately remains until about day 60) plus one lifecycle pass (daily by default, so up to about a day more [S12]). Delete markers: `NoncurrentDays` does not apply to them; a delete marker that has become the only remaining version is removed by an `ExpiredObjectDeleteMarker` rule, which the SeaweedFS lifecycle doc lists as supported [S12], so that rule is required in the bucket configuration and a marker passes if it still has older versions or is within one lifecycle pass plus up to one `walker_interval_minutes` window of becoming the last one (the `ExpiredObjectDeleteMarker` rule is walker-based, so the observed lag can reach that window beyond the daily cadence [S12]). Fail only past these per-object deadlines, excluding versions under a recorded legal hold or unexpired Object Lock retention (listed explicitly in the test output); also assert bucket usage is not growing beyond what the still-valid versions explain. | cluster |

## Owner decisions

For each, the proposal and its source. "NOR" = no official recommendation; the number is yours.

| ID | Decision | Proposal | Source / basis |
|---|---|---|---|
| D1 | Raw Kafka retention (time/size) per topic family | Keep `retention.ms` 7d, `retention.bytes` unlimited | Kafka defaults [S1]. NOR for CDC-specific values |
| D2 | CDC topic `cleanup.policy`: `delete` or `compact` (or both) | Keep `delete`; choose `compact` only if consumers need keyed state replay | Debezium: compatible with compaction, no recommendation [S22]; Kafka semantics [S1]. NOR |
| D3 | Snapshot retention R and `retain_last` | R = 7d; `retain_last` = Iceberg/Trino default 1 unless owner wants N versions | Trino floor 7d [S6]; Iceberg default 5d [S4] |
| D4 | Orphan file age | 7d | Trino and Lakekeeper default [S6, S7]; Iceberg default 3d [S3] |
| D5 | Extend maintenance DAG: expire to `customers`/`orders`, add `remove_orphan_files`, cadence (hourly today) | Yes to both; cadence NOR (Iceberg: "periodically"; may "not need to execute this often" [S3]) | Gap in repo |
| D6 | `tmp/` expiry days and multipart-abort days | NOR | SeaweedFS supports the rules [S12] |
| D7 | Enable Lakekeeper soft deletion and delay; check the `push-s3-delete-disabled` interaction per engine (I4) | Enable only together with the I4 remedy; delay NOR | S8, S9 |
| D8 | Flink `num-retained` and `externalized-checkpoint-retention`, plus declared `execution.checkpointing.dir` | Keep defaults (1 / `NO_EXTERNALIZED_CHECKPOINTS`) until restart-from-older is a requirement; NOR | S11 |
| D9 | PostgreSQL audit/operational log retention and whether to deploy pgaudit | NOR; if adopted, partition by time and drop/detach [S17]; log rotation per S16 | S16, S17, S18 |
| D10 | Backup retention (30d today), migration off the deprecated `retentionPolicy`, Object Lock mode, hold mechanism (an Iceberg tag alone is not acceptable; a drop-blocking control is required, see 4) | Keep 30d until the plugin migration; mode and hold mechanism NOR | S19, S13, S4, S8 |
| D11 | Business retention periods per class (raw/curated/audit) | NOR. Existing declared targets: P365D / P90D | `policies/data-standards.yaml` |
| D12 | Hard delete vs soft delete in OpenMetadata on purge; whether soft-deleted assets must be hidden | Hard delete on approved purge | S20, S21 (soft-delete visibility not documented on pages read) |

## Sources

All accessed 2026-10-07. Raw-file URLs were used to read the docs source; the cited page is the published or tagged document.

| ID | Source |
|---|---|
| S1 | Apache Kafka 4.3, Topic-Level Configs: https://kafka.apache.org/43/generated/topic_config.html |
| S2 | Apache Kafka 4.2, Broker Configs: https://kafka.apache.org/42/generated/kafka_config.html (the 4.2 page was read for `log.retention.*`, `log.retention.check.interval.ms`, `offsets.retention.minutes`; not re-read on 4.3) |
| S3 | Apache Iceberg, Maintenance: https://iceberg.apache.org/docs/latest/maintenance/ |
| S4 | Apache Iceberg, Configuration: https://iceberg.apache.org/docs/latest/configuration/ |
| S5 | Apache Iceberg, Spark Procedures: https://iceberg.apache.org/docs/latest/spark-procedures/ |
| S6 | Trino 483, Iceberg connector: https://trino.io/docs/483/connector/iceberg.html |
| S7 | Lakekeeper v0.13.1, Table Maintenance: https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/table-maintenance.md |
| S8 | Lakekeeper v0.13.1, Concepts (warehouse, soft deletion, protection): https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/concepts.md |
| S9 | Lakekeeper v0.13.1, Storage (`push-s3-delete-disabled`): https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/storage.md |
| S10 | Lakekeeper v0.13.1, Configuration (task queues; Plus license): https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/configuration.md |
| S11 | Apache Flink 1.20, Configuration: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/config/ |
| S12 | SeaweedFS wiki, S3 Lifecycle: https://github.com/seaweedfs/seaweedfs/wiki/S3-Lifecycle |
| S13 | SeaweedFS wiki, S3 API FAQ (Object Lock, versioning): https://github.com/seaweedfs/seaweedfs/wiki/S3-API-FAQ |
| S14 | SeaweedFS wiki, Amazon S3 API (lifecycle: "Transition rules not supported"): https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API |
| S15 | SeaweedFS wiki, Store file with a Time To Live: https://github.com/seaweedfs/seaweedfs/wiki/Store-file-with-a-Time-To-Live |
| S16 | PostgreSQL 17, Error Reporting and Logging: https://www.postgresql.org/docs/17/runtime-config-logging.html |
| S17 | PostgreSQL 17, Table Partitioning: https://www.postgresql.org/docs/17/ddl-partitioning.html |
| S18 | pgAudit README: https://github.com/pgaudit/pgaudit |
| S19 | CloudNativePG v1.30.0, Backup (Retention Policies): https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/backup.md |
| S20 | OpenMetadata, How to Delete a Data Asset: https://docs.open-metadata.org/latest/how-to-guides/guide-for-data-users/delete |
| S21 | OpenMetadata, Iceberg connector (Mark Deleted Tables): https://docs.open-metadata.org/latest/connectors/database/iceberg |
| S22 | Debezium, PostgreSQL connector (log compaction, tombstones): https://debezium.io/documentation/reference/stable/connectors/postgresql.html |
| S23 | Debezium, Topic auto-creation: https://debezium.io/documentation/reference/stable/configuration/topic-auto-create-config.html |
| S24 | Strimzi, KafkaTopicSpec (`config` map): https://strimzi.io/docs/operators/latest/configuring.html |
| S25 | Trino 483, DROP TABLE: https://trino.io/docs/483/sql/drop-table.html |
| S26 | Trino 483 source, `TrinoRestCatalog.java` (`dropTable`/`purgeTable`): https://github.com/trinodb/trino/blob/483/plugin/trino-iceberg/src/main/java/io/trino/plugin/iceberg/catalog/rest/TrinoRestCatalog.java |
