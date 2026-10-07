# Governed Data Quality Framework (Proposal)

English | [한국어](data-quality-framework-ko.md)

Refs issue #85 ("Build governed data quality management framework with OpenMetadata integration").

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, script, policy or `VERSIONS.md` value is changed by this
> document. Repository statements carry a `file:line` read at commit `9f74c2b`. "Live" statements were read with
> read-only `kubectl` on 2026-10-07; other runtime facts are marked **not verified live**. External facts cite `[S#]`
> (see [Sources](#sources), accessed 2026-10-07); where upstream is silent the text says **no official recommendation**
> or **not on the page read**. Items labelled **Proposed** are not implemented. Thresholds are never invented here; they are owner decisions.

Related: [`medallion-architecture.md`](medallion-architecture.md) (section 5.2 gate rules, quarantine), [`pii-classification-enforcement.md`](pii-classification-enforcement.md),
[`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md), [`data-contract-standard.md`](data-contract-standard.md), [`data-lifecycle-policy.md`](data-lifecycle-policy.md) (retention of results and quarantine).
Issues #20, #56 (gates, continuous quality), #81, #82 (run identifiers), #75 are named in the issue text; their content was not re-read for this document.

## 1. Purpose and issue mapping

The issue asks for a Beluga quality control plane that uses OpenMetadata as the catalog integration point. This document defines ownership boundaries, gate placement, PII-safe execution and an evidence model on top of the existing layers.

| Issue #85 acceptance criterion | Section |
|---|---|
| Representative datasets have quality profiles | 2.2, 4.6 |
| Reusable rules execute and produce versioned evidence | 4.2, 4.4 |
| Results visible in the OpenMetadata-integrated catalog | 4.1, 4.5 |
| Silver/Gold publication can be blocked by critical failures | 4.3 |
| Drift, freshness, volume anomalies detected | 4.2, 4.6 |
| Failure traced through lineage to downstream assets | 4.5 |
| Quarantine, remediation, recheck, closure auditable | 4.7 |
| Profiling respects PII/security and source limits | 4.8 |
| Metrics feed SLA and operational reporting | 4.9 |

## 2. Current state (verified)

### 2.1 Quality controls that exist

- **None in the data pipelines.** The medallion document records: no quality gates before Silver/Gold, no quarantine, `lake.customers`/`lake.orders` written straight from the stream
  ([`medallion-architecture.md`](medallion-architecture.md) section 4, gap list). Flink SQL casts types (for example string to `TIMESTAMP(3)`, `DECIMAL(10, 2)`) but the files contain no validation or dead-letter path
  (`gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:54-58`, `cdc_orders.sql:55-63`; no `WHERE` or error sink in either file).
- **Metadata completeness is not data quality.** `completeness_threshold_percent: 100` in [`policies/data-standards.yaml:31`](../policies/data-standards.yaml#L31) measures whether registry fields are present, enforced by `scripts/ci/check-data-standards.py` in `make validate` (`Makefile:68`). It says nothing about row values.
- Freshness is declared (`PT5M`) and not measured (see [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md) section 2.1).

### 2.2 Catalog layer and datasets

- OpenMetadata 1.13.3 is optional (`values.yaml:58-59`), deployed with OIDC login and `DefaultAuthorizer` (`11-openmetadata.yaml:179-205`); **live:** running in `governance`; no ingestion-runner pod found; no test suites defined in the repository. Live contents **not verified**.
- Candidate datasets today are structured only: `lake.customers`, `lake.orders`, `lake.events_enriched` and their PostgreSQL sources (`policies/data-standards.yaml:33-112`). No API-derived, document-derived or multimedia-derived dataset exists in the repository, so the issue's four dataset kinds cannot all be demonstrated now.
- Run identifiers (#82) do not exist in the repository; the nearest stable identifiers are Iceberg snapshot ids and Airflow/Flink job names.

### 2.3 Access path any quality runner would use

- Humans and services reach Iceberg through Trino, and Trino enforces table-level OPA with `default allow := false` (`trino.rego:6`). `lake.customers` is selectable only by `admins`/`engineers` (`trino.rego:31-39`). No Trino column mask exists today (see [`pii-classification-enforcement.md`](pii-classification-enforcement.md) section 2.3).
- OpenMetadata's Trino connector documents `Data Profiler`, `Data Quality` and `Sample Data` features and states it needs `SELECT` on tables (plus `system.metadata.table_comments`) and additional `SELECT` for profiling and quality [S2]. A quality runner is therefore a new Trino principal that must hold an explicit grant; today none exists in `policies/roles.yaml` (`analysts`, `engineers`, `admins` only).

### 2.4 What upstream documents

| Topic | Upstream statement | Source |
|---|---|---|
| OpenMetadata quality | Table- and column-level tests for supported database connectors; YAML and UI configuration; custom tests/suites; alerts on failure; health dashboard; resolution workflow. Whether these are open-source features is **not stated on the page read** | [S1] |
| Table test definitions | `tableRowCountToEqual`, `tableRowCountToBeBetween`, `tableColumnCountToEqual`, `tableColumnCountToBeBetween`, `tableColumnNameToExist`, `tableColumnToMatchSet`, `tableCustomSQLQuery`, `tableRowInsertedCountToBeBetween`, `tableDiff`; run through YAML (`testDefinitionName`) and a TestSuite. Column test names are on a separate page, **not read** | [S3] |
| Blocking publication | Whether an OpenMetadata test can block a pipeline step is **not documented on the pages read**: no official recommendation | [S1, S3] |
| Quality dimensions | ODCS lists `accuracy`, `completeness`, `conformity`, `consistency`, `coverage`, `timeliness`, `uniqueness`; library metrics `nullValues`, `missingValues`, `invalidValues`, `duplicateValues`, `rowCount`; operators `mustBe`, `mustNotBe`, `mustBeGreaterThan`, ...; custom rules may name an `engine` (examples `soda`, `greatExpectations`) | [S4] |
| Great Expectations / Soda / dbt tests | Not evaluated for this document: no official-doc review was done and no recommendation is made. Adoption needs the license/SBOM check against `policies/license-policy.yaml:1-7` | n/a |

## 3. Gaps vs the acceptance criteria

| ID | Gap |
|---|---|
| G1 | No rule definitions, execution, results or evidence exist anywhere |
| G2 | No pipeline gate; OpenMetadata tests are not documented as able to block a step, so a blocking gate must live in the pipeline |
| G3 | No quarantine namespace/tables or remediation workflow (medallion defines the rule, nothing implements it) |
| G4 | No quality-runner identity; granting one carelessly would widen PII access |
| G5 | No run identifier (#82) to correlate failures; only snapshot ids and job names |
| G6 | Only structured datasets exist for the representative-dataset criterion |

## 4. Proposal (Proposed)

### 4.1 Ownership boundary (authority split)

| Item | Authority | OpenMetadata role |
|---|---|---|
| Rule definitions, templates, severities, thresholds, waivers | Git (`policies/quality/*.yaml`, Proposed path) | read copy; synced from Git |
| Gate decision (pass/block/warn) | the pipeline (Airflow task or Flink job) | none |
| Execution evidence (rule version, run id, snapshot id, timestamp, counts) | Beluga evidence record (4.4) | displays test results and incidents |
| Dataset ownership, classification, lineage | registry (see [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md)) | read copy |
| Incident status in the UI | OpenMetadata resolution workflow [S1] | authoritative for UI state only; closure also recorded in Git/evidence (4.7) |

OpenMetadata edits never change a rule or a gate result. This keeps one authoritative definition and avoids an incompatible metadata silo.

### 4.2 Dimension and rule model

Use the ODCS dimension names as the **vocabulary** (not a mandate) so rules map one-to-one to the contract ([`data-contract-standard.md`](data-contract-standard.md)); the issue's `validity`, `integrity` and `volume/anomaly` are mapped as sub-kinds:

| Issue dimension | Rule template (Proposed) | Candidate OpenMetadata mapping |
|---|---|---|
| completeness | not-null / missing ratio per column | column test (name **not read**) |
| uniqueness | duplicate ratio on key | column test (name **not read**) |
| validity / conformity | allowed set, range, pattern | column test or `tableCustomSQLQuery` |
| integrity | referential check across tables | `tableCustomSQLQuery`, `tableDiff` |
| volume | row count within band; inserted rows per period | `tableRowCountToBeBetween`, `tableRowInsertedCountToBeBetween` |
| schema drift | expected columns present | `tableColumnToMatchSet`, `tableColumnNameToExist` |
| timeliness | freshness from `$snapshots` (see lineage document section 4.4) | none read; Beluga check |
| accuracy, anomaly detection | only where a reference exists; statistical anomaly detection is **out of the first slice** | none read |

Numbers (bands, ratios) are owner-supplied per dataset; none is proposed.

### 4.3 Gate placement (aligned with medallion 5.2)

- Bronze to Silver: schema/type/key checks in the transformation; failing records go to the quarantine table, not dropped (medallion rule).
- Silver to Gold: an Airflow task runs the declared rules against the Silver inputs for the period and publishes Gold only on pass; severity `critical` blocks, `warning` records and continues (blocking vs warning is configured per rule in Git). A block leaves the previous Gold snapshot in place.
- OpenMetadata tests run as additional visibility and alerting, not as the gate [S1, S3].
- Today's streaming Gold-like `lake.events_enriched` has no Silver input; gating it requires the medallion Q4 decision.

### 4.4 Evidence record (reproducibility)

Per rule execution store: rule id, rule version (Git commit of the rule file), execution id, input dataset id and Iceberg `snapshot_id`/`committed_at` [S5], gate decision, counts (rows checked, rows failed), timestamp, runner identity. **No row values** are stored, only counts and rule outcomes. Storage location is an owner decision (D3): an Iceberg `quality_results` table (must itself be registered and classified `internal`) or files attached to release evidence. Retention follows [`data-lifecycle-policy.md`](data-lifecycle-policy.md) (audit class); no period is set here.

### 4.5 Lineage-aware impact

On a failed gate, the report lists downstream assets using the declared `derived_from` edges ([`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md) L1). Reports, APIs and data products are listed only once they are declared as lineage nodes; Superset dashboards are **not** nodes today.

### 4.6 Representative first slice

`lake.orders` (structured), with row-count band, freshness, key uniqueness, not-null on keys and schema-match. `lake.customers` is **not** in the first slice: Trino OPA grants are table-level (`trino.rego:31-39`), so the runner cannot be granted its `internal` columns alone. It joins only if owner decision D2 is approved, with the prerequisites in 4.8. API, document and multimedia datasets are deferred until they exist (G6). Source PostgreSQL tables are **not profiled directly** (4.8).

### 4.7 Quarantine, remediation, closure (audit trail)

States: `open -> quarantined -> remediating -> rechecked -> closed`, plus `waived`. Each transition is a Git-reviewed record or an evidence-record append (who, when, run id). A waiver requires a named approver and an expiry in the same record. OpenMetadata's resolution workflow [S1] mirrors the state for the UI; the Git record is the audit source. Quarantined data inherits the classification of its source (PII stays PII) and the same retention hook.

### 4.8 Security: PII and source load

- The quality runner must not widen PII access. First slice: run rules only on non-`pii` tables; the runner is **not** granted access to `lake.customers` (grants are table-level, so a column-only grant does not exist in the current compiler).
- Value-level checks on `pii` tables (completeness, uniqueness, row count) are conditional on D2 and need three prerequisites: (a) a new runner role with a `select` grant on the table in `policies/roles.yaml` plus a Keycloak group, never `engineers`; (b) masks on **every** registry-`pii` column of that table (see [`pii-classification-enforcement.md`](pii-classification-enforcement.md) section 4.3); (c) a rule for metadata tables such as `customers$snapshots`, since whether OPA sees them as separate table names was not verified. Mask kind: the PII document recommends `null` as default and warns that `hash` is a deterministic hash of low-entropy values that can be reversed by guessing. `null` makes null-count and uniqueness checks meaningless, so `hash` would be a **documented exception limited to the machine runner role**, recorded as an extension of the PII document's D4 (not a join-key case) and approved together with D2 (it never returns rows and the evidence record stores counts only); the residual risk is a dictionary attack by anyone able to run queries as that role, so the role must not be reachable by humans. That null-preserving behaviour (a hash of NULL is NULL) is an inference from SQL semantics and must be tested before adoption.
- Disable sample-data/preview collection for `pii` tables in any OpenMetadata profiler run ([`pii-classification-enforcement.md`](pii-classification-enforcement.md) section 4.5).
- Source load: profile the Iceberg mirror through Trino, not PostgreSQL. Trino concurrency limits and sampling ratios are owner decisions (D4); no benchmark exists and none is claimed.

### 4.9 SLA/SLO and APIs

Per-dataset freshness and pass-rate SLOs reuse the registry `freshness` target and the contract SLA ([`data-contract-standard.md`](data-contract-standard.md)). Export for portal/automation: the evidence record (4.4) as JSON plus the OpenMetadata API when enabled. No new service is proposed.

## 5. Verification and test ideas

| Test | Type | Pass condition |
|---|---|---|
| Rule file schema and unique ids | static, `make validate` | invalid fixture fails |
| Failing `critical` rule on a staged Silver input | live (Airflow) | Gold not published, previous snapshot unchanged |
| `warning` rule failing | live | recorded, publication continues |
| Row-count band, duplicate key injected into a test table | live | detected, evidence has rule version and `snapshot_id` |
| Runner identity cannot read `lake.customers` raw | live | `SELECT` denied (OPA) |
| Masked null/uniqueness counts on `customers` (only if D2 approved) | live | counts equal the unmasked counts; no value stored in evidence |
| Waiver without approver/expiry | static negative | fails |

## Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | OpenMetadata tests as gate or visibility only | Visibility only; gate in the pipeline |
| D2 | A dedicated read-only quality-runner role for masked `pii` checks | Not in the first slice; add only if PII completeness checks are required |
| D3 | Evidence storage: Iceberg table vs release evidence files | Iceberg table once Silver exists; files before |
| D4 | Profiling concurrency/sampling limits and rule thresholds | No official recommendation; owner picks per dataset |
| D5 | Evaluate Great Expectations/Soda or stay with OpenMetadata plus SQL rules | Stay with OpenMetadata plus SQL rules until a gap is shown; evaluate with license review |
| D6 | Blocking default severity for new rules | `warning` until the rule has a baseline |

## Follow-up implementation tasks (ordered)

1. Define the rule file format and a static validator (`policies/quality/`). Test: invalid fixtures fail.
2. Implement volume, freshness and schema-match checks for `lake.orders` as an Airflow task writing the evidence record. Test: injected failure produces evidence with `snapshot_id`.
3. Add the Silver-to-Gold gate task pattern with critical/warning severity. Test: block and warn cases above.
4. Quarantine table convention and state records (after medallion Bronze/Silver exist). Test: waiver and closure negative cases.
5. Sync rules and results to OpenMetadata when enabled. Test: results visible on the dataset page.
6. Quality-runner identity decision (D2) and masked PII completeness test. Test: counts equal, no raw access.
7. Impact report from declared lineage. Test: failure on `lake.customers` lists declared downstream tables.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | OpenMetadata, Data Quality overview: https://docs.open-metadata.org/latest/how-to-guides/data-quality-observability/quality |
| S2 | OpenMetadata, Trino connector: https://docs.open-metadata.org/latest/connectors/database/trino |
| S3 | OpenMetadata, Table test definitions (YAML): https://docs.open-metadata.org/latest/how-to-guides/data-quality-observability/quality/tests-yaml |
| S4 | Open Data Contract Standard, Data Quality: https://bitol-io.github.io/open-data-contract-standard/latest/data-quality/ |
| S5 | Trino 483, Iceberg connector (`$snapshots`): https://trino.io/docs/483/connector/iceberg.html |
