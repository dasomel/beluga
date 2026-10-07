# PII / Data Classification Enforcement (Proposal)

English | [한국어](pii-classification-enforcement-ko.md)

Refs issue #8 ("Make PII/data classification enforceable across catalog and query layers").

> **Status: PROPOSAL. Documentation only.** No manifest, script, policy, `VERSIONS.md` or registry value is changed
> by this document. Repository statements carry a `file:line` read at commit `9f74c2b`. "Live" statements were read
> with read-only `kubectl` on 2026-10-07; anything else about a running system is marked **not verified live**.
> External facts cite `[S#]` (see [Sources](#sources), accessed 2026-10-07); where an upstream page is silent the text
> says **no official recommendation**. Items labelled **Proposed** are not implemented.

Related: [`medallion-architecture.md`](medallion-architecture.md) section 5.3 (classification propagation),
[`data-lifecycle-policy.md`](data-lifecycle-policy.md) (retention hook; section 2.6 catalog metadata), [`data-standards.md`](data-standards.md), [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md),
[`data-contract-standard.md`](data-contract-standard.md).

## 1. Purpose and issue mapping

Issue #8 asks for a declarative classification model that drives enforcement consistently across query, catalog and
storage layers. This document records, from code read, **which layers enforce `pii` today and which do not**, and
proposes the smallest additions that close the acceptance-criteria gaps without widening any access.

| Issue #8 acceptance criterion | Section |
|---|---|
| PII classification is represented declaratively | 2.1, 3 (G1, G2) |
| Analyst access to sensitive data cannot be reintroduced by a new table without an explicit policy | 2.2, 3 (G3), 4.2 |
| Masked access is demonstrated for at least one sensitive column | 2.3, 3 (G4), 4.3 |
| Classification and ownership visible in the catalog when OpenMetadata is enabled | 2.6, 3 (G6), 4.5 |
| Regression tests cover source and derived datasets | 2.7, 5 |

The issue's evidence line (`REVOKE SELECT ON TABLE customers FROM beluga_analyst`) is **out of date**: the generated body of
[`db-roles.sql`](../gitops/charts/beluga-data/files/db-roles.sql) (lines 8-42) now contains only explicit `GRANT`s (no `REVOKE`);
`beluga_analyst` appears only in a legacy cleanup block (lines 70-100).

## 2. Current state (verified)

### 2.1 Where classification is declared

| Source | What it says | Evidence |
|---|---|---|
| `policies/data-standards.yaml` | Allowed values `[internal, pii]`; every table and column must carry `classification`. `customers` (PG and Iceberg): table `pii`; columns `name`, `email`, `city` = `pii`, `customer_id`, `created_at` = `internal` | `policies/data-standards.yaml:26-28`, `:34-48`, `:66-80` |
| `policies/resources.yaml` | Per-resource `classification`; `lake.customers` and `public.customers` are `pii` with `sensitiveColumns: [email]` and a single grant to `engineers` with `allowUnmasked: true` | `policies/resources.yaml:16-22`, `:33-40` |
| Policy compiler schema (sibling repo `beluga-manager`, commit `f9c4e38`) | Accepts `public \| internal \| pii`; a `pii` resource must declare `sensitiveColumns` (`PII_NO_SENSITIVE_COLUMNS`) and any `select` grant without masking needs `allowUnmasked: true` (`PII_UNMASKED`) | `packages/policy-compiler/src/schema.ts:18`, `validate.ts:233`, `validate.ts:285-296` |

Findings:

- **F1 (drift risk).** The two declarations disagree on which columns are PII: the registry marks `name`, `email`, `city`; the
  enforcement policy lists only `email`. The compiler requires masking only for `sensitiveColumns`, so a future masked grant
  written against today's `resources.yaml` would leave `name` and `city` unmasked.
- **F2.** Allowed values differ: the registry validator accepts `internal`/`pii` only (`policies/data-standards.yaml:28`), the compiler
  also accepts `public`. Nothing cross-checks the two files: `scripts/ci/check-data-standards.py` has no reference to
  `resources.yaml` (grep on the file, no match).
- **F3.** The registry covers five tables from an explicit list of DDL files (`policies/data-standards.yaml:8-16`). A new DDL file that is
  not added to `schema_sources` is not seen by the checker (`docs/data-standards.md` states the scope is the five representative tables).

### 2.2 Query layer: Trino + OPA (table-level, default deny)

- `default allow := false` ([`trino.rego:6`](../gitops/charts/beluga-platform/files/opa/trino.rego#L6)). `SelectFromColumns` on
  `iceberg.lake.customers` is allowed only for groups `admins`/`engineers` (`trino.rego:31-39`). `lake.orders` and
  `lake.events_enriched` also allow `analysts` (`:51-59`, `:101-109`). A table with no rule gets no data-access allow for anybody (rule text read; a
  live test for a brand-new Iceberg table was **not found** in `tests/`).
- Catalog browsing is catalog-wide, not per table: `FilterTables`, `FilterColumns`, `ShowColumns`, `ShowCreateTable` are allowed for `analysts` on
  every table of catalog `iceberg` (`trino.rego:174-196`, `:206-220`). Analysts can therefore see table and column **names** (not values), including
  `email` of `lake.customers`. Whether that is acceptable is an owner decision (D5).
- Live regression: `tests/07-trino-authz-live.sh:112-119` asserts that an analyst `SELECT` on `iceberg.lake.customers` is denied.

### 2.3 Query layer: masking is wired but empty

- Trino is configured with `opa.policy.column-masking-uri` and `opa.policy.row-filters-uri`
  ([`06-trino.yaml:165-166`](../gitops/charts/beluga-data/templates/06-trino.yaml#L165)). Trino documents that without these URIs no masking or
  filtering applies; behaviour for an undefined OPA rule is **not documented on that page** [S1].
- `trino.rego` contains **no** `columnMask` or `rowFilters` rule (file read; live: the deployed `opa-policies` ConfigMap `trino.rego` contains neither string, checked 2026-10-07). The spec
  already records this ([`2026-08-09-beluga-data-platform-design.md:395`](superpowers/specs/2026-08-09-beluga-data-platform-design.md)).
- The compiler can emit masks (`hash`, `partial`, `null`) from `columnMask:` in a grant (`beluga-manager/packages/policy-compiler/src/compiler/rego.ts:6-10`, `:171-186`),
  but no grant in `policies/resources.yaml` declares one. **Conclusion: no column is masked anywhere today; PII protection is "deny the table".**

### 2.4 Storage/catalog layer: Lakekeeper + OpenFGA

- Lakekeeper runs with `LAKEKEEPER__AUTHZ_BACKEND=openfga` (live, `lakehouse/lakekeeper`; chart `04-lakekeeper.yaml:49-52`).
- The only seeded assignments are warehouse-level `describe/select/create/modify` for two **service accounts** (`service-account-trino`, `service-account-flink`)
  ([`12-lakekeeper-bootstrap.yaml:158-170`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L158)). No human principal and no classification input exists.
- Lakekeeper documents authorization on server, project, warehouse, namespace, table, view and role objects with top-down inheritance, and does not mention column- or row-level control [S2].
  So Lakekeeper can isolate **tables or namespaces**, never columns.
- Consequence: Trino's own identity can read every Iceberg table; the human-facing control is Trino OPA alone. Any future engine that reads Iceberg or object storage directly (for example the DuckDB path, issues #61-#65) would bypass Trino OPA, and therefore any column mask.

### 2.5 Source database and stream

- PostgreSQL: table-level `GRANT` only; `public.customers` is granted to `engineers` only (`db-roles.sql:35-41`); no column privileges or masking. `tests/06-authz-defaults.sh:26-35` asserts a new table is not selectable by `analysts` (default deny, PostgreSQL only).
- Kafka: the Debezium topic `cdc.shop.public.customers` carries the PII columns unmasked (`flink-sql/cdc_customers.sql:26-34`, source table definition). **Live 2026-10-07:** the Kafka listener is `plain` 9092 and `spec.kafka.authorization` is empty; the chart options `strimzi.opaAuthorizer` and `strimzi.aclAuthorizer` default to `false`
  (`values.yaml:37`, `:48`; `03-strimzi-kafka.yaml:44-54`). `kafka.rego` is `default allow = true` with analyst-only deny rules (`kafka.rego:15`, `:26-29`). Classification therefore does not reach the stream layer.

### 2.6 Catalog/governance layer: OpenMetadata

- Optional and gated: `openmetadata.enabled: false` by default ([`values.yaml:58-59`](../gitops/charts/beluga-data/values.yaml#L58)); the template deploys server, OpenSearch and an OIDC login
  with `DefaultAuthorizer` and admin principal `admin` (`11-openmetadata.yaml:1`, `:179-205`). **Live:** the `governance` namespace runs `openmetadata` and `opensearch` (1.13.3).
- No repository artifact pushes classification, owner or tags to OpenMetadata (grep: only chart template, docs and version pins mention it; no script or job). `docs/data-standards.md` lists OpenMetadata integration as out of scope. What the live catalog contains was **not verified live** (no API token used).
- Upstream: OpenMetadata documents auto-classification (`PII.Sensitive`, `PII.NonSensitive`) via a column-name scanner and, optionally, entity recognition over **sample data** [S3]. Its Trino connector page lists `Owners` and `Tags` as unsupported features [S4], so owners/tags are not read from Trino and must come from another path.

### 2.7 Existing tests

Static: `tests/14-policy-compiler-seam.sh` (Rego and `db-roles.sql` regenerate with zero diff; tamper self-test), `make validate` (data-standards check).
Live: `tests/06`, `tests/07` (above). **Not covered:** a new Iceberg table, a masked grant, a derived table, OpenMetadata labels.

## 3. Gaps vs the acceptance criteria

| ID | Gap | Criterion |
|---|---|---|
| G1 | Two classification sources (registry and `resources.yaml`) with different PII column sets and value sets, no cross-check (F1, F2) | declarative |
| G2 | Table-level `classification` does not drive grants; grants are hand-written per resource | declarative |
| G3 | No static or live test that a new Iceberg table (or a new DDL file outside `schema_sources`) is denied to analysts until classified and granted (F3) | new table |
| G4 | No masked grant, no `columnMask` rule, no test (2.3) | masked access |
| G5 | Kafka stream and direct-storage readers are outside OPA column control (2.4, 2.5) | consistency |
| G6 | Classification/owner/steward not synchronised to OpenMetadata; no steward field in the registry (only `owner: data-platform`) | catalog visibility |
| G7 | No propagation rule enforced for derived tables (the medallion rule in section 5.3 is prose only) | derived datasets |

## 4. Proposal (Proposed)

Design constraints: **never widen access**; deny by default; a classification can only add restrictions; masking never grants a table the role could not read; PII reaches a role only through an explicit, reviewed grant.

### 4.1 Taxonomy and metadata

Keep `internal | pii` as the supported values (they are what the registry enforces). `public` and a non-PII `confidential` value are **owner decisions** (D1): adding one needs a change in the registry validator and the compiler schema together, never in one. Add `steward` beside `owner` as a required table field (D2); the issue asks for owner/steward and the registry has only `owner`.

### 4.2 One source of truth, cross-checked in CI

- Keep `policies/resources.yaml` as the **enforcement** source and `policies/data-standards.yaml` as the **metadata** source (no third file).
- Proposed static check (extension of the existing checker, no new tool): for every registry table whose `classification` is `pii`, `resources.yaml` must contain the resource with `classification: pii` and `sensitiveColumns` equal to the set of registry columns marked `pii`; every `resources.yaml` resource must have a registry entry; mismatch fails `make validate`. This turns F1 into a failing test.
- Proposed completeness check: every `CREATE TABLE` DDL under `flink-sql/` and the shop schema must be reachable from `schema_sources` (closes F3), so an unregistered table fails CI instead of being invisible.
- Default deny for new datasets: keep `default allow := false`; add no wildcard grant. A new table is unreadable until it has a registry entry (CI) and a resource entry (compiler output). Reviewers must reject a PR that adds a resource grant without a registry classification.

### 4.3 Masked access for analysts (one demonstrator, opt-in)

- Not a default. Today analysts have **no** access to `lake.customers`; masked access is an additional grant, only if the owner approves (D3). If approved, add to `lake.customers` a grant for `analysts` with `privileges: [select]` and `columnMask` for **every** registry-`pii` column (`name`, `email`, `city`), using the compiler's existing mask kinds. Because the compiler only requires masking of `sensitiveColumns`, `sensitiveColumns` must first be extended to `[name, email, city]` (G1).
- Mask kind per column is an owner decision (D4). Judgement, not an upstream recommendation (**no official recommendation** found): `hash` keeps joinability but is a deterministic hash of low-entropy values and can be reversed by dictionary guessing; `null` is the safest default; `partial` (`substr(col,1,2)||'***'`) still reveals a prefix.
- `engineers` keep `allowUnmasked: true` and the compiler already exempts them from the analyst mask (`rego.ts:104-138`).
- The Trino-only limit (2.4) means a masked grant is **Trino-only**: a table with a masked analyst grant must not be exposed to a human through any engine that cannot apply the mask.

### 4.4 Catalog and storage rules

- No human principal is added to Lakekeeper OpenFGA for `pii` tables. If namespace/table assignments are introduced (medallion Q2), they are compiled from the same `resources.yaml` and grant a table only to roles that already hold the Trino grant.
- Direct-storage readers (DuckDB and similar): may read only tables whose classification is `internal`; `pii` tables are reachable through Trino only (D6).
- Browsing: decide whether `FilterColumns`/`ShowColumns` should be restricted to granted tables for `pii` tables (D5). Restricting needs per-table catalog rules in the compiler and is a larger change than 4.2-4.3.
- Kafka: out of scope here; tracked by the Kafka authorization work. State plainly in the matrix that classification is **not enforced** at the stream layer until an authorizer is enabled.

### 4.5 OpenMetadata visibility

- Source of the labels is the registry (Git), applied to OpenMetadata by a small reconcile job (Proposed, runs only when `openmetadata.enabled`): table tags/classification, column tags and owner/steward. Direction is Git to OpenMetadata only; OpenMetadata edits never relax a classification (no write-back).
- Tag mapping `pii` to OpenMetadata `PII.Sensitive` is an owner decision (D7); `internal` has no built-in OpenMetadata equivalent named on the pages read.
- If auto-classification is used, **disable sample-data ingestion for `pii` tables**: entity recognition processes sample values [S3], which would copy PII into the catalog. Whether sample data is shown to catalog viewers, and how `DefaultAuthorizer` roles restrict it, was **not verified live**.
- Propagation to derived datasets uses the lineage design in [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md): a derived table is at least as sensitive as its most sensitive input column unless a documented transformation justifies lowering it (medallion 5.3), enforced as a registry check on declared `derived_from` (see that document).

### 4.6 Retention hook

Each `pii` table's `retention` in the registry is the hook already defined by [`data-lifecycle-policy.md`](data-lifecycle-policy.md); a purge/erasure request (#30) for a `pii` table must include its derived tables, found through the same `derived_from` declarations. No period is set here.

## 5. Verification and test ideas

| Test | Type | Pass condition |
|---|---|---|
| Registry vs `resources.yaml` PII-column equality | static, `make validate` | fails on today's mismatch until `sensitiveColumns` is fixed; passes after |
| Self-test: remove a PII column from `sensitiveColumns` | static negative | checker fails |
| New DDL file not in `schema_sources` | static negative | checker fails |
| New Iceberg table without registry/resource entry | live, extends test 07 | analyst and engineer `SELECT` denied |
| Analyst masked select (only if D3 approved) | live | `email`, `name`, `city` are masked; engineers see raw values; analyst cannot select an unmasked variant (`SELECT` of derived expressions still masked) |
| Derived table from `lake.customers` | static | registry `derived_from` input is `pii` and the derived table is not marked lower |
| Compiled Rego contains `columnMask` for every `pii` column granted to a non-`allowUnmasked` role | static | zero diff against compiler output (existing test 14) |

## Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Add `public` or a non-PII `confidential` value | Not now; keep `internal\|pii` |
| D2 | Add required `steward` field | Yes |
| D3 | Give analysts masked access to `lake.customers` | No until a consumer needs it; keep deny |
| D4 | Mask kind per column | `null` default; `hash` only where a join key is required, or for the machine-only quality-runner role if quality document D2 is approved (see that document, section 4.8) |
| D5 | Restrict column/table browsing for `pii` tables | Defer; low risk (names only) |
| D6 | Direct-storage readers limited to `internal` tables | Yes |
| D7 | OpenMetadata tag mapping for `pii` and whether to run auto-classification | Map `pii` to `PII.Sensitive`; run auto-classification only without sample data on `pii` tables |

## Follow-up implementation tasks (ordered)

1. Extend `sensitiveColumns` of both `customers` resources to `[name, email, city]` (and compile). Test: the cross-check in task 2 passes; test 14 zero diff.
2. Add the registry-vs-`resources.yaml` cross-check and the `schema_sources` completeness check to `scripts/ci/check-data-standards.py` with fixtures. Test: negative fixtures fail.
3. Add the new-Iceberg-table denial case to the live suite. Test: `SELECT` denied for analyst and engineer.
4. (If D3 approved) Add the masked analyst grant and the live masked-select test. Test: masked values for analyst, raw for engineer.
5. Add `steward` to the registry and validator. Test: missing steward fails.
6. OpenMetadata reconcile job for tags/owner/steward (only when enabled). Test: labels appear on `customers`; removing a tag in OpenMetadata is restored on the next run.
7. Derived-table check using `derived_from` (see lineage document). Test: derived table of a `pii` input marked `internal` fails.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | Trino 483, OPA access control (column masking and row filters): https://trino.io/docs/483/security/opa-access-control.html |
| S2 | Lakekeeper v0.13.1, Authorization with OpenFGA: https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/authorization-openfga.md |
| S3 | OpenMetadata, Auto Classification: https://docs.open-metadata.org/latest/how-to-guides/data-governance/classification/auto-classification |
| S4 | OpenMetadata, Trino connector: https://docs.open-metadata.org/latest/connectors/database/trino |
