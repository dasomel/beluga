# Medallion Lakehouse Architecture (Bronze / Silver / Gold)

English | [한국어](medallion-architecture-ko.md)

Status: **design proposal for owner review** (Issue #70). This is a design document only; no manifest,
pipeline, policy, or catalog change accompanies it. Statements about the current platform are verified against
the repository at the commit this document was written; statements marked **Proposal** are not implemented.

Owner decision recorded on the issue: *confirm the medallion architecture as described by Databricks, then
define it.* Section 1 therefore records what Databricks states; sections 2 onward are Beluga's adaptation and
are kept separate so the two are never confused.

## 1. What Databricks says

Source: [What is the medallion lakehouse architecture?](https://docs.databricks.com/aws/en/lakehouse/medallion)
(Databricks documentation, accessed 2026-10-07). Only points present on that page are attributed to Databricks.

**Definition.** A series of data layers "that denote the quality of data stored in the lakehouse", a data design
pattern used to organize data logically, intended to "incrementally and progressively improve the structure and
quality of data as it flows through each layer". Also called multi-hop architecture.

**Logical guidance, not a rule.** "Following the medallion architecture is a recommended best practice but not
a requirement."

| | Bronze | Silver | Gold |
|---|---|---|---|
| Purpose / data state | Raw, unvalidated data; maintains the raw state of the source in its original formats | Validated, cleaned, enriched versions of the data | Consumption-ready; highly refined views for analytics, dashboards, ML, applications |
| Typical operations | Append incrementally; minimal validation; add metadata columns such as source file name for provenance | Schema enforcement, null/missing handling, deduplication, out-of-order and late-arriving data resolution, quality checks, schema evolution, type casting, joins, modeling of semi-structured data | Dimensional modeling and aggregation, domain business logic, materialized aggregates, performance optimization |
| Sources / inputs | Streaming and batch from object storage, message buses (for example Kafka), federated systems | Reads one or more Bronze or Silver tables, writes Silver tables | Aggregated data tailored to analytics and reporting |
| Consumers named | Data engineers, data operations, compliance and audit | Data engineers, data analysts, data scientists | Business analysts and BI developers, data scientists and ML engineers, executives, operational teams |

Further points stated on the page:

- Bronze "serves as the single source of truth, preserving the data's fidelity" and "enables reprocessing and
  auditing by retaining all historical data".
- Bronze cautions: limit cleanup and validation here; to guard against dropped data, store most fields as
  string, VARIANT, or binary to survive unexpected schema changes (VARIANT is a Databricks type; see section 3
  for the Iceberg equivalent decision).
- Silver "should always include at least one validated, non-aggregated representation of each record".
- Silver caution: Databricks does not recommend writing to Silver directly from ingestion, because schema
  changes or corrupt source records would then cause failures. Silver is built from Bronze (or other Silver).
- Gold is frequently queried, so optimizing Gold tables for performance is a best practice; large amounts of
  history are typically read from Silver rather than materialized in Gold. Some customers keep several Gold
  layers for different business domains (the page names HR, finance, IT).
- The page describes the layers as denoting quality (Bronze raw, Silver validated, Gold enriched) and states
  that the architecture "guarantees atomicity, consistency, isolation, and durability" across the layers'
  validations and transformations. The page does not say how that guarantee is implemented; Beluga makes no
  claim about it, relies on Iceberg table commits for per-table atomicity, and does not claim cross-layer
  transactions.
- Ingestion cadence (continuous, triggered, batch) is a cost/latency trade-off.

**Not on the page (do not attribute to Databricks):** namespace naming, retention periods, PII handling,
quarantine tables, access-control roles, lineage mechanics, and any engine allocation. These are Beluga
decisions in sections 3 to 9.

## 2. Beluga layer definitions (Proposal)

The layers are logical. They are expressed as Iceberg namespaces in the Lakekeeper catalog; they are not
separate products, and a dataset that does not need all three hops may skip a hop only by recorded decision
(open question Q4).

| Layer | Beluga definition | Write semantics | Owner | Primary readers |
|---|---|---|---|---|
| Bronze | Immutable, append-only source fidelity plus ingestion metadata. Enough to rebuild Silver without contacting the source again. | Append only. No updates, no deletes except governed purge (section 6). | Platform/data engineering (ingestion pipeline owner) | Data engineers, audit. Not analysts. |
| Silver | Validated, typed, deduplicated, conformed, current-state (and where required, history) records at the source grain. At least one non-aggregated representation of each record. | Upsert/merge keyed by business key, produced only from Bronze or Silver. | Domain data engineering | Engineers; analysts for non-sensitive Silver where the policy allows. |
| Gold | Business-ready data products: aggregates, dimensional marts, feature tables, each with a named owner and consumers. | Rebuilt or incrementally maintained from Silver (or Gold). | Data product owner | Analysts, BI (Superset), data science, DuckDB/Trino users, subject to the per-table access rule in 5.5. |

Engine and catalog are unchanged: **Iceberg tables governed by Lakekeeper remain the layer substrate**;
Trino and Superset and Airflow consume. Flink stays the streaming writer.

## 3. Lakekeeper namespace and table naming (Proposal)

Constraints inherited from [data-standards.md](data-standards.md): lower `snake_case`, `_id`/`_at` suffix
semantics, no reserved SQL identifiers.

- **Warehouse.** Keep the existing single warehouse `lake` (bucket `beluga-lake`). Layers are namespaces inside
  it. Separate warehouses per layer would give a harder storage boundary but add, per extra warehouse, one warehouse-create call and one set of assignments to `12-lakekeeper-bootstrap.yaml` (today 8 tuples: 2 service accounts x 4 relations);
  see Q2.
- **Namespace:** `<layer>_<domain>`, for example `bronze_shop`, `silver_shop`, `gold_shop`, `gold_web`.
  `<layer>` is one of `bronze`, `silver`, `gold`; `<domain>` is the source system or business domain.
- **Table:** Bronze `<source_object>` named after the source object and capture mode (`cdc_customers`,
  `clickstream_events`, `file_manifest_<class>`); Silver `<entity>` (`customers`, `orders`); Gold
  `<product>` named for the business meaning (`daily_orders_by_status`, `user_activity_1m`).
- **Quarantine:** `<silver_table>_quarantine` in the Silver namespace, same access class as the Bronze data it
  came from (it holds records that failed validation and may contain PII).
- **Partitioning guidance (starting point, to be validated by #65 benchmarks):** Bronze by ingestion date
  (`day(_ingest_ts)`); Silver by the dominant business-time column when a table is large enough to benefit,
  otherwise unpartitioned; Gold by the dominant dashboard filter. No file-size or partition-count numbers are
  fixed here.
- **Bronze metadata columns (Proposal):** `_ingest_ts`, `_source_system`, `_source_ref` (Kafka
  topic/partition/offset, file path plus checksum, or API request id), `_batch_id`, and the unmodified payload
  (`_raw`: string or binary; the current tables use Iceberg `format-version` 2, which has no variant type, so
  string/binary is the portable choice, in line with Databricks' advice to avoid early typing).
- **Registry:** every table in every layer needs the metadata `policies/data-standards.yaml` already requires
  (owner, classification, description, retention, freshness). Layer is derivable from the namespace.
- The existing namespace `lake` is legacy; see section 4 for the migration decision (Q1).

## 4. Where Beluga is today (verified)

Current persistent Iceberg tables, all in namespace `lake` of warehouse `lake`
(`gitops/charts/beluga-data/files/flink-sql/*.sql`, `policies/resources.yaml`):

| Table | Built by | Input | Honest layer classification |
|---|---|---|---|
| `lake.customers` | `cdc_customers.sql` (Flink) | Kafka topic `cdc.shop.public.customers` (Debezium JSON from PostgreSQL) | **Silver-like.** Typed (string timestamps cast to `TIMESTAMP(3)`), keyed upsert (`write.upsert.enabled`), current state only. Written straight from the stream: no raw copy, no quarantine, no quality gate. Classification `pii` (email). |
| `lake.orders` | `cdc_orders.sql` (Flink) | Kafka topic `cdc.shop.public.orders` | **Silver-like**, same gaps. `total_amount` cast string to `DECIMAL(10, 2)`. |
| `lake.events_enriched` | `events_sessionization.sql` (Flink) | Kafka topic `events.clickstream` (JSON) | **Gold-like** one-minute per-user window aggregate, but built directly from the stream, skipping Bronze and Silver. Flink drops events later than the declared 5-second watermark from a window (standard event-time behavior, not tested here), and no raw event is stored, so it cannot be rebuilt from governed data. |

Other facts that bear on layers:

- **No Bronze Iceberg table exists.** The only raw copy is the Kafka topics. `beluga-data` templates declare no
  explicit topic retention (broker default applies; not verified on a live cluster), so Kafka is not a
  governed or guaranteed Bronze.
- Trino catalog name is `iceberg` (`ALTER TABLE iceberg.lake.events_enriched ...` in
  `dags/iceberg_maintenance.py`); Superset datasets and policies reference `lake.*` names.
- Declared retention in `policies/data-standards.yaml` is `P365D` for `lake.customers` and `lake.orders` and `P90D` for `lake.events_enriched`; freshness is `PT5M` for all three. The
  data-standards document states that declaring a target does not imply physical enforcement. The only
  physical lifecycle job found is `iceberg_maintenance.py` (compaction and `expire_snapshots` with a `7d`
  threshold on `lake.events_enriched`).
- Authorization: Trino access for humans is enforced through the OPA Rego compiled from `policies/` with
  roles `analysts`, `engineers` (includes analysts), `admins` (includes engineers). Lakekeeper OpenFGA
  assignments seeded by `12-lakekeeper-bootstrap.yaml` are warehouse-level (`describe`, `select`, `create`,
  `modify`) for the service accounts `service-account-trino` and `service-account-flink` only.
  Namespace-level isolation inside the warehouse does not exist today.

**Gap list against the issue's acceptance criteria**

| Gap | Today |
|---|---|
| Bronze with source fidelity and rebuild metadata | none |
| Quality gates before Silver/Gold publication (#20, #56) | none in the pipelines |
| Quarantine of invalid records | none |
| Semi-structured file and unstructured flows | none (only Kafka JSON and Debezium CDC) |
| Gold built from Silver | none; the one aggregate reads Kafka |
| DuckDB consumption path (#61-#65) | not part of the flows reviewed |
| Layer-specific access, classification and retention tests | not present; classification exists per table |
| End-to-end lineage (#19) | not demonstrable today |

**Proposed mapping of existing assets (no change made here):**

| Existing | Target |
|---|---|
| Debezium topics `cdc.shop.public.*` | Source for new `bronze_shop.cdc_customers`, `bronze_shop.cdc_orders` (raw envelope, before/after, op, ts) |
| `lake.customers`, `lake.orders` | Become `silver_shop.customers`, `silver_shop.orders`, fed from Bronze |
| `lake.events_enriched` | Becomes a Gold product (`gold_web.user_activity_1m`) fed from `silver_web.clickstream_events`, itself fed from `bronze_web.clickstream_events` |

Renaming `lake.*` touches `policies/resources.yaml`, the compiled Rego, Superset imports and the Trino
authorization tests, which is the cross-repo seam with `beluga-manager`. Migration is therefore a separate
issue after owner sign-off (Q1).

## 5. Per-layer rules (Proposal)

### 5.1 Schema evolution

- Bronze: schema-tolerant. Keep the payload unmodified; additive source changes must never stop ingestion.
  Metadata columns are fixed.
- Silver: schema is a contract. Additive changes (new nullable column) are allowed through reviewed change;
  type narrowing or renames require a versioned change and a documented backfill from Bronze. Records that no
  longer conform go to quarantine, not into the main table.
- Gold: schema is a published interface. Breaking changes require a new table name or version and a
  deprecation period; the length is an owner decision, not set here.

### 5.2 Quality gates

Gate definitions, rule syntax, thresholds and monitoring belong to #20 and #56 and are not invented here. The
structural rule this design requires of them:

- Bronze to Silver: schema/type validation, key presence, deduplication; failures are written to quarantine,
  never silently dropped.
- Silver to Gold: a Gold build or refresh runs only when the Silver inputs have passed their gate for the
  period being published; a failed gate blocks publication and leaves the previous Gold snapshot in place.
- Each gate outcome is recorded (pass/fail, counts, run id) so it can be shown as lineage evidence (#19).

### 5.3 PII and classification

- Classification (currently `internal` or `pii` per `policies/data-standards.yaml`; a `public` value would be a proposed addition needing an owner decision and a registry change) is assigned at Bronze and
  propagates to every derived table; a derived table's classification is at least that of its most sensitive
  input column unless a documented transformation (masking, tokenization, aggregation) justifies lowering it.
- Bronze stores unmodified payloads and therefore holds raw PII. It is restricted to engineers and the
  pipeline service accounts; analysts never read Bronze.
- Today `policies/resources.yaml` grants `lake.customers` (PII, `sensitiveColumns: [email]`) to `engineers` only,
  with `allowUnmasked: true`; analysts have no access to it, masked or otherwise. Proposal: if analysts should
  see PII tables, add an explicit masked grant per table; none exists now.
- Deletion and erasure requests against immutable Bronze are governed by #30; see Q5.

### 5.4 Retention hook

Retention periods per layer are defined by #18 (and PII-specific periods by #30). This document only fixes the
hook: every table's `retention` value in the registry is authoritative for its layer, Bronze retention must be
at least as long as the longest rebuild window promised for Silver and Gold, and a purge of Bronze that would
break a promised rebuild window must be a recorded decision. No numbers are set here. Iceberg snapshot expiry
and data purge are distinct operations and #18 must define both.

### 5.5 Access by role (Proposal, expressed in existing roles)

| Layer | analysts | engineers | admins | Service accounts |
|---|---|---|---|---|
| Bronze | none | select (PII unmasked where `allowUnmasked`) | all via engineers | `flink`/ingestion: create, modify; `trino`: select |
| Silver | select on non-PII (as today for `lake.orders`, `lake.events_enriched`); PII tables: no access today, masked access would be a proposal | select, insert, update, delete | all | pipeline account writes |
| Gold | select only on Gold tables classified non-PII, otherwise explicit per-table grants (a Gold table that still carries PII inherits `pii` and is engineers-only until a masked grant is added) | select, and write through the owning pipeline | all | pipeline account writes |

Enforcement points: Trino OPA Rego compiled from `policies/resources.yaml` for humans (exists today), and
Lakekeeper OpenFGA for catalog operations. Today OpenFGA is warehouse-level, so layer isolation in Lakekeeper
requires either namespace-level assignments or separate warehouses (Q2). Tenant isolation is #21.

## 6. Lineage, reprocessing and rebuildability (Proposal)

- **Lineage chain:** source object, then Bronze `_source_ref`/`_batch_id`, then Silver run id, then Gold
  product. Every Silver/Gold write records its input table snapshot ids (Iceberg snapshot ids are available
  from the catalog), so a Gold row set can be traced to the Silver and Bronze snapshots it came from. Tooling
  (OpenMetadata, OpenLineage emission) is #19's scope.
- **Rebuild rule:** Silver and Gold must be regenerable from governed Bronze by re-running a deterministic,
  idempotent job (merge on business key, or partition overwrite). Transformations must not read non-governed
  state (current time, external lookups) without recording it in the run.
- **Failed transformation:** re-run Silver or Gold from Bronze/Silver snapshots; the source is not contacted
  again. This is the issue's reprocessing acceptance criterion.
- **Corrections, late data, deletes:** corrections and late-arriving records arrive as new Bronze appends;
  Silver resolves them by key and event time. Source deletes are captured as Bronze delete events and applied
  in Silver (hard delete or soft-delete flag is Q6). Event-time windows in Flink need an explicit allowed
  lateness decision per product; Gold products fed from windows should be recomputable from Silver.

## 7. Source classes and Bronze landing (Proposal)

| Source class | Bronze landing | Silver step | Example flow |
|---|---|---|---|
| Relational / CDC | Debezium envelope kept whole (op, before, after, source ts) appended by Flink from the CDC topic | Latest-state merge by key, type casting, validation | PostgreSQL `public.customers` to `bronze_shop.cdc_customers` to `silver_shop.customers` (today's `lake.customers` is this Silver step without Bronze) |
| Streaming events | Event payload as received (string/binary) plus Kafka coordinates | Parse JSON, validate, dedupe on `event_id`, conform timestamps | `events.clickstream` to `bronze_web.clickstream_events` to `silver_web.clickstream_events` to `gold_web.user_activity_1m` |
| Semi-structured files (JSON/CSV/Parquet) | File landed unchanged in the object store, plus a Bronze table row per record or per file with `_source_ref` (path, checksum) and raw content; Parquet may be registered as-is | Schema inference proposed, then pinned, typed table | Airflow task lands a CSV export, appends to `bronze_<domain>.<file_class>` |
| API / SaaS export | Response body per request with request parameters and id | As semi-structured | Scheduled Airflow pull |
| Unstructured (documents, logs, binaries) | Object stored unchanged in S3 (SeaweedFS); Iceberg manifest table `bronze_<domain>.file_manifest_<class>` holds path, size, checksum, content type, ingest metadata | Extraction job (text, parsed fields, log line parsing) writes Silver tables referencing the manifest row | A log archive or PDF set: manifest in Bronze, parsed records in Silver |

These are flows to demonstrate under #70's acceptance criteria; none is implemented. Unstructured binaries
are never stored inside table rows; only their governed metadata and the access policy of the bucket prefix
apply the layer rules (bucket-prefix-level policy design is Q3).

## 8. Which engine runs which transformation (Proposal)

| Work | Engine | Reason |
|---|---|---|
| Continuous ingestion to Bronze, low-latency Silver from streams | Flink | Already the streaming writer; checkpoint-committed Iceberg sink |
| Scheduled batch Silver/Gold, backfills, maintenance | Airflow orchestrating Trino SQL | Shared, governed, OPA-enforced path; `iceberg_maintenance` already follows this |
| Local/ad-hoc exploration of Gold (and permitted Silver) | DuckDB reading Iceberg | Per #61/#62, where its compatibility allows |
| Shared BI and federation | Trino (Superset) | Existing; fallback target of #63 routing |

DuckDB must read only through the same catalog authorization; its policy is #63.

## 9. Non-goals and open questions

**Non-goals of this document:** implementing any pipeline, namespace, or policy; choosing quality-rule
syntax or thresholds (#20, #56); retention periods (#18, #30); lineage tooling (#19); tenant isolation
mechanics (#21); DuckDB routing rules and benchmarks (#61 to #65); renaming current tables; a fourth layer.

**Open questions for the owner:**

- Q1. Rename the legacy `lake` namespace to layer namespaces (cross-repo migration with the policy compiler)
  or add the new layers beside it and retire `lake` later?
- Q2. Layer isolation: namespaces in the single `lake` warehouse with namespace-level OpenFGA assignments, or
  one warehouse (and bucket prefix/credential) per layer?
- Q3. Unstructured objects: one bucket with per-prefix policy, or a dedicated bucket and credential?
- Q4. May a dataset skip a hop (for example a streaming aggregate straight to Gold as today)? If yes, under
  what recorded decision, given that it then cannot be rebuilt from Bronze?
- Q5. Bronze holds raw PII: approve crypto-shredding, tokenization before Bronze, or restricted raw retention
  as the erasure approach (with #30)?
- Q6. Source deletes in Silver: hard delete or soft-delete flag with history?
- Q7. Is a Bronze copy of Debezium topics acceptable as the first deliverable before any new source class?

## Sources

- Databricks, "What is the medallion lakehouse architecture?",
  https://docs.databricks.com/aws/en/lakehouse/medallion (accessed 2026-10-07).
- Repository (verified at write time): `gitops/charts/beluga-data/files/flink-sql/`,
  `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml`,
  `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`, `policies/`, [data-standards.md](data-standards.md),
  [architecture.md](architecture.md).
- Issues: #70, #18, #19, #20, #21, #30, #33, #34, #56, #61, #62, #63, #65.
