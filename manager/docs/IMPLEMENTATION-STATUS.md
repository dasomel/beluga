# Implementation Status

Last verified: 2026-09-23 against the local branch stack ending at `c059576` (on top of `main` `e6397c0`; becomes `main` status once merged)

This file records behavior implemented on the default branch and separates it from design direction.

## Implemented

- Repository and documentation foundation for a future unified Beluga data-platform control plane/UI.
- English/Korean product, architecture, development, contribution and security documentation.
- ADR-0001/0002/0003 Accepted: React 19 + Vite 8 + Tailwind 4 frontend, TypeScript/Node + Hono backend
  direction, shadcn/ui + Radix design system with a WCAG 2.2 AA target.
- A frontend shell (`src/web/`) with six shipped views — Overview, Services, Pipelines, Data Catalog,
  Query Workspace, Policy — driven by `mockData.ts`, not yet wired to a real backend.
- The policy compiler (`src/compiler/`, `src/schema.ts`), generating Keycloak realm configuration,
  Trino OPA Rego and PostgreSQL DDL/roles from Zod-validated input.
- A System-1 decision provider scaffold (`src/decision/`) for issue #69: a provider-neutral,
  Zod-validated interface and a deterministic rule-based provider with fail-closed behavior on
  missing/stale telemetry. No local-model or external-provider integration yet.
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

- **No backend/API route or integration adapter has been implemented yet** — the Domain API decided
  in ADR-0002 does not exist as code; the frontend runs entirely on mock data.
- The frontend has no data grid, DAG/topology graph, or SQL editor component yet (issues #16-#18);
  current views are Tailwind-styled shells, not the specialist components ADR-0003 selected.
- Architecture (topology) navigation section (issue #18) does not exist yet — see
  `docs/architecture.md`'s Navigation section. Operations drill-down (issue #19) now covers
  service/pipeline references only; Kubernetes resource and log drill-down are still open.
- Kafka/Flink/Iceberg/Trino/Airflow integration and cross-service domain views remain planned; architecture documents define target boundaries only.
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
- `npm test` — 226 tests passing across 24 files (includes `packages/web`); `npm run typecheck`,
  `npm run build` and `make verify` passing
