# Machine-Enforceable Data Contract Standard (Proposal)

English | [한국어](data-contract-standard-ko.md)

Refs issue #91 ("Adopt machine-enforceable Open Data Contract Standard across data products").

> **Status: PROPOSAL. Documentation only.** No manifest, DAG, script, policy, registry or `VERSIONS.md` value is changed by this
> document and no contract file is added. Repository statements carry a `file:line` read at commit `9f74c2b`. External
> facts cite `[S#]` (see [Sources](#sources), accessed 2026-10-07); where the pages read are silent the text says
> **not on the page read** or **no official recommendation**, and no field name is used that was not read. Items labelled
> **Proposed** are not implemented.

Related: [`medallion-architecture.md`](medallion-architecture.md) (section 5.1 schema evolution), [`data-standards.md`](data-standards.md),
[`pii-classification-enforcement.md`](pii-classification-enforcement.md), [`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md),
[`data-quality-framework.md`](data-quality-framework.md), [`data-lifecycle-policy.md`](data-lifecycle-policy.md).

## 1. Purpose and issue mapping

| Issue #91 acceptance criterion | Section |
|---|---|
| A representative Gold data product has a versioned machine-readable contract | 4.1, 4.6 |
| A breaking schema change is rejected before publication | 4.3, 4.4 |
| Quality/SLA expectations are validated against the contract | 4.4 |
| Contract metadata visible from the catalog and linked to lineage | 4.5 |
| API/event/data contracts related without duplicating incompatible definitions | 4.7 |
| Contract history and approvals are auditable | 4.8 |

Correction to the issue's reference: the link `github.com/datacontract/datacontract-specification` is the **Data Contract Specification**, whose README states it is deprecated with the release of ODCS v3.1.0 (support stated to continue through the end of 2026) [S1]. The Open Data Contract Standard is maintained at `github.com/bitol-io/open-data-contract-standard` [S2].

## 2. Current state (verified)

- **No data contract exists** in the repository: a search for `datacontract`, `odcs`, `data contract`, `asyncapi` finds no contract file; `docs/critical-interfaces-inventory.md:78` states that formal contract artifacts (OpenAPI, Avro/Protobuf registries, compatibility SLAs, deprecation schedules) are "Not established in this repository".
- **Closest artifact: the data-standards registry.** [`policies/data-standards.yaml`](../policies/data-standards.yaml) holds per-table `owner`, `classification`, `description`, `retention`, `freshness` and per-column `description`, `classification` (`:25-28`), checked statically by `scripts/ci/check-data-standards.py` in `make validate` (`Makefile:68`). It has no version, no consumer list, no quality rules, no usage terms and no compatibility check; its own header says it is a Git registry, not runtime state (`check-data-standards.py:29-31`).
- **Schema source of truth** is DDL in Git (`gitops/charts/beluga-data/files/flink-sql/*.sql`, `shop-schema.sql`); `lake.events_enriched` is the only Gold-like table (`medallion-architecture.md` section 4) with five columns, retention `P90D` and freshness `PT5M` (`policies/data-standards.yaml:98-112`).
- **Enforcement sources** that a contract must not contradict: access in `policies/resources.yaml` (compiled to Trino OPA and PostgreSQL grants), classification as in the PII document, quality gates as in the quality document. Today no pipeline gate exists (`medallion-architecture.md` section 4).
- CI tooling is Python with hash-pinned PyYAML only (`requirements-ci.txt`, installed with `--require-hashes` at `.github/workflows/ci.yml:57`). Any additional validator dependency needs the repository's dependency-pin and license review (`policies/license-policy.yaml:1-7`).

### What the standard documents (read from the published pages [S2-S8])

- Current version: repository states **v3.2.0**; the `apiVersion` field's default value is `v3.2.0`; `kind` must be `DataContract` [S2, S3]. Pages read describe sections: fundamentals, schema, context, references, data quality, support, pricing, team, roles, service-level agreement, infrastructure/servers, custom properties, authoritative definitions, tags, variables [S4]. License Apache-2.0 [S2].
- Fundamentals fields: `apiVersion`, `kind`, `id`, `name`, `version`, `status` (examples `proposed`, `draft`, `active`, `deprecated`, `retired`), `tenant`, `domain`, `description` (container for purpose, limitations, usage), `tags`, `customProperties`, `authoritativeDefinitions`; `dataProduct` is deprecated since v3.1.0 [S3].
- Schema object: `name`, `id`, `logicalType`, `physicalType`, `physicalName`, `description`, `businessName`, `deprecated`, `tags`, `authoritativeDefinitions`, `synonyms`, `customProperties`, `dataGranularityDescription`, `quality`. Schema property additionally: `classification`, `criticalDataElement`, `primaryKey`, `primaryKeyPosition`, `required`, `unique`, `partitioned`, `semanticType`, `transformSourceObjects`, `transformLogic`, `transformDescription`, `enum`, `examples`, and others [S5].
- Quality: rule `type` is `text`, `library`, `sql` or `custom`; dimensions `accuracy`, `completeness`, `conformity`, `consistency`, `coverage`, `timeliness`, `uniqueness`; comparison operators `mustBe`, `mustNotBe`, `mustBeGreaterThan`, ...; `severity`, `scheduler`/`schedule`, `engine` (examples `soda`, `greatExpectations`) [S6].
- SLA: `slaProperties` entries with `property`, `value`, `unit`, `element`, `driver`; property names `availability`, `throughput`, `errorRate`, `generalAvailability`, `endOfSupport`, `endOfLife`, `retention`, `frequency`, `latency`, `timeToDetect`, `timeToNotify`, `timeToRepair`; `latency` is "preferred to freshness" [S7].
- Team: `team` with `members` (`username`, `role` with examples owner and data steward, `dateIn`, `dateOut`, `replacedByUsername`) [S8]. The fields of the separate **roles** section were **not on the page read**.
- **Not found on the pages read:** compatibility or breaking-change rules, a lineage section, an effective-date field, a mapping to OpenAPI/AsyncAPI, and the `classification` value vocabulary. For each, **no official recommendation** is claimed; the proposal below defines Beluga rules and labels them as such. The JSON Schema in the repository is described as a companion that "may include bugs" and does not define the standard [S4].

## 3. Gaps vs the acceptance criteria

| ID | Gap |
|---|---|
| G1 | No contract format, file location or example |
| G2 | No compatibility classification or check; no baseline to compare against |
| G3 | No publication gate (and no Silver/Gold gating at all today) |
| G4 | Duplicated truth risk: classification, owner, retention, freshness already live in the registry; a contract could contradict it |
| G5 | Catalog/lineage links do not exist (OpenMetadata optional; no lineage recorded) |
| G6 | No approval trail beyond Git history; no status lifecycle |
| G7 | No relationship between data contracts and API/event definitions (none exist: `critical-interfaces-inventory.md:78`) |

## 4. Proposal (Proposed)

### 4.1 Adopt ODCS v3.2.0 as the preferred format

- Contract files: `contracts/<domain>.<product>.yaml` (Proposed path), `apiVersion: v3.2.0`, one file per **data product** (Gold first). Do not use `dataProduct` (deprecated) [S3].
- Version decision is owner-pinned (D1): pin `v3.2.0` and re-check upstream at each upgrade; the standard's compatibility behaviour between its own versions was **not read**.
- The registry stays the table-level governance baseline for all tables; the contract is the richer per-product interface. No tool, SDK or CLI is adopted by this proposal (none evaluated; license/SBOM review is required first).

### 4.2 Field mapping (single source per fact)

| Fact | Authoritative source | ODCS field (verified name) | Rule |
|---|---|---|---|
| Table schema (names, types, key, required) | DDL in Git | `schema[].name`, `physicalName`, schema properties (the nesting key name was not read), `primaryKey`, `required`, `unique` | CI: contract equals DDL |
| Classification | registry, enforced by `resources.yaml` | property `classification`, object `tags` | CI: equal to registry; value vocabulary is not defined by ODCS on the page read, so Beluga values `internal`, `pii` are used verbatim |
| Owner / steward | registry (`owner`, Proposed `steward`) | `team.members[]` with `role` | CI: equal |
| Retention | registry | `slaProperties` property `retention` | CI: equal to registry `retention`, using only the day-form rule below |
| Freshness target | registry `freshness` | `slaProperties` property `latency` | Equality check **not enabled** until D8 defines a duration conversion (`PT5M` to a `latency` value and unit is unverified: unit spelling for minutes not confirmed on the page read); until then the value is recorded and reviewed manually |
| Quality expectations | rule files ([`data-quality-framework.md`](data-quality-framework.md)) | `quality[]` (`type`, `dimension`, `severity`, `schedule`) | rule ids referenced, not copied |
| Lifecycle status, effective/expiry | contract | `status`; `slaProperties` `endOfSupport`, `endOfLife`; effective date: no field read, use `customProperties` (D3) | status transitions in 4.8 |
| Usage terms / restrictions | contract `description` (purpose, limitations, usage) | `description` | text only |
| Consumer access | `policies/resources.yaml` | none: contract may **list** intended consumer roles, but enforcement stays in policy | CI: listed roles must already hold a grant; a contract can never create one |
| Lineage | registry `derived_from` ([`lineage-and-metadata-quality.md`](lineage-and-metadata-quality.md)) | property `transformSourceObjects` (as hints), `authoritativeDefinitions` for links | CI: consistent with registry; no second lineage source |

Security design: a contract is **descriptive and restrictive only**. It cannot grant access, lower a classification, or relax masking; CI fails if it lists a consumer role without an existing grant or classifies a column lower than the registry.

Conversion rule (Proposed, D8): a registry duration of the form `P<n>D` equals `value: <n>`, `unit: d` (`d` is listed on the SLA page [S7]). Other forms (`P1Y`, `PT5M`, mixed) have **no defined conversion** (unit spellings other than days were not confirmed on the page read), so CI must reject equality checks on them until the owner defines one. The example in 4.6 (`P90D` to `90 d`) is illustrative and unverified against the validator.

### 4.3 Compatibility classes (Beluga rule; ODCS defines none on the pages read)

| Change to a published contract | Class | Rule (aligned with medallion 5.1) |
|---|---|---|
| New nullable property | additive | allowed by reviewed change; minor version |
| Property marked `deprecated` | deprecated | allowed; consumers notified; removal not before the deprecation period (length is an owner decision, D4) |
| Removal, rename, type change, nullable to `required`, tightened `unique`/key | breaking | rejected unless a new major version/table name is published beside the old one |
| Removal after deprecation period | removed | allowed only as part of a new major version |
| Classification lowered, retention shortened or SLA weakened | policy-breaking | rejected without a recorded owner approval (never automatic) |

### 4.4 Validation points

- **CI (`make validate`), Proposed:** schema validity of the contract file (using the ODCS JSON Schema only after the licence/pin review and treating it as a companion, per [S4]; otherwise a minimal in-repo structural check), contract vs DDL, contract vs registry/`resources.yaml` (4.2), and compatibility against the previous released version (4.3). A deliberate breaking change in a fixture must fail.
- **Publication gate (runtime), Proposed:** the pipeline task that publishes a Gold table compares the live Iceberg schema (Trino `information_schema`) with the contract and runs the contract's quality rules ([`data-quality-framework.md`](data-quality-framework.md) section 4.3); mismatch or a failed critical rule blocks publication. This requires Silver/Gold gating from the medallion work; before that only the CI check is possible.
- **SLA check:** freshness and retention targets are compared with the measured values from the lineage document (section 4.4 there) and the lifecycle policy.

### 4.5 Catalog and lineage links

When OpenMetadata is enabled, the reconcile job (see the other proposals) attaches the contract (`id`, `version`, `status`, link to the file) to the table. Contract-to-lineage linkage uses the registry edges; the contract does not hold lineage of its own. Whether OpenMetadata has a native contract entity in 1.13.3 was **not checked** for this document.

### 4.6 Representative Gold product

Proposed first contract: `lake.events_enriched` (five columns; classification `internal`; retention `P90D`; freshness `PT5M`; values from `policies/data-standards.yaml:98-112`). Illustrative skeleton, using the field names verified above except the two keys marked in comments; `id` is generated once, and the value vocabularies for types are to be confirmed before the file is added:

```yaml
apiVersion: v3.2.0
kind: DataContract
id: <generated-uuid>
name: events-enriched
version: 1.0.0
status: draft
description:
  purpose: <owner text>   # key name to be confirmed: page describes purpose/limitations/usage only
team:
  members:
    - username: <owner>
      role: owner
schema:
  - name: events_enriched
    physicalName: lake.events_enriched
    properties:   # nesting key name to be confirmed against the schema page
      - name: user_id
        classification: internal
      # window_start, window_end, event_count, total_duration_ms follow the DDL
slaProperties:
  - property: retention
    value: 90
    unit: d
```

The medallion proposal would rename this table (`gold_web.user_activity_1m`); the contract's `physicalName` must then change as a **new major version**, which is a useful first compatibility test.

### 4.7 Relating API, event and data contracts

Where an OpenAPI (#78) or AsyncAPI definition exists, the data contract references it through `authoritativeDefinitions` and does not copy its schema; a mapping between OpenAPI/AsyncAPI and ODCS fields is **not documented on the pages read** (no official recommendation), so any field-level equivalence is a Beluga rule checked in CI against one named source of truth. No OpenAPI/AsyncAPI definition exists today. Kafka transport schemas are outside the registry scope (`docs/data-standards.md`); whether they get contracts is an owner decision (D5).

### 4.8 History and approvals

Git history plus pull-request review is the audit trail; `status` follows `draft -> active -> deprecated -> retired` (names from [S3] examples) with each transition in a reviewed commit that names the approver. A contract with `status: active` cannot change without a version bump (CI). Generated artifacts (documentation page, compatibility report) are CI outputs, not hand-edited.

## 5. Verification and test ideas

| Test | Type | Pass condition |
|---|---|---|
| Contract equals DDL for `events_enriched` | static | fails when a column is added to DDL only |
| Breaking change fixture (drop/rename/type change) | static negative | rejected |
| Additive change fixture | static | passes with a minor version bump |
| Classification in contract lower than registry | static negative | rejected |
| Consumer role listed without a grant in `resources.yaml` | static negative | rejected |
| `active` contract edited without version bump | static negative | rejected |
| Live schema mismatch before Gold publish | live | publication blocked |
| Retention (day form `P<n>D`) equal to registry | static | passes; mismatch fails (freshness equality is deferred, see D8) |

## Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Pin ODCS `v3.2.0` | Yes, re-verify on upgrade |
| D2 | Contract files generated from the registry or hand-written with CI equality | Hand-written for Gold, CI equality for shared fields |
| D3 | Where to record effective dates (no field read) | `customProperties`, with `endOfSupport`/`endOfLife` for expiry |
| D4 | Deprecation period before removal | No official recommendation; owner picks |
| D5 | Contracts for Kafka transport schemas | Defer until the registry scope is extended |
| D6 | Adopt an external ODCS tool/CLI | Not now; evaluate with license/SBOM review after the CI checks exist |
| D7 | Representative product | `lake.events_enriched` |
| D8 | Duration-to-SLA unit conversion beyond `P<n>D`, including the freshness `PT5M` to `latency` mapping | Day form only for now; owner defines the rest |

## Follow-up implementation tasks (ordered)

1. Add `contracts/` with the `events_enriched` contract and a minimal structural validator in `scripts/ci`. Test: malformed fixture fails.
2. Contract vs DDL and contract vs registry/`resources.yaml` checks. Test: negative fixtures above fail.
3. Compatibility checker against the previous tagged version. Test: breaking/additive fixtures.
4. Generate a documentation page and compatibility report as CI artifacts. Test: artifacts present, no manual edits.
5. Wire the publication-gate comparison into the Gold publish task (after medallion Silver/Gold exist). Test: schema mismatch blocks.
6. OpenMetadata link of contract metadata (when enabled). Test: contract id/version visible on the table.
7. Status lifecycle and approval check in CI. Test: `active` edit without version bump fails.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | Data Contract Specification README (deprecation notice): https://github.com/datacontract/datacontract-specification |
| S2 | Open Data Contract Standard repository: https://github.com/bitol-io/open-data-contract-standard |
| S3 | ODCS, Fundamentals: https://bitol-io.github.io/open-data-contract-standard/latest/fundamentals/ |
| S4 | ODCS, documentation index: https://bitol-io.github.io/open-data-contract-standard/latest/ |
| S5 | ODCS, Schema: https://bitol-io.github.io/open-data-contract-standard/latest/schema/ |
| S6 | ODCS, Data Quality: https://bitol-io.github.io/open-data-contract-standard/latest/data-quality/ |
| S7 | ODCS, Service-Level Agreement: https://bitol-io.github.io/open-data-contract-standard/latest/service-level-agreement/ |
| S8 | ODCS, Team: https://bitol-io.github.io/open-data-contract-standard/latest/team/ |
