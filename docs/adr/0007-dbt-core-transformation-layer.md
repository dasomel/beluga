# ADR-0007: dbt Core as the governed SQL transformation layer

English | [한국어](0007-dbt-core-transformation-layer-ko.md)

- Status: Accepted
- Date: 2026-11-10
- Supersedes: —
- Superseded by: —

Decision IDs: D-DBT-1 (namespaces), D-DBT-2 (service identity), D-DBT-3
(authorization), D-DBT-4 (phases), D-DBT-5 (supply chain), D-DBT-6 (build gate),
D-DBT-7 (initial materialization and metrics), D-DBT-8 (Linux hash locks).
Owner decisions D-DBT-1–6: dasomel, 2026-11-10, issue #95.
Related branch: `feat/95-dbt-core-phase-a`.

## Context

[Transformation framework](../transformation-and-semantic-layer.md) section 4,
OD-TR-1 and Task 4 propose governed batch Silver/Gold models. Airflow orchestrates,
Trino executes SQL against Iceberg, and dbt Core owns SQL dependencies, tests and docs.
DuckDB exercises synthetic CI fixtures only: this does not authorize production writes
or broaden [ADR-0004](0004-duckdb-complementary-analytics-engine.md)'s read-only
Phase 1 data-plane boundary. Local fixture tables are disposable test outputs.

## Decision

### D-DBT-1: New output namespaces; legacy source unchanged

