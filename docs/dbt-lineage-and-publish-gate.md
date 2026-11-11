# Governed dbt Lineage and Silver Publication Gate (Proposal)

English | [한국어](dbt-lineage-and-publish-gate-ko.md)

Refs issue #95 ("Adopt dbt Core as governed SQL transformation layer").

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, script, policy, registry, or `VERSIONS.md` value is changed by this document. Repository statements carry a `file:line` verified against `origin/main`. Unprobed runtime behaviors are explicitly marked **not verified live** or **to verify against upstream docs for the pinned version**. External tool licenses cite official project terms or `VERSIONS.md`. Items labelled **Proposed** are design proposals and are not implemented.

Related documents:
- [`adr/0007-dbt-core-transformation-layer.md`](adr/0007-dbt-core-transformation-layer.md) (dbt Core adoption decisions D-DBT-1 through D-DBT-15)
- [`transformation-and-semantic-layer.md`](transformation-and-semantic-layer.md) (batch Silver/Gold transformation framework, OD-TR-1, OD-TR-6)
- [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md) (lineage controls, OpenMetadata posture, G1–G5)
- [`policies/resources.yaml`](../policies/resources.yaml) (OPA resource and schemaGrants for role `transformers`)
- [`dbt/README.md`](../dbt/README.md) (dbt project structure, local checks, publication gate)

---

## 1. Purpose and Issue Mapping

Issue #95 established dbt Core with Trino execution on Iceberg (`adr/0007-dbt-core-transformation-layer.md:20-28`). Two architectural gaps remain unaddressed:
1. **Governed Lineage and Documentation Visibility**: Exposing dbt transformation DAGs, model definitions, column documentation, and test assertions in a governed catalog accessible to consumers.
2. **Silver Model Publication Gate (WAP)**: Today, models are materialized directly as `table` before their tests execute (`adr/0007-dbt-core-transformation-layer.md:112-132`). A failing Silver test skips Gold but leaves a corrupted Silver table in place (`dbt/README.md:68-70`).

| Gap ID | Issue #95 Acceptance Criterion | Addressed in Section |
|---|---|---|
| G-DBT-1 | dbt model lineage, metadata, and schema documentation visible in governed catalog | 2.1, 4, 6.1 |
| G-DBT-2 | Pre-publication quality and schema assertions gate Silver table replacement (WAP) | 2.2, 5, 6.2 |

---

## 2. Current State (Verified)

### 2.1 Catalog and Lineage Posture
- **OpenMetadata optional**: Deployed conditionally (`gitops/charts/beluga-data/templates/11-openmetadata.yaml:28`, `{{ if (dig "openmetadata" "enabled" false .Values.AsMap) }}`); disabled by default in chart values (`gitops/charts/beluga-data/values.yaml:67-68`) and enabled via `gitops/values/profile-full.yaml:2-3`. Version is `1.13.3` (`VERSIONS.md:48`, Apache-2.0). Whether OpenMetadata resource footprint fits default 32GB cluster sizing is **to verify live**.
- **No ingestion workflow**: No ingestion runner, DAG, or sync job exists in the repository (`docs/lineage-and-metadata-quality.md:48-51`). Lakekeeper (`VERSIONS.md:34`, Apache-2.0) is the sole authority for Iceberg metadata. Whether the live OpenMetadata catalog holds any entity was **not verified live** (`docs/lineage-and-metadata-quality.md:49`).
- **Static column lineage**: Offline SQL parser exists in `scripts/lineage/sql_lineage.py:1-40` and commits `docs/generated/column-lineage.json:1-35` verified by `scripts/ci/check-column-lineage.py` (`Makefile:58`). It extracts static SQL but does not parse dbt Jinja models.
- **dbt artifacts**: Local CI generates `target/manifest.json`, `target/catalog.json`, and `target/run_results.json` (`dbt/README.md:16-19,51-53`). The production DAG (`gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py:24-26`) runs `dbt build` in an ephemeral pod and discards artifacts on pod deletion (`:74`).

