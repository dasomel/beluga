# Product Requirements & User Scenarios (Draft)

- **Status**: Draft — synthesized from issues #1, #2, #12, #13-#21, #41, and ADR-0001's context
  table. Not a design decision itself; personas and journeys below are inferred from the UX issues
  already filed, not new product direction. Needs dasomel's review before being treated as settled.
- **Issue**: [#2](https://github.com/dasomel/beluga-manager/issues/2)
- **Parent epic**: #1

## Problem

Operators of the Beluga Data Platform must currently move between the separate UIs of Kafka, Flink,
Trino, Iceberg (via Lakekeeper), Airflow, and Kubernetes tooling to answer one question: *is the
platform healthy, and if not, where and why?* No single view correlates state across these systems
into Beluga's own Pipeline/Service/Data Asset concepts. Beluga Manager exists to be that correlation
layer — not a portal of links to each OSS UI, and not a replacement for any of them (per #1's core
differentiation principle).

## Personas (inferred from the filed UX issues, not independently sourced)

| Persona | Primary views | Representative need |
|---|---|---|
| **Platform/data engineer** | Overview (#13), Services (#14), Pipelines (#16), Architecture (#18), Operations (#19) | "Is the pipeline healthy end-to-end, and if a stage is failing, which resource/event/log explains it?" |
| **Data analyst** | Data Catalog (#15), Query Workspace (#17) | "What tables exist, what's their schema, and how do I get into Trino with that context already loaded?" |
| **Platform administrator** | Security & Policy (#20), Safe Actions (#21) | "Who has access to what, and can I perform a controlled operational action with an audit trail, not a raw kubectl/API call?" |

A single person may hold more than one of these roles; they are not intended as strict access tiers
(#20 owns the actual RBAC model).

## Key user journeys

1. **Health check (Overview → Services)**: land on Overview, see platform-wide KPI/health cards
   (#13), drill into a specific degraded service (#14) without leaving Beluga Manager.
2. **Pipeline troubleshooting (Pipelines → Architecture → Operations)**: notice a pipeline is
   degraded (#16), inspect its topology to find the failing stage (#18), drill into that stage's
   Kubernetes resources/events/logs (#19) — this is the journey issue #41's vertical slice
   (Kafka → Flink → Iceberg → Trino) is built to prove end-to-end.
3. **Data exploration to query (Data Catalog → Query Workspace)**: browse catalog → schema → table
   → column (#15), then hand off to the Query Workspace with that table context pre-loaded (#17)
   rather than re-discovering it in Trino's own UI.
4. **Controlled action (Security & Policy → Safe Actions)**: check current role/permission state
   (#20) before performing a scoped, confirmed, audited operational action (#21) — never a direct,
   unconfirmed mutation.

Every journey ends inside Beluga Manager or hands off to a specialist OSS UI with context preserved
(#1's "professional features connect to existing service APIs/UIs with context retained" principle)
— it never requires reimplementing that specialist UI.

## MVP feature priority

Ordered by what issue #41 (the first executable vertical slice) and ADR-0002's minimum backend
scope actually require, not by view number:

1. **Unified Service API** (#42) — health/version/capability for Kafka, Flink, Iceberg, Trino,
   Airflow, Kubernetes. Nothing else can be built without this.
2. **Domain API contract** (#43) — the OpenAPI-first `/api/v1/*` surface everything else consumes.
3. **Overview + Services views** (#13, #14) — the cheapest real screens once #42/#43 exist; already
   shipped as mock-data shells (`src/web/views/OverviewView.tsx`, `ServicesView.tsx`).
4. **Vertical slice pipeline view** (#41, #16 partial) — prove Kafka→Flink→Iceberg→Trino as one
   correlated Beluga Pipeline. This is the MVP's actual success bar, not any individual view.
5. Data Catalog, Query Workspace, Architecture, Operations, Security, Safe Actions (#15, #17-#21)
   — sequenced after the vertical slice proves the correlation model works, per the existing
   ADR-0001 view table.

## Explicit scope (from #41 and #1)

**In scope for MVP**: read-only service/pipeline/data-asset views; cross-service correlation with
explicit provenance/confidence, never presented as unverified fact (`docs/architecture.md` principle
6); stale/degraded state shown explicitly, not hidden; hand-off to specialist OSS UIs with context.

**Out of scope for MVP** (from #41's exclusions, still binding): mutating operations of any kind; a
complete Data Catalog (lineage, full metadata management); advanced lineage; a full observability
product (Beluga Manager surfaces health/events, it does not replace Prometheus/Grafana/Loki).

## Open items for dasomel

- Confirm or correct the three inferred personas — they are read off the UX issue set, not from
  direct user research.
- Confirm the MVP feature ordering above matches actual priority, or reorder it.
- #2 stays open until this document is reviewed and either accepted as-is or revised.

See [product-requirements-ko.md](product-requirements-ko.md) for the Korean version.
