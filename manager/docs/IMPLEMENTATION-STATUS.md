# Implementation Status

Last verified: 2026-09-21 against `main`

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

## Partial / evolving

- **No backend/API route or integration adapter has been implemented yet** — the Domain API decided
  in ADR-0002 does not exist as code; the frontend runs entirely on mock data.
- The frontend has no data grid, DAG/topology graph, or SQL editor component yet (issues #16-#18);
  current views are Tailwind-styled shells, not the specialist components ADR-0003 selected.
- Architecture (topology) and Operations (resource/event/log drill-down) navigation sections (issues
  #18, #19) do not exist yet — see `docs/architecture.md`'s Navigation section.
- Kafka/Flink/Iceberg/Trino/Airflow integration and cross-service domain views remain planned; architecture documents define target boundaries only.

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
