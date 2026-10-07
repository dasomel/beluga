# DuckDB Phase 1 Detailed Design: Iceberg Boundaries, Routing, Security, and Workflows

English | [한국어](duckdb-phase1-design-ko.md)

Refs #62 #63 #64 #65 #66 #67 #68 #69.

> **Status: PROPOSAL. Documentation only.**
> This design document elaborates the adoption framework defined in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md) and does not alter any of its recorded decisions. Any discrepancy between this document and ADR-0004 constitutes an open owner decision. No manifest, container image, Helm value, or `VERSIONS.md` row is modified by this document.

---

## Relationship to ADR-0004 and Architectural Scope

[ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md#L58-L69) adopted DuckDB as a **complementary embedded analytics engine** running alongside Trino, not as a replacement. The primary goal is reducing resource overhead on lightweight profiles, local development, and ephemeral CI validation while preserving Beluga's centralized governance and distributed execution capabilities.

This document provides technical design specifications for the open follow-up issues (#62 through #69) across eight domains:
1. **[Issue #62](#1-iceberg-compatibility-and-safe-write-boundaries-issue-62)**: Iceberg compatibility matrix and safe read/write boundaries.
2. **[Issue #63](#2-query-workload-routing-and-trino-fallback-policy-issue-63)**: Workload routing classes, thresholds, and deterministic Trino fallback.
3. **[Issue #64](#3-governed-credentials-and-access-path-for-embedded-duckdb-issue-64)**: Governed authentication, Lakekeeper OpenFGA authorization, and secret injection.
4. **[Issue #65](#4-trinoduckdb-result-consistency-and-benchmark-suite-issue-65)**: Semantic parity validation rules and reproducible benchmark methodology.
5. **[Issue #66](#5-duckdb-in-ci-airflow-and-reproducible-local-workflows-issue-66)**: Execution paths for CI, Airflow tasks, and developer workstations.
6. **[Issue #67](#6-engine-level-metrics-and-resource-attribution-issue-67)**: Structured execution events, telemetry emission, and Prometheus metrics.
7. **[Issue #68](#7-result-reuse-spill-and-temporary-data-lifecycle-issue-68)**: Temporary scratch files, disk spill limits, cache invalidation, and PII isolation.
8. **[Issue #69](#8-evaluation-gate-for-quack-remote-protocol-issue-69)**: Strict evaluation gate criteria before considering DuckDB Quack service mode.

### Normative Security Guardrails (Inherited from ADR-0004)

All proposals in this document strictly enforce the non-negotiable security requirements established in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md#L84-L124):
- **Distinct OIDC Identity**: DuckDB clients authenticate using their own dedicated Keycloak OIDC client credentials (`duckdb-ci`, `duckdb-airflow`), never reusing `service-account-trino` or `service-account-flink`.
- **Table-Level Grants Only**: OpenFGA grants via Lakekeeper must be explicitly scoped to specific tables. Warehouse-level or namespace-level grants are strictly prohibited because Lakekeeper inherits `select` to all child tables, which would expose PII tables (`lake.customers`, classified as `pii` in [`policies/resources.yaml`](../policies/resources.yaml#L16-L23)).
- **Zero Static Admin Storage Credentials**: Static administrator S3 access keys must never be provided to DuckDB clients on production or PII paths. Credential vending from Lakekeeper is mandatory for production data. The only permitted static key is scoped exclusively to a dedicated non-PII test bucket (`beluga-test`) with synthetic data for CI and PoC validation.
- **Strict Network Isolation**: Kubernetes NetworkPolicies must deny all traffic by default and only permit explicitly selected DuckDB client pods to communicate with `lakekeeper:8181`, `keycloak:8080`, and `seaweedfs-s3:8333`.
- **Read-Only First**: DuckDB remains strictly read-only for Lakekeeper catalog tables until write safety and commit concurrency semantics are empirically verified.

---

## 1. Iceberg Compatibility and Safe Write Boundaries (Issue #62)

### 1.1 Purpose and Acceptance Criteria Mapping
Issue #62 requires defining the supported DuckDB and Apache Iceberg compatibility matrix, distinguishing read-only from write workloads, establishing write eligibility criteria, adding negative tests for unsupported mutations, verifying snapshot commit semantics, and confirming that Trino/Flink remain the authoritative mutation path.

### 1.2 Current State (VERIFIED)
- **Catalog Configuration**: Trino's Iceberg catalog is configured in [`gitops/charts/beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml#L7-L28). It connects to the Lakekeeper REST catalog at `http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog` for warehouse `lake`. Trino uses OAuth2 client credentials against Keycloak (`http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token`) and holds a static S3 access key (`s3.aws-access-key=${ENV:TRINO_S3_ACCESS_KEY}`).
- **Lakekeeper Warehouse**: Lakekeeper's `lake` warehouse is bootstrapped in [`gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L137-L138) with `"sts-enabled": false` and static credentials pointing to bucket `beluga-lake`.
- **Data Classification**: In [`policies/resources.yaml`](../policies/resources.yaml#L1-L23), `lake.events_enriched` and `lake.orders` are labeled `classification: internal`, whereas `lake.customers` is labeled `classification: pii` with sensitive column `email`.
- **Authoritative Mutation Engines**: Flink handles streaming CDC ingestion (`14-flink-jobs.yaml`), while Trino handles batch compaction and maintenance in [`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py#L24-L52).
- **Live Cluster Status**: Lakekeeper pod `lakehouse/lakekeeper-66bbf6776c-dtpcx` is Running; Trino coordinator `analytics/trino-coordinator-76cf9f6b9-rkksm` and worker `analytics/trino-worker-5d75dd75b-g95l4` are Running (verified live 2026-10-08).

### 1.3 External Documentation and Evidence (Accessed 2026-10-08)
- **DuckDB Iceberg Overview** ([`https://duckdb.org/docs/current/core_extensions/iceberg/overview`](https://duckdb.org/docs/current/core_extensions/iceberg/overview)): Direct table reads via `iceberg_scan` are read-only and require metadata version hints (`version-hint.text` or explicit `version`). Attaching an Iceberg REST catalog (`ATTACH ... TYPE iceberg`) unlocks catalog-managed tables.
- **DuckDB Iceberg Writing** ([`https://duckdb.org/docs/current/core_extensions/iceberg/writing`](https://duckdb.org/docs/current/core_extensions/iceberg/writing)): Writing requires an attached REST catalog. Supported operations include `CREATE TABLE` (with partitioning: identity, year, month, day, hour, bucket, truncate), `INSERT INTO` (including `BY NAME`), `UPDATE`, `DELETE`, `MERGE INTO`, and schema evolution (`ALTER TABLE ADD/DROP/RENAME/ALTER COLUMN`).
  - *Documented Limitation 1*: `UPDATE` and `DELETE` write **positional delete** files only; copy-on-write is unsupported.
  - *Documented Limitation 2*: `UPDATE` and `DELETE` require **merge-on-read** semantics. If `write.update.mode` or `write.delete.mode` is set to anything else, DuckDB execution fails.
  - *Documented Limitation 3*: `write.target-file-size-bytes` and `write.parquet.row-group-size-bytes` table properties are unsupported on partitioned tables and raise an error unless `ignore_target_file_size_for_partitioned_tables` is set to `true`.
- **DuckDB Iceberg Troubleshooting** ([`https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting`](https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting)): In DuckDB 1.4 LTS, reading tables containing deletes is explicitly documented under Limitations: *"Reading tables with deletes is not yet supported."*
- **Concurrency & Commits**: Multi-engine commit conflict resolution and catalog retry semantics against Lakekeeper under concurrent Trino/Flink mutations remain **UNVERIFIED** (as recorded in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md#L43-L56)).

### 1.4 Gaps vs Acceptance Criteria
1. Beluga lacks a formal, version-pinned Iceberg compatibility matrix document defining which Iceberg table specifications DuckDB may query or mutate.
2. DuckDB read compatibility on tables with positional deletes is unverified and known to fail on DuckDB 1.4 LTS.
3. No write boundaries or validation barriers exist to prevent DuckDB from issuing mutations against shared production tables (`lake.*`).
4. Automated rollback procedures for aborted DuckDB writes do not exist.

### 1.5 Proposal (Proposed)

#### Proposed Compatibility Matrix (DuckDB Iceberg Extension)

| Workload / Table Feature | DuckDB Support Status | Authoritative Engine | Beluga Policy |
|---|---|---|---|
| Unpartitioned / Partitioned table read | Supported (v1, v2) | DuckDB / Trino | Permitted for granted tables |
| Append-only read (`lake.events_enriched`) | Supported | DuckDB / Trino | Permitted for granted tables |
| Direct path read (`iceberg_scan`) | Read-only | Trino / DuckDB | Restricted to debugging; bypasses Lakekeeper authz |
| Read tables containing deletes | **Conditional** (fails in 1.4 LTS) | Trino | **Blocked on 1.4 LTS**; requires verification on 1.5+ |
| `INSERT INTO` append writes | Supported via REST catalog | Trino / Flink | Permitted **only** on dedicated sandbox/derived namespaces |
| `UPDATE` / `DELETE` mutations | Merge-on-read only (positional) | Trino | **Prohibited on production tables**; sandbox only |
| Copy-on-write table mutations | **Unsupported** | Trino | **Prohibited**; fails closed |
| `MERGE INTO` (Upsert) | Supported via REST catalog | Trino / Flink | **Prohibited on production tables**; sandbox only |
| Schema Evolution (`ALTER TABLE`) | Supported via REST catalog | Trino | **Prohibited for DuckDB**; DDL reserved for migration jobs |
| Streaming high-frequency commits | Not suited | Flink | Flink only |

#### Safe Write Boundaries
- **Production Immutability**: DuckDB clients are strictly denied write privileges (`modify`, `create`) on the `lake` warehouse and all production namespaces (`raw`, `curated`, `lake`).
- **Sandbox Boundary**: DuckDB writes are permitted solely on an isolated `sandbox` namespace or user-specific scratch tables (subject to [Issue #70](medallion-architecture.md)).
- **Rollback & Garbage Collection**: Because DuckDB commits atomically through the Iceberg REST catalog API, an aborted write leaves orphaned Parquet files in object storage. These orphaned files must be reclaimed on schedule by Airflow's compaction DAG ([`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py#L38-L50)).

### 1.6 Verification and Test Ideas
- **Read Parity Test**: Execute `SELECT count(*), sum(amount)` on `lake.orders` concurrently using DuckDB and Trino against the same Iceberg snapshot; assert zero difference.
- **Negative Delete-Read Test**: Construct a test Iceberg table containing positional deletes in the test warehouse; execute a DuckDB read under DuckDB 1.4 LTS and 1.5+ to verify failure or success mode.
- **Negative Write-Enforcement Test**: Attempt an `UPDATE` operation from a DuckDB client against `lake.events_enriched`; assert that Lakekeeper/OpenFGA denies the commit with HTTP 403.
- **Copy-on-Write Rejection Test**: Attempt an `UPDATE` on an Iceberg table configured with `write.update.mode='copy-on-write'`; assert that DuckDB raises an explicit descriptive error without metadata corruption.

### 1.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-62-1 | Should DuckDB writes be restricted permanently to sandbox namespaces, or permitted on curated gold layers? | **Sandbox namespaces only** | Prevents subtle Iceberg commit conflicts with Flink and Trino compaction. |
| OD-62-2 | Pin DuckDB to 1.4 LTS or adopt 1.5.x/2.0.x for delete-vector read support? | **Pin 1.4 LTS initially, canary 1.5+ in CI** | Preserves stability while evaluating delete-vector compatibility in isolated CI pipelines. |

### 1.8 Follow-Up Implementation Tasks
1. **T-62-1 (CI Compatibility Suite)**: Implement automated CI test suite querying synthetic partitioned, sorted, and delete-bearing Iceberg tables with DuckDB. Acceptance: CI fails closed if DuckDB produces inaccurate rows on tables with deletes.
2. **T-62-2 (Write Admission Filter)**: Implement client-side wrapper assertion rejecting any write query whose target table does not reside in `sandbox.*`. Acceptance: Unit tests verify rejection of writes targeting `lake.*`.

---

## 2. Query Workload Routing and Trino Fallback Policy (Issue #63)

### 2.1 Purpose and Acceptance Criteria Mapping
Issue #63 requires establishing a deterministic workload-routing policy that routes queries to DuckDB when sufficient and falls back to Trino when centralized governance, distributed execution, or BI concurrency is required, including manual overrides and telemetry.

### 2.2 Current State (VERIFIED)
- **Single Engine Deployment**: Trino is currently the sole query execution engine in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml), serving Superset dashboards ([`08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml)) and Airflow DAGs ([`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py)).
- **ADR-0004 Allocation Matrix**: [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md#L70-L83) establishes the baseline allocation: single-user notebooks, CI validation, and small Airflow transforms go to DuckDB; shared BI, federated queries, large scans, and OPA-governed datasets go to Trino.

### 2.3 Gaps vs Acceptance Criteria
1. No programmatic routing layer or quantitative size thresholds exist to choose between engines.
2. Manual engine override flags (`BELUGA_SQL_ENGINE`) are not implemented.
3. Fallback logic for unsupported syntax, memory exhaustion, or authorization denial is undefined.
4. No fallback counters or metrics are collected.

### 2.4 Proposal (Proposed)

#### Workload Classification & Routing Rules

```
                      Incoming SQL Query / Job
                                 |
         +-----------------------+-----------------------+
         |                                               |
Does query touch PII dataset?             Is it interactive BI (Superset)
Or require OPA row/column policy?         or multi-user dashboard?
         | YES                                           | YES
         v                                               v
   [TRINO ONLY]                                    [TRINO ONLY]
         | NO                                            | NO
         +-----------------------+-----------------------+
                                 |
             Is workload CI contract check, local ad-hoc,
             or bounded single-partition ETL (< 5 GB)?
                                 |
                     +-----------+-----------+
                     | YES                   | NO
                     v                       v
               [DUCKDB FIRST]           [TRINO ONLY]
                     |
            Execution Error / Spill Cap / Unsupported Syntax?
                     | YES
                     v
             [FALLBACK TO TRINO] (with telemetry event)
```

| Workload Class | Default Engine | Selection Criteria | Fallback to Trino Allowed? |
|---|---|---|---|
| **Class 1: CI & Schema Checks** | **DuckDB** | Ephemeral runner, non-PII test warehouse, scan < 1 GB | No (fail CI loudly if broken) |
| **Class 2: Single-User Ad-Hoc** | **DuckDB** | Interactive developer queries on non-PII internal datasets | Yes (on syntax or capacity failure) |
| **Class 3: Bounded Pipeline Task** | **DuckDB** | Airflow transform on single partition, scan < 5 GB | Yes (if memory limit exceeded) |
| **Class 4: Concurrent BI / Superset** | **Trino** | Superset dashboards, concurrent analysts | n/a (Trino default) |
| **Class 5: Distributed / Federated** | **Trino** | Scans > 5 GB, cross-source joins (Postgres + Iceberg) | n/a (Trino default) |
| **Class 6: PII / Governed Policies** | **Trino** | Accesses `lake.customers` or policies in `trino.rego` | **Strictly prohibited** (No DuckDB path) |

#### Quantitative Routing Thresholds (Proposed)
- **Scan Data Cap**: 5 GB uncompressed scan volume limit for DuckDB. Queries estimating > 5 GB route to Trino.
- **Partition Cap**: Maximum of 50 partitions scanned by a single DuckDB query.
- **Memory Ceiling**: DuckDB process memory capped at 4 GB (`SET max_memory = '4GB'`).

#### Deterministic Fallback Specification
- **Trigger Conditions**: Fallback occurs if DuckDB raises:
  1. `UNSUPPORTED_SYNTAX`: Parser or extension error for features like distributed grouping sets.
  2. `CAPACITY_LIMIT`: Process exceeds memory limit and spill allocation.
  3. `AUTH_UNSUPPORTED`: Lakekeeper catalog rejects query due to missing table grant.
- **Deterministic Action**: The client wrapper catches the exception, logs a structured fallback warning, increments Prometheus counter `beluga_query_fallback_total`, and resubmits the exact SQL query to Trino over HTTPS port 8443.
- **Manual Override**: Applications and CLI scripts may specify environment variable `BELUGA_SQL_ENGINE=duckdb` (force DuckDB, no fallback) or `BELUGA_SQL_ENGINE=trino` (force Trino).

### 2.5 Verification and Test Ideas
- **Threshold Routing Test**: Execute query scanning a 10 GB synthetic dataset; verify router automatically chooses Trino.
- **Syntax Fallback Test**: Submit a query using Trino-specific functions to the router; verify graceful fallback to Trino with emission of fallback telemetry.
- **PII Guardrail Test**: Submit `SELECT * FROM lake.customers` to the router; verify router rejects DuckDB unconditionally and selects Trino.

### 2.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-63-1 | What default scan threshold should trigger routing to Trino? | **Proposed 5 GB** | Matches typical single-node container memory limits (4–8 GB) in Beluga profiles. |
| OD-63-2 | Should batch pipeline jobs fall back silently to Trino? | **Fail loudly in batch/CI, fallback in ad-hoc** | Silent fallback in ETL hides performance regressions and unexpected costs. |

### 2.7 Follow-Up Implementation Tasks
1. **T-63-1 (Routing Library)**: Implement Python module `beluga_router` implementing the routing matrix and manual override switches. Acceptance: Unit test suite verifies correct engine selection across all six workload classes.
2. **T-63-2 (Fallback Metric Integration)**: Hook router exceptions into Prometheus client counters. Acceptance: Metric `beluga_query_fallback_total` increments upon simulated query failure.

---

## 3. Governed Credentials and Access Path for Embedded DuckDB (Issue #64)

### 3.1 Purpose and Acceptance Criteria Mapping
Issue #64 requires defining a secure, governed credential and access model for DuckDB clients without distributing long-lived shared storage credentials or silently bypassing Lakekeeper/Trino policy boundaries.

### 3.2 Current State (VERIFIED)
- **Trino Storage Key Gap**: Trino holds a static administrator S3 access key in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml#L26-L27). This key grants full access to the `beluga-lake` bucket, bypassing catalog policies for any entity possessing it. [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md#L97-L108) designates this as a known gap that DuckDB must not widen.
- **Lakekeeper Bootstrap**: In [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L137), warehouse `lake` is created with `"sts-enabled": false` and static credentials. OpenFGA warehouse assignments grant full access to `service-account-trino` and `service-account-flink` ([lines 165–172](gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L165-L172)).
- **Network Policies**: [`04b-lakehouse-network-policy.yaml`](../gitops/charts/beluga-data/templates/04b-lakehouse-network-policy.yaml#L57-L97) enforces default-deny and allows ingress to `lakekeeper:8181` only from Trino, Flink, APISIX, and the bootstrap job. DuckDB clients have no ingress rule.
- **Classification**: `lake.customers` contains PII (`policies/resources.yaml#L17`).

### 3.3 External Documentation and Evidence (Accessed 2026-10-08)
- **DuckDB Catalog Secrets** ([`https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html`](https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html)):
  - Attaching with OAuth2:
    ```sql
    CREATE SECRET lakekeeper_secret (
        TYPE ICEBERG,
        CLIENT_ID 'duckdb-client',
        CLIENT_SECRET 'password',
        OAUTH2_SCOPE 'lakekeeper',
        OAUTH2_SERVER_URI 'http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token'
    );
    ATTACH 'warehouse' AS lake_catalog (
        TYPE ICEBERG,
        ENDPOINT 'http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog',
        SECRET lakekeeper_secret
    );
    ```
  - DuckDB's documentation for SeaweedFS demonstrates static S3 secrets (`TYPE s3`), while credential vending (`ACCESS_DELEGATION_MODE 'vended_credentials'`) is only illustrated for Polaris.
- **Lakekeeper Storage Docs** ([`https://docs.lakekeeper.io/docs/latest/storage/`](https://docs.lakekeeper.io/docs/latest/storage/)): Lakekeeper vended credentials rely on AWS STS `AssumeRole`. Lakekeeper documentation explicitly states that *"not all S3 compatible object stores support AssumeRole"*. SeaweedFS STS compatibility remains **UNVERIFIED**.

### 3.4 Gaps vs Acceptance Criteria
1. SeaweedFS STS support is unverified: until proven, DuckDB cannot receive vended credentials for `beluga-lake`.
2. Dedicated non-PII test bucket (`beluga-test`) and test warehouse do not exist in Lakekeeper bootstrap.
3. NetworkPolicy in `04b-lakehouse-network-policy.yaml` blocks all DuckDB client pods from reaching Lakekeeper `:8181`.
4. Dedicated Keycloak client definitions (`duckdb-ci`, `duckdb-airflow`) and OpenFGA table-level grants do not exist.

### 3.5 Proposal (Proposed)

#### Dual-Phase Access Architecture

```
+-----------------------------------------------------------------------------------+
| Phase 1: Test & CI Isolation (Static Key Scoped Exception)                        |
|                                                                                   |
|  [DuckDB Client] ---OIDC Token---> [Lakekeeper:8181] (Validates via OpenFGA)      |
|         |                                 |                                       |
|  (Static Scoped S3 Key)            (Catalog Metadata)                             |
|         |                                 |                                       |
|         v                                 v                                       |
|  [SeaweedFS: s3://beluga-test/] <---------+ (Synthetic Non-PII Data Only)         |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
| Phase 2: Governed Production Path (Vended Credentials Gate)                       |
|                                                                                   |
|  [DuckDB Client] ---OIDC Token---> [Lakekeeper:8181] (Validates via OpenFGA)      |
|         |                                 |                                       |
|         | <---Vended Scoped STS Token-----+ (Temporary Table-Scoped Token)        |
|         |                                                                         |
|         v                                                                         |
|  [SeaweedFS: s3://beluga-lake/] (Production Internal Data - PII Excluded)         |
+-----------------------------------------------------------------------------------+
```

1. **Phase 1 (Immediate / CI / PoC)**:
   - Create a dedicated SeaweedFS bucket `beluga-test` containing only synthetic data.
   - Bootstrap a dedicated Lakekeeper warehouse `test_warehouse` pointing to `s3://beluga-test/`.
   - Provision a restricted static S3 credential pair scoped exclusively to `beluga-test`.
   - Configure Keycloak client `duckdb-ci` and grant OpenFGA table-level `select` permissions on test tables only.
2. **Phase 2 (Production Gate)**:
   - Production access to `beluga-lake` remains **BLOCKED** until task 1 (SeaweedFS STS evaluation) proves that SeaweedFS can vend temporary, scoped credentials. If STS cannot be enabled, DuckDB remains permanently restricted to the non-PII test warehouse.
3. **NetworkPolicy Additions (Proposed in `04b-lakehouse-network-policy.yaml`)**:
   - Add explicit ingress rule to `lakekeeper-ingress`:
     ```yaml
     - from:
         - namespaceSelector:
             matchLabels:
               kubernetes.io/metadata.name: analytics
           podSelector:
             matchLabels:
               app.kubernetes.io/component: duckdb-client
     ```
   - Add egress rules on DuckDB client pods allowing TCP port 8181 to `lakekeeper`, TCP port 8080 to `keycloak`, and TCP port 8333 to `seaweedfs-s3`.
4. **Secret Injection Standard**:
   - In Kubernetes, client secrets are injected via Kubernetes Secrets mounted into memory (`tmpfs`). DuckDB creates in-memory secrets (`CREATE TEMPORARY SECRET ...`). No credentials may be persisted to disk or emitted in logs.

### 3.6 Verification and Test Ideas
- **Unauthorized Catalog Denial Test**: Attempt `ATTACH` with an invalid Keycloak token; assert Lakekeeper rejects the connection with HTTP 401.
- **PII Table Denial Test (Mandatory Regression)**: Authenticate with valid `duckdb-ci` token and attempt `SELECT * FROM lake_catalog.lake.customers`; assert Lakekeeper OpenFGA returns HTTP 403 Forbidden.
- **Bypass Prevention Test**: Verify that the S3 credential supplied to `duckdb-ci` cannot access `s3://beluga-lake/` directly via AWS CLI; assert `AccessDenied`.
- **Credential Expiry Test**: Configure a short-lived token (5 minutes); verify DuckDB refreshes or cleanly terminates without hang when expired.

### 3.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-64-1 | If SeaweedFS STS is unsupported, confirm DuckDB remains restricted to the synthetic test warehouse. | **Confirm restriction (Hold production access)** | Preserves ADR-0004 Security Item 3; bucket-level static keys would defeat table-level OpenFGA PII protection. |
| OD-64-2 | Human developer authentication: per-user bearer tokens vs service account? | **User bearer tokens for CLI/notebook** | Ensures OpenFGA audit logs identify the actual human caller. |

### 3.8 Follow-Up Implementation Tasks
1. **T-64-1 (STS Probe Script)**: Run automated STS `AssumeRole` compatibility test against SeaweedFS. Acceptance: Documented result confirming whether SeaweedFS supports credential vending.
2. **T-64-2 (Test Warehouse Provisioning)**: Update bootstrap script to create bucket `beluga-test` and warehouse `test_warehouse`. Acceptance: Synthetic tables queryable via test credentials.
3. **T-64-3 (NetworkPolicy Ingress Update)**: Add DuckDB client pod label selector to `04b-lakehouse-network-policy.yaml`. Acceptance: `make validate` passes and connection succeeds.

---

## 4. Trino/DuckDB Result Consistency and Benchmark Suite (Issue #65)

### 4.1 Purpose and Acceptance Criteria Mapping
Issue #65 requires creating a repeatable benchmark and semantic validation suite for representative Beluga datasets and query classes, comparing DuckDB and Trino results on the same Iceberg snapshots without fabricating numbers, and defining tolerance policies.

### 4.2 Current State (VERIFIED)
- **Baseline Tables**: `lake.events_enriched` (internal clickstream events), `lake.orders` (internal transactions), and `lake.customers` (PII records) in [`policies/resources.yaml`](../policies/resources.yaml#L1-L23).
- **Existing Scripts**: Test scripts exist in `tests/` (`06-trino-query.sh`, `tests/run-all.sh`), but no automated parity comparator between DuckDB and Trino exists.
- **Benchmark Requirement**: ADR-0004 task 10 requires comparing CPU, memory, I/O, startup, latency, and concurrency between engines.

### 4.3 Gaps vs Acceptance Criteria
1. No automated tool compares row counts, schemas, null handling, and numeric outputs between DuckDB and Trino.
2. No explicit floating-point tolerance policy exists.
3. No benchmark execution harness exists to measure process RSS, CPU time, and I/O.
4. Benchmark numbers must not be fabricated; an empirical benchmark methodology must be defined.

### 4.4 Proposal (Proposed)

#### Semantic Consistency Verification Rules
The consistency validation suite executes identical SQL against the same Iceberg snapshot ID:

```sql
-- Trino query
SELECT date_trunc('day', event_time) AS day, count(*) AS cnt, sum(amount) AS total
FROM iceberg.lake.orders FOR VERSION AS OF <snapshot_id>
GROUP BY 1 ORDER BY 1;

-- DuckDB query
SELECT date_trunc('day', event_time) AS day, count(*) AS cnt, sum(amount) AS total
FROM lake_catalog.lake.orders AT (VERSION => <snapshot_id>)
GROUP BY 1 ORDER BY 1;
```

1. **Schema & Type Mapping**:
   - `BIGINT`, `INTEGER`, `BOOLEAN`, `VARCHAR` must match exactly in type class and values.
   - `TIMESTAMP` precision: Trino default `TIMESTAMP(6)` mapped to DuckDB microsecond `TIMESTAMP`.
2. **Floating-Point Tolerance Policy**:
   - For `DOUBLE` and `REAL` aggregate computations, strict equality is not required due to differing SIMD/vectorized reduction order.
   - Relative tolerance is defined as:
     $$\frac{|V_{\text{duckdb}} - V_{\text{trino}}|}{\max(|V_{\text{trino}}|, 10^{-9})} \le 10^{-6}$$
3. **Ordering & Null Semantics**:
   - Results without an explicit `ORDER BY` clause are sorted by primary key in the validation harness before row-by-row diffing.
   - `NULL` sorting: DuckDB defaults to `NULLS FIRST` for ASC; Trino defaults to `NULLS LAST`. Test queries must specify `NULLS LAST` explicitly.

#### Repeatable Benchmark Suite Methodology (No Fabricated Numbers)
- **Target Workloads**:
  - *Query Class A (Point/Filter)*: Highly selective filter on partition column (`event_date = '2026-10-01'`).
  - *Query Class B (Heavy Aggregation)*: Multi-column `GROUP BY` with `count(DISTINCT)` over 10M rows.
  - *Query Class C (Join)*: Two-table hash join (`orders` joined with `events_enriched`).
  - *Query Class D (Window Function)*: `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY event_time)`.
- **Metrics Collected**:
  1. *Cold-Start Latency (ms)*: Time from process launch to first result batch.
  2. *Query Elapsed Time (ms)*: Wall-clock duration of query execution.
  3. *Peak Memory (RSS MiB)*: Measured via `getrusage(RUSAGE_CHILDREN).ru_maxrss` for DuckDB; JVM JMX memory beans for Trino.
  4. *CPU Consumption (User + System ms)*: Process CPU time consumed.
  5. *Storage I/O Read (MiB)*: Total bytes fetched over HTTP/S3 gateway.
- **Reporting Standard**: Output benchmark results as machine-readable JSON artifacts committed to `docs/benchmarks/` with hardware profile, OS kernel, and exact engine commit versions.

### 4.5 Verification and Test Ideas
- **Automated Regression Suite**: Implement `tests/duckdb-trino-parity.py` executed in CI against test warehouse snapshots.
- **Intentional Failure Injection**: Inject a deliberate SQL syntax variation or data-type mismatch in a test branch to verify the comparator detects discrepancies and fails closed.

### 4.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-65-1 | What floating-point relative error tolerance is acceptable for business reporting? | **$10^{-6}$ relative tolerance** | Accommodates compiler optimization differences without masking material financial discrepancies. |
| OD-65-2 | Where should versioned benchmark output JSONs be archived? | **`docs/benchmarks/` in repo** | Enables GitOps tracking of query performance across platform releases. |

### 4.7 Follow-Up Implementation Tasks
1. **T-65-1 (Parity Harness)**: Build Python comparator CLI `tests/duckdb-trino-parity.py`. Acceptance: Passes against synthetic dataset for query classes A through D.
2. **T-65-2 (Benchmark Harness)**: Create benchmark runner script capturing RSS, CPU, and I/O. Acceptance: Generates valid schema-compliant benchmark summary JSON.

---

## 5. DuckDB in CI, Airflow, and Reproducible Local Workflows (Issue #66)

### 5.1 Purpose and Acceptance Criteria Mapping
Issue #66 requires integrating DuckDB into CI validation, Airflow data pipelines, and local developer workflows with pinned runtimes, reusable bootstrap utilities, and clean lifecycle management without embedding persistent production credentials.

### 5.2 Current State (VERIFIED)
- **Airflow DAG Location**: Airflow DAGs reside in [`gitops/charts/beluga-data/files/dags/`](../gitops/charts/beluga-data/files/dags/).
- **Current Airflow Operator**: [`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py#L24-L52) executes `KubernetesPodOperator` launching `trinodb/trino:483` CLI pods in namespace `analytics`.
- **Version Tracking**: DuckDB is currently absent from [`VERSIONS.md`](../VERSIONS.md).

### 5.3 Gaps vs Acceptance Criteria
1. DuckDB binary and Python library versions are unpinned in `VERSIONS.md`.
2. No reusable connection helper exists for local scripts, CI, and Airflow.
3. Airflow lacks an operator pattern for executing DuckDB workloads.
4. Local developers cannot resolve internal S3 DNS (`seaweedfs-s3.storage.svc.cluster.local:8333`).

### 5.4 Proposal (Proposed)

#### Version Pinning (Proposed for `VERSIONS.md`)
- `duckdb`: Version `1.4.0` (LTS, community support through 2026-11-17) or `1.4.4` / `1.5.0` (per owner decision Q4). License: `MIT`.
- `duckdb-iceberg-extension`: Pinned release matching DuckDB core version. License: `MIT`.

#### Reusable Bootstrap Helper (`beluga_duckdb` Python Module)
Provide a standardized helper script in `scripts/helpers/duckdb_client.py`:
```python
import duckdb, os

def get_duckdb_iceberg_connection(catalog_endpoint, warehouse, client_id, client_secret, token_endpoint):
    con = duckdb.connect(":memory:")
    con.execute("INSTALL iceberg; LOAD iceberg;")
    con.execute(f"""
        CREATE TEMPORARY SECRET lakekeeper_auth (
            TYPE ICEBERG,
            CLIENT_ID '{client_id}',
            CLIENT_SECRET '{client_secret}',
            OAUTH2_SERVER_URI '{token_endpoint}',
            OAUTH2_SCOPE 'lakekeeper'
        );
    """)
    con.execute(f"""
        ATTACH '{warehouse}' AS lake (
            TYPE ICEBERG,
            ENDPOINT '{catalog_endpoint}',
            SECRET lakekeeper_auth
        );
    """)
    return con
```

#### CI Validation Workflow Integration
- Add a dedicated CI job (`.github/workflows/duckdb-validation.yml` and `make validate-duckdb`):
  - Executes DuckDB in-process against local test Parquet/Iceberg metadata fixtures.
  - Verifies data-contract schema compliance in under 5 seconds without starting Trino JVM workers.

#### Airflow Task Integration Pattern
- Implement `BelugaDuckDBPodOperator` running a hardened Python container in the `analytics` namespace:
  - Mounts Keycloak client credentials from `keycloak-duckdb-secrets`.
  - Configures `emptyDir` scratch volume capped at 5 GB.
  - Enforces resource limits (`requests: memory: 512Mi, cpu: 250m`; `limits: memory: 2Gi, cpu: 1000m`).

#### Local Developer Workflow Access Path
- Local developer laptops cannot resolve cluster-internal DNS.
- *Proposed Local Access Path*: Route developer traffic through the APISIX gateway using local `/etc/hosts` entries (`catalog.local.beluga.internal:443` and `s3.local.beluga.internal:443`) with TLS termination and user-scoped bearer tokens.

### 5.5 Verification and Test Ideas
- **Standalone CI Test**: Execute `make test-duckdb-ci` in a clean workspace; assert Iceberg contract query runs successfully without Trino pods.
- **Airflow DAG Parse Test**: Add `test_duckdb_dag_render.py` in `tests/` verifying DAG syntax, operator inheritance, and parameter binding.

### 5.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-66-1 | What base container image should run DuckDB in Airflow pods? | **`python:3.12-slim` with pinned wheels** | Minimizes container attack surface and image pull duration. |
| OD-66-2 | Should local CLI access use gateway HTTPS or `kubectl port-forward`? | **Gateway HTTPS (`*.local.beluga.internal`)** | Matches Beluga's domain registry contract and enforces TLS certificates. |

### 5.7 Follow-Up Implementation Tasks
1. **T-66-1 (Connection Helper)**: Implement `scripts/helpers/duckdb_client.py`. Acceptance: Unit tests verify secret formatting and connection parameters.
2. **T-66-2 (Airflow Operator)**: Implement `BelugaDuckDBPodOperator` in `gitops/charts/beluga-data/files/dags/operators/`. Acceptance: Test DAG executes successfully in local dev stack.

---

## 6. Engine-Level Metrics and Resource Attribution (Issue #67)

### 6.1 Purpose and Acceptance Criteria Mapping
Issue #67 requires making DuckDB and Trino engine selection, execution outcomes, fallbacks, and resource impact measurable without turning DuckDB into a long-running platform service.

### 6.2 Current State (VERIFIED)
- **Trino Telemetry**: Trino exports metrics via Prometheus JMX exporter in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml).
- **Cluster Monitoring**: Prometheus operates in `monitoring` / `platform-system`.
- **Embedded DuckDB Gap**: Because DuckDB runs embedded in client tasks, it does not expose an always-on HTTP `/metrics` endpoint.

### 6.3 Gaps vs Acceptance Criteria
1. No unified telemetry schema attributes query execution to DuckDB vs Trino.
2. Job-level DuckDB CPU time, peak RSS, spill volume, and I/O are unmonitored.
3. Routing decisions and fallback events are uncounted in Prometheus.
4. Raw SQL queries must not be logged to avoid credential/PII leakage.

### 6.4 Proposal (Proposed)

#### Structured Execution Event Schema
Every query execution (DuckDB or Trino) emits a structured JSON log event:

```json
{
  "event_id": "evt-7f8a9b2c-3d4e",
  "timestamp": "2026-10-08T00:30:00Z",
  "engine": "duckdb",
  "engine_version": "1.4.0",
  "workload_class": 2,
  "caller": "airflow-iceberg-compaction",
  "dataset": "lake.events_enriched",
  "query_hash": "a1b2c3d4e5f6...",
  "status": "SUCCESS",
  "fallback_reason": null,
  "elapsed_ms": 1420,
  "cpu_user_ms": 1150,
  "cpu_sys_ms": 120,
  "peak_rss_bytes": 536870912,
  "spill_bytes": 0,
  "bytes_scanned": 104857600,
  "rows_returned": 50000
}
```

*Privacy Constraint*: Raw SQL text and literal parameter values are **never logged**. Only normalized `query_hash` and target `dataset` are included.

#### Telemetry Emission & Metric Integration
- **Ephemeral Jobs (CI & Airflow)**:
  - DuckDB queries enable profiling via `PRAGMA enable_profiling = 'json';`.
  - Upon task completion, metrics are formatted into the execution event schema and emitted to `stdout`. Fluentbit/Vector ingests the log stream.
  - In Airflow, the operator pushes task completion metrics to Prometheus Pushgateway.
- **Prometheus Metrics (Proposed)**:
  - `beluga_query_executions_total{engine="duckdb|trino", class="1..6", status="SUCCESS|FAILED|FALLBACK"}`
  - `beluga_query_fallback_total{reason="UNSUPPORTED_SYNTAX|CAPACITY_LIMIT|OPA_REQUIRED", class="1..6"}`
  - `beluga_query_execution_duration_seconds{engine="duckdb|trino", class="1..6"}`
  - `beluga_query_peak_memory_bytes{engine="duckdb|trino", class="1..6"}`

### 6.5 Verification and Test Ideas
- **Log Structure Test**: Execute DuckDB query via wrapper; verify generated log matches the JSON schema and contains no plaintext SQL string literals.
- **Prometheus Metric Ingestion Test**: Trigger a fallback query; verify `beluga_query_fallback_total` counter increments in Prometheus scrape data.

### 6.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-67-1 | Standard telemetry pipeline: stdout logging or Prometheus Pushgateway? | **Stdout JSON logging for all; Pushgateway for Airflow** | Fits existing Fluentbit log aggregation without adding server dependencies to simple CLI tools. |

### 6.7 Follow-Up Implementation Tasks
1. **T-67-1 (Telemetry Emitter)**: Implement `beluga_metrics` logging decorator in Python wrapper. Acceptance: Unit test verifies JSON output conforms to schema.
2. **T-67-2 (Grafana Dashboard Panel)**: Add DuckDB vs Trino engine attribution panel in platform Grafana dashboard. Acceptance: Displays engine query counts and fallback frequency.

---

## 7. Result Reuse, Spill, and Temporary-Data Lifecycle (Issue #68)

### 7.1 Purpose and Acceptance Criteria Mapping
Issue #68 requires defining safe, measurable result reuse/caching and temporary-data lifecycles for DuckDB workloads without turning DuckDB into an uncontrolled persistent store or leaking PII across tenant boundaries.

### 7.2 Current State (VERIFIED)
- **Lifecycle Retention Policy**: [`docs/data-lifecycle-policy.md`](data-lifecycle-policy.md#L31) defines the `temporary` retention class for scratch data, rewrites, and checkpoints with automated age-based cleanup.
- **SeaweedFS Prefix**: [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L5) designates `tmp/` for transient rewrite/checkpoint/scratch data.
- **Storage Boundaries**: Disk space on Kubernetes worker nodes is finite. Ephemeral pod storage must be bounded to prevent node disk exhaustion.

### 7.3 External Documentation and Evidence (Accessed 2026-10-08)
- **DuckDB Concurrency & Storage** ([`https://duckdb.org/docs/current/connect/concurrency`](https://duckdb.org/docs/current/connect/concurrency)): DuckDB operates in single-process mode. By default, it allocates memory up to system limits and spills excess intermediate data to a temporary directory configured via `SET temp_directory = 'path'`.

### 7.4 Gaps vs Acceptance Criteria
1. No documented lifecycle limits, TTLs, or size ceilings exist for DuckDB disk spill or intermediate Parquet files.
2. Cache invalidation tied to Iceberg snapshot IDs is not implemented.
3. No safeguards prevent PII from persisting in shared temporary files.
4. Failed or aborted jobs risk leaving unbounded spill files on host nodes.

### 7.5 Proposal (Proposed)

#### Temporary Artifact Lifecycle Policy Matrix

| Artifact Class | Storage Location | Max Size Limit (Cap) | Retention / TTL | Cleanup Mechanism |
|---|---|---|---|---|
| **In-Memory Buffers** | Process RAM (Heap) | 4 GB (`max_memory`) | Query lifetime | Automatic on process exit |
| **Disk Spill Files** | Container `/tmp/duckdb_spill/` | 10 GB per pod | Query execution duration | Automatic by DuckDB engine; pod `emptyDir` wiped on termination |
| **Intermediate Parquet** | Container `/tmp/scratch/<job_id>/` | 5 GB per job | 2 hours maximum | Container `trap cleanup EXIT` handler; Airflow task cleanup hook |
| **Persisted `.duckdb` Files** | Prohibited for shared/prod | 10 GB (Local dev only) | 24 hours | Local developer responsibility / tmpfs wipe |

#### Cache Isolation and PII Boundary Protection
- **Zero Shared Caches**: DuckDB scratch directories and spill files must never be shared across users, tenants, or pipeline DAGs. Every run must use an isolated path: `/tmp/scratch/${TENANT_ID}/${JOB_ID}/`.
- **Absolute PII Caching Prohibition**: Datasets classified as `pii` (`lake.customers`, [`policies/resources.yaml`](../policies/resources.yaml#L17)) are **strictly barred from disk-based caching or spill**. If a query involving PII cannot complete within memory, it must fail or run on Trino. Disk materialization of PII is prohibited.

#### Snapshot-Aware Result Reuse
- Any cached intermediate table or Parquet summary must construct its cache key using:
  $$\text{CacheKey} = \text{SHA256}(\text{TableUUID} + \text{SnapshotID} + \text{QueryHash} + \text{EngineVersion})$$
- When Lakekeeper advances the snapshot ID of a source table, any cached artifact associated with prior snapshot IDs is rendered invalid immediately.

#### Bounded Ephemeral Volumes in Kubernetes
- All Kubernetes pods running DuckDB must specify explicit `emptyDir` volume resource constraints:
  ```yaml
  volumes:
    - name: duckdb-scratch
      emptyDir:
        sizeLimit: 10Gi
  ```
- If a runaway query exceeds the 10 GiB cap, the kubelet evicts the pod, preventing node starvation.

### 7.6 Verification and Test Ideas
- **Disk Spill Cleanup Test**: Execute a query with `SET max_memory = '64MB'` against a 500 MB dataset, forcing disk spill; verify that all temporary `.tmp` files in `temp_directory` are deleted upon query completion.
- **Abort Cleanup Test**: Force-terminate a DuckDB runner process via `SIGKILL`; verify that the outer wrapper trap or container restart cleanly purges the scratch directory.
- **PII Materialization Rejection Test**: Attempt to execute `COPY (SELECT * FROM lake_catalog.lake.customers) TO '/tmp/customers.parquet'`; assert that the security wrapper intercepts and rejects the statement.

### 7.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-68-1 | What storage limit should be enforced on pod `emptyDir` scratch volumes? | **Proposed 10 GiB limit** | Protects node root filesystems from being overwhelmed by unpartitioned spills. |
| OD-68-2 | Should intermediate Parquet reuse across DAG tasks be permitted? | **Permitted within same DAG run only** | Avoids stale data across pipeline runs while accelerating multi-stage DAGs. |

### 7.8 Follow-Up Implementation Tasks
1. **T-68-1 (Spill Configuration)**: Set default `temp_directory` and `max_memory` in the bootstrap connection helper. Acceptance: Queries spill to dedicated volume under low memory settings.
2. **T-68-2 (Kubernetes Volume Limits)**: Update pod template specs to include `sizeLimit: 10Gi` on scratch mounts. Acceptance: Pods exceeding limit are evicted safely.

---

## 8. Evaluation Gate for Quack Remote Protocol (Issue #69)

### 8.1 Purpose and Acceptance Criteria Mapping
Issue #69 requires defining a separate, evidence-driven evaluation gate for DuckDB's Quack protocol before considering it for shared lightweight query/service workloads, ensuring the embedded DuckDB design is proven first.

### 8.2 Current State (VERIFIED)
- **Centralized Service Architecture**: Trino operates as Beluga's centralized distributed query service in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml), integrating with APISIX ingress routing ([`10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml)), Keycloak OAuth2 ([`06-trino.yaml#L81-L85`](../gitops/charts/beluga-data/templates/06-trino.yaml#L81-L85)), and OpenFGA.
- **ADR-0004 Decision**: [ADR-0004 Decision 2](adr/0004-duckdb-complementary-analytics-engine.md#L62-L63) explicitly ruled Quack out of scope: *"DuckDB runs embedded in clients and jobs, not as an always-on service. DuckDB/Quack server mode is out of scope and is evaluated separately after the embedded path is proven."*

### 8.3 External Documentation and Evidence (Accessed 2026-10-08)
- **DuckDB Quack Overview** ([`https://duckdb.org/docs/current/quack/overview`](https://duckdb.org/docs/current/quack/overview)):
  - Released May 12, 2026.
  - *"The Quack extension turns a DuckDB instance into a server that other DuckDB instances (clients) can connect to over HTTP."*
  - Explicit upstream warning: *"Warning: Quack is under active development and the protocol, function names, settings, and defaults are still subject to change."*
- **DuckDB Quack Security Guidance** ([`https://duckdb.org/docs/current/quack/security`](https://duckdb.org/docs/current/quack/security)):
  - Exposure model: *"A Quack server exposes the full SQL surface of the underlying DuckDB instance, including read and write access to every table the server's session can see."*
  - Requires an external TLS-terminating reverse proxy for production deployments.
  - Relies on startup-generated random authentication tokens. Lacks native enterprise multi-tenant RBAC, row-level security, or audit attribution out of the box.

### 8.4 Gaps vs Acceptance Criteria
1. Quack is in active beta development with unstable protocol contracts.
2. Introducing a long-running Quack daemon re-introduces always-on infrastructure overhead, contradicting the primary rationale for adopting embedded DuckDB.
3. Multi-tenant security, TLS termination, and OpenFGA policy integration for Quack are unverified in Beluga.

### 8.5 Proposal (Proposed)

#### Formal Evaluation Gates (Pre-requisites for Quack Consideration)
Quack remains **DEFERRED / OUT OF SCOPE** until all four gates pass:

```
  [Gate Q-1: Embedded Stability]
  Embedded DuckDB operates in production CI & pipelines for >= 90 days without data corruption
               |
               v PASS
  [Gate Q-2: Evidence of Need]
  Demonstrated requirement for shared warm-state or centralized low-footprint cache saving > 50% CPU
               |
               v PASS
  [Gate Q-3: Upstream Protocol Stability]
  Quack protocol graduates from beta to GA in upstream DuckDB documentation
               |
               v PASS
  [Gate Q-4: Enterprise Security Verification]
  Security architecture proves APISIX TLS termination, Keycloak OIDC authentication,
  and tenant session isolation preventing cross-tenant data leakage
               |
               v PASS
  [OWNER DECISION TO EVALUATE QUACK]
```

#### Baseline Architecture Decision
- **Quack is REJECTED for the baseline Beluga platform.**
- Embedded DuckDB is the sole approved DuckDB execution form.
- Shared service workloads remain exclusively on Trino.

### 8.6 Verification and Test Ideas
- If Gate Q-1 through Q-4 are ever satisfied, execute a side-by-side concurrency benchmark comparing Quack and Trino on 50 concurrent ad-hoc queries, measuring memory leak stability, crash isolation, and TLS termination latency.

### 8.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-69-1 | Confirm that Quack remains out of scope for the current Beluga architecture. | **Confirm out of scope** | Prevents architectural bloat and preserves focus on proving embedded DuckDB. |

### 8.8 Follow-Up Implementation Tasks
1. **T-69-1 (Upstream Tracking)**: Review DuckDB Quack release notes during quarterly platform maintenance reviews. Acceptance: Documented status in quarterly architecture review notes.

---

## 9. Consolidated Owner Decisions Table

| ID | Issue | Question | Recommendation | Priority |
|---|---|---|---|---|
| **OD-62-1** | #62 | Should DuckDB writes be restricted permanently to sandbox namespaces? | **Sandbox namespaces only; read-only on production `lake.*`** | P1 |
| **OD-62-2** | #62 | Pin DuckDB to 1.4 LTS or adopt 1.5.x/2.0.x for delete-vector reads? | **Pin 1.4 LTS initially, canary 1.5+ in CI** | P1 |
| **OD-63-1** | #63 | What default data scan cap should trigger automatic routing to Trino? | **Proposed 5 GB scan cap** | P2 |
| **OD-63-2** | #63 | Should batch pipeline jobs fall back silently to Trino? | **Fail loudly in batch/CI, fallback in ad-hoc** | P2 |
| **OD-64-1** | #64 | If SeaweedFS STS is unsupported, confirm DuckDB remains restricted to test bucket? | **Confirm restriction (Hold production access)** | P1 |
| **OD-64-2** | #64 | Human developer authentication: user bearer tokens vs service account? | **User bearer tokens for CLI/notebook** | P2 |
| **OD-65-1** | #65 | What floating-point relative error tolerance is acceptable? | **$10^{-6}$ relative tolerance** | P2 |
| **OD-65-2** | #65 | Where should versioned benchmark output JSONs be archived? | **`docs/benchmarks/` in repository** | P3 |
| **OD-66-1** | #66 | What base container image should run DuckDB in Airflow pods? | **`python:3.12-slim` with pinned wheels** | P2 |
| **OD-66-2** | #66 | Should local CLI access use gateway HTTPS or port-forwarding? | **Gateway HTTPS (`*.local.beluga.internal`)** | P2 |
| **OD-67-1** | #67 | Standard telemetry pipeline: stdout logging or Pushgateway? | **Stdout JSON logging for all; Pushgateway for Airflow** | P2 |
| **OD-68-1** | #68 | What storage limit should be enforced on pod `emptyDir` scratch volumes? | **Proposed 10 GiB limit** | P2 |
| **OD-68-2** | #68 | Should intermediate Parquet reuse across DAG tasks be permitted? | **Permitted within same DAG run only** | P2 |
| **OD-69-1** | #69 | Confirm that Quack remains out of scope for current Beluga platform? | **Confirm out of scope** | P1 |

---

## 10. Consolidated Follow-Up Implementation Tasks

| Task ID | Issue | Description | Dependencies | Acceptance Test Idea |
|---|---|---|---|---|
| **T-62-1** | #62 | Implement automated CI test suite querying synthetic partitioned and delete-bearing Iceberg tables. | None | CI runner asserts DuckDB results match Trino on non-delete tables and fails closed on deletes. |
| **T-62-2** | #62 | Implement client-side wrapper assertion rejecting any write query targeting `lake.*`. | T-62-1 | Unit test verifies rejection of `INSERT/UPDATE` queries targeting production tables. |
| **T-63-1** | #63 | Implement Python module `beluga_router` implementing routing rules and manual override switches. | T-62-2 | Unit test suite verifies correct engine selection across all six workload classes. |
| **T-63-2** | #63 | Hook router exceptions into Prometheus client counters for fallback telemetry. | T-63-1 | Simulated query failure increments `beluga_query_fallback_total`. |
| **T-64-1** | #64 | Run automated STS `AssumeRole` compatibility test against SeaweedFS. | None | Documented probe script output confirming STS support status. |
| **T-64-2** | #64 | Update bootstrap job to create bucket `beluga-test` and warehouse `test_warehouse`. | T-64-1 | Synthetic tables queryable via test credentials. |
| **T-64-3** | #64 | Add DuckDB client pod label selector to `04b-lakehouse-network-policy.yaml`. | None | `make validate` passes and connection succeeds. |
| **T-65-1** | #65 | Build Python comparator CLI `tests/duckdb-trino-parity.py`. | T-64-2 | Passes against synthetic dataset for query classes A through D. |
| **T-65-2** | #65 | Create benchmark runner script capturing RSS, CPU, and I/O. | T-65-1 | Generates valid schema-compliant benchmark summary JSON. |
| **T-66-1** | #66 | Implement reusable bootstrap helper `scripts/helpers/duckdb_client.py`. | T-64-2 | Unit tests verify secret formatting and connection parameters. |
| **T-66-2** | #66 | Implement `BelugaDuckDBPodOperator` in Airflow operators directory. | T-66-1 | Test DAG executes successfully in local dev stack. |
| **T-67-1** | #67 | Implement `beluga_metrics` logging decorator in Python wrapper. | T-66-1 | Unit test verifies JSON output conforms to schema without raw SQL literals. |
| **T-67-2** | #67 | Add DuckDB vs Trino engine attribution panel in platform Grafana dashboard. | T-67-1 | Dashboard displays engine query counts and fallback frequency. |
| **T-68-1** | #68 | Set default `temp_directory` and `max_memory` in bootstrap connection helper. | T-66-1 | Queries spill to dedicated volume under low memory settings. |
| **T-68-2** | #68 | Update pod template specs to include `sizeLimit: 10Gi` on scratch mounts. | None | Pods exceeding limit are evicted safely. |
| **T-69-1** | #69 | Review DuckDB Quack release notes during quarterly platform maintenance reviews. | None | Documented status in quarterly architecture review notes. |
