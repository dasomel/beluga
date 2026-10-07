# Implementation Status

Last verified for issues #17/#23/#35/#36: 2026-10-05 against default branch commit `2081fef`, including merged PRs [#120](https://github.com/dasomel/beluga-manager/pull/120), [#121](https://github.com/dasomel/beluga-manager/pull/121), [#124](https://github.com/dasomel/beluga-manager/pull/124) and [#125](https://github.com/dasomel/beluga-manager/pull/125).

This file records behavior implemented on the default branch and separates it from design direction.

## Implemented

- Repository and documentation foundation for a future unified Beluga data-platform control plane/UI.
- English/Korean product, architecture, development, contribution and security documentation.
- ADR-0001/0002/0003 Accepted: React 19 + Vite 8 + Tailwind 4 frontend, TypeScript/Node + Hono backend
  direction, shadcn/ui + Radix design system with a WCAG 2.2 AA target.
- A frontend shell (`src/web/`) with six shipped views — Overview, Services, Pipelines, Data Catalog,
  Query Workspace, Policy. The Policy view consumes the read-only Domain API projection below; the
  remaining views are still driven by `mockData.ts`.
- The policy compiler (`src/compiler/`, `src/schema.ts`), generating Keycloak realm configuration,
  Trino OPA Rego and PostgreSQL DDL/roles from Zod-validated input.
- A System-1 decision provider scaffold (`src/decision/`) for issue #69: a provider-neutral,
  Zod-validated interface and a deterministic rule-based provider with fail-closed behavior on
  missing/stale telemetry. No local-model or external-provider integration yet.
- Read-only decision projection API (`GET /api/v1/decisions` and `GET /api/v1/decisions/{id}`) plus an Operations view section. Three fixed telemetry fixtures are evaluated through the isolated rule provider at startup and exposed with deterministic metadata, evidence timestamps, related navigation IDs, and localized abstain codes. Confidence is advisory and uncalibrated; no automatic action is taken. These are fixtures, not live recommendations.
- Read-only policy summary projection API (`GET /api/v1/policies` and `GET /api/v1/policies/{id}`) and
  Policy view. It returns fixture-backed role/group permissions separated into read-only and mutating
  actions, plus SHA-256 and line-count metadata for Trino Rego, PostgreSQL GRANT, and Keycloak mapper
  artefacts. It intentionally excludes raw compiled text, credentials, and secrets. A test compiles the
  checked-in fixture with the real policy compiler to detect projection drift; this is not a live
  Keycloak or OPA integration.
