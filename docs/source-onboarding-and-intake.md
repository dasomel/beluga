# Governed Source Onboarding, External Integrations, and Intake Reconciliation (Proposal)

English | [한국어](source-onboarding-and-intake-ko.md)

Refs issues #71, #75, #77, #78, #82.

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, script, policy, registry, or `VERSIONS.md` value is changed by this document, and no connector or pipeline is deployed. Repository statements carry a `file:line` verified against `origin/main` at commit `d424c38`. Live cluster facts cite read-only commands executed on 2026-10-08 using the designated isolated kubeconfig (`/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`); any unprobed element is explicitly marked **not verified live**. External standards cite official documentation read on 2026-10-08 (see [Sources](#sources)). Items labelled **Proposed** are design proposals and are not implemented.

Related documents:
- [`medallion-architecture.md`](medallion-architecture.md) (Bronze landing, schema evolution, and open questions Q1–Q7)
- [`data-standards.md`](data-standards.md) and [`policies/data-standards.yaml`](../policies/data-standards.yaml) (metadata baseline, identifier naming, classification values `internal` and `pii`)
- [`data-contract-standard.md`](data-contract-standard.md) (Open Data Contract Standard baseline)
- [`data-quality-framework.md`](data-quality-framework.md) (quality dimensions, gate mechanics)
- [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md) (lineage propagation and metadata completeness)
- [`pii-classification-enforcement.md`](pii-classification-enforcement.md) (data sensitivity and masking rules)
- [`data-lifecycle-policy.md`](data-lifecycle-policy.md) (retention hooks and snapshot expiry)

---

## 1. Purpose and Issue Mapping

This proposal unifies five tightly coupled data acquisition and governance issues into a single platform intake architecture:
1. **Issue #71**: Heterogeneous source onboarding framework (source registration, landing into Bronze, replayability).
2. **Issue #75**: Database schema discovery, profiling, and reverse-engineering framework (PostgreSQL, MySQL, Oracle, MSSQL).
3. **Issue #77**: External API connector framework for OpenAPI and non-relational sources (auth, pagination, rate limits, retries).
4. **Issue #78**: OpenAPI-driven external integration contracts and schema governance (drift detection, contract versioning).
5. **Issue #82**: Governed data intake control plane and source-to-platform reconciliation (run lifecycle, row count and checksum matching per Iceberg snapshot).

| Issue | Acceptance Criterion | Addressed in Section |
|---|---|---|
| #71 | At least one source from each major class onboarded via documented template | 4.1 |
| #71 | Bronze datasets contain consistent ingestion metadata (`_ingest_ts`, `_source_ref`, etc.) | 4.1 |
| #71 | Schema changes and malformed records follow documented quarantine behavior | 4.1 |
| #71 | Replay and backfill are deterministic without unintended duplication | 4.1, 4.5 |
| #71 | Lineage and ownership visible from source to Bronze | 4.1, 4.5 |
| #71 | Production onboarding fails preflight when governance/security metadata is missing | 4.1, 5.1 |
| #75 | Representative RDBMS (PostgreSQL, MySQL, Oracle, MSSQL) discoverable via documented adapter | 4.2 |
| #75 | Canonical schema model produced consistently across database engines | 4.2 |
| #75 | Keys, relationships, indexes, and constraints captured | 4.2 |
| #75 | Profiling reports include row/column statistics without unrestricted full table scans | 4.2 |
| #75 | PII candidates classified through governed policy and sample data protected | 4.2 |
| #75 | Discovery runs diffed to detect schema and profile changes | 4.2 |
| #75 | Least-privilege discovery credentials and OSS license compliance | 4.2 |
| #77 | Representative OpenAPI-described source registered and ingested | 4.3, 4.4 |
| #77 | OAuth2 and API-key credentials injected securely and rotated without code change | 4.3 |
| #77 | Pagination, rate limiting, retries, and incremental extraction demonstrated | 4.3 |
| #77 | Raw payload and provenance preserved; HTTP failures observable with quarantine | 4.3 |
| #77 | Connector tests run against mock API without live external dependency | 4.3, 5.3 |
| #78 | OpenAPI 3.x specification registered, validated, versioned, and used for connector contract | 4.4 |
| #78 | Breaking vs non-breaking API changes detected by automated checks | 4.4 |
| #78 | Observed payload drift reported against declared contract | 4.4 |
| #78 | Non-OpenAPI APIs use equivalent governed schema path | 4.4 |
| #82 | Representative DB, API, edge, and file flows have visible lifecycle and status | 4.5 |
| #82 | Source-vs-platform reconciliation detects deliberate mismatch | 4.5, 5.4 |
| #82 | Partial and duplicate transfer detected and handled deterministically | 4.5 |
| #82 | Replay and recovery evidence retained | 4.5 |
| #82 | Freshness and SLA violations surfaced to catalog/quality metadata | 4.5 |

---

## 2. Current State (Verified)

### 2.1 Repository Artifacts (Code and Manifests)

The current platform implements specific ingestion components, but lacks a generalized onboarding and intake control plane:

- **Debezium CDC Ingestion**:
  - Debezium Kafka Connect is deployed as a standalone Deployment `debezium-connect` (`gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:120-191`) running image `quay.io/debezium/connect:3.6.1.Final` (`:135`) with Service `debezium-connect` on port 8083 (`:192-205`).
  - Connector registration Job `debezium-register-shop` (`gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:207-275`) registers connector `shop-cdc` via idempotent HTTP PUT to `http://debezium-connect.streaming.svc.cluster.local:8083/connectors/shop-cdc/config` (`:252-275`).
  - Connector configuration specifies `io.debezium.connector.postgresql.PostgresConnector` (`:258`), PostgreSQL hostname `postgres-main-rw.database.svc.cluster.local` (`:259`), database `shop` (`:263`), topic prefix `cdc.shop` (`:264`), replication slot `beluga_shop_slot` (`:266`), and table inclusion `public.orders,public.customers` (`:267`).
  - Password injection uses Secret `postgres-admin-credential` (`:241-245`), replaced via `sed` into the request payload (`:274`).
- **Streaming Ingestion to Iceberg (Flink SQL)**:
  - Flink SQL pipelines ingest CDC Kafka topics directly into Iceberg tables (`gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`, `events_sessionization.sql:1-62`).
  - In `cdc_customers.sql`, Flink connects to Lakekeeper REST catalog at `http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog` (`:10-21`) and writes to `lakekeeper.lake.customers` (`:42-52`) with `format-version = '2'` and `write.upsert.enabled = 'true'` (`:50-51`).
  - Ingestion consumes topic `cdc.shop.public.customers` with format `debezium-json` (`:34-40`). Checkpointing interval is forced to 30 seconds (`:2`).
  - As established in [`medallion-architecture.md`](medallion-architecture.md) section 4 (`:98-138`), these tables are typed, deduplicated, and upserted directly into the `lake` namespace without an immutable Bronze raw copy.
- **Airflow Orchestration**:
  - Airflow 3.3.0 (`VERSIONS.md:36`) runs with `KubernetesExecutor` (`gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`).
  - Airflow ServiceAccount `airflow` in namespace `orchestration` has `Role` and `RoleBinding` `airflow-pod-operator` in namespaces `orchestration` (`07-airflow.yaml:8-34`) and `analytics` (`:39-60`), granting `create`, `get`, `list`, `watch`, `delete`, and `patch` on pods (`:14-16, 45-47`).
  - The only existing DAG is `iceberg_table_maintenance` (`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`), which executes compaction and snapshot expiration on Trino via `KubernetesPodOperator` (`:24-50`). No data intake or reconciliation DAG exists today.
- **Data Standards and Governance**:
  - [`policies/data-standards.yaml`](../policies/data-standards.yaml) defines mandatory table metadata (`owner`, `classification`, `description`, `retention`, `freshness`) and column metadata (`description`, `classification`) (`:25-28`). Allowed classifications are restricted to `internal` and `pii` (`:28`).
  - Schema discovery is static: `policies/data-standards.yaml` lists DDL source files (`:8-16`), verified by `scripts/ci/check-data-standards.py` during `make validate`.
  - Formal API contracts (OpenAPI specifications) and source intake reconciliation manifests are absent (`docs/critical-interfaces-inventory.md:78` confirms formal contract artifacts are not established).
- **Metadata and Governance Engines**:
  - Lakekeeper v0.13.1 (`VERSIONS.md:33`) manages the Iceberg REST catalog on warehouse `lake` backed by SeaweedFS S3 (`gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:1-120`).
  - OpenMetadata 1.13.3 (`VERSIONS.md:43`) and OpenSearch 2.18.0 (`VERSIONS.md:44`) are defined in `gitops/charts/beluga-data/templates/11-openmetadata.yaml:1-348`.

### 2.2 Live Cluster State (Verified 2026-10-08)

The following read-only cluster facts were verified using the designated kubeconfig:
- **Workloads Active**:
  - Namespace `streaming`: Pod `debezium-connect-848597646b-6kcnv` is `Running` (1/1); Job `debezium-register-shop-6jkws` is `Completed` (0/1); Flink pods `flink-cluster-787f4dd587-gjl4r`, `flink-cluster-taskmanager-2-1`, and `flink-cluster-taskmanager-2-2` are `Running` (1/1); Kafka broker pods `beluga-kafka-mixed-0`, `1`, `2` are `Running`.
  - Namespace `database`: Pod `postgres-main-1` is `Running` (1/1); Job `shop-seed-smvcc` is `Completed`.
  - Namespace `orchestration`: Pod `airflow-webserver-798bf8db59-2nzgt` is `Running` (1/1).
  - Namespace `lakehouse`: Pod `lakekeeper-66bbf6776c-dtpcx` is `Running` (1/1).
  - Namespace `governance`: Pods `openmetadata-5547c79cb5-6vm9j` and `opensearch-65c94b9f97-hszx2` are `Running` (1/1).
  - Namespace `storage`: Pod `seaweedfs-0` is `Running` (1/1).
- **Network Boundaries**: Ingress to Lakekeeper port 8181 is restricted by `04b-lakehouse-network-policy.yaml` to Trino, Flink, and APISIX; Airflow cannot communicate with Lakekeeper REST directly.

---

## 3. Gaps vs Acceptance Criteria

| ID | Description | Root Cause / Today's State |
|---|---|---|
| G-INT-1 | No unified source onboarding template or lifecycle for heterogeneous sources (#71) | Ingestion is hardcoded in Flink SQL scripts and Debezium registration Jobs. No declarative YAML model exists for onboarding new sources. |
| G-INT-2 | Ingestion lands directly in Silver-like tables, bypassing Bronze (#71) | `cdc_customers.sql` and `cdc_orders.sql` upsert typed records directly to `lake.customers` and `lake.orders`. Original raw CDC envelopes and ingest metadata are not preserved in Iceberg. |
| G-INT-3 | Lack of automated database schema discovery and profiling (#75) | Schemas are manually defined in SQL DDL and mirrored into `policies/data-standards.yaml`. No automated introspection captures constraints, approximate statistics, or PII heuristics from live databases. |
| G-INT-4 | No least-privilege profiling roles (#75) | Current Debezium registration and seeding jobs connect as `beluga_admin` (`03-strimzi-kafka.yaml:261`). Dedicated read-only profiling roles with resource limits do not exist. |
| G-INT-5 | No external API connector framework (#77) | The platform only consumes PostgreSQL CDC and internal Kafka clickstream events. There is no runtime for HTTP/REST pagination, rate limiting (HTTP 429), or backoff. |
| G-INT-6 | No OpenAPI contract governance or drift detection (#78) | OpenAPI 3.x specifications are not cataloged, versioned, or compared against incoming payloads. Schema drift silently breaks downstream transformations. |
| G-INT-7 | No intake control plane or reconciliation (#82) | No mechanism tracks planned vs received records or reconciles source counts against Iceberg snapshot metadata (`total-records`). Mismatches and duplicate loads go undetected. |

---

## 4. Proposal (Proposed)

### 4.1 Single Source Onboarding Framework (Issue #71)

#### 4.1.1 Supported Source Classes
Beluga defines five standardized source classes:
1. **Relational / CDC**: RDBMS sources (PostgreSQL, MySQL, Oracle, MSSQL) captured continuously via Debezium Connect into Kafka topics, or extracted via scheduled batch JDBC queries.
2. **External API**: HTTP/REST endpoints described by OpenAPI 3.x, SaaS exports, and webhooks.
3. **Files / Batch Object Storage**: Delimited text (CSV, TSV), JSON Lines, and Parquet files delivered to SeaweedFS S3 or external object storage.
4. **Streaming Message Buses**: External Kafka topics, MQTT, and event streams.
5. **Unstructured & Media**: Documents (PDF, Word), log archives, audio/video files stored directly in SeaweedFS S3, governed by Iceberg manifest tables.

#### 4.1.2 Declarative Source Registration Schema
Sources must be registered declaratively in Git under `sources/<domain>/<source_name>.yaml` before deployment. Production onboarding fails preflight validation if mandatory fields are missing:

```yaml
# Proposed: sources/shop/shop_postgres_customers.yaml
apiVersion: beluga.data/v1alpha1
kind: SourceRegistration
metadata:
  name: shop-postgres-customers
  domain: shop
spec:
  owner: data-platform
  classification: pii             # Must be 'internal' or 'pii' (policies/data-standards.yaml)
  sourceClass: relational-cdc     # relational-cdc | external-api | file-batch | stream | unstructured
  freshnessSLA: PT15M             # ISO-8601 duration
  retention: P365D                # ISO-8601 duration
  ingestionMode: continuous-cdc   # continuous-cdc | scheduled-batch | event-stream | webhook
  connection:
    secretRef:
      name: shop-cdc-source-credential
      namespace: streaming
  targetBronze:
    namespace: bronze_shop
    tableName: cdc_customers
    partitionBy: "day(_ingest_ts)"
  schemaContractRef: contracts/shop/customers-contract.yaml
```

#### 4.1.3 Standard Bronze Ingestion Contract
In compliance with [`medallion-architecture.md`](medallion-architecture.md) section 3 (`:90-93`) and section 7 (`:225-238`), all Bronze Iceberg tables must preserve raw source fidelity while attaching standard ingestion metadata columns:

| Column Name | Iceberg Type | Description |
|---|---|---|
| `_raw` | `STRING` | Unmodified source record payload (JSON string or encoded payload). Stored as `STRING` for portability in Iceberg format-version 2 (`medallion-architecture.md:92`). |
| `_ingest_ts` | `TIMESTAMP(6)` | UTC timestamp when the record was written to Bronze. |
| `_source_system` | `STRING` | Registered source identifier (e.g., `shop-postgres`). |
| `_source_ref` | `STRING` | Coordinates in source system (Kafka `topic/partition/offset`, file S3 URI + SHA-256, or API request ID + cursor). |
| `_batch_id` | `STRING` | Ingestion run UUID generated by the intake control plane. |
| `_schema_version` | `STRING` | Active contract/schema version string at ingestion time. |

#### 4.1.4 Malformed Records and Quarantine Handling
- If a record cannot be parsed or violates physical wire formatting during Bronze ingestion, it is routed to a designated quarantine table `<bronze_table>_quarantine` in the same Bronze namespace.
- The quarantine table retains `_raw`, `_ingest_ts`, `_source_ref`, `_batch_id`, plus `_error_code` and `_error_message`.
- Quarantined records inherit the highest classification of the source dataset (default `pii` if source is `pii`) and are strictly inaccessible to analysts (`medallion-architecture.md:84-85, 179-181`).

#### 4.1.5 Deterministic Replay and Backfill
- Replay is executed from Bronze snapshots rather than re-querying the source system (`medallion-architecture.md:218-219`).
- Backfill pipelines write to downstream Silver tables using deterministic `MERGE INTO` on the business key (`customer_id`, `order_id`) to ensure idempotency without duplicate records.

---

### 4.2 Database Schema Discovery, Profiling, and Reverse Engineering (Issue #75)

#### 4.2.1 Extensible Database Discovery Engine
Beluga adopts an automated, containerized schema discovery runner executed as an Airflow `KubernetesPodOperator` task in namespace `orchestration`:
- **Core Technology**: Python 3.12 with SQLAlchemy 2.0 (MIT License) and dialect drivers.
- **Supported Adapters**:
  - PostgreSQL: `psycopg2-binary` (LGPL with exception / BSD compatible) or `asyncpg` (Apache-2.0).
  - MySQL / MariaDB: `PyMySQL` (MIT License).
  - Microsoft SQL Server: `pymssql` (LGPL) or FreeTDS ODBC.
  - Oracle: `python-oracledb` (Apache-2.0 / Universal Permissive License).
- **License / SBOM Compliance**: All runtime profiling libraries must adhere to `policies/license-policy.yaml` (Apache-2.0, MIT, BSD). Copyleft-only drivers (GPL) are prohibited from production container builds.

#### 4.2.2 Introspection Scope and Canonical Schema Model
The discovery engine inspects the source catalog and generates a canonical schema definition:
- Tables, views, and materialized views.
- Columns: name, ordinal position, native data type, mapped Iceberg canonical data type, nullability, default values, character length, numeric precision and scale.
- Constraints: Primary Keys, Foreign Keys (including referenced table and column), Unique constraints, Check constraints.
- Indexes: index name, column list, unique flag.

**Canonical Type Mapping Table (Proposed)**:

| Source Engine Type (PostgreSQL / MySQL / Oracle / MSSQL) | Beluga Canonical / Iceberg Type |
|---|---|
| `INT`, `INTEGER`, `SERIAL`, `NUMBER(9,0)` | `INTEGER` |
| `BIGINT`, `BIGSERIAL`, `NUMBER(18,0)` | `BIGINT` |
| `NUMERIC(p,s)`, `DECIMAL(p,s)`, `NUMBER(p,s)` | `DECIMAL(precision, scale)` |
| `VARCHAR`, `TEXT`, `CHAR`, `NVARCHAR`, `CLOB` | `STRING` |
| `BOOLEAN`, `TINYINT(1)`, `BIT` | `BOOLEAN` |
| `FLOAT`, `REAL`, `FLOAT4`, `BINARY_FLOAT` | `FLOAT` |
| `DOUBLE PRECISION`, `FLOAT8`, `BINARY_DOUBLE` | `DOUBLE` |
| `DATE` | `DATE` |
| `TIMESTAMP`, `DATETIME2`, `TIMESTAMP WITHOUT TIME ZONE` | `TIMESTAMP(6)` |
| `TIMESTAMPTZ`, `TIMESTAMP WITH TIME ZONE` | `TIMESTAMPTZ` |
| `JSON`, `JSONB` | `STRING` (Iceberg v2 representation) |
| `BYTEA`, `BLOB`, `VARBINARY` | `BINARY` |

#### 4.2.3 Safe, Bounded Profiling and Resource Limits
To prevent discovery workloads from degrading production operational databases:
- **Strict Query Bounds**: Full table scans are forbidden on unpartitioned tables exceeding 100,000 rows.
- **Sampling**: Column statistics use `TABLESAMPLE SYSTEM (5)` (PostgreSQL) or bounded sampling queries (`SELECT ... FROM (SELECT ... FROM table LIMIT 10000) sample`).
- **Collected Statistics**:
  - Table level: approximate row count (from `pg_class.reltuples` / `information_schema`), physical size.
  - Column level: null rate (percentage), approximate distinct values (HyperLogLog / `COUNT(DISTINCT)` on sample), minimum and maximum value (for numeric/temporal non-PII fields), average string length.
- **Resource Constraints**: Discovery containers run with strict Kubernetes limits (`resources.limits.cpu: "1000m"`, `resources.limits.memory: "1Gi"`) and a query timeout of 30 seconds (`statement_timeout = '30000'`).

#### 4.2.4 PII Candidate Detection and Sample Masking
- The discovery engine analyzes column names, comments, and sample data patterns against regex heuristics (e.g., email, phone, resident registration number, credit card).
- Columns matching sensitivity heuristics are flagged as candidate `classification: pii`.
- **Sample Protection**: Any extracted sample records are masked in-flight (e.g., `user@domain.com` → `u***@domain.com`) before being persisted in discovery reports. Raw PII is never included in discovery artifacts.

#### 4.2.5 Least-Privilege Introspection Roles
Discovery must not run as database superusers. A least-privilege role is provisioned per source database:
- PostgreSQL example:
  ```sql
  CREATE ROLE beluga_profiler WITH LOGIN PASSWORD '...';
  GRANT CONNECT ON DATABASE shop TO beluga_profiler;
  GRANT USAGE ON SCHEMA public TO beluga_profiler;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO beluga_profiler;
  ALTER ROLE beluga_profiler SET statement_timeout = '30s';
  ```

#### 4.2.6 Drift Detection Between Discovery Runs
Each discovery run produces a canonical JSON artifact `discovery/<source_id>/<timestamp>.json`. A CI or Airflow diff task compares consecutive discovery snapshots:
- Additive changes (new nullable columns): flagged for automated contract update.
- Breaking changes (dropped columns, narrowed data types, renamed keys): trips a severity alert and blocks automated pipeline promotion.

---

### 4.3 External API Connector Framework (Issue #77)

#### 4.3.1 Connector Architecture and Runtime
External API connectors run as scheduled Airflow tasks executing containerized Python runners (`KubernetesPodOperator`), isolating network access and dependencies:
- **Authentication Handlers**:
  - OAuth2 Client Credentials & Authorization Code with Refresh Tokens.
  - OIDC / Service Account JWTs.
  - API Keys (injected via HTTP Header or Query Parameter).
  - Mutual TLS (mTLS) with client certificates mounted from Kubernetes Secrets.
- **Credential Storage**: Credentials reside in Kubernetes Secrets (e.g., `secretKeyRef`) or HashiCorp Vault. No API key or secret token is ever committed to source code or DAG files.

#### 4.3.2 Extraction and Resilience Patterns
- **Pagination**: Supports Cursor-based (`next_cursor`), Offset/Limit (`offset`, `limit`), Page-number (`page`, `size`), and Link header (`RFC 5988`) pagination models.
- **Rate Limiting & Throttling**: Implements client-side token-bucket rate limiting matching the provider's published quota.
- **HTTP 429 Handling**: Automatically honors `Retry-After` response headers with exponential backoff and jitter (maximum 5 retries).
- **Incremental Extraction**: State is maintained via persistent watermark markers (`last_extracted_updated_at` or high-watermark ID) committed to SeaweedFS S3 state storage.
- **Circuit Breaker**: Halts execution after 3 consecutive HTTP 5xx responses or authentication failures, writing an operational incident record.

#### 4.3.3 Webhook Ingestion Path
For event-driven APIs:
- External webhooks terminate at APISIX Ingress Gateway (`apisix.platform-system.svc.cluster.local`).
- APISIX validates HMAC signatures (e.g., via `hmac-auth` plugin) and forwards raw payloads into a dedicated Kafka topic `webhooks.<source_domain>.<event_type>`.
- Flink SQL or Airflow consumes from Kafka and lands the raw payload into the corresponding Bronze table.

---

### 4.4 OpenAPI-Driven Contract & Schema Governance (Issue #78)

#### 4.4.1 OpenAPI Specification Registration
External APIs must register their official specification (OpenAPI 3.0.x or 3.1.x) under `contracts/apis/<source_id>/openapi.yaml`:
- Source of truth: [OpenAPI Specification v3.1.0](https://spec.openapis.org/oas/v3.1.0.html) (accessed 2026-10-08; Apache-2.0 License).
- Essential OpenAPI objects utilized by Beluga:
  - `paths`: Defines endpoint URIs, path parameters, and query parameters (`oas:4.8.8`).
  - `operationId`: Unique identifier mapped to the ingestion pipeline operation (`oas:4.8.10`).
  - `responses`: HTTP status code schemas, specifically `200 OK` response payload schema (`oas:4.8.16`).
  - `components.schemas`: Reusable data schemas mapping to entity models (`oas:4.8.7, 4.8.24`).
  - `securitySchemes`: Declares OAuth2 flows, API keys, or HTTP bearer tokens (`oas:4.8.27`).

#### 4.4.2 Automated Contract Drift and Compatibility Checking
Beluga implements a schema contract validator (`scripts/ci/check-api-contract-drift.py`) comparing observed Bronze payload samples against the registered OpenAPI schema:
- **Non-Breaking Changes**:
  - Adding a new optional (non-required) field to the response schema.
  - Adding a new endpoint or operation.
- **Breaking Changes**:
  - Removing an existing response property.
  - Changing a property data type (e.g., `integer` → `string` or scalar → array).
  - Renaming an existing property.
- When breaking contract drift is detected at runtime:
  - The offending payload batch is routed to `<table_name>_quarantine`.
  - The intake control plane marks the ingestion run as `CONTRACT_DRIFT_QUARANTINED` and prevents promotion to Silver.

#### 4.4.3 Non-OpenAPI Fallback
For legacy APIs lacking OpenAPI specifications (SOAP, unstructured REST, proprietary RPC):
- Teams must declare a governed JSON Schema conforming to draft 2020-12 or an Open Data Contract Standard (ODCS v3.2.0) file as defined in [`data-contract-standard.md`](data-contract-standard.md).
- The contract validator applies the same drift rules against the declared JSON Schema.

---

### 4.5 Governed Data Intake Control Plane and Source-to-Platform Reconciliation (Issue #82)

#### 4.5.1 Ingestion Flow Lifecycle
The intake control plane tracks every data transfer execution across all source classes:
```
[PLANNED] ---> [EXTRACTING / INGESTING] ---> [LANDED_BRONZE]
                                                    |
                                          [RECONCILING]
                                           /         \
                             (Match OK)   /           \  (Mismatch / Drift)
                                         v             v
                                   [COMMITTED]    [QUARANTINED / FAILED]
                                         |             |
                                  (Trigger Silver)  (Alert Operator & Audit)
```

**Run Metadata Recorded**:
- `run_id`: UUIDv4 for the ingestion batch.
- `source_id`: Registered source identifier.
- `target_dataset`: Fully qualified Iceberg table (e.g., `bronze_shop.cdc_customers`).
- `execution_window`: `[window_start_ts, window_end_ts]`.
- `source_metrics`: Expected record count, expected byte volume, source checksum/hash.
- `platform_metrics`: Actual records written, Iceberg snapshot ID, data file count.
- `reconciliation_status`: `COMMITTED`, `QUARANTINED`, `MISMATCH_FLAGGED`.

#### 4.5.2 Source-to-Platform Reconciliation Mechanics
Reconciliation verifies that data transferred from the source matches the data committed in the lakehouse:

1. **Batch & API Ingestion Reconciliation**:
   - **Source Count**: Total rows extracted or returned by API pagination during the execution window.
   - **Platform Count**: Querying the Iceberg snapshot summary via Lakekeeper / Trino:
     ```sql
     -- Query Iceberg table snapshots metadata
     SELECT snapshot_id,
            summary['total-records'] AS total_records,
            summary['added-records'] AS added_records,
            summary['total-data-files'] AS total_files
     FROM iceberg.bronze_shop."cdc_customers$snapshots"
     ORDER BY committed_at DESC
     LIMIT 1;
     ```
   - **Variance Check**:
     $$\text{Variance} = |\text{Source Record Count} - \text{Iceberg Added Records}|$$
   - For batch and API extractions, acceptable tolerance is strictly **0%**. Any non-zero variance halts the pipeline.
2. **Streaming & CDC Ingestion Reconciliation**:
   - For continuous CDC (Debezium → Kafka → Flink → Iceberg), instantaneous counts diverge due to in-flight buffers and checkpoint latency (30s checkpoint interval in `cdc_customers.sql:2`).
   - Reconciliation runs on a scheduled window (e.g., hourly):
     - Source: Querying source database high-watermark sequence / LSN or count of records with `updated_at <= :window_end`.
     - Platform: Counting distinct primary keys in Iceberg where `_ingest_ts <= :window_end + PT5M`.
     - Permissible variance threshold: Configurable (default: 0 missing records once CDC buffer drains; see Owner Decision OD-4).
3. **Checksum and Volume Verification**:
   - For file ingestion (CSV/Parquet): The source SHA-256 hash and byte size are compared against the SeaweedFS S3 object ETag/checksum and metadata recorded in `_source_ref`.

#### 4.5.3 Partial and Duplicate Transfer Handling
- **Partial Transfers**: If an API extraction terminates unexpectedly mid-page, the intake run is aborted. Because Bronze writes occur atomically per Airflow task batch or per Flink checkpoint commit, partial records from failed runs are never published to Silver.
- **Duplicate Deliveries**: At-least-once delivery from Kafka or API retries is deduplicated during the Bronze-to-Silver transformation using the source primary key and event timestamp (`medallion-architecture.md:65, 220-221`).

---

## 5. Verification and Test Ideas

### 5.1 Test 1: Source Onboarding Preflight Gate (Static CI)
- **Goal**: Verify that invalid source registrations are rejected before merge.
- **Method**: Run CI validator against a test source YAML lacking `owner` and `classification`.
- **Expected Outcome**: Validation fails with non-zero exit code reporting missing mandatory metadata fields per `policies/data-standards.yaml`.

### 5.2 Test 2: Database Schema Introspection on Live PostgreSQL
- **Goal**: Verify that least-privilege reflection extracts keys, constraints, and types matching `shop-schema.sql`.
- **Method**: Execute profiling script targeting `postgres-main-rw.database.svc.cluster.local:5432/shop` using read-only role.
- **Expected Outcome**: Produced JSON schema reflects `customers` table with PK `customer_id`, columns `name`, `email`, `city`, `created_at`, flagging `email` and `name` as PII candidates.

### 5.3 Test 3: Hermetic Mock OpenAPI Connector & Drift Test
- **Goal**: Verify API connector pagination, retry logic, and contract drift detection without external network dependencies.
- **Method**: Stand up a local Python mock HTTP server delivering paginated responses matching an OpenAPI 3.1.0 specification. In phase 2, inject a breaking schema change (remove a required property).
- **Expected Outcome**: Phase 1 completes ingestion with 100% record match. Phase 2 detects breaking drift, routes payload to quarantine, and marks status `CONTRACT_DRIFT_QUARANTINED`.

### 5.4 Test 4: Deliberate Ingestion Mismatch Reconciliation Test
- **Goal**: Verify that source-vs-platform reconciliation catches record count mismatches.
- **Method**: Ingest 100 records into a mock Bronze table, but inject a manifest declaring 105 expected records.
- **Expected Outcome**: Intake control plane flags a variance of 5 records, sets status `MISMATCH_FLAGGED`, logs reconciliation audit evidence, and blocks downstream Silver DAG execution.

---

## 6. Owner Decisions Remaining

| Decision ID | Topic | Options Considered | Recommendation | Rationale |
|---|---|---|---|---|
| **OD-INT-1** | Source registration store | (A) GitOps YAML directory (`sources/**/*.yaml`)<br>(B) Database table / OpenMetadata REST API only | **Option A: GitOps YAML baseline** | Ensures PR review, change history, and CI validation before runtime synchronization to OpenMetadata. |
| **OD-INT-2** | Profiling execution engine | (A) Airflow `KubernetesPodOperator` with Python/SQLAlchemy<br>(B) OpenMetadata built-in Ingestion Framework | **Option A: Airflow Pod Operator** | Keeps orchestration centralized in Airflow and works in resource-constrained profiles where OpenMetadata ingestion is disabled. |
| **OD-INT-3** | External API ingestion runtime | (A) Airflow scheduled batch pods for polling APIs<br>(B) Dedicated long-running microservice daemon | **Option A: Airflow scheduled pods** | Minimizes idle memory footprint; ephemeral pods run on demand and exit upon completion. |
| **OD-INT-4** | CDC reconciliation tolerance | (A) Strict 0% difference after buffer drain window<br>(B) Heuristic threshold (e.g., ±0.1%) | **Option A: Strict 0% after buffer drain** | Prevents silent data loss in transactional tables (`customers`, `orders`). |
| **OD-INT-5** | Bronze raw payload storage format | (A) String (UTF-8 JSON string)<br>(B) Binary (gzip/zstd compressed byte array) | **Option A: String** | Compatible with Iceberg format-version 2 without proprietary variant types, matching `medallion-architecture.md:92`. |

---

## 7. Ordered Follow-up Implementation Tasks

1. **Task 1: Source Registration Schema & CI Preflight Validator**
   - Implement JSON Schema / Pydantic validator `scripts/ci/check-source-definitions.py` validating `sources/**/*.yaml` for required fields (`owner`, `classification`, `freshnessSLA`, `retention`).
   - *Acceptance Test Idea*: Validator passes on valid source fixture and fails on fixture missing `classification`.
2. **Task 2: Least-Privilege PostgreSQL Discovery & Profiling Script**
   - Create containerized discovery script connecting to `shop` database, outputting canonical schema JSON and identifying PII candidate columns.
   - *Acceptance Test Idea*: Run script against `postgres-main`; verify generated schema matches table definitions in `shop-schema.sql:1-48`.
3. **Task 3: OpenAPI Contract Drift Validator**
   - Implement CLI tool comparing sample JSON payloads against OpenAPI 3.1.0 schemas, reporting breaking vs non-breaking changes.
   - *Acceptance Test Idea*: Unit test validates that removing a field produces an exit code 1 with breaking change description.
4. **Task 4: Reference Airflow API Intake & Reconciliation DAG**
   - Build a reference Airflow DAG that fetches records from a mock API, appends them to a Bronze Iceberg table, queries Iceberg `$snapshots` metadata, and verifies row-count equality.
   - *Acceptance Test Idea*: DAG completes successfully on matching counts, and halts with alert on artificially injected count mismatch.

---

## 8. Sources

### 8.1 External Specifications and Standards
- [S1] OpenAPI Initiative, *OpenAPI Specification v3.1.0*, https://spec.openapis.org/oas/v3.1.0.html (accessed 2026-10-08). Apache License 2.0. Sections read: 4.8.7 Components, 4.8.8 Paths, 4.8.10 Operation, 4.8.16 Responses, 4.8.24 Schema Object, 4.8.27 Security Scheme.
- [S2] Databricks, *What is the medallion lakehouse architecture?*, https://docs.databricks.com/aws/en/lakehouse/medallion (accessed 2026-10-07).
- [S3] Apache Iceberg, *Iceberg Table Spec v2*, https://iceberg.apache.org/spec/ (accessed 2026-10-07).
- [S4] Open Data Contract Standard, https://github.com/bitol-io/open-data-contract-standard (accessed 2026-10-07). Apache License 2.0.

### 8.2 Repository Sources (Verified at Commit `d424c38`)
- Debezium Deployment & Registration: `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:120-275`.
- Flink SQL Streaming Ingestion: `gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`.
- Airflow Operator & RBAC: `gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`.
- Maintenance DAG: `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`.
- Lakekeeper Bootstrap: `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:1-120`.
- OpenMetadata & OpenSearch: `gitops/charts/beluga-data/templates/11-openmetadata.yaml:1-348`.
- Governance Baseline: `policies/data-standards.yaml:1-117`.
- Component Versions: `VERSIONS.md:1-60`.
- Network Policy Lakekeeper: `gitops/charts/beluga-data/templates/04b-lakehouse-network-policy.yaml:1-50`.

### 8.3 Live Cluster Verification (Verified 2026-10-08)
- Pods running in namespaces `streaming`, `database`, `orchestration`, `lakehouse`, `governance`, `storage`, and `analytics` verified via `kubectl get pods -A` using kubeconfig `/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`.
- *Items Not Verified Live*: Specific Debezium internal replication slot lag, Oracle/MSSQL live database connections (external systems not provisioned in local VM), live external OpenAPI endpoint network reachability.