### 2.2 Publication Gate Posture
- **Downstream gating only**: D-DBT-6 (`adr/0007-dbt-core-transformation-layer.md:112-128`) uses `dbt build` to execute tests after model materialization. An error test skips downstream Gold (`daily_revenue`), but Silver (`silver_shop.orders`) is already replaced in Iceberg.
- **Materialization**: Both models use full `table` rebuild (`adr/0007-dbt-core-transformation-layer.md:129-139`, D-DBT-7).
- **Existing schema permissions**: Role `transformers` possesses `[CreateSchema, CreateTable, DropTable, RenameTable, SetTableProperties, InsertIntoTable, DeleteFromTable, SelectFromColumns, CreateView, DropView, CreateViewWithSelectFromColumns, ShowTables, ShowColumns, ShowCreateTable, FilterTables, FilterColumns, FilterSchemas]` on catalog `iceberg` schemas `[silver_shop, gold_shop]` (`policies/resources.yaml:45-56`, `gitops/charts/beluga-platform/files/opa/trino.rego:518-525`). `RenameTable` is already granted within these schemas.

---

## 3. Gaps vs Acceptance Criteria

| ID | Description | Root Cause in Repository |
|---|---|---|
| G-DBT-1 | dbt DAG, documentation, and column descriptions are invisible to catalog users | No ingestion pipeline into OpenMetadata; `dbt docs` site is not served; dbt artifacts are discarded when pod exits (`dbt_shop_medallion.py:74`). |
| G-DBT-2 | Silver table is overwritten before assertions validate candidate data | Models materialized directly into destination tables; `dbt build` fails post-materialization (`adr/0007-dbt-core-transformation-layer.md:112-125`). |

---

## 4. Gap 1 Options: dbt Lineage and Documentation in Governed Catalog

### Option A: OpenMetadata dbt Ingestion Pipeline
- **Mechanism**: Ingest `manifest.json`, `catalog.json`, and `run_results.json` into OpenMetadata using `metadata-ingestion[dbt]` (*to verify against upstream OM 1.13.3 docs*).
- **Artifact storage**: Store artifacts in SeaweedFS S3 (`http://seaweedfs-s3.storage.svc.cluster.local:8333`, bucket `beluga-lake/dbt-artifacts/<run_id>/`, `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:78,137`).
- **Identity & grants**: Requires OpenMetadata Ingestion Bot token (`docs/lineage-and-metadata-quality.md:49`), S3 read credentials, and OM entity write grants (`Table`, `Lineage`, `Tag`) (*to verify against OM 1.13.3 docs*).
- **Scheduling**: Post-build task in Airflow DAG `dbt_shop_medallion.py` using `KubernetesPodOperator` in namespace `governance` or `orchestration`.
- **Dependencies & risks**: Strict dependency on prior Trino service metadata ingestion (*to verify against upstream OM 1.13.3 docs*). OpenMetadata is disabled by default in chart values (`gitops/charts/beluga-data/values.yaml:67-68`) and enabled via `gitops/values/profile-full.yaml:2-3`; resource fit on default 32GB profiles and runtime overhead are **to verify live**.

### Option B: Publish `dbt docs` Static Site behind Gateway/SSO
- **Mechanism**: Run `dbt docs generate` during or after DAG run, publish static assets (`index.html`, `manifest.json`, `catalog.json`) to SeaweedFS or dedicated nginx pod in `analytics` (license *to verify* before adoption; not asserted here).
- **Access**: APISIX route `dbt-docs.<baseDomain>` with Keycloak OIDC authentication (`openid-connect` plugin) restricted to groups `analysts` and `engineers`.
- **Dependencies & risks**: Independent of OpenMetadata; functions with chart default values (`gitops/charts/beluga-data/values.yaml:67-68`). Resource overhead of static server vs cluster sizing is **to verify live**. Does not unify non-dbt assets (Kafka/Flink) into a single enterprise search UI.

