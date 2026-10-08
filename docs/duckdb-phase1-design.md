# DuckDB Phase 1 Detailed Design: Iceberg Boundaries, Routing, Security, and Workflows

English | [한국어](duckdb-phase1-design-ko.md)

Refs #62 #63 #64 #65 #66 #67 #68 #69.

> **Status: PROPOSAL. Documentation only.**
> This design document elaborates the adoption framework defined in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md) and does not alter any of its recorded decisions. Any discrepancy between this document and ADR-0004 constitutes an open owner decision. No manifest, container image, Helm value, or `VERSIONS.md` row is modified by this document.

---

## Relationship to ADR-0004 and Architectural Scope

[ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md) adopted DuckDB as a **complementary embedded analytics engine** running alongside Trino, not as a replacement. Phase 1 covers read-only CI/PoC; local CLI/notebooks and Airflow are Phase 2, and writes are Phase 3. ADR-0004 remains authoritative for phase gates and owner questions.

This document provides technical design specifications for the open follow-up issues (#62 through #69) across eight domains:
1. **[Issue #62](#1-iceberg-compatibility-and-safe-write-boundaries-issue-62)**: Iceberg compatibility matrix and safe read/write boundaries.
2. **[Issue #63](#2-query-workload-routing-and-trino-fallback-policy-issue-63)**: Phase-aware initial routing and fail-closed errors with explicit user resubmission.
3. **[Issue #64](#3-governed-credentials-and-access-path-for-embedded-duckdb-issue-64)**: Governed authentication, Lakekeeper OpenFGA authorization, and secret injection.
4. **[Issue #65](#4-trinoduckdb-result-consistency-and-benchmark-suite-issue-65)**: Semantic parity validation rules and reproducible benchmark methodology.
5. **[Issue #66](#5-duckdb-in-ci-airflow-and-reproducible-local-workflows-issue-66)**: Execution paths for CI, Airflow tasks, and developer workstations.
6. **[Issue #67](#6-engine-level-metrics-and-resource-attribution-issue-67)**: Structured execution events, telemetry emission, and Prometheus metrics.
7. **[Issue #68](#7-result-reuse-spill-and-temporary-data-lifecycle-issue-68)**: Temporary scratch files, disk spill limits, cache invalidation, and PII isolation.
8. **[Issue #69](#8-evaluation-gate-for-quack-remote-protocol-issue-69)**: Strict evaluation gate criteria before considering DuckDB Quack service mode.

### Normative Security Guardrails (Inherited from ADR-0004)

All proposals in this document strictly enforce the non-negotiable security requirements established in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md):
- **Distinct OIDC Identity**: DuckDB clients authenticate using their own dedicated Keycloak OIDC client credentials (`duckdb-ci`, `duckdb-airflow`), never reusing `service-account-trino` or `service-account-flink`.
- **Table-Level Grants Only**: OpenFGA grants via Lakekeeper must be explicitly scoped to specific tables. Warehouse-level or namespace-level grants are strictly prohibited because Lakekeeper inherits `select` to all child tables, which would expose PII tables (`lake.customers`, classified as `pii` in [`policies/resources.yaml`](../policies/resources.yaml)).
- **Zero Static Admin Storage Credentials**: Static administrator S3 access keys must never be provided to DuckDB clients on production or PII paths. Credential vending from Lakekeeper is mandatory for production data. The only permitted static key is scoped exclusively to a dedicated non-PII test bucket (`beluga-test`) with synthetic data for CI and PoC validation.
- **Strict Network Isolation**: Kubernetes NetworkPolicies must deny all traffic by default and only permit explicitly selected DuckDB client pods to communicate with `lakekeeper:8181`, `keycloak:8080`, and `seaweedfs-s3:8333`.
- **Read-Only First**: DuckDB remains strictly read-only for Lakekeeper catalog tables until write safety and commit concurrency semantics are empirically verified.

---

## 1. Iceberg Compatibility and Safe Write Boundaries (Issue #62)

### 1.1 Purpose and Acceptance Criteria Mapping
Issue #62 requires defining the supported DuckDB and Apache Iceberg compatibility matrix, distinguishing read-only from write workloads, establishing write eligibility criteria, adding negative tests for unsupported mutations, verifying snapshot commit semantics, and confirming that Trino/Flink remain the authoritative mutation path.

### 1.2 Current State (VERIFIED)
- **Catalog Configuration**: Trino's Iceberg catalog is configured in [`gitops/charts/beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml). It connects to the Lakekeeper REST catalog at `http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog` for warehouse `lake`. Trino uses OAuth2 client credentials against Keycloak (`http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token`) and holds a static S3 access key (`s3.aws-access-key=${ENV:TRINO_S3_ACCESS_KEY}`).
- **Lakekeeper Warehouse**: Lakekeeper's `lake` warehouse is bootstrapped in [`gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml) with `"sts-enabled": false` and static credentials pointing to bucket `beluga-lake`.
- **Data Classification**: In [`policies/resources.yaml`](../policies/resources.yaml), `lake.events_enriched` and `lake.orders` are labeled `classification: internal`, whereas `lake.customers` is labeled `classification: pii` with sensitive column `email`.
- **Authoritative Mutation Engines**: Flink handles streaming CDC ingestion (`14-flink-jobs.yaml`), while Trino handles batch compaction and maintenance in [`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py).
- **Live evidence scope**: The original PR reported these running pods on 2026-10-08. The correction rechecked deployment/service inventory read-only (section 6.2); it did not repeat authenticated DuckDB queries or establish runtime compatibility.

### 1.3 External Documentation and Evidence (Accessed 2026-10-08)
- **DuckDB Iceberg Overview** ([`https://duckdb.org/docs/current/core_extensions/iceberg/overview`](https://duckdb.org/docs/current/core_extensions/iceberg/overview)): Direct table reads via `iceberg_scan` are read-only and require metadata version hints (`version-hint.text` or explicit `version`). Attaching an Iceberg REST catalog (`ATTACH ... TYPE iceberg`) unlocks catalog-managed tables.
- **DuckDB Iceberg Writing** ([`https://duckdb.org/docs/current/core_extensions/iceberg/writing`](https://duckdb.org/docs/current/core_extensions/iceberg/writing)): Writing requires an attached REST catalog. Supported operations include `CREATE TABLE` (with partitioning: identity, year, month, day, hour, bucket, truncate), `INSERT INTO` (including `BY NAME`), `UPDATE`, `DELETE`, `MERGE INTO`, and schema evolution (`ALTER TABLE ADD/DROP/RENAME/ALTER COLUMN`).
  - *Documented Limitation 1*: `UPDATE` and `DELETE` write **positional delete** files only; copy-on-write is unsupported.
  - *Documented Limitation 2*: `UPDATE` and `DELETE` require **merge-on-read** semantics. If `write.update.mode` or `write.delete.mode` is set to anything else, DuckDB execution fails.
  - *Documented Limitation 3*: `write.target-file-size-bytes` and `write.parquet.row-group-size-bytes` table properties are unsupported on partitioned tables and raise an error unless the matching `ignore_target_file_size_for_partitioned_tables` or `ignore_row_group_size_for_partitioned_tables` flag is set to `true`.
- **DuckDB Iceberg Troubleshooting** ([`https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting`](https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting)): In DuckDB 1.4 LTS, reading tables containing deletes is explicitly documented under Limitations: *"Reading tables with deletes is not yet supported."*
- **Concurrency & Commits**: Multi-engine commit conflict resolution and catalog retry semantics against Lakekeeper under concurrent Trino/Flink mutations remain **UNVERIFIED** (as recorded in [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md)).

### 1.4 Gaps vs Acceptance Criteria
1. Beluga lacks a formal, version-pinned Iceberg compatibility matrix document defining which Iceberg table specifications DuckDB may query or mutate.
2. DuckDB read compatibility on tables with positional deletes is unverified and known to fail on DuckDB 1.4 LTS.
3. No write boundaries or validation barriers exist to prevent DuckDB from issuing mutations against shared production tables (`lake.*`).
4. Automated rollback procedures for aborted DuckDB writes do not exist.

### 1.5 Proposal (Proposed)

<!-- D1: Preserve ADR-0004 phases to avoid silently authorizing writes; cost: delayed write use; escape hatch: owner decision and task 8 evidence. -->

| Feature | Upstream documentation | Phase 1 Beluga eligibility |
|---|---|---|
| Catalog-attached reads, partitioned or unpartitioned | Documented; exact pinned runtime/extension and format version need testing | Granted synthetic non-PII test tables only until the vending gate passes |
| Delete-bearing tables | 1.4 LTS documents a read limitation; positional deletes and Iceberg v3 deletion vectors are distinct | Fail closed unless the exact pinned combination passes parity tests; do not infer support from “1.5+” |
| Direct path `iceberg_scan` | Read-only upstream path | Prohibited for governed access, including debugging: bypasses Lakekeeper/OpenFGA |
| INSERT, UPDATE, DELETE, MERGE, DDL | Current writing docs describe REST-catalog writes and limitations | All writes blocked in Phase 1, including sandbox writes |
| Streaming/high-frequency commits | Not the adopted DuckDB workload | Flink remains the mutation path |

Phase 1 uses read-only OpenFGA table grants and storage credentials limited to the allowed reads. A SQL wrapper is defense in depth and cannot substitute for catalog/storage authorization. The static test-bucket exception cannot enforce table-level denial at the object store; it is limited to synthetic data, never evidence for production isolation.

Sandbox/derived writes are a **Phase 3 owner question**, subject to ADR task 8 concurrency evidence and #70. Namespace names alone do not authorize writes. The existing [maintenance DAG](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py) runs `optimize` and `expire_snapshots`; it does **not** run orphan-file removal. Cleanup of uncommitted files, retention safety, ownership and concurrent-writer protection need a separate design before writes can be enabled. Atomic metadata commits do not establish automatic object cleanup.

### 1.6 Verification and Test Ideas
- Read parity on synthetic fixtures at the same recorded snapshot, exact DuckDB and extension versions.
- Separate fixtures for positional deletes and deletion vectors where supported; unsupported reads must fail rather than return incomplete rows.
- Phase 1 negative writes against both the test warehouse and production catalog must be denied.
- Phase 3 only: copy-on-write rejection, concurrent commit/retry, abort and safe orphan-cleanup experiments.

### 1.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-62-1 | What sandbox/derived write scope should Phase 3 evaluate? | Keep all Phase 1 writes disabled; decide after #70 and task 8 | ADR-0004 remains authoritative |
| OD-62-2 | Which exact runtime/extension should be pinned (ADR Q4)? | Decide using pinned-version parity evidence | No claim that 1.5+ reads deletes or vectors |

### 1.8 Follow-Up Implementation Tasks
1. **T-62-1**: Version-pinned read compatibility suite with synthetic fixtures; incorrect or unsupported results fail CI.
2. **T-62-2**: Phase 1 negative authorization tests for every write, including sandbox; Phase 3 write admission and cleanup remain deferred.

---

## 2. Query Workload Routing and Trino Fallback Policy (Issue #63)

### 2.1 Purpose and Acceptance Criteria Mapping
Issue #63 requires establishing a deterministic workload-routing policy that routes queries to DuckDB when sufficient and falls back to Trino when centralized governance, distributed execution, or BI concurrency is required, including manual overrides and telemetry.

### 2.2 Current State (VERIFIED)
- **Single Engine Deployment**: Trino is currently the sole query execution engine in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml), serving Superset dashboards ([`08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml)) and Airflow DAGs ([`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py)).
- **ADR-0004 Allocation Matrix**: [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md) establishes workload candidates, subject to its Operational forms: only read-only CI is Phase 1; CLI/notebooks and Airflow are Phase 2, writes Phase 3. Shared BI, federated/large scans and OPA-governed datasets stay on Trino.

### 2.3 Gaps vs Acceptance Criteria
1. No programmatic routing layer or quantitative size thresholds exist to choose between engines.
2. Manual engine override flags (`BELUGA_SQL_ENGINE`) are not implemented.
3. Fallback logic for unsupported syntax, memory exhaustion, or authorization denial is undefined.
4. No fallback counters or metrics are collected.

### 2.4 Proposal (Proposed)

<!-- D2: Stop on DuckDB denial rather than escalate credentials; cost: explicit user retry; escape hatch: a separately authorized Trino request under the user's own identity. -->

| Class | Initial route | Phase / boundary |
|---|---|---|
| 1: CI/schema checks | DuckDB after ADR prerequisites | Phase 1, synthetic non-PII test warehouse, read-only; errors fail CI |
| 2: Single-user ad-hoc/CLI/notebook | Deferred DuckDB candidate | Phase 2, endpoint reachability and human identity decisions unresolved |
| 3: Bounded Airflow transform | Deferred DuckDB candidate | Phase 2 form; writes remain Phase 3; #70 / ADR Q5 gate |
| 4: Concurrent BI/Superset | Trino | Existing authenticated/authorized Trino path |
| 5: Distributed/federated | Trino | Existing authorized path; unknown workload sizing chooses Trino before execution |
| 6: PII / OPA row/column policies | Trino only | DuckDB principals have no table grant; never a post-denial fallback |

The router is a convenience layer. **Lakekeeper/OpenFGA table grants enforce PII exclusion**, including callers who bypass the wrapper. The Trino path must apply its own user authentication and OPA authorization; a PII classification does not grant access.

No measured scan/partition thresholds exist. Candidate 5 GB scan / 50 partitions / 4 GB buffer-manager limits are **unvalidated sizing hypotheses**, not profile facts or acceptance thresholds. Benchmark supported profiles before choosing defaults. DuckDB `memory_limit` does not cap all process allocations; the pod memory limit bounds the process and must leave measured overhead.

#### Fail-Closed Execution and Explicit Resubmission
- Any DuckDB error stops that execution. Authorization failure, timeout, missing/expired credentials, 401/403, unknown error, unsupported features or capacity exhaustion must **never automatically submit to Trino**.
- A user may explicitly request a **new** Trino execution under their own identity and normal Trino authorization, with a new request ID linked to the failed execution. No shared or wider service credentials, implicit impersonation or automatic SQL replay. If that identity path is unavailable, resubmission stays blocked.
- Engine overrides are proposed API inputs, not implemented flags; forcing DuckDB cannot waive authorization, phase, or credential gates. In-cluster Trino HTTPS 8443 is distinct from the user gateway HTTPS 443 in the domain registry.
- Structured events record failure and an explicit new request separately; metrics infrastructure is not a prerequisite (section 6).

### 2.5 Verification and Test Ideas
- Deny a DuckDB catalog read (401/403, PII grant exclusion); verify zero Trino submissions, including wrapper bypass.
- Unsupported syntax, timeout and capacity failure also produce zero automatic Trino submissions.
- Explicit resubmission uses the user's identity, is reauthorized by Trino/OPA, and links request IDs; absent identity or denied rights fails closed.
- Benchmark-based initial routing happens before execution and never converts an authorization denial into an engine selection.

### 2.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-63-1 | What measured sizing defaults should select the initial engine? | Benchmark first; unknown selects Trino | No fabricated profile threshold |
| OD-63-2 | What explicit user retry interface is needed? | New user-identity Trino request only | Prevents privilege escalation through fallback |

### 2.7 Follow-Up Implementation Tasks
1. **T-63-1**: Phase-aware routing with negative tests asserting no automatic retry; initial CI path only in Phase 1.
2. **T-63-2**: Emit failure and explicit-resubmission events; add optional counters only after a separately accepted observability design.

---

## 3. Governed Credentials and Access Path for Embedded DuckDB (Issue #64)

### 3.1 Purpose and Acceptance Criteria Mapping
Issue #64 requires defining a secure, governed credential and access model for DuckDB clients without distributing long-lived shared storage credentials or silently bypassing Lakekeeper/Trino policy boundaries.

### 3.2 Current State (VERIFIED)
- **Trino Storage Key Gap**: Trino holds a static administrator S3 access key in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml). This key grants full access to the `beluga-lake` bucket, bypassing catalog policies for any entity possessing it. [ADR-0004](adr/0004-duckdb-complementary-analytics-engine.md) designates this as a known gap that DuckDB must not widen.
- **Lakekeeper Bootstrap**: In [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml), warehouse `lake` is created with `"sts-enabled": false` and static credentials. OpenFGA warehouse assignments grant full access to `service-account-trino` and `service-account-flink` ([lines 165–172](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml)).
- **Network Policies**: [`04b-lakehouse-network-policy.yaml`](../gitops/charts/beluga-data/templates/04b-lakehouse-network-policy.yaml) enforces default-deny and allows ingress to `lakekeeper:8181` only from Trino, Flink, APISIX, and the bootstrap job. DuckDB clients have no ingress rule.
- **Classification**: `lake.customers` contains PII (`policies/resources.yaml`).

### 3.3 External Documentation and Evidence (Accessed 2026-10-08)
- **DuckDB Catalog Secrets** ([`https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html`](https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html)):
  - Attaching with OAuth2:
    ```sql
    CREATE TEMPORARY SECRET lakekeeper_secret (
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

#### Credential Gate and Test Isolation

```
+-----------------------------------------------------------------------------------+
| Phase 1: Test & CI Isolation (Synthetic Test-Key Exception)                        |
|                                                                                   |
|  [DuckDB Client] ---OIDC Token---> [Lakekeeper:8181] (Validates via OpenFGA)      |
|         |                                 |                                       |
|  (Static Scoped S3 Key)            (Catalog Metadata)                             |
|         |                                 |                                       |
|         v                                 v                                       |
|  [SeaweedFS: s3://beluga-test/] <---------+ (Synthetic Non-PII Data Only)         |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
| Credential gate: governed read path (not an ADR phase change)                       |
|                                                                                   |
|  [DuckDB Client] ---OIDC Token---> [Lakekeeper:8181] (Validates via OpenFGA)      |
|         |                                 |                                       |
|         | <---Vended Scoped STS Token-----+ (Temporary Table-Scoped Token)        |
|         |                                                                         |
|         v                                                                         |
|  [SeaweedFS: s3://beluga-lake/] (Production Internal Data - PII Excluded)         |
+-----------------------------------------------------------------------------------+
```

1. **Phase 1 (CI / PoC after prerequisites)**:
   - Create a dedicated SeaweedFS bucket `beluga-test` containing only synthetic data.
   - Bootstrap a dedicated Lakekeeper warehouse `test_warehouse` pointing to `s3://beluga-test/`.
   - Provision a restricted static S3 credential pair scoped exclusively to `beluga-test`.
   - Configure Keycloak client `duckdb-ci` and grant OpenFGA table-level read permissions on test tables only (map the operation to the pinned Lakekeeper model during implementation).
2. **Credential gate (not an execution-phase authorization)**:
   - Production access to `beluga-lake` remains **BLOCKED** until task 1 (SeaweedFS STS evaluation) proves that SeaweedFS can vend temporary, scoped credentials. If STS cannot be enabled, DuckDB remains restricted to the non-PII test warehouse until scoped vending is proven; any other exception needs a new ADR.
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
- **Baseline Tables**: `lake.events_enriched` (internal clickstream events), `lake.orders` (internal transactions), and `lake.customers` (PII records) in [`policies/resources.yaml`](../policies/resources.yaml).
- **Existing Scripts**: Test scripts exist in `tests/` (`04-trino-query.sh`, `tests/run-all.sh`), but no automated parity comparator between DuckDB and Trino exists.
- **Benchmark Requirement**: ADR-0004 task 10 requires comparing CPU, memory, I/O, startup, latency, and concurrency between engines.

### 4.3 Gaps vs Acceptance Criteria
1. No automated tool compares row counts, schemas, null handling, and numeric outputs between DuckDB and Trino.
2. No explicit floating-point tolerance policy exists.
3. No benchmark execution harness exists to measure process RSS, CPU time, and I/O.
4. Benchmark numbers must not be fabricated; an empirical benchmark methodology must be defined.

### 4.4 Proposal (Proposed)

#### Semantic Consistency Verification Rules
The Phase 1 suite uses synthetic test-warehouse fixtures at recorded snapshot IDs. The production names below illustrate syntax only and do not authorize access. Confirm time-travel support on the pinned version:

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
   - `TIMESTAMP` precision: record actual Iceberg types and Trino precision (bare Trino `TIMESTAMP` defaults to 3), mapping microseconds to DuckDB `TIMESTAMP`; timezone/decimal/NaN/infinity require explicit cases.
2. **Floating-Point Tolerance Policy**:
   - For `DOUBLE` and `REAL` aggregate computations, strict equality is not required due to differing SIMD/vectorized reduction order.
   - Relative tolerance is defined as:
     $$\frac{|V_{\text{duckdb}} - V_{\text{trino}}|}{\max(|V_{\text{trino}}|, 10^{-9})} \le 10^{-6}$$
3. **Ordering & Null Semantics**:
   - Results without `ORDER BY` are compared as multisets, preserving duplicate multiplicity; aggregate outputs may have no primary key.
   - `NULL` sorting: DuckDB and Trino both default to `NULLS LAST`; configuration can change DuckDB ordering. Test queries must specify `NULLS LAST` explicitly.

#### Repeatable Benchmark Suite Methodology (No Fabricated Numbers)
- **Target Workloads**:
  - *Query Class A (Point/Filter)*: Highly selective filter on partition column (`event_date = '2026-10-01'`).
  - *Query Class B (Heavy Aggregation)*: Multi-column `GROUP BY` with `count(DISTINCT)` over 10M rows.
  - *Query Class C (Join)*: Two-table hash join (`orders` joined with `events_enriched`).
  - *Query Class D (Window Function)*: `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY event_time)`.
- **Metrics Collected**:
  1. *Cold-Start Latency (ms)*: Time from process launch to first result batch.
  2. *Query Elapsed Time (ms)*: Wall-clock duration of query execution.
  3. *Peak Memory (RSS MiB)*: Measure one fresh DuckDB child per run (OS-specific `ru_maxrss` units), and process/container RSS across all Trino pods; do not compare JVM heap to process RSS.
  4. *CPU Consumption (User + System ms)*: Process CPU time consumed.
  5. *Storage I/O Read (MiB)*: Total bytes fetched over HTTP/S3 gateway.
- **Reporting Standard**: Output benchmark results as machine-readable JSON artifacts committed to `docs/benchmarks/` with hardware profile, OS kernel, and exact engine commit versions.

### 4.5 Verification and Test Ideas
- **Automated Regression Suite**: Implement `tests/duckdb-trino-parity.py` executed in CI against test warehouse snapshots.
- **Intentional Failure Injection**: Inject a deliberate SQL syntax variation or data-type mismatch in a test branch to verify the comparator detects discrepancies and fails closed.

### 4.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-65-1 | What floating-point relative error tolerance is acceptable for business reporting? | **$10^{-6}$ relative tolerance** | Candidate tolerance only; exact decimal/financial comparisons and near-zero/NaN/infinity cases need separate owner-approved rules. |
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
- **Current Airflow Operator**: [`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py) executes `KubernetesPodOperator` launching `trinodb/trino:483` CLI pods in namespace `analytics`.
- **Version Tracking**: DuckDB is currently absent from [`VERSIONS.md`](../VERSIONS.md).

### 5.3 Gaps vs Acceptance Criteria
1. DuckDB binary and Python library versions are unpinned in `VERSIONS.md`.
2. No reusable connection helper exists for local scripts, CI, and Airflow.
3. Airflow lacks an operator pattern for executing DuckDB workloads.
4. Local developers cannot resolve internal S3 DNS (`seaweedfs-s3.storage.svc.cluster.local:8333`).

### 5.4 Proposal (Proposed)

Phase 1 is **read-only CI/PoC in-cluster or against a test stack**. ADR tasks 1–4 precede attach: storage decision and scoped-key evidence, synthetic warehouse, dedicated identity/table grants, explicit client network rules. Pin exact runtime, extension artifact/version and image digest at implementation time after ADR Q4; this proposal changes no `VERSIONS.md` row. Runtime installation from a floating extension repository is not a reproducible pin.

A proposed connection helper must use ephemeral in-memory secrets, correctly encode SQL values/identifiers using the pinned API, avoid secret interpolation/logging, and pass the selected vended-credential or scoped synthetic-test path. Catalog attach alone proves neither S3 reachability nor read-only enforcement.

**Airflow is Phase 2**, blocked on its dedicated client/network path, credential proof and #70 unless the owner resolves Q5 “sandbox first”. A `BelugaDuckDBPodOperator`, base image and resource sizing are open questions, not the Phase 1 baseline. Sandbox writes still require Phase 3 task 8.

**Local CLI/notebooks are Phase 2**. APISIX catalog/S3 hostnames alone do not fix cluster-internal endpoints embedded in catalog metadata or vended configuration. The local path requires designed endpoint translation/reachability, TLS and user identity, and an actual laptop-to-catalog-and-data read before adoption. No default gateway or port-forward recipe is approved here.

### 5.5 Verification and Test Ideas
- Phase 1 CI query succeeds against the synthetic warehouse without a Trino worker; no existing `make test-duckdb-ci` target is claimed.
- Test pinned artifact provenance, secret handling, storage-scope denial, read-only grant and negative authorization behavior.
- Phase 2 only: Airflow task lifecycle and laptop reads across both catalog and object storage endpoints.

### 5.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-66-1 | Which hardened image/operator should Phase 2 Airflow use? | Defer until ADR prerequisites and Q5 | Phase 1 CI comes first |
| OD-66-2 | How should a laptop reach both catalog and data with user identity? | Design and prove endpoints in Phase 2 | Gateway naming alone is insufficient |

### 5.7 Follow-Up Implementation Tasks
1. **T-66-1**: Pinned Phase 1 CI connection helper after ADR prerequisites; verify a synthetic read and all security negatives.
2. **T-66-2**: Phase 2 Airflow/local evaluation only after owner questions and phase gates; no operator implementation in Phase 1.

---

## 6. Engine-Level Metrics and Resource Attribution (Issue #67)

### 6.1 Purpose and Acceptance Criteria Mapping
Issue #67 requires making DuckDB and Trino engine selection, execution outcomes, fallbacks, and resource impact measurable without turning DuckDB into a long-running platform service.

### 6.2 Current State (Repository and Live Evidence)

`06-trino.yaml` has no Prometheus JMX exporter configuration. On 2026-10-08 a read-only `kubectl get deploy,ds,sts,svc -A -o json` found no Prometheus, Fluentbit/Vector or Pushgateway workload/service among 84 resources. A `platform-system/grafana-external` Service exists; that alone proves no collector, dashboard or functioning telemetry pipeline. These components are **not existing dependencies** of this proposal. This observation does not exclude separately hosted systems.

### 6.3 Gaps vs Acceptance Criteria
No DuckDB attribution emitter, collection path or engine dashboard has been implemented. Do not log raw SQL, literals, tokens or raw profiling JSON (which may contain query text).

### 6.4 Proposal (Proposed)

<!-- D3: Use sanitized CI artifacts without assuming installed collectors; cost: no live aggregation; escape hatch: a separately approved collector/deployment design. -->

Emit allowlisted JSON events to stdout and retain sanitized CI artifacts. Fields: request ID, timestamp, engine/runtime/extension versions, phase/workload class, pseudonymous caller, permitted dataset identifier, status, error class and explicitly linked retry ID. Normalized query hashes exclude literals and must still be reviewed for sensitive metadata. Never copy SQL or secrets into error messages.

Measured fields may include elapsed time, CPU, RSS, spill and bytes read; missing measurements are `null`, not estimated values. Any example is illustrative and carries no benchmark result. DuckDB JSON profiling must be parsed and scrubbed before emission. Compare equivalent scopes: single-process RSS differs from JVM heap; Trino distributed CPU/RSS/I/O includes coordinator and all workers. Label measurement units and methods per OS.

Prometheus counters, Pushgateway, Fluentbit/Vector collection and Grafana panels are optional future proposals with deployment, retention, access, cardinality and cleanup decisions. Airflow emission is Phase 2. None is an accepted or installed Phase 1 dependency.

### 6.5 Verification and Test Ideas
- Validate emitted schema and missing-value handling; inject SQL/credential-bearing errors and profiling input and verify no leakage.
- Force denial/timeout/capacity failure: record one failed execution and zero automatic Trino retries.
- Collector and dashboard integration tests only after a separate deployment exists.

### 6.6 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-67-1 | What collector and retention should follow sanitized CI artifacts? | Stdout + CI artifacts first; deployment separate | No installed collection pipeline is assumed |

### 6.7 Follow-Up Implementation Tasks
1. **T-67-1**: Allowlisted event emitter with privacy and schema tests.
2. **T-67-2**: Evaluate aggregation/dashboard after approved infrastructure; no existing platform dashboard is claimed.

---

## 7. Result Reuse, Spill, and Temporary-Data Lifecycle (Issue #68)

### 7.1 Purpose and Acceptance Criteria Mapping
Issue #68 requires defining safe, measurable result reuse/caching and temporary-data lifecycles for DuckDB workloads without turning DuckDB into an uncontrolled persistent store or leaking PII across tenant boundaries.

### 7.2 Current State (VERIFIED)
- **Lifecycle Retention Policy**: [`docs/data-lifecycle-policy.md`](data-lifecycle-policy.md) defines the `temporary` retention class for scratch data, rewrites, and checkpoints with automated age-based cleanup.
- **SeaweedFS Prefix**: [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml) designates `tmp/` for transient rewrite/checkpoint/scratch data.
- **Storage Boundaries**: Disk space on Kubernetes worker nodes is finite. Ephemeral pod storage must be bounded to prevent node disk exhaustion.

### 7.3 External Documentation and Evidence (Accessed 2026-10-08)

[DuckDB configuration](https://duckdb.org/docs/current/configuration/overview) documents `memory_limit`, `temp_directory` and `max_temp_directory_size`. [Kubernetes ephemeral storage](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#local-ephemeral-storage) describes storage accounting/eviction; `emptyDir.sizeLimit` is not a synchronous filesystem quota.

### 7.4 Gaps vs Acceptance Criteria
Spill accounting, abrupt-death cleanup and authorization-aware cache invalidation are unimplemented. No bounded storage or cleanup success is claimed.

### 7.5 Proposal (Proposed)

Phase 1 uses fresh in-memory databases and per-run non-PII scratch paths, with **no cross-run or cross-user result reuse**. PII tables are denied by OpenFGA before any read, including `COPY`/spill or direct wrapper bypass. “PII in memory only” is not an exception to that denial.

Candidate memory/spill caps require sizing and owner decision OD-68-1. Combine DuckDB buffer/spill settings, pod memory/ephemeral-storage requests and limits, and `emptyDir.sizeLimit`; leave process/storage headroom. Kubelet eviction is asynchronous and depends on accounting/node support; test it without claiming that 10 GiB prevents all node starvation.

Normal exit may clean process files. `SIGKILL` cannot run a shell trap; a container restart in the same pod preserves `emptyDir`. Design supervisor/startup cleanup or a bounded janitor for abandoned run directories; verify cleanup after pod deletion separately. Airflow hooks and reuse between tasks are Phase 2 owner questions.

Future result reuse requires a key containing **all source** table UUID/snapshot pairs, query/parameter identity, engine+extension version, tenant/principal and authorization context/version. Revalidate current permission before lookup or return; revoke access even when a snapshot is unchanged. No immediate invalidation is claimed without an implemented mechanism.

### 7.6 Verification and Test Ideas
- Force spill with synthetic data; measure configured engine limit and pod accounting.
- `SIGKILL`, same-pod container restart and pod deletion test distinct cleanup paths; prove no abandoned directory growth.
- PII reads and `COPY` denied by catalog authorization without the wrapper.
- If reuse is later adopted: user separation, permission revocation and multi-table snapshot changes invalidate access.

### 7.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-68-1 | What measured process/spill/pod caps are safe? | Size and test accounting first | No hard-quota or immediate-eviction claim |
| OD-68-2 | Should Phase 2 DAG tasks reuse intermediates? | Deferred; Phase 1 fresh run only | Identity, revocation and cleanup evidence required |

### 7.8 Follow-Up Implementation Tasks
1. **T-68-1**: Per-run scratch and pinned-runtime spill settings with observed cleanup tests.
2. **T-68-2**: Pod accounting/limits and kill/restart/deletion tests; future cache evaluation separately gated.

---

## 8. Evaluation Gate for Quack Remote Protocol (Issue #69)

### 8.1 Purpose and Acceptance Criteria Mapping
Issue #69 requires defining a separate, evidence-driven evaluation gate for DuckDB's Quack protocol before considering it for shared lightweight query/service workloads, ensuring the embedded DuckDB design is proven first.

### 8.2 Current State (VERIFIED)
- **Centralized Service Architecture**: Trino operates as Beluga's centralized distributed query service in [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml), integrating with APISIX ingress routing ([`10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml)), Keycloak OAuth2 ([`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)), and Lakekeeper/OpenFGA catalog authorization (distinct from Trino OPA query policy).
- **ADR-0004 Decision**: [ADR-0004 Decision 2](adr/0004-duckdb-complementary-analytics-engine.md) explicitly ruled Quack out of scope: *"DuckDB runs embedded in clients and jobs, not as an always-on service. DuckDB/Quack server mode is out of scope and is evaluated separately after the embedded path is proven."*

### 8.3 External Documentation and Evidence (Accessed 2026-10-08)

[Quack overview](https://duckdb.org/docs/current/quack/overview) describes a beta remote protocol under active development. [Quack security](https://duckdb.org/docs/current/quack/security) documents default token authentication, permissive default authorization, replaceable authentication/authorization callbacks, and a per-user ACL example using custom hooks. These hooks are not evidence of an integrated Beluga enterprise RBAC model. HTTP exposure needs an external TLS termination design.

### 8.4 Gaps vs Acceptance Criteria
Beluga has no demonstrated Quack identity propagation, table-policy enforcement, tenant isolation or operational evidence. No claim is made that upstream has no authorization hooks.

### 8.5 Proposal (Proposed)

Quack stays **out of scope**, as ADR-0004 already decided. This document does not add a permanent rejection or authorize a service. A later evaluation requires an owner decision and evidence for:
1. Embedded path stability on supported workloads.
2. A measured need for a shared service versus Trino.
3. A pinned protocol/version compatibility and upgrade plan.
4. TLS, caller identity, parsed-statement authorization, tenant isolation and catalog/storage policy enforcement.

No unsupported “90 days”, “50% CPU saving”, GA requirement or concurrency count is an accepted gate. Evaluation criteria must be chosen and measured in the future decision.

### 8.6 Verification and Test Ideas
Future evaluation tests authorization hook failures, wrapper bypass, tenant/session isolation, catalog/PII denial and load under agreed representative concurrency.

### 8.7 Owner Decisions Remaining
| ID | Question | Recommendation | Rationale |
|---|---|---|---|
| OD-69-1 | When is a separate Quack evaluation warranted? | Keep out of scope until embedded path is proven | Preserves ADR decision 2 |

### 8.8 Follow-Up Implementation Tasks
1. **T-69-1**: Track official protocol/security changes; no service adoption or new component in this proposal.

---

## 9. Consolidated Owner Decisions Table

The section-level tables are authoritative. OD-62-1 / OD-62-2 cover deferred writes and pinning; OD-63-1 / OD-63-2 cover sizing and explicit user resubmission; OD-64-1 / OD-64-2 cover vending and human identity; OD-65-1 / OD-65-2 cover tolerance and benchmark retention; OD-66-1 / OD-66-2 cover Phase 2 forms; OD-67-1 covers future collection; OD-68-1 / OD-68-2 cover measured limits and deferred reuse; OD-69-1 covers a separate Quack evaluation. None changes an ADR decision. ADR Q1/Q4 and tasks 1–4 are prerequisites for Phase 1 attach; writes remain Phase 3.

## 10. Consolidated Follow-Up Implementation Tasks

| Phase / tasks | Dependencies | Acceptance evidence |
|---|---|---|
| Phase 1 storage/identity/network: T-64-1 / T-64-2 / T-64-3 | ADR tasks 1–4, owner storage decision | Scoped synthetic key or proven vending, dedicated grants, PII catalog denial, positive/negative network probes |
| Phase 1 reads/security: T-62-1 / T-62-2 / T-63-1 / T-66-1 | Above prerequisites, exact runtime+extension pin | Read parity, all writes denied, zero automatic Trino retries |
| Phase 1 parity/measurement: T-65-1 / T-65-2 / T-63-2 / T-67-1 | Synthetic fixtures and readable pinned snapshots | Comparable measured outputs, sanitized events, missing values explicit |
| Phase 1 scratch: T-68-1 / T-68-2 | Pinned runner and measured limits | Spill, kill, restart and deletion evidence |
| Phase 2 Airflow/local: T-66-2 | Vending/identity/network and ADR Q5/#70 | Actual Airflow and laptop-to-catalog-and-data reads |
| Future aggregation: T-67-2 | Separate deployment decision | Actual collector/dashboard evidence |
| Phase 3 writes | ADR task 8, #70 and owner scope/cleanup decision | Commit conflicts, abort/retry and safe orphan lifecycle |
| Separate Quack evaluation: T-69-1 | Embedded-path proof and owner decision | Versioned security/operational evidence |

## Correction Evidence and Limits (2026-10-08)

Repository baseline: `0526d9371cae5f895c6e38905e17624f67b09912`. Correction sources: the existing DAG, `tests/04-trino-query.sh`, ADR-0004 Operational forms/security/task order, and the official documentation linked above. [DuckDB ordering](https://duckdb.org/docs/current/sql/query_syntax/orderby) confirms the NULL default; [Trino types](https://trino.io/docs/current/language/types.html) defines timestamp precision. Read-only cluster inventory used an isolated copy of the previous verified kubeconfig; 84 deployment/DaemonSet/StatefulSet/Service resources were inspected, with no named collector dependencies found. The shared `vagrant-beluga` context failed CA verification; that failed probe was not used as evidence and TLS verification was not disabled. No cluster mutation, DuckDB runtime test, credential-vending proof or benchmark was performed. Planned tests above are acceptance ideas, not results.
