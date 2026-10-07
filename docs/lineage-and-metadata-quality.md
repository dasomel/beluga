# Data Lineage and Metadata Quality Controls (Proposal)

English | [한국어](lineage-and-metadata-quality-ko.md)

Refs issue #19 ("Establish data lineage and metadata quality controls").

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, script, policy or `VERSIONS.md` value is changed by this
> document. Repository statements carry a `file:line` read at commit `9f74c2b`. "Live" statements were read with
> read-only `kubectl` on 2026-10-07; other runtime facts are marked **not verified live**. External facts cite `[S#]`
> (see [Sources](#sources), accessed 2026-10-07); where upstream is silent the text says **no official recommendation**
> or **not on the page read**. Items labelled **Proposed** are not implemented.

Related: [`medallion-architecture.md`](medallion-architecture.md) (sections 5.1, 5.2, 6), [`data-standards.md`](data-standards.md),
[`data-lifecycle-policy.md`](data-lifecycle-policy.md) (section 2.6, catalog metadata), [`pii-classification-enforcement.md`](pii-classification-enforcement.md),
[`data-quality-framework.md`](data-quality-framework.md), [`data-contract-standard.md`](data-contract-standard.md).

## 1. Purpose and issue mapping

| Issue #19 acceptance criterion | Section |
|---|---|
| Required metadata contract is documented | 2.1, 4.1 |
| Representative end-to-end lineage is visible | 2.2, 2.4, 4.2 |
| Schema changes are detected and handled per documented policy | 2.1, 4.3 |
| Stale/orphaned metadata can be identified and reconciled | 4.5 |
| Ownership, classification and freshness are queryable | 2.3, 4.4, 4.6 |

## 2. Current state (verified)

### 2.1 Metadata that exists: a Git registry, static only

- [`policies/data-standards.yaml`](../policies/data-standards.yaml) requires, per table, `owner, classification, description, retention, freshness` and, per column, `description, classification`
  (`:25-28`); `retention`/`freshness` are ISO-8601 durations (`:30`). Five tables are registered (`:33-112`); all have `owner: data-platform` and `freshness: PT5M`.
- `scripts/ci/check-data-standards.py` (part of `make validate`, `Makefile:68`) fails on an unregistered `CREATE TABLE`, a stale registry entry, a missing field or a bad classification. Its own comment states the registry is "not runtime catalog state"
  (`check-data-standards.py:29-31`). This is the only schema-change detector in the repository: it compares **Git DDL to Git registry**, not a running catalog.
- Freshness is a declared target only: no job, DAG or query in the repository measures it (grep for `freshness` outside the registry and its checker: no match). `docs/data-standards.md` says physical enforcement is not implied.
- There is no `steward`, layer/namespace, upstream or schema-version field in the registry.

### 2.2 Lineage that exists: none recorded

- Actual data path from files read: PostgreSQL `shop` -> Debezium topics `cdc.shop.public.{customers,orders}` -> Flink SQL (`cdc_customers.sql`, `cdc_orders.sql`) -> Iceberg `lake.customers`/`lake.orders` via Lakekeeper;
  `events.clickstream` -> Flink SQL (`events_sessionization.sql`) -> `lake.events_enriched`; Trino reads Iceberg; Superset reads Trino (not re-verified here). Airflow runs only
  `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py` (`optimize` on `events_enriched` and `orders`, `expire_snapshots` on `events_enriched`, `:30`, `:44`).
- No OpenLineage configuration exists anywhere in the repository (the only mentions are in `medallion-architecture.md` section 6 and a design-lineage note unrelated to data). `medallion-architecture.md` already assigns lineage tooling to this issue.
- Registry coverage excludes Kafka topics and connector-local Flink tables by design (`docs/data-standards.md`, "Scope"); lineage nodes for topics therefore need a separate declaration (4.2).

### 2.3 Catalog layer: OpenMetadata

- Optional (`openmetadata.enabled: false` default, `values.yaml:58-59`; on only for 48 GB+ profiles per `README.md:65,78-79`). **Live:** `openmetadata` and `opensearch` (1.13.3) run in namespace `governance`; no pod whose name contains `ingest` exists in any namespace.
- No ingestion workflow, lineage workflow or classification sync is defined in the repository (`11-openmetadata.yaml` deploys server, search, OIDC login and network policies only). Whether the live catalog holds any entity was **not verified live** (no API token used).
- Lakekeeper is the Iceberg REST catalog and the authority for table existence and schema (`06-trino.yaml:10-16`, Flink `CREATE CATALOG lakekeeper`). OpenMetadata would be a second copy of that metadata; none is synchronised today.

### 2.4 What upstream documents (tooling options)

| Capability | Upstream statement | Consequence for Beluga |
|---|---|---|
| OpenMetadata lineage generation | Query-log lineage workflow, view lineage during ingestion, manual lineage in the UI, dbt, CSV query logs; supported services on that page: BigQuery, Snowflake, MSSQL, Redshift, Clickhouse, PostgreSQL, Databricks [S1] | Trino and Iceberg are **not on that list**; the Trino connector page separately lists `Lineage` and `Column-level Lineage` but not how they are obtained [S2]. Verify on a test run before relying on either |
| OpenMetadata OpenLineage connector | Consumes OpenLineage events from Kafka or Kinesis; integrated with OpenLineage up to 1.7.0; Airflow and Spark configurations documented; Flink not mentioned; no pipeline status, owner or tag support [S3] | A usable runtime path exists for Airflow events; none documented for Flink |
| OpenLineage for Flink | Flink 1.x integration "does not support Flink SQL"; Flink 2.x uses Flink's native lineage interfaces (FLIP-314), needs no job-code change and supports Flink SQL [S4] | Beluga runs Flink 1.20 and keeps it because 2.x connectors are not available (`VERSIONS.md:34,50`); its jobs are SQL. Runtime OpenLineage from Flink is therefore **not available** with the documented 1.x integration |
| OpenLineage for Airflow | Native provider for Airflow 2.7+ [S5] | Beluga uses Airflow 3.3.0 (`VERSIONS.md:36`); support for 3.x is **not stated on the page read**; and the only DAG is maintenance, which produces no data lineage |
| Iceberg freshness source | Trino exposes `"<table>$snapshots"` with `committed_at`, `snapshot_id`, `parent_id`, `operation`, `summary` [S6] | Freshness can be computed from the catalog without new infrastructure |

## 3. Gaps vs the acceptance criteria

| ID | Gap | Criterion |
|---|---|---|
| G1 | Metadata contract exists only as registry fields; no steward/layer/upstream; not queryable at runtime | contract, queryable |
| G2 | No lineage is recorded anywhere; Flink SQL cannot emit OpenLineage with the documented 1.x integration | end-to-end lineage |
| G3 | Schema change is detected only statically (Git DDL vs Git registry); no running-catalog drift check | schema changes |
| G4 | Freshness declared (`PT5M`), never measured | freshness |
| G5 | No reconciliation among registry, Lakekeeper/Iceberg and OpenMetadata; no orphan/stale report | stale/orphaned |

## 4. Proposal (Proposed)

Principle: **Git is the authority for governance fields (owner, steward, classification, retention, freshness target, declared lineage); Lakekeeper/Iceberg is the authority for physical existence and schema; OpenMetadata is a derived view.** Reconciliation never relaxes a classification or grants access (see [`pii-classification-enforcement.md`](pii-classification-enforcement.md)).

### 4.1 Required metadata contract

| Field | Level | Status |
|---|---|---|
| `owner`, `classification`, `description`, `retention`, `freshness` | table | exists |
| `description`, `classification` | column | exists |
| `steward` | table | Proposed (required) |
| `layer` (`bronze|silver|gold`, per medallion) | table | Proposed; `legacy` for the current `lake` namespace until medallion Q1 is decided |
| `derived_from` (list of registry table ids or declared transport sources) | table | Proposed |
| Schema | table | derived from DDL (exists); a version number is **not** proposed here, it belongs to the contract ([`data-contract-standard.md`](data-contract-standard.md)) |

The same fields feed the data contract; the contract must not redefine them.

### 4.2 Lineage

- **L1, declared lineage (first deliverable).** `derived_from` per table plus a small `transport_sources` list (Kafka topics and Flink job names as non-dataset nodes). A static check verifies every referenced id exists. This gives table-level lineage for all five tables without runtime tooling and works with Flink 1.20 SQL.
- **L2, catalog visibility.** A reconcile job pushes L1 edges to OpenMetadata when it is enabled (via its lineage API or the UI-supported path; the API endpoint is **not documented on the page read** [S1] and must be confirmed against 1.13.3 before implementation).
- **L3, runtime events (optional).** Airflow OpenLineage provider to OpenMetadata's OpenLineage connector, only after Airflow 3.3.0 support is confirmed [S3, S5]. Flink runtime lineage waits for a Flink version with SQL support [S4].
- **L4, column-level lineage:** out of scope here (issue #88).
- Medallion alignment: layer ids and `_batch_id`/snapshot-id evidence from medallion section 6 attach to L1 edges once Bronze exists.

### 4.3 Schema change policy

- Static: the existing checker remains the gate for DDL in Git.
- Live drift (Proposed): compare `information_schema.columns` of `iceberg.lake.*` (through Trino; this needs a **new** read-only Trino principal limited to `information_schema` and the `$snapshots` metadata tables, because no existing role is suitable and `engineers` must not be reused: it requires its own compiler rule and an owner decision, so access is never widened implicitly) with the registry. Additive column: warning and registry update required within a review. Dropped, renamed or type-changed column: failure, aligned with medallion 5.1 (Silver additive via reviewed change, Gold breaking changes need a new table or version) and with the compatibility classes of the data contract.
- Propagation expectation: Flink source tables and sink DDL declare fixed column lists (`cdc_customers.sql:26-34` source, `:42` onward sink), so an additive source-database column is **not** propagated until the Flink DDL, Iceberg table and registry are changed together. This should be stated as expected behaviour, not treated as an incident.

### 4.4 Freshness

- Measure `now() - max(committed_at)` from `"lake.<table>$snapshots"` [S6] per table and compare with the registry `freshness`.
- Caveat: `optimize` (Airflow, hourly) also creates snapshots (`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:30`); the check must filter on `operation` so compaction does not mask a stale table. The `operation` values must be confirmed in the Iceberg documentation before implementation (not read for this document).
- Alert grace beyond the declared target is an owner decision (D3).

### 4.5 Stale and orphaned metadata, reconciliation

Three-way comparison, report only (no automatic delete):

| Finding | Meaning | Action |
|---|---|---|
| In Lakekeeper/Trino, not in registry | unclassified table | report as blocking; default deny already applies at Trino (see PII document) |
| In registry, not in Lakekeeper | stale registry entry | CI fails today for DDL; live check reports |
| In OpenMetadata, not in Lakekeeper | orphan catalog entity | report; removal per `data-lifecycle-policy.md` section 2.6 (soft vs hard delete is its owner decision D12) |
| Owner/classification differs between Git and OpenMetadata | drift | overwrite OpenMetadata from Git |

### 4.6 Exposure for governance review

A read-only generated report (JSON, attached to the release evidence like other inventories) listing per table: owner, steward, classification, declared lineage, freshness status, last schema check. When OpenMetadata is enabled the same fields are visible there. A new queryable governance table is **not** proposed.

## 5. Verification and test ideas

| Test | Type | Pass condition |
|---|---|---|
| `derived_from` id exists / cycle-free | static, `make validate` | fails on dangling id |
| Registry table without `steward`/`layer` | static negative | fails |
| Add a column to a test Iceberg table | live | drift check reports additive warning; drop column reports failure |
| Stop the Flink job for a test table | live | freshness status becomes stale after the declared target plus grace |
| Delete a test table in Lakekeeper | live | reported as stale registry entry; OpenMetadata orphan reported (if enabled) |
| Representative lineage `postgres.public.customers -> iceberg.lake.customers` | static plus OpenMetadata (if enabled) | edge present in the report and in the catalog |

## Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Accept declared (Git) lineage as the first deliverable | Yes; runtime lineage later |
| D2 | Authority for lineage if Git and OpenMetadata differ | Git |
| D3 | Freshness alert grace beyond the declared `PT5M` | No official recommendation; owner picks |
| D4 | Pursue Airflow OpenLineage on Airflow 3.3.0 | Only after provider support is confirmed |
| D5 | Orphan OpenMetadata entities: report only or remove | Report only |
| D6 | Is OpenMetadata required in every profile for this issue | No; the report works without it |

## Follow-up implementation tasks (ordered)

1. Add `steward`, `layer`, `derived_from`, `transport_sources` to the registry and checker. Test: negative fixtures fail.
2. Generate the governance report from the registry (owner, classification, lineage, freshness target). Test: report lists all five tables.
3. Live schema-drift check through Trino `information_schema`. Test: add/drop column cases above.
4. Freshness check from `$snapshots` with `operation` filter. Test: stopped-job case.
5. Three-way reconciliation report. Test: deleted-table case.
6. OpenMetadata reconcile job (labels, owner, steward, lineage edges) when enabled. Test: edge visible in 1.13.3.
7. Evaluate Airflow OpenLineage provider support on Airflow 3.3.0. Test: a sample DAG event arrives in OpenMetadata.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | OpenMetadata, How lineage is produced: https://docs.open-metadata.org/latest/how-to-guides/data-lineage/workflow |
| S2 | OpenMetadata, Trino connector: https://docs.open-metadata.org/latest/connectors/database/trino |
| S3 | OpenMetadata, OpenLineage connector: https://docs.open-metadata.org/latest/connectors/pipeline/openlineage |
| S4 | OpenLineage, Flink integration: https://openlineage.io/docs/integrations/flink/ |
| S5 | OpenLineage, Airflow integration: https://openlineage.io/docs/integrations/airflow/ |
| S6 | Trino 483, Iceberg connector (`$snapshots`): https://trino.io/docs/483/connector/iceberg.html |