### Option C: OpenLineage Runtime Events via `openlineage-dbt`
- **Mechanism**: dbt emits OpenLineage JSON events to an HTTP backend (*to verify license and adapter support on dbt 1.12.6*).
- **Dependencies & risks**: Beluga deploys no OpenLineage backend (`docs/lineage-and-metadata-quality.md:43,57`). Introducing Marquez or backend collector adds unallocated cluster footprint (*to verify live*) and requires new network policies.

### Option D: Defer Catalog Ingestion; Rely on Static Column Lineage Report
- **Mechanism**: Extend `scripts/lineage/sql_lineage.py` to ingest dbt compiled SQL or `manifest.json` into `docs/generated/column-lineage.json`.
- **Dependencies & risks**: Verified in CI (`make validate`, `Makefile:58`). Lacks interactive UI, search, and live execution status for data consumers.

---

## 5. Gap 2 Options: Silver Publication Gate and Candidate Isolation

### Option A: Iceberg Branch Write-Audit-Publish (WAP) with Trino
- **Mechanism**: Write Silver candidate into Iceberg audit branch `orders$branch_<run_id>`, audit branch data via dbt tests, fast-forward `main` branch to audit snapshot on test pass (`ALTER TABLE silver_shop.orders EXECUTE fast_forward(...)`), and drop audit branch (*to verify syntax and support against upstream Trino 483 docs*).
- **Capabilities to verify**: Does Trino 483 (`VERSIONS.md:37`) support writing to and fast-forwarding Iceberg branches via Lakekeeper REST catalog v0.13.1 (`VERSIONS.md:34`)? (*To verify against upstream Trino 483 docs*). Does `dbt-trino` 1.11.0 provide native branch materializations? (*To verify against upstream dbt-trino docs*).
- **Privilege gap and OPA mapping**: `ExecuteTableProcedure` is granted exclusively to role `maintainers` (maintenance identity) for procedures `[optimize, expire_snapshots]` on exact tables (`policies/resources.yaml:57-63`, `gitops/charts/beluga-platform/files/opa/trino.rego:651-752`). Role `transformers` holds schema-scoped operations on `silver_shop` and `gold_shop` (`policies/resources.yaml:45-56`, `gitops/charts/beluga-platform/files/opa/trino.rego:518-525`) but holds zero procedure grants today. Whether Iceberg branch operations in pinned Trino map to `ExecuteTableProcedure` or other OPA operations is **to verify live from the OPA decision log** (not asserted); if ungranted procedures or actions are invoked, policy compiler changes will be required.

### Option B: Staging Table + Table Swap (Rename) within `silver_shop`
- **Mechanism**:
  1. Materialize Silver candidate to `silver_shop.orders__staging`.
  2. Execute dbt error-severity tests against `orders__staging`.
  3. If tests fail: drop `orders__staging`; `silver_shop.orders` remains unaltered.
  4. If tests pass: execute table rename sequence:
     `ALTER TABLE silver_shop.orders RENAME TO silver_shop.orders__backup;`
     `ALTER TABLE silver_shop.orders__staging RENAME TO silver_shop.orders;`
     `DROP TABLE silver_shop.orders__backup;`
- **Privilege alignment**: `RenameTable` is granted to `transformers` within `silver_shop` and `gold_shop` (`policies/resources.yaml:45-56`, `gitops/charts/beluga-platform/files/opa/trino.rego:518-525`). `CreateTable`, `DropTable` and `InsertIntoTable` are declared for the same role and schemas in `policies/resources.yaml:49-55` and generated in the schemaGrants block `gitops/charts/beluga-platform/files/opa/trino.rego:418-623`. No OPA policy change is needed for these four operations; whether the swap needs any further operation is part of the Task 1 live check.
- **Runtime behaviors to verify live (Task 1)**:
  - Whether Trino 483 / Lakekeeper supports atomic table swap or strictly sequential rename is **to verify live**.
  - The existence and duration of any transient missing-table window where `orders` is absent is **to verify live**.
  - Reader behavior (concurrent query failure with `TABLE_NOT_FOUND` vs query queuing or retry) is **to verify live**.
  - Recovery after partial failure (e.g. step 2 failing and requiring automated rollback of `orders__backup`) is **to verify live**.
  - Whether rename directly onto an existing target table is possible or requires drop/backup + rename is **to verify live**.

