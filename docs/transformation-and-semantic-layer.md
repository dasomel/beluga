# Governed Transformation Framework, Engine Selection, and Semantic Layer (Proposal)

English | [한국어](transformation-and-semantic-layer-ko.md)

Refs issues #72, #86 (building on issues #61, #63, #65, #70, #95, #96).

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, script, policy, registry, or `VERSIONS.md` value is changed by this document, and no engine or semantic service is deployed. Repository statements carry a `file:line` verified against `origin/main` at commit `d424c38`. Live cluster facts cite read-only commands executed on 2026-10-08 using the designated isolated kubeconfig (`/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`); any unprobed element is explicitly marked **not verified live**. External engine documentation and licenses cite official sources read on 2026-10-08 (see [Sources](#sources)). Items labelled **Proposed** are design proposals and are not implemented.

Related documents:
- [`medallion-architecture.md`](medallion-architecture.md) (Bronze, Silver, Gold layer definitions, engine allocations in section 8, and open questions Q1–Q7)
- [`adr/0004-duckdb-complementary-analytics-engine.md`](adr/0004-duckdb-complementary-analytics-engine.md) (DuckDB adoption decision, REST catalog attach, MIT license)
- [`data-standards.md`](data-standards.md) and [`policies/data-standards.yaml`](../policies/data-standards.yaml) (naming conventions, metadata requirements, classification vocabulary `internal` and `pii`)
- [`data-contract-standard.md`](data-contract-standard.md) (machine-readable data contract specification)
- [`data-quality-framework.md`](data-quality-framework.md) (quality dimensions, gate mechanics, and quarantine behavior)
- [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md) (lineage tracking and OpenLineage/OpenMetadata integration)
- [`pii-classification-enforcement.md`](pii-classification-enforcement.md) (data sensitivity and masking rules)

---

## 1. Purpose and Issue Mapping

This proposal addresses two tightly coupled data processing and consumption issues:
1. **Issue #72**: Reusable Silver/Gold transformation framework and engine selection across Apache Flink SQL, Trino SQL, DuckDB (ADR-0004), Apache Spark (Issue #96 evaluation), and dbt Core (Issue #95 evaluation).
2. **Issue #86**: Governed semantic layer for metrics, dimensions, entities, join paths, and shared business definitions across BI tools, DuckDB/Trino consumers, and AI clients.

| Issue | Acceptance Criterion | Addressed in Section |
|---|---|---|
| #72 | Transformation classes and engine-selection decision matrix documented | 4.1, 4.2 |
| #72 | At least one representative Silver pipeline runs with each applicable execution mode | 4.1, 7 (Task 2) |
| #72 | Incremental, retry, and backfill behavior is deterministic | 4.3 |
| #72 | Transformation output carries reproducible lineage and source/runtime metadata | 4.3 |
| #72 | Silver quality and schema gates block invalid Gold publication | 4.4 |
| #72 | Gold publication produces governed, queryable datasets consumable by Trino and DuckDB | 4.4 |
| #72 | Workload can be migrated between supported engines without changing the data contract | 4.2, 5.2 |
| #86 | Representative business metrics defined once and consumed consistently from multiple clients | 5.1, 5.2 |
| #86 | Metric definitions carry owner, version, source, freshness, and lineage | 5.1 |
| #86 | Breaking semantic changes detected and require approval | 5.1 |
| #86 | Unauthorized consumers cannot bypass semantic access policies | 5.3 |
| #86 | Certified metrics expose quality and freshness status | 5.1, 5.3 |
| #86 | Representative Trino and DuckDB queries resolve to the same governed metric definition | 5.2 |

---

## 2. Current State (Verified)

### 2.1 Repository Artifacts (Code and Manifests)

The repository currently implements streaming transformations in Flink SQL, interactive queries in Trino, and an initial maintenance DAG in Airflow, but lacks batch Silver/Gold pipelines and a central semantic layer:

- **Current Transformations (Streaming Only)**:
  - Transformations are implemented exclusively as Flink SQL streaming jobs (`gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`, `events_sessionization.sql:1-62`).
  - `cdc_customers.sql` and `cdc_orders.sql` consume Debezium CDC topics from Kafka (`cdc.shop.public.*`), cast string timestamps, and write directly into Iceberg tables in namespace `lake` with `write.upsert.enabled = 'true'` (`cdc_customers.sql:50-58`).
  - `events_sessionization.sql` consumes `events.clickstream` (`:19`), defines an event-time watermark `WATERMARK FOR timestamp AS timestamp - INTERVAL '5' SECOND` (`:16`), and executes a 1-minute tumbling window aggregate (`:56-62`) writing into `lakekeeper.lake.events_enriched` (`:45-54`).
  - As established in [`medallion-architecture.md`](medallion-architecture.md) section 4 (`:100-138`), no Bronze tables exist, and the current tables skip the multi-hop progression (writing directly from Kafka streams into Silver-like or Gold-like tables).
- **Execution Engines in Deployment**:
  - **Trino**: Deployed as coordinator and worker (`gitops/charts/beluga-data/templates/06-trino.yaml:1-120`) running version `483` (`VERSIONS.md:35`, Apache-2.0). Connects to Lakekeeper REST catalog on warehouse `lake` with OAuth2 authentication via Keycloak (`06-trino.yaml:15`). Human access is authorized through compiled OPA Rego policies (`policies/resources.yaml`).
  - **DuckDB**: Accepted as a complementary analytics engine in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md) (MIT License). Connects to Lakekeeper REST catalog via `ATTACH ... (TYPE ICEBERG)` and SeaweedFS S3. It is not currently deployed as an in-cluster service; ADR-0004 specifies it as an embedded query engine for local, CI, and complementary analytical workloads.
  - **Airflow**: Deployed with `KubernetesExecutor` (`gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`) running version `3.3.0` (`VERSIONS.md:36`, Apache-2.0). Executes Trino SQL via `KubernetesPodOperator` in `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`.
  - **Apache Spark**: Evaluated under Issue #96 as an optional large-scale batch processing engine. No Spark operator, cluster, or job manifests exist in the repository today.
  - **dbt**: Evaluated under Issue #95 as a SQL transformation modeling tool. No `dbt_project.yml`, models, or dbt adapter manifests exist in the repository today.
- **Semantic Definitions and Consumption Today**:
  - No central semantic layer exists in the platform.
  - Metrics are hardcoded in SQL: `events_sessionization.sql:59-62` hardcodes `event_count` (`COUNT(event_id)`) and `total_duration_ms` (`SUM(duration_ms)`); Superset dashboards (`gitops/charts/beluga-data/templates/15-superset-import.yaml:1-200`) define visualization slices directly against Trino tables without shared semantic models.
  - Superset 6.1.0 (`VERSIONS.md:37`) connects to Trino over `sqlalchemy-trino` (`15-superset-import.yaml:160-178`).
  - Table schemas, owners, descriptions, retention, and freshness are recorded statically in [`policies/data-standards.yaml`](../policies/data-standards.yaml) (`:25-32`).

### 2.2 Live Cluster State (Verified 2026-10-08)

The following read-only cluster facts were verified using the designated kubeconfig:
- **Active Engines**:
  - Namespace `analytics`: Pod `trino-coordinator-76cf9f6b9-rkksm` is `Running` (1/1); Pod `trino-worker-5d75dd75b-g95l4` is `Running` (1/1); Pod `superset-6956cb4889-ndskf` is `Running` (1/1).
  - Namespace `streaming`: Pod `flink-cluster-787f4dd587-gjl4r` is `Running` (1/1); TaskManager pods `flink-cluster-taskmanager-2-1` and `2-2` are `Running` (1/1).
  - Namespace `orchestration`: Pod `airflow-webserver-798bf8db59-2nzgt` is `Running` (1/1).
  - Namespace `lakehouse`: Pod `lakekeeper-66bbf6776c-dtpcx` is `Running` (1/1).
- **Engines Not Deployed**: No Spark operator or Spark pods exist in any namespace; no dbt runner or Cube service exists in the cluster.

---

## 3. Gaps vs Acceptance Criteria

| ID | Description | Root Cause / Today's State |
|---|---|---|
| G-TR-1 | No reusable batch Silver/Gold transformation framework (#72) | Transformations are limited to streaming Flink SQL jobs. There is no standard framework for batch SQL transformations, incremental merges, or historical backfills. |
| G-TR-2 | Absence of an objective engine-selection matrix (#72) | No documented decision matrix guides when to choose Flink, Trino, DuckDB, Spark, or dbt. Engine allocation has been ad-hoc. |
| G-TR-3 | Transformation metadata and lineage capture are missing (#72) | Flink SQL jobs do not record input snapshot IDs, execution job IDs, or code Git commit versions into the target Iceberg table metadata. |
| G-TR-4 | Gold publication quality gates are absent (#72) | Gold tables (`lake.events_enriched`) are populated continuously from streams without pre-publication schema or quality assertions. A failed window does not halt Gold publication. |
| G-TR-5 | Semantic definitions are fragmented across tools (#86) | Business metrics (e.g., user activity, order value) are defined independently in Flink SQL, Superset chart configurations, and ad-hoc analyst queries. |
| G-TR-6 | No multi-engine semantic consistency (#86) | Queries executed from DuckDB, Trino, and Superset cannot resolve against a shared semantic model, risking divergent calculations of the same business metric. |
| G-TR-7 | Lack of metric governance and certification lifecycle (#86) | Metrics lack formal ownership, versioning, freshness SLAs, deprecation status, and authorization boundaries. |

---

## 4. Silver/Gold Transformation Framework and Engine Selection (Issue #72)

### 4.1 Transformation Lifecycle and Layer Roles

In accordance with [`medallion-architecture.md`](medallion-architecture.md) sections 2, 5, and 6:

```
[Bronze: Immutable Raw] 
         |
         |---> (Silver Transformation: Schema conform, deduplicate, validate, type cast)
         v
[Silver: Conformed Entities at Source Grain]
         |
         |---> (Gold Transformation: Dimensional modeling, aggregation, business metrics)
         v
[Gold: Governed Data Products]
```

1. **Bronze to Silver**:
   - Reads immutable raw records from Bronze Iceberg tables (`_raw`, `_source_ref`, `_ingest_ts`).
   - Parses payload, applies strict schema typing, validates primary keys, and deduplicates late-arriving records.
   - Any record failing validation or business key constraints is written to `<silver_table>_quarantine`.
   - Result: Validated, non-aggregated representation of each entity (`silver_shop.customers`, `silver_shop.orders`).
2. **Silver to Gold**:
   - Reads one or more conformed Silver tables.
   - Applies dimensional joins, business rollups, window aggregations, and metric calculations.
   - Enforces pre-publication quality gates. If quality gates fail, the transaction is aborted and the previous Gold snapshot remains unchanged (`medallion-architecture.md:170-172`).
   - Result: Query-optimized data marts (`gold_shop.daily_revenue`, `gold_web.user_activity_1m`).

### 4.2 Engine Selection Decision Matrix

The platform evaluates five distinct execution engines across technical criteria. This matrix records criteria and current repository status rather than a permanent verdict:

| Engine | Execution Model | Primary Sweet Spot | Scalability & Shuffle Limits | Latency Profile | Resource Footprint | License (OSI-Permissive) | Current Repo State |
|---|---|---|---|---|---|---|---|
| **Apache Flink SQL** | Continuous streaming & micro-batch | Continuous stream-to-Silver ingestion, event-time windowing, sub-minute latency | Stateful streaming; heavy multi-way historical batch shuffles require dedicated RocksDB state tuning | Seconds to sub-minute (30s checkpoint in `cdc_customers.sql:2`) | Always-on cluster (`flink-cluster` JobManager + TaskManagers; ~2–4 GiB RAM) | **Apache-2.0** (`VERSIONS.md:34`) | **Deployed & Active** (`files/flink-sql/*.sql`) |
| **Trino SQL** | Distributed MPP interactive & batch SQL | Shared federated queries, BI dashboard acceleration (Superset), scheduled batch SQL on Iceberg | Memory-bound distributed shuffle; spills to disk or fails on queries exceeding cluster memory | Seconds to minutes | Always-on JVM coordinator & workers (`06-trino.yaml`; ~4–8 GiB RAM) | **Apache-2.0** (`VERSIONS.md:35`) | **Deployed & Active** (`06-trino.yaml`, `iceberg_maintenance.py`) |
| **DuckDB** | In-process columnar OLAP engine | Local ad-hoc queries, embedded CI validation, single-node small/medium batch ETL/ELT | Single-node only (multi-threaded, disk-spilling); cannot distribute across multiple K8s nodes | Sub-second to seconds | Ephemeral embedded process; zero idle cluster daemon overhead | **MIT** (`docs/adr/0004...:46`) | **Accepted per ADR-0004**; client library pattern |
| **Apache Spark** | Distributed driver / executor batch processing | Very large batch shuffles (>100 GB/batch), complex iterative algorithms, distributed PySpark ML/graph pipelines | Highly resilient disk-based shuffle; handles multi-terabyte data volume that exceeds Trino memory limits | Minutes to hours | Heavy driver + executor pods; high memory/CPU requirements | **Apache-2.0** (Official Apache License 2.0) | **Evaluated under Issue #96**; not deployed |
| **dbt Core** | SQL transformation modeling & DAG orchestrator | Declarative SQL modeling, Jinja templating, automated testing, and dependency DAG management | Compiles to SQL; execution scalability depends entirely on target engine (Trino or DuckDB) | Inherits target engine | Lightweight CLI / container (~256 MiB RAM per run); ephemeral execution | **Apache-2.0** (dbt Core Apache-2.0) | **Evaluated under Issue #95**; not deployed |

#### 4.2.1 Workload-to-Engine Selection Guidance

```
Workload Requirement:
├── Requires sub-minute latency / event-time stream windowing?
│   └── YES ──> Choose Apache Flink SQL
│
├── Requires local execution, CI test validation, or zero-JVM small ETL?
│   └── YES ──> Choose DuckDB (per ADR-0004)
│
├── Involves massive distributed shuffle (>100 GB) or complex PySpark ML/graph algorithms?
│   └── YES ──> Choose Apache Spark on K8s (Ephemeral Job, Issue #96)
│
└── Standard analytical Silver/Gold batch transformation on Iceberg?
    ├── Declarative SQL modeling & testing framework ──> dbt Core (Issue #95)
    └── Execution backend ─────────────────────────────> Trino SQL (Airflow orchestrated)
```

**Anti-Patterns to Avoid**:
1. *Streaming ETL in Trino*: Trino is not designed for continuous record-by-record streaming. Continuous streaming must remain on Flink.
2. *Always-on Spark clusters in small profiles*: Running permanent Spark clusters on small/development profiles wastes resources. Spark must strictly run as ephemeral on-demand jobs (`SparkApplication` or `spark-submit` via Airflow) when adopted.
3. *Single-node DuckDB on distributed multi-terabyte datasets*: DuckDB cannot scale horizontally across cluster nodes; workloads exceeding single-node capacity must run on Trino or Spark.

### 4.3 Idempotency, Backfill, and Snapshot Lineage

All batch Silver and Gold transformations must guarantee deterministic idempotency:
- **Write Semantics**:
  - Silver dimension/entity tables use Iceberg `MERGE INTO` keyed on business identifiers.
  - Gold aggregated tables use atomic partition replacement (`INSERT OVERWRITE` on date/window partition).
- **Transformation Metadata Columns (Proposed)**:
  Every Silver and Gold table must attach governed transformation tracking metadata:

| Column | Type | Description |
|---|---|---|
| `_transform_id` | `STRING` | Unique execution UUID of the transformation run. |
| `_transform_engine` | `STRING` | Engine that executed the transform (`trino`, `flink`, `duckdb`, `spark`). |
| `_code_version` | `STRING` | Git commit SHA of the transformation SQL/model code. |
| `_input_snapshots` | `STRING` | Comma-delimited list of source Iceberg table snapshot IDs consumed by this run. |
| `_transformed_at` | `TIMESTAMP(6)` | UTC timestamp when the transformation completed. |

### 4.4 Publication Quality Gates

Before any Silver table is promoted or any Gold dataset is published for consumer queries, automated quality gates execute (conforming to [`data-quality-framework.md`](data-quality-framework.md) and [`medallion-architecture.md:163-173`](medallion-architecture.md)):
- **Pre-Publication Checks**:
  1. Primary key uniqueness and non-null assertions (`completeness = 100%`).
  2. Referential integrity across declared foreign keys.
  3. Metric threshold bounds (e.g., negative amounts or invalid status codes).
  4. Anomaly volume check (row count variance within expected range).
- **Gate Enforcement**:
  - If quality checks pass: The Iceberg snapshot commit is marked as published.
  - If critical quality checks fail: The transaction is rolled back, the candidate snapshot is expired or quarantined, an incident is flagged in OpenMetadata, and downstream Gold/BI consumption remains pinned to the previous valid snapshot.

---

## 5. Governed Semantic Layer Architecture (Issue #86)

### 5.1 Semantic Modeling Primitives

The semantic layer centralizes business definitions once, ensuring identical calculation across BI tools, DuckDB, Trino, and AI clients:
- **Entities**: Business objects with a defined primary key (e.g., `Customer`, `Order`).
- **Dimensions**: Categorical or temporal attributes used for grouping and filtering (e.g., `order_date`, `customer_city`, `product_category`).
- **Measures / Metrics**: Aggregations evaluated over dimensions:
  - Additive: `SUM(total_amount)`, `COUNT(order_id)`.
  - Semi-additive / Non-additive: `COUNT(DISTINCT customer_id)`, `AVG(duration_ms)`.
  - Derived / Composite: `total_revenue / count_orders` (Average Order Value).
- **Join Paths**: Explicit, directed relationships between entities (e.g., `Order` → `Customer` on `customer_id`), preventing ambiguous joins, chasm traps, and fan-out errors.
- **Metric Certification Lifecycle**:
  - `Draft`: Proposed metric under development.
  - `In Review`: Submitted for domain steward validation.
  - `Certified`: Formally approved single source of truth, carrying owner, freshness SLA, and quality status.
  - `Deprecated`: Marked for retirement with a recorded migration path.

### 5.2 Semantic Layer Technology Options

Beluga evaluates three open-source, OSI-permissive candidate architectures for the semantic layer:

| Dimension | Option A: Trino Governed Views & Materialized Views | Option B: Cube Core (Universal Semantic Layer) | Option C: dbt Semantic Layer / MetricFlow |
|---|---|---|---|
| **License** | **Apache-2.0** (`VERSIONS.md:35`) | **Apache-2.0 / MIT** (`LICENSE` verified) | **Apache-2.0** (Open-sourced Oct 2025; `LICENSE` verified) |
| **Architectural Model** | Database-native SQL Views and Iceberg Materialized Views | Standalone semantic service with Code-First modeling (YAML/JS/Python) | CLI/Library-compiled semantic models defined in dbt project YAML |
| **Query Interfaces** | Standard Trino SQL (consumed by Superset, JDBC/ODBC, Trino CLI) | **SQL API** (PostgreSQL wire protocol), REST API, GraphQL API | MetricFlow CLI, Python API, or dbt Semantic Layer JDBC (Cloud/Core) |
| **Engine Translation** | Native Trino engine execution only | Translates semantic queries to native SQL and pushes down to Trino | Generates native SQL for underlying target engine (Trino or DuckDB) |
| **Caching / Pre-agg** | Trino Iceberg Materialized Views (`REFRESH MATERIALIZED VIEW`) | Built-in pre-aggregations engine with multi-level cache | Aggregation tables modeled in dbt project |
| **New Infrastructure** | **Zero new components** (uses existing Trino cluster) | Requires deploying Cube service (Node.js runtime + cache store) | Requires adopting dbt Core (#95) |
| **Dynamic Slicing** | Static projection per view; complex drill-downs require new views | Fully dynamic dimensional slicing, metric drill-down, and filtering | Fully dynamic dimensional metric querying |

#### 5.2.1 Phased Implementation Evaluation

1. **Phase 1 (Immediate / Baseline)**: **Trino Governed Views and Materialized Views**.
   - Implement certified metrics as governed Trino views within Gold namespaces (`gold_shop.view_daily_revenue`).
   - Materialized views in Trino use Iceberg storage (`CREATE MATERIALIZED VIEW`, stored as Iceberg tables in Lakekeeper), refreshed via Airflow tasks (`REFRESH MATERIALIZED VIEW`).
   - Advantage: Zero additional cluster components, full reuse of existing OPA authorization policies (`policies/resources.yaml`), and immediate consumption from Superset.
2. **Phase 2 (Evaluation / Future Expansion)**: **Cube Core (Apache-2.0)**.
   - Deploy Cube Core as a governance service in namespace `analytics`.
   - Expose the semantic model via Cube's PostgreSQL-compatible SQL API (`:5432`) to Superset and DuckDB, while pushing heavy queries down to Trino.
   - Advantage: Centralizes multi-client consumption (REST, GraphQL, AI agents) with code-first YAML models and automatic pre-aggregation acceleration.

### 5.3 Semantic Access Control and Catalog Lineage

- **Access Enforcement**:
  - The semantic layer must never bypass underlying security policies.
  - Queries executing through Trino views inherit Trino OPA Rego authorization rules (`policies/resources.yaml`). Columns classified as `pii` are masked or blocked based on user roles (`analysts` vs `engineers`).
  - If Cube Core is deployed in Phase 2, Cube's security context must pass the authenticated Keycloak user identity through to Trino session properties, ensuring OPA policies apply at query time.
- **Catalog and Lineage Integration**:
  - Every certified metric is exported to OpenMetadata 1.13.3 (`11-openmetadata.yaml:1-348`) as a certified glossary term and metric asset.
  - End-to-end lineage links the semantic metric to the backing Gold Iceberg table, the Silver entity tables, and the source Bronze coordinates.

---

## 6. Verification and Test Ideas

### 6.1 Test 1: Cross-Engine Query Consistency (Trino vs DuckDB)
- **Goal**: Verify that Trino and DuckDB compute identical metric results when querying the same Iceberg Gold snapshot.
- **Method**: Define a test aggregate query over `lakekeeper.lake.events_enriched` (or a mock Gold table). Execute the identical query in Trino SQL and in DuckDB via `ATTACH ... (TYPE ICEBERG)`.
- **Expected Outcome**: Exact numerical equivalence across `user_id`, `event_count`, and `total_duration_ms` for the specified time window.

### 6.2 Test 2: Idempotent Batch Backfill Test
- **Goal**: Verify that re-running a Silver/Gold transformation does not create duplicate records.
- **Method**: Execute an Airflow batch merge task on a simulated Silver dataset. Re-run the identical task with the same input snapshot ID.
- **Expected Outcome**: Total record count in the target Iceberg table remains unchanged; second run updates existing keys idempotently.

### 6.3 Test 3: Pre-Publication Quality Gate Enforcement
- **Goal**: Verify that invalid transformation outputs are blocked from Gold publication.
- **Method**: Execute a synthetic Gold build task where input records violate a critical nullability check on the business metric.
- **Expected Outcome**: The publication quality gate catches the violation, rolls back the Iceberg transaction, logs an alert, and keeps the prior Gold snapshot active for consumers.

### 6.4 Test 4: Semantic PII Masking Protection
- **Goal**: Verify that semantic metrics do not expose unmasked PII to unauthorized roles.
- **Method**: Query a governed semantic view containing customer attributes using an `analysts` role credential.
- **Expected Outcome**: Non-PII measures return successfully, while sensitive PII columns (`name`, `email`) are masked or inaccessible per `policies/resources.yaml`.

---

## 7. Owner Decisions Remaining

| Decision ID | Topic | Options Considered | Recommendation | Rationale |
|---|---|---|---|---|
| **OD-TR-1** | Batch transformation modeling standard | (A) Trino SQL scripts orchestrated directly by Airflow<br>(B) dbt Core models orchestrated by Airflow (#95) | **Option B: dbt Core modeling with Trino execution** | dbt provides modular Jinja SQL, automated schema testing, DAG dependencies, and documentation in Git. |
| **OD-TR-2** | Spark adoption boundary (#96) | (A) Deploy permanent always-on Spark cluster<br>(B) Ephemeral on-demand Spark-on-K8s jobs only<br>(C) Defer Spark entirely | **Option B: Ephemeral on-demand jobs only** | Prevents resource bloat on smaller profiles while reserving Spark for large shuffles exceeding Trino memory. |
| **OD-TR-3** | Semantic layer engine selection (#86) | (A) Trino Governed Views & Materialized Views (Phase 1)<br>(B) Cube Core service (Phase 2)<br>(C) dbt Semantic Layer / MetricFlow | **Option A for Phase 1, evaluate Option B for Phase 2** | Phase 1 adds zero cluster footprint; Phase 2 introduces Cube if multi-protocol (REST/AI/BI) semantic serving is needed. |
| **OD-TR-4** | Metric certification authority | (A) Data Engineering team alone<br>(B) Domain Product Owner + Governance Steward joint sign-off | **Option B: Joint sign-off** | Guarantees business alignment and platform governance consistency before a metric is certified. |
| **OD-TR-5** | Pre-aggregation storage substrate | (A) Standard Iceberg Gold tables in Lakekeeper<br>(B) Engine-internal proprietary caches | **Option A: Iceberg Gold tables** | Maintains Iceberg as the single source of truth across all consumption engines and catalog tools. |

---

## 8. Ordered Follow-up Implementation Tasks

1. **Task 1: Transformation Metadata Specification in Data Standards**
   - Extend `policies/data-standards.yaml` to specify mandatory transformation tracking columns (`_transform_id`, `_code_version`, `_input_snapshots`).
   - *Acceptance Test Idea*: CI static check validates that new Silver/Gold table definitions contain the required metadata columns.
2. **Task 2: Reference Airflow DAG for Batch Silver Upsert**
   - Create a reference DAG executing idempotent `MERGE INTO` SQL on Trino, reading simulated Bronze records and upserting into a Silver table.
   - *Acceptance Test Idea*: DAG executes idempotently across two consecutive runs, asserting zero duplicate primary keys.
3. **Task 3: Governed Trino Metric View Prototype**
   - Create a representative Gold metric view in Trino (`gold_shop.view_customer_order_summary`) with column-level descriptions and OPA classification annotations.
   - *Acceptance Test Idea*: Query executes successfully in Trino and Superset; analysts query receives masked PII.
4. **Task 4: dbt Core PoC on Trino & DuckDB (#95)**
   - Create a prototype `dbt` project containing one Silver model and one Gold model, executing against Trino and validated locally with DuckDB.
   - *Acceptance Test Idea*: `dbt run` and `dbt test` succeed against Lakekeeper-governed Iceberg tables.

---

## 9. Sources

### 9.1 External Documentation and Specifications
- [S1] Stichting DuckDB Foundation, *DuckDB Documentation and Iceberg Extension*, https://duckdb.org/docs/current/core_extensions/iceberg/overview (accessed 2026-10-07). MIT License.
- [S2] Trino Software Foundation, *Trino Documentation: Iceberg Connector & Materialized Views*, https://trino.io/docs/current/connector/iceberg.html (accessed 2026-10-08). Apache License 2.0.
- [S3] Cube Dev, Inc., *Cube Documentation & Architecture*, https://cube.dev/docs (accessed 2026-10-08); *Cube License*, https://raw.githubusercontent.com/cube-js/cube/master/LICENSE (accessed 2026-10-08). Apache License 2.0 / MIT.
- [S4] dbt Labs, *MetricFlow License & Documentation*, https://raw.githubusercontent.com/dbt-labs/metricflow/main/LICENSE (accessed 2026-10-08). Apache License 2.0.
- [S5] Apache Spark, *Apache Spark Documentation*, https://spark.apache.org/docs/latest/ (accessed 2026-10-08). Apache License 2.0.
- [S6] Databricks, *What is the medallion lakehouse architecture?*, https://docs.databricks.com/aws/en/lakehouse/medallion (accessed 2026-10-07).

### 9.2 Repository Sources (Verified at Commit `d424c38`)
- Flink SQL Streaming Jobs: `gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`, `events_sessionization.sql:1-62`.
- Trino Deployment: `gitops/charts/beluga-data/templates/06-trino.yaml:1-120`.
- Airflow Deployment & DAGs: `gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`, `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`.
- Superset Connection to Trino: `gitops/charts/beluga-data/templates/15-superset-import.yaml:150-180`.
- DuckDB Architecture Decision: `docs/adr/0004-duckdb-complementary-analytics-engine.md:1-226`.
- Data Standards & Governance: `policies/data-standards.yaml:1-117`.
- Component Versions: `VERSIONS.md:1-60`.

### 9.3 Live Cluster Verification (Verified 2026-10-08)
- Verified active running pods for Trino (`trino-coordinator`, `trino-worker`), Flink (`flink-cluster`, taskmanagers), Airflow (`airflow-webserver`), Lakekeeper (`lakekeeper`), and Superset (`superset`) using kubeconfig `/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`.
- *Items Not Verified Live*: Live Spark job execution on Kubernetes (Spark not provisioned), live Cube Core service deployment, cross-engine benchmark performance numbers under high concurrency.