dbt writes only to `silver_shop` and `gold_shop` in the `iceberg` catalog. The existing
`lake.orders` is the Bronze input for this adoption; `lake` remains untouched.
Names follow `<layer>_<domain>` from [the #70 proposal](../medallion-architecture.md).
Issue #70 remains pending; this does not migrate its legacy tables or implement its
immutable raw Bronze design. CI substitutes synthetic seeds in a local `fixtures`
schema. `generate_schema_name` uses custom schemas verbatim, without target prefixes.
Cost: explicit namespace ownership. Escape hatch: a separately reviewed namespace
migration, never implicit writes into `lake`.

### D-DBT-2: Keycloak service identity (Phase B)

Use a Keycloak client-credentials OAuth2/JWT service identity to authenticate to Trino.
Phase A checks in an environment-driven JWT profile without credentials. It does not
create a client, obtain tokens, or change Trino authentication. Cost: token delivery,
renewal and TLS trust require integration work. Escape hatch: revise this decision
before adopting another authentication mechanism; no shared human/admin credential.

### D-DBT-3: Dedicated least-privilege group (Phase B)

Use a dedicated group, for example `transformers`, with CREATE/INSERT/DROP restricted
to `silver_shop`/`gold_shop` and source SELECT restricted to `lake.orders`.
Do not grant access to PII `lake.customers` or model it. This requires a
policy-compiler schema-level grant extension; no current policy is widened here.
Cost: extend the compiler and prove the exact adapter operation/read permissions in
Phase B, including access to its own output models. Escape hatch: adjust the reviewed
contract if actual table materialization needs additional operations, without blanket
schema/catalog or PII grants.

### D-DBT-4: Two delivery phases

- **Phase A (this change):** dbt project, pinned runtime image recipe and publication
  workflow, DuckDB CI build and negative gate, and offline Trino profile parsing.
  No chart, Airflow DAG, OPA, Keycloak, policy declaration or live cluster change.
- **Phase B (follow-up):** service identity/token delivery and TLS trust, schema-level
  OPA/compiler authorization, Airflow `KubernetesPodOperator` running dbt in namespace
  `analytics`, live colima verification, OpenMetadata/lineage and run metadata.

Cost: Phase A cannot prove Trino/Iceberg behavior or live authorization. Escape hatch:
hold deployment until Phase B evidence exists. No deployed image row is added to
`VERSIONS.md` now: the deployment pin row and its license-change review arrive with
Phase B chart adoption, using the published, attested index digest. Runtime pins live
in `images/dbt/requirements.txt` and the Dockerfile until then; CI pins live in
`requirements-dbt-ci.txt`. Both pre-generated hash locks are preserved.

### D-DBT-5: Core 1.12.x; exclude the dbt v2 distribution

Pin Apache-2.0 dbt Core **1.12.6** (1.12.x) and `dbt-trino` **1.11.0**. DuckDB CI
uses `dbt-duckdb` **1.11.1** with the same Core pin. Python 3.12 base is pinned to
the supplied amd64/arm64 index digest; pip requires hashes. The image runs as UID
10001, disables anonymous usage statistics, and carries OCI source/license labels.
Image publication copies the Flink native runner, digest merge, provenance and SBOM
verification pattern; PR builds do not push, and only main publishes.

dbt v2 is excluded (license research 2026-11-10, sources below):

- **`dbt` 2.x (formerly the Fusion engine, the default v2 install)** is proprietary to
  dbt Labs under the dbt Product Licensing Agreement, not an OSI license, and contains
  components whose source is not public. Its terms forbid blocking user access to dbt
  servers and removing login paths/notices, which conflicts with Beluga's egress
  baseline. Its sdist is a download-at-install shim fetching prebuilt binaries from
  `public.cdn.getdbt.com`, so `pip --require-hashes` cannot verify the installed binary.
- **`dbt-oss` 2.x (formerly dbt Core v2)** is Apache-2.0, but v2's ADBC adapter list
  (Snowflake, Databricks, Redshift, BigQuery, DuckDB; Spark/ClickHouse beta) has no
  Trino, Beluga's execution engine. It also downloads prebuilt binaries from GitHub
  releases at install time and fetches drivers on demand.
- **dbt Core 1.x** stays Apache-2.0 and supported. 1.13 is the last minor with new
  features; security/installation patches continue for an expected 3-5 years with no
  fixed end-of-life date. Future features land in v2 only.

This excludes those distributions, not dependencies whose version number starts with 2.
Cost: no v2-only features; maintain Core/adapter locks. Escape hatch: move to `dbt-oss`
once it supports Trino at GA and its binary and drivers can be hash-pinned and vendored
offline; until then upgrade to Core 1.13 when it ships. The proprietary `dbt` 2.x is out
of scope for Beluga regardless.

Sources: docs.getdbt.com/docs/dbt-licensing, docs.getdbt.com/blog/comparing-dbt-and-dbt-oss,
getdbt.com/licenses-faq, docs.getdbt.com/docs/local/connect-data-platform/about-dbt-connections
(v2), and the PyPI metadata of `dbt` 2.0.11, `dbt-oss` 2.0.11, `dbt-core` 1.12.6 and
`dbt-trino` 1.11.0 (`dbt-core<2.0`).

### D-DBT-6: `dbt build` gates downstream models

Use `dbt build`, which runs tests after each model and skips downstream Gold models
when an upstream error-severity test fails. Critical tests use `severity: error`;
future advisory tests may use `warn`. `dbt run` followed by `dbt test` is insufficient:
it can execute Gold before checking Silver. CI requires a successful valid-fixture
build, then injects an invalid status, requires exit 1, and reads `run_results.json`
to prove the Silver test failed and `daily_revenue` was skipped. It also checks exact
expected Gold values, offline Trino source/schema resolution and disabled live seeds.

Cost/limit: models are materialized before their own tests. This gate blocks downstream
execution; it is not a transaction or atomic candidate publication/rollback mechanism.
A failing Gold test does not undo its table, and an existing Gold table is not deleted
when skipped. OD-TR-6 candidate isolation/atomic promotion remains unresolved.
Escape hatch: design and prove that publication mechanism separately before claiming
reader isolation. Do not bypass the gate with `dbt run` in the future DAG.

### D-DBT-7: Full tables and explicit latest-state metrics

Initially materialize both models as tables for portable DuckDB/Trino execution and
deterministic full rebuilds, avoiding an unproven cross-adapter incremental merge.
Silver casts the source types, trims/lowercases status, and keeps the latest row per
`order_id` by `updated_at`. Equal timestamps use descending customer ID, amount and
normalized status with nulls last as deterministic tie breakers; identical rows are
equivalent. Cost: full scans and no business ordering for conflicting timestamp ties.
Escape hatch: adopt an authoritative source sequence and incremental MERGE after
Phase B proves retries, backfills, Iceberg writes and required privileges.

Gold groups latest states by the date of `updated_at`, because the source has no
purchase timestamp. `order_count` counts all states; `completed_order_count` counts
only `completed`; `completed_revenue` sums only their amounts (zero otherwise).
These are latest-update-date metrics, not historical booked sales. An order can move
between dates/statuses on rebuild. Cost: no event-time revenue history. Escape hatch:
introduce a governed purchase/event-time source contract before redefining the metric.

### D-DBT-8: Linux-targeted hash locks; dependency gate unchanged

Both locks (`images/dbt/requirements.txt`, `requirements-dbt-ci.txt`) are compiled with
`uv pip compile --generate-hashes --python-version 3.12 --python-platform
x86_64-manylinux_2_28`, so they contain no environment markers and pass the existing
`scripts/ci/check-dependency-integrity.py` grammar unchanged. The aarch64 resolution was
checked to be identical, and every pinned version carries the hashes of all its
published files, so arm64 image builds verify too. The CI lock also carries `dbt-trino`
so the offline Trino profile parse runs in CI. Cost: re-check aarch64 parity when
regenerating. Escape hatch: if a future dependency diverges per platform, keep one lock
per platform rather than widening the gate.

## Alternatives considered

- Direct Airflow SQL scripts: less reusable model/testing/documentation structure.
- Incremental MERGE immediately: retry and adapter/Iceberg semantics lack live evidence.
- DuckDB production transformation: outside ADR-0004 Phase 1 and this offline scope.
- dbt v2 (`dbt` proprietary, `dbt-oss` without Trino): rejected by D-DBT-5.

## Consequences and follow-ups

OD-TR-1 is decided: adopt dbt Core with Trino execution and Airflow orchestration.
Phase A demonstrates local fixture behavior only. Phase B must prove identity, least
privilege (including denied PII/other-schema writes), repeat runs and failure gating
on colima before deployment, then integrate metadata and lineage. Docker image build,
multi-architecture publication/attestations and live operation require online runners.