### Option C: Pre-Flight dbt `--empty` and Source Tests
- **Mechanism**: Execute `dbt build --empty` and `dbt test --select source:*` prior to table materialization.
- **Dependencies & risks**: Catches upstream contract violations and syntax errors before writing to Silver, but cannot catch invalid data produced by the transformation logic itself.

### Option D: Status Quo (`dbt build` Direct Replacement)
- **Mechanism**: Maintain current D-DBT-6 behavior; Silver is overwritten, and failing tests block Gold only.
- **Dependencies & risks**: Corrupted Silver data is exposed to consumers until manual rollback or repair occurs.

---

## 6. Recommendations and Trade-offs

1. **Gap 1 Recommendation**: Adopt **Option B (Static `dbt docs` behind Gateway/SSO)** for Phase 1, combined with **Option D (Static Column Lineage CI Extension)**.
   - *Rationale*: OpenMetadata is disabled by default in chart values (`gitops/charts/beluga-data/values.yaml:67-68`), enabled in `gitops/values/profile-full.yaml:2-3`, and lacks an ingestion runner (`docs/lineage-and-metadata-quality.md:48-51`). Serving `dbt docs` provides visual lineage, model definitions, and test documentation without waiting for full catalog ingestion; resource fit and runtime overhead are to verify live under Task 3. Defer Option A to Phase 2 for full profiles once Trino catalog ingestion is operational.
2. **Gap 2 Recommendation**: Adopt **Option B (Staging Table + Rename Swap)** combined with **Option C (Source Test Pre-flight)**, explicitly conditional on live verification under Task 1.
   - *Rationale*: `RenameTable` is granted to `transformers` within `silver_shop` and `gold_shop` (`policies/resources.yaml:45-56`, `gitops/charts/beluga-platform/files/opa/trino.rego:518-525`). If live verification in Task 1 confirms acceptable reader behavior, error recovery, and rename mechanics, this eliminates Silver data corruption risks with zero OPA compiler modifications. Iceberg branch WAP (Option A) remains deferred until Trino 483 / Lakekeeper branch procedures and OPA decision mappings are verified live.

---

## 7. Owner Decisions Remaining

| Decision ID | Topic | Options Considered | Recommendation | Rationale |
|---|---|---|---|---|
| **OD-DBTL-1** | Lineage and documentation exposure | (A) OpenMetadata dbt ingestion<br>(B) `dbt docs` via APISIX/SSO<br>(C) OpenLineage runtime backend<br>(D) Static CI report only | **Option B for Phase 1; evaluate Option A in Phase 2** | Option B uses existing APISIX/Keycloak SSO and default chart values (`values.yaml:67-68`), avoiding dependency on unverified OpenMetadata ingestion. Resource fit to verify live under Task 3. |
| **OD-DBTL-2** | dbt artifact persistence substrate | (A) SeaweedFS S3 bucket `beluga-lake`<br>(B) Shared PVC in `analytics`<br>(C) Ephemeral pod storage (discard) | **Option A: SeaweedFS S3 (`beluga-lake/dbt-artifacts/`)** | Enables decoupled ingestion and documentation serving without tying storage to pod lifecycles. |
| **OD-DBTL-3** | Silver publication gate mechanism | (A) Iceberg branch WAP<br>(B) Staging table + rename swap<br>(C) Source pre-flight only<br>(D) Status quo | **Option B combined with Option C, conditional on Task 1 live verification** | `RenameTable` is granted in `policies/resources.yaml:45-56` and `gitops/charts/beluga-platform/files/opa/trino.rego:518-525`. Adoption is conditional on Task 1 live verification of swap mechanics. |
| **OD-DBTL-4** | Reader impact tolerance during table swap | (A) Tolerate swap window subject to live verification<br>(B) Block swap until native branch WAP proven | **Option A, conditional on Task 1 live verification** | Reader behavior and missing-table window are to verify live in Task 1. Off-peak batch runs may tolerate minor impact if verified acceptable. |

