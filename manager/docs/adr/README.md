# Architecture Decision Records

Index for issue #4 (technology/architecture tracking). Consistency check: ADR-0001 to ADR-0003
were cross-read while writing ADR-0002 and ADR-0003 and no conflicts were found between them —
ADR-0002 builds its npm-workspace/TypeScript decision on ADR-0001's frontend choice, and ADR-0003's
component set assumes ADR-0001's React selection throughout.

| ADR | Title | Status | Decided |
|---|---|---|---|
| [0001](0001-frontend-technology.md) | Frontend Technology Selection | Accepted — React + TypeScript + Vite, static SPA | 2026-09-21 (recorded from implementation shipped 2026-09-19) |
| [0002](0002-backend-api-technology.md) | Backend / API Technology Selection | Accepted — TypeScript/Node.js, npm workspace, Hono + `@hono/zod-openapi` | 2026-09-21 |
| [0003](0003-ui-design-system.md) | UI Design System & Component Strategy | Accepted — shadcn/ui (Radix + Tailwind, vendored), WCAG 2.2 AA target | 2026-09-21 |
| [0004](0004-hierarchical-data-asset-api.md) | Hierarchical Data Asset API — Catalog → Schema → Table → Column | Accepted (direction) — Phase 1 implemented (PR #120: additive catalog/namespace/`parentId`; flat list stays the default); OPA node filtering, `childCount` and real-user rollout still gated | 2026-09-24 |
| [0005](0005-deployment-gitops-integration.md) | Deployment & GitOps Integration with Beluga | Proposed — design direction only; chart/Application not implemented | 2026-10-01 |
| [0006](0006-safe-actions.md) | Safe Actions — Controlled Operational Actions | Proposed — design proposal; two-phase preview/execute framework; auth/authz is a hard prerequisite; Phase 1 is preview-only, first executable action is an Airflow DAG trigger; Flink actions deferred | 2026-10-07 |
| [0007](0007-observability-integration.md) | Observability Integration — Metrics, Logs & Events | Proposed — design proposal; zero-storage adapter model, Grafana Explore deep-linking, degraded state fallbacks | 2026-10-07 |
| [0008](0008-gitops-argocd-integration.md) | GitOps Integration with ArgoCD — Deployment & Synchronization Visibility | Proposed — design proposal; read-only ArgoCD status adapter (ArgoCD v3.5.0); authN/authZ hard prerequisite; narrow read-only account; complements ADR-0005 (packaging) | 2026-10-07 |

## Not yet closed by ADR-0001 to ADR-0003

Issue #4's own completion criterion is "no conflicts between individual ADRs, and a final Architecture
Diagram + ADR index documented" — the index is this file, and no conflicts were found, but issue #4
also lists four sibling tracking issues not yet resolved: #23 (Service Integration Adapter Model),
#24 (Observability Integration), #25 (Deployment & GitOps Integration; ADR-0005 proposes an answer, still open until Phase 2), and #29 (API Contract &
Domain Model). Those remain open.

## Adding a new ADR

Follow the format already established in 0001–0003 (Context, Decision Drivers, Considered Options,
Decision Outcome, Consequences, Open Questions), and add both the English and `-ko` file per this
repository's bilingual documentation rule. Link the new file from this index and its Korean pair.