- Read-only Data Asset API and table detail panel (issues #15/#36): `DataCatalogView` fetches asset lists and selected table details through the Domain API and displays table columns, nullability, location, format, and metadata summary from local fixtures. Merged PR #120 adds `catalog` kind, optional `catalog`/`namespace`/`parentId`/`path`, `?parentId=` filtering, a derived-id helper, and partition-column markers while retaining the flat-list default and existing IDs.
- Query context is a separate Domain API endpoint (`GET /api/v1/data-assets/{id}/query-context`): DataCatalogView hands only the selected asset ID to Query Workspace, which fetches the query context and starter SQL. The endpoint uses fixture assets and a stub service registry; it does not query live Trino.
- Query history (#17): `GET /api/v1/query-history` exposes a paginated, adapter-visible query snapshot (id, SQL, upstream state). No persistent history, inferred chronology, user, or asset association. The default app returns 503: no live history adapter is connected. Injected stubs are used only in tests; `sql` is exposed verbatim and may contain sensitive literals; there is no redaction and no per-caller authz (the app has no auth middleware), so a live adapter must not be wired until a redaction/authz policy is decided. UI integration and live visibility/auth validation remain pending.
- Opt-in read-only upstream adapters (issues #17/#36): (a) a Trino query-history adapter (`GET /v1/query` on the coordinator) behind `GET /api/v1/query-history`, and (b) an Iceberg REST catalog source for Lakekeeper (`GET /v1/config`, `/namespaces`, `/namespaces/{ns}/tables`, `/tables/{table}`, `/namespaces/{ns}`) behind `GET /api/v1/data-assets` (`?parentId=`), `GET /api/v1/data-assets/{id}` and `.../query-context`. Both are **disabled by default** (env opt-in, see `docs/api-reference.md`), so the app and CI keep using stubs/503. Bearer tokens come from config via a token-provider interface and are never logged; calls are GET-only with timeouts, size limit, redirect refusal and failure classification (unreachable/timeout/401/403/404/5xx/malformed) that degrades to 503 without partial data. **Verified by unit/contract tests only** against spec-derived fixtures (Trino 483 `BasicQueryInfo`, Iceberg REST OpenAPI), not live-recorded payloads. Live evidence limited to unauthenticated reachability on 2026-10-07: Trino 483 `GET /v1/info` returned 200 and unauthenticated `GET /v1/query` returned 403; Lakekeeper `GET /health` returned 200 and unauthenticated `GET /catalog/v1/config` returned 401. **Authenticated flows were NOT verified live** (no credentials were minted or read).
- Service list type filtering (#23): `GET /api/v1/services` selects registered adapters by `type` before calling them (`registry.listServices(type)`, merged PR [#125](https://github.com/dasomel/beluga-manager/pull/125)) instead of fanning out to all adapters and filtering afterwards; `status` is still filtered after the health fetch, and partial-failure semantics are unchanged.
- Pipeline correlation contract (issue #35): merged PR #121 adds typed `correlationLinks` to Pipeline responses, deterministic declared-label/name-convention rules with confidence/evidence, and read-only PipelinesView rendering. Current links are calculated from checked-in stub inventories; they are not discovered from live Kafka, Flink, Iceberg/Lakekeeper, Trino, or Airflow APIs.
- Overview Dashboard and Services Catalog (issues #13/#14): KPI cards include Iceberg table assets, active workloads (healthy or degraded `Workload` resources; a resource proxy, not a distinct Job count), and monitored resource count with the number reporting CPU or memory usage. Resource KPIs use `GET /api/v1/resources` and drill down to Operations. The usage summary counts resources with string usage fields; it does not calculate aggregate CPU or storage quantities. Superset is registered with version 6.1.0 per `beluga/VERSIONS.md`.
- A fault-isolated execution boundary for `DecisionProvider` (`src/decision/isolatedProvider.ts`,
  issue #69): wraps any provider so a throw, rejection, schema-invalid result, or budget overrun
  (default 500ms, overridable) always degrades to `ABSTAIN` with a machine-readable abstain code and developer reason
  (`ISOLATION_TIMEOUT` / `ISOLATION_PROVIDER_ERROR` / `ISOLATION_INVALID_SHAPE`) instead of
  propagating to the caller; the timeout releases the caller via `Promise.race` with the timer
  cleared, and a late provider response after timeout is swallowed without an unhandled rejection.
- A domain direction around Services, Pipelines, Data Assets and Operations, with adapter/capability and read-first boundaries recorded as design decisions rather than implemented runtime behavior.
- Repository verification, CI controls and OpenForge portfolio-status publication integration.
- Locale detection, persistence and fallback (issue #44): initial locale comes from a stored manual
  choice, else `navigator.language` (`ko*` → `ko-KR`, else `en-US`); storage access is wrapped so a
  blocked `localStorage` cannot crash the app; missing `ko-KR` keys fall back to `en-US`, then the
  dotted key; `<html lang>` follows the selected locale; a parity test fails CI on key-set drift.
- Remaining hard-coded UI strings translated (issue #44): theme toggle, cluster card, Figma modal,
  overview cards, catalog/query/policy views now read from `en-US`/`ko-KR` keys. Brand names,
  identifiers, SQL, LDAP groups and API enum/message values stay untranslated by design.
  Intl-based `formatDateTime`/`formatNumber`/`formatPercent` (`i18n/format.ts`) drive Operations
  event time, pipeline update time and query counts.
- Operations event drill-down to Services/Pipelines (issue #19 partial, #32): an event's related
  service or pipeline reference is a button; clicking it opens the Services catalog pre-filtered by
  ID, or selects the item in Pipelines (a not-found notice if absent). The mapping is a pure module,
  `packages/web/src/views/eventNavigation.ts`, covered by Vitest.
- Root `npm run dev:api` script (issue #32) starts the Domain API (`tsx watch`, port 8787);
  `docs/development.md`/`-ko.md` describe running web (5180) and API together against stub fixtures.
- `packages/web` is a Vitest project running in a `node` environment (issue #30), covering the API
  client and runtime config loading.
- CI runs the production web bundle build (`npm run build`, issue #31) in addition to typecheck and
  test, so a Vite bundling regression fails CI.

## Partial / evolving

- Only two opt-in upstream adapters exist (Trino query history, Lakekeeper catalog; default off, no authenticated live evidence); every other adapter and live telemetry discovery are not implemented. The Domain API
  serves local fixtures, including decision and policy projections, Data Assets, and Pipeline
  correlation; passing stub-backed API tests does not establish real upstream behavior.
- Issue #35 remains incomplete: the Pipeline schema, correlation rules, response model, and UI are
  implemented against fixtures, but a minimum end-to-end Pipeline has not been verified in an actual
  Beluga environment as the issue requires.
- Issue #36 / ADR-0004 hierarchy work is at the API/schema/stub-fixture slice. `DataCatalogView` now
  expands catalog and namespace nodes lazily through `GET /api/v1/data-assets?parentId=` (fixture-backed,
  with loading/empty/error states; it falls back to the flat table list when the API returns no catalog
  nodes, and the fallback label is still fixed text; verified by unit/render tests only, not in a browser).
  The Lakekeeper/Iceberg mapping now exists as an opt-in source (see Implemented) but has no authenticated live evidence; a Trino metadata (catalog/`SHOW`) adapter and Superset context do not exist. By default the query-context route still uses fixture assets and a stub service registry (with the live source enabled it reads the table from Lakekeeper; Trino itself is still not queried). `childCount` remains `null` until node-level OPA filtering
  exists (the live source returns only the service credential's view and marks every hierarchy list with a `NODE_AUTHZ_NOT_ENFORCED` warning; the single-asset detail response has no warnings field, an open owner question); ADR-0004 treats that filtering as a gate for rollout to real users. Superset dataset context
  is optional in issue #36.
- The frontend has no data grid, DAG/topology graph, or SQL editor component yet (issues #16-#18);
  current views are Tailwind-styled shells, not the specialist components ADR-0003 selected.
- Architecture (topology) navigation section (issue #18) does not exist yet — see
  `docs/architecture.md`'s Navigation section. Operations drill-down (issue #19) covers
  service/pipeline references, Kubernetes resource list (kinds Namespace/Workload/Pod/Service/
  Endpoint/Job/PersistentVolumeClaim with a kind filter, optional PVC `capacity`/`storageClass`)
  and an optional event `source` (kubernetes/service/job; absent = unknown, never back-filled).
  All of this is stub data. No Job-specific log entry or back-link from a logs screen exists:
  `logsUrl` is the only (generic, external) log link and the stub Job has none.
- Live Kafka/Flink/Iceberg/Trino/Airflow integration remains planned; the merged #35 Pipeline
  correlation contract is fixture-backed. Superset dataset context is optional for #36.
- Known cosmetic gap (issue #44): the Korean `columnsCount` string (`개 컬럼`) is concatenated after
  the count and keeps a leading space (`N 개 컬럼`); it needs interpolation instead of concatenation.
- `packages/web` tests run in Vitest's `node` environment; there is no DOM or E2E coverage yet
  (issue #30), so rendering/interaction regressions are only caught by manual/headless-Chrome checks
  recorded in commit messages, not by the automated suite.

## Not claimed

- Beluga Manager is not a replacement UI for every upstream OSS.
- Broad destructive/mutating platform administration is not part of the current read-first baseline.
- Architecture diagrams and MVP scope are not themselves execution evidence.
- Repository scaffolding and documentation are not claimed as an executable product.

## Evidence

- `README.md`
- `README-ko.md`
- `docs/architecture.md`
- repository CI workflows
- `scripts/verify.py`
- `tests/test_verify.py`
- OpenForge portfolio publisher integration
- GitHub CI for merged PRs #120 and #121 — Typecheck and Tests, dependency freshness and vulnerability
  checks, and deterministic repository verification passed.
- `make verify` — passed against default branch commit `f5e34a9` on 2026-10-03.