---

## 8. Ordered Follow-up Implementation Tasks

1. **Task 1: Live Verification & Implementation of Staging Rename Swap (Gap 2)**
   - Verify live on Trino 483 / Lakekeeper: (a) atomicity and missing-table window during swap, (b) reader behavior during sequential rename, (c) recovery procedure after partial failure, and (d) whether direct overwrite rename is supported vs drop+rename. If verified acceptable, implement custom dbt materialization or pre/post-hook macro using granted `RenameTable` (`policies/resources.yaml:45-56`, `gitops/charts/beluga-platform/files/opa/trino.rego:518-525`).
   - *Verification (Static/Render)*: `make dbt-check` passes with synthetic DuckDB fixture proving staging isolation.
   - *Verification (Live Cluster)*: Live probe on Trino/Lakekeeper measures concurrent reader queries during rename and validates rollback hook on injected failure.
2. **Task 2: Artifact S3 Export in Airflow DAG (Gap 1)**
   - Update `dbt_shop_medallion.py` to upload `manifest.json`, `catalog.json`, and `run_results.json` to `s3://beluga-lake/dbt-artifacts/`.
   - *Verification (Static/Render)*: DAG lint and Python syntax tests pass (`scripts/ci/check-rendered-shell-syntax.py`).
   - *Verification (Live Cluster)*: DAG run uploads verified JSON artifacts to SeaweedFS S3.
3. **Task 3: Governed `dbt docs` Service and APISIX Route (Gap 1)**
   - Deploy static doc server in `analytics` and expose via APISIX route `dbt-docs.<baseDomain>` with Keycloak OIDC; verify resource footprint against cluster sizing.
   - *Verification (Static/Render)*: `helm lint gitops/charts/beluga-data`, `scripts/ci/check-gateway-sso.py`.
   - *Verification (Gateway/Auth Live)*: HTTPS 443 access to `https://dbt-docs.local.beluga.internal` enforces Keycloak login.
4. **Task 4: Static Column Lineage Ingestion of dbt Models (Gap 1)**
   - Extend `scripts/lineage/sql_lineage.py` to parse dbt compiled models and verify against `docs/generated/column-lineage.json`.
   - *Verification (Static/Render)*: `python3 scripts/ci/check-column-lineage.py --check` passes in `make validate`.

---

## 9. Sources

### 9.1 External Documentation and Licenses
- [S1] OpenMetadata, *dbt Connector Documentation*, https://docs.open-metadata.org/latest/connectors/ingestion/workflows/dbt (*to verify against pinned OM 1.13.3*). Apache-2.0.
- [S2] Trino Software Foundation, *Iceberg Connector Procedures & Branches*, https://trino.io/docs/483/connector/iceberg.html (*to verify branch fast_forward syntax in Trino 483*). Apache-2.0.
- [S3] dbt-trino, *dbt-trino Adapter Documentation*, https://github.com/starburstdata/dbt-trino (*to verify against pinned 1.11.0*). Apache-2.0.
- [S4] OpenLineage, *dbt Integration*, https://openlineage.io/docs/integrations/dbt (*to verify license and runtime dependencies*). Apache-2.0 (*to verify*).

### 9.2 Repository Sources
- OpenMetadata configuration & profile: `gitops/charts/beluga-data/templates/11-openmetadata.yaml:28`, `gitops/values/profile-full.yaml:2-3`, `gitops/charts/beluga-data/values.yaml:67-68`.
- Component pins & licenses: `VERSIONS.md:34,37-39,48-49`.
- dbt decisions & runtime DAG: `docs/adr/0007-dbt-core-transformation-layer.md:30-59,112-146`, `gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py:13-77`, `dbt/README.md:16-100`.
- OPA resource, schema, and procedure permissions: `policies/resources.yaml:9-17,45-63`, `gitops/charts/beluga-platform/files/opa/trino.rego:518-525,651-752`.
- S3 SeaweedFS endpoints: `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:78,137`.
- Metadata quality and lineage baseline: `docs/lineage-and-metadata-quality.md:46-71`.
