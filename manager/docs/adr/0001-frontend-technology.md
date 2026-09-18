# ADR-0001: Frontend Technology Selection

- **Status**: Proposed — awaiting decision
- **Date**: 2026-09-18
- **Issue**: [#26 \[EVALUATION\]\[ADR\] Frontend Technology Selection](https://github.com/dasomel/beluga-manager/issues/26)
- **Parent epic**: #1
- **Related**: [ADR-0002](0002-backend-api-technology.md), [ADR-0003](0003-ui-design-system.md)
- **Deciders**: dasomel

## Context

Beluga Manager has no frontend code today. The repository currently contains one implemented
slice — the policy compiler (`src/`, TypeScript, Zod, Vitest) — while the Manager UI described in
[Architecture](../architecture.md) and the [README](../../README.md) is still planned.

The frontend to be built is an **internal operations console**, not a public web property. Its
shape is fixed by the UX issues already filed (#13–#21):

| View | Issue | Dominant component class |
|---|---|---|
| Overview dashboard | #13 | Status/KPI card grid, health badges, drill-down links |
| Services catalog | #14 | Filterable/sortable list, status badges, external-UI launch links |
| Data catalog | #15 | Hierarchical catalog → schema → table → column navigator |
| Pipeline & job view | #16 | **DAG / flow graph**, job-run status table |
| Query workspace | #17 | **SQL editor** with syntax highlighting, Trino context hand-off |
| Architecture view | #18 | **Two interactive topology graphs** (data pipeline, Kubernetes infra) with health overlay and node drill-down |
| Operations | #19 | Resource tables, event timeline, log viewer / Loki link-out |
| Security & policy | #20 | Role/permission summary tables, policy lists |
| Safe actions | #21 | Action forms, confirmation modals, audit trail list |

Three capability classes therefore dominate the decision — **data grids**, **graph/topology
rendering**, and a **code editor** — and everything else (cards, forms, badges, timelines) is
commodity in every candidate framework.

Additional constraints that are already settled elsewhere and are inputs here, not open questions:

- **Auth-gated, zero SEO surface.** The console is reached through Keycloak SSO
  (`sso.local.beluga.internal`, Keycloak 26.7.1, the platform's single identity source). There are
  no anonymous visitors and no crawlers, so server-side rendering earns no discoverability and no
  meaningful first-paint benefit for a logged-in operator.
- **Air-gapped friendly** is a standing architecture principle (`docs/architecture.md`, principle
  7): "dependencies and runtime assets must be controllable for self-hosted environments." Runtime
  CDN fetches, remote font loading, and phone-home telemetry are disqualifying unless fully
  disableable and verified offline.
- **Deployment substrate is fixed.** The sibling `beluga` platform serves everything through a
  single APISIX 3.17.0 gateway on HTTPS 443 under `*.local.beluga.internal`, delivered by ArgoCD
  GitOps with `selfHeal: true`. Any new runtime process is a new container image that must be
  mirrored into the air-gapped registry and built for both `arm64` and `amd64`.
- **The frontend must not hold credentials.** Issue #22 states the frontend never handles
  per-service credentials or APIs directly; the backend is the sole integration point. This is
  binding on ADR-0002 and removes "SPA talks to upstream OSS directly" from consideration.
- **i18n is day-one scope.** `en-US` and `ko-KR`, browser locale detection, persistent preference,
  localized date/number formatting, and a locale-neutral API (localization happens in the frontend
  — `docs/architecture.md`, principle 4).
- **License hygiene.** The repository is Apache-2.0; #26 lists OSS license as an explicit criterion.

**There is no in-repo signal of a prior frontend preference or of team familiarity.** No frontend
framework, chart library, or graph library is named anywhere in issues #1–#43, and the repository
contains no frontend code, no design assets, and no lockfile evidence of a prior attempt. The
Narwhal Portal references in #1, #18, #19 and #20 are consistently **UX prior art to reference**
("참고"), always paired with explicit redesign language — never an instruction to reuse Narwhal's
code or components. Narwhal's stack is therefore *not* treated as a constraint here; if dasomel
intends component-level reuse rather than UX inspiration, that changes this ADR materially and
should be stated before a decision.

## Decision Drivers

1. **Ecosystem depth for the three hard component classes** — data grid, topology/DAG graph, code
   editor. This is the only criterion on which the candidates genuinely diverge.
2. **TypeScript-first fit** — the repository is 100% TypeScript (TS 7.0.2, Node ≥22) and ADR-0002
   will likely keep the API in TypeScript; end-to-end type sharing is the prize.
3. **Operational complexity of hosting** — static assets behind the existing APISIX gateway versus
   an additional long-lived Node process with its own image, Deployment, probes and mirror.
4. **Air-gapped installability** — offline `npm ci`, self-hosted fonts and assets, no runtime CDN,
   no mandatory telemetry.
5. **OSS license cleanliness** — permissive (MIT/Apache-2.0/BSD/ISC) across the whole dependency
   path, including the grid and graph libraries, which is where commercial licensing usually hides.
6. **Maintainability and hiring surface** — a small team must be able to hand this off.
7. **Build/dev-server speed** — secondary; all modern candidates are acceptable.
8. **Boundary preservation** — the tooling must not make it *easy* to violate the #22 frontend/
   backend split.

## Considered Options

### Option A — React + TypeScript + Vite (static SPA)

Client-rendered SPA, built to static assets, served by the gateway (or a minimal static container).

**Pros**

- Deepest permissively licensed ecosystem for exactly the hard parts: TanStack Table + TanStack
  Virtual (MIT) for virtualized grids, React Flow / xyflow (MIT) and Cytoscape.js (MIT) for DAG and
  topology rendering, Monaco (MIT) or CodeMirror 6 (MIT) for the SQL editor, Apache ECharts
  (Apache-2.0) or Recharts (MIT) for charts. Every one of these is first-class in React and
  installable offline.
- Largest pool of Kubernetes/data-platform console prior art to borrow patterns from.
- Mature, boring, well-understood TypeScript story; TanStack Query (MIT) covers the polling,
  caching, stale-state and refetch semantics the "degraded/stale" requirements in #41/#42 demand.
- Deployment is the cheapest possible: a directory of static files. No new runtime, no new image to
  mirror, no readiness probe, no Node process to patch for CVEs.
- The absence of a server tier makes the #22 boundary hard to violate by accident — there is no
  server-side escape hatch in which upstream OSS calls could quietly accumulate.

**Cons**

- React itself ships more framework machinery than Svelte or Vue; bundle size needs discipline
  (route-level code splitting, lazy-loading Monaco and the graph libraries).
- More boilerplate and more decisions than the batteries-included alternatives; state management,
  routing and forms are all separate choices.
- Client-side rendering means a visible initial load; acceptable for an authenticated console that
  operators keep open, but it is a real difference.
- The ecosystem's breadth is also a hazard — it is easy to accumulate overlapping dependencies.

### Option B — Next.js (React with SSR/RSC)

Same React component ecosystem, plus a server runtime, file-system routing, server components and
route handlers.

**Pros**

- Inherits every React ecosystem advantage in Option A.
- Server components could keep heavy dependencies off the client and centralize data fetching.
- Route handlers offer a convenient place for session/token handling, and cookie-based auth is
  simpler when a server is present.
- Strong conventions reduce per-project decision load.

**Cons**

- **Its headline benefits do not apply here.** SEO is irrelevant behind SSO; there are no anonymous
  first paints to optimize; the audience is a handful of authenticated operators.
- **It adds a second production runtime**: a Node server needing its own image (built for arm64 and
  amd64), Deployment, probes, resource limits, rollout strategy, CVE patching, and a mirror into the
  air-gapped registry — all for a console whose payload could have been static files.
- **It structurally invites a violation of #22 and #34.** Route handlers and server components make
  it trivially easy to call Kubernetes, Trino or Kafka "just this once" from the frontend tier,
  producing a shadow backend that bypasses the Beluga Domain API. AGENTS.md explicitly forbids the
  UI bypassing the domain API to call upstream OSS directly. Preventing this becomes a review
  discipline problem rather than an architectural guarantee.
- If ADR-0002 also chooses Node, the platform ends up with **two** Node services with overlapping
  responsibilities and an ambiguous boundary between them.
- Air-gapped operation requires deliberate work: disabling telemetry, self-hosting fonts (the
  built-in font optimization fetches from Google by default), and validating the standalone output
  offline.

### Option C — Vue 3 + TypeScript + Vite (static SPA)

**Pros**

- Excellent TypeScript support in Vue 3 with `<script setup>`; very good developer ergonomics.
- Vite is the native build tool; dev server and HMR are first-class.
- Smaller runtime than React, generally smaller bundles, gentler learning curve.
- Strong batteries-included component libraries with dense enterprise tables built in (see
  ADR-0003): Naive UI, PrimeVue, Vuetify, Element Plus.
- Excellent Korean-language documentation and a strong community presence in Korea — a real, if
  soft, maintainability advantage for this team's context.

**Cons**

- The three hard component classes are thinner: graph/topology options are largely Vue wrappers
  around framework-agnostic cores (Cytoscape, D3) or `vue-flow` (a community port of React Flow,
  MIT, smaller maintainer base). Monaco and CodeMirror are framework-agnostic and integrate fine,
  so the editor is a non-issue; the **graph layer is where Vue carries more integration risk**.
- TanStack Table has a Vue adapter, but the Vue table story is usually "use the component
  library's table," which couples the data grid to the design-system decision in ADR-0003.
- Less Kubernetes/data-console prior art to copy from.

### Option D — SvelteKit (static adapter, or SSR)

**Pros**

- Smallest runtime and typically the smallest bundles; excellent raw performance.
- `adapter-static` produces a pure static build, keeping the Option A deployment story, while the
  same framework can later add SSR if a requirement ever justifies it.
- Very low boilerplate; fast to write; good TypeScript support.

**Cons**

- **Thinnest ecosystem for precisely the hard parts.** There is no Svelte-native equivalent of
  React Flow with comparable maturity; topology work would mean wrapping Cytoscape or D3 by hand.
  Virtualized enterprise data grids are similarly a build-it-yourself proposition.
- Smallest hiring pool and the least Kubernetes-console prior art.
- Svelte 5's runes reactivity model is recent; some ecosystem libraries still lag.
- Choosing SvelteKit to then use only its static adapter means adopting a full-stack framework's
  conventions for none of its full-stack benefits.

### Option E — Reuse Narwhal Portal's stack and components

**Pros**

- Potentially large head start if Narwhal's components are genuinely reusable and its stack is
  current.
- Automatic UX consistency with the sibling product, which #1 names as a goal.

**Cons**

- **Not supported by the issue record.** Every Narwhal reference in #1, #18, #19 and #20 says
  *reference the UX* and pairs it with explicit redesign language for Beluga's data-platform
  character. Nothing asks for code reuse.
- Cannot be evaluated from this repository — Narwhal's stack, licence, and component quality are
  not visible here. Evaluating it requires access and a separate spike.
- Risks importing a stack chosen for a different problem domain (general platform/ops portal rather
  than data-platform topology, catalog and query workloads).
- #28's stated principle is an **independent Beluga brand experience** with consistency limited to
  management-platform UX patterns — which argues for pattern reuse, not component reuse.

## Decision Outcome

**TBD — pending dasomel review.**

This ADR deliberately does not select an option. Frontend framework selection is a design change
under `AGENTS.md` ("Treat domain-model changes, correlation authority, upstream adapter contracts,
auth/RBAC, destructive operations, and public API changes as design changes") and is dasomel's call.

---

> ### 🏛 Architect's Recommendation *(advisory only — not the decision)*
>
> **Option A: React + TypeScript + Vite, built as a static SPA, served behind APISIX.**
>
> **Single strongest reason:** the three component classes that actually decide this — virtualized
> data grids, interactive DAG/topology graphs, and an embedded SQL editor — have mature,
> MIT-licensed, offline-installable implementations in React (TanStack Table/Virtual, React Flow and
> Cytoscape, Monaco/CodeMirror). Every other criterion is close to a tie between the candidates; this
> one is not, and it maps directly onto #16, #17 and #18, which are the views that make Beluga
> Manager more than a list of links.
>
> **Supporting reasons**
>
> - Static output is the cheapest thing to operate in an air-gapped, GitOps-delivered cluster: no
>   second runtime, no additional image to mirror, no probes, no Node CVE treadmill.
> - The absence of a server tier makes the #22 boundary *structurally* enforceable rather than a
>   code-review convention.
> - Vite is already present in the dependency tree via Vitest 5, and Vitest is already the test
>   runner — the frontend inherits the existing test idiom rather than introducing a second one.
>
> **Explicitly rejecting Next.js**, despite it being the popular default: SSR buys nothing behind
> SSO, costs a second production runtime in an air-gapped cluster, and its route handlers are an
> open invitation to the exact upstream-bypass that AGENTS.md and #22 forbid.
>
> **What would change this recommendation:** if the team has real Vue depth and no React depth,
> take Option C. Framework familiarity outweighs my ecosystem argument, because the ecosystem gap is
> concentrated in the graph layer and is bridgeable (Cytoscape and Monaco are framework-agnostic;
> only React Flow has no true Vue peer). A team fighting an unfamiliar framework will lose more time
> than it saves.

---

## Consequences

**If Option A (or any static SPA) is chosen:**

- A build-time decision is needed on where the frontend lives: an npm workspace in this repository
  or a separate repository. `package.json` is currently a single non-workspace package — **this is
  unresolved and is a prerequisite, not a detail** (see Open Questions).
- The API base URL must be build-time or runtime configurable so the SPA can be repointed without a
  rebuild; a runtime `config.json` fetched at boot is the usual air-gap-friendly answer.
- Auth becomes an OIDC public client with PKCE against the existing Keycloak realm
  (`sso.local.beluga.internal`). Token storage, silent renewal and logout are frontend concerns, and
  the access token is attached to Beluga Domain API calls. ADR-0002 owns verification.
- APISIX gains a route for the console host (e.g. `manager.local.beluga.internal`) plus SPA history
  fallback (unknown paths → `index.html`).
- Bundle discipline is required from day one: route-level code splitting, and lazy-loading Monaco
  and the graph library, which are the two largest dependencies.
- All fonts and icons are vendored into the repository; no runtime CDN references.

**If a server-rendered option is chosen instead:**

- A container image, Deployment, Service, probes, resource limits and an ArgoCD application entry
  are added, plus arm64/amd64 builds and an air-gapped registry mirror.
- A written rule (and preferably a lint rule or CI check) is required to prevent the server tier
  from calling upstream OSS APIs directly, preserving #22 and #34.

**In all cases:**

- ADR-0003 (UI design system) is **gated on this decision** — component libraries are
  framework-specific.
- The i18n library choice follows the framework (`react-i18next` / `vue-i18n` / `svelte-i18n`) and
  must support `en-US` and `ko-KR` with persisted preference, per the README's i18n section.
- Platform resource identifiers — Kafka topic names, table names, job names, namespaces — must
  never be translated, per the README.

## Open Questions for dasomel

1. **Monorepo or split repositories?** Frontend, Domain API and the existing policy compiler in one
   npm-workspaces repository, or separate repositories? Nothing in #1–#43 decides this, and it
   blocks the first commit of frontend code.
2. **Team composition and existing framework experience.** This is the single largest unknown in
   this ADR and it can legitimately flip the recommendation to Vue. Nothing in the repository
   answers it.
3. **Is Narwhal Portal reuse actually on the table?** The issues say "reference the UX." If code or
   component reuse is genuinely intended, Option E needs a real evaluation with access to Narwhal,
   and this ADR should be revised rather than decided.
4. **How hard is the air-gap requirement?** `docs/architecture.md` states it as a principle, but no
   issue in #1–#43 mentions it. Whether this is a firm production constraint or an aspiration
   changes how much weight Option B's mirroring cost carries.
5. **Is a browser support floor required?** Assumed modern evergreen browsers; if a locked-down
   corporate browser baseline exists, it constrains build targets and some libraries.
