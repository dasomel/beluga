# Architecture Decision Records

Index for issue #4 (technology/architecture tracking). Consistency check: the three ADRs below
were cross-read while writing ADR-0002 and ADR-0003 and no conflicts were found between them —
ADR-0002 builds its npm-workspace/TypeScript decision on ADR-0001's frontend choice, and ADR-0003's
component set assumes ADR-0001's React selection throughout.

| ADR | Title | Status | Decided |
|---|---|---|---|
| [0001](0001-frontend-technology.md) | Frontend Technology Selection | Accepted — React + TypeScript + Vite, static SPA | 2026-09-21 (recorded from implementation shipped 2026-09-19) |
| [0002](0002-backend-api-technology.md) | Backend / API Technology Selection | Accepted — TypeScript/Node.js, npm workspace, Hono + `@hono/zod-openapi` | 2026-09-21 |
| [0003](0003-ui-design-system.md) | UI Design System & Component Strategy | Accepted — shadcn/ui (Radix + Tailwind, vendored), WCAG 2.2 AA target | 2026-09-21 |

## Not yet closed by these three

Issue #4's own completion criterion is "no conflicts between individual ADRs, and a final Architecture
Diagram + ADR index documented" — the index is this file, and no conflicts were found, but issue #4
also lists four sibling tracking issues not yet resolved: #23 (Service Integration Adapter Model),
#24 (Observability Integration), #25 (Deployment & GitOps Integration), and #29 (API Contract &
Domain Model). Those remain open.

## Adding a new ADR

Follow the format already established in 0001–0003 (Context, Decision Drivers, Considered Options,
Decision Outcome, Consequences, Open Questions), and add both the English and `-ko` file per this
repository's bilingual documentation rule. Link the new file from this index and its Korean pair.
