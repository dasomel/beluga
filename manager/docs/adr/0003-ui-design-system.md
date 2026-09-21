# ADR-0003: UI Design System & Component Strategy

- **Status**: Proposed — awaiting decision. **Blocked on [ADR-0001](0001-frontend-technology.md).**
- **Date**: 2026-09-18
- **Issue**: [#28 \[EVALUATION\]\[ADR\] UI Design System & Component Strategy](https://github.com/dasomel/beluga-manager/issues/28)
- **Parent epic**: #1
- **Related**: [ADR-0001](0001-frontend-technology.md), [ADR-0002](0002-backend-api-technology.md)
- **Deciders**: dasomel

## Context

Issue #28 asks for a design-system and shared-component strategy covering layout/navigation,
typography/spacing, status and health indicators, tables, cards, forms, topology/graph, charts,
dark/light theme, and accessibility. Its stated principle is to build **an independent Beluga
Manager brand experience** while keeping consistency with Narwhal and general management-platform
UX patterns.

**This ADR is structurally dependent on ADR-0001.** Component libraries are framework-specific, so
the option set below is organised *conditionally* by framework. Only the framework-agnostic
sections — the specialist components, the licensing constraints, and the decision drivers — can be
settled independently of #26.

### What the product actually needs

From #13–#21, the UI is a **dense internal operations console**. Functional density matters more
than marketing polish, but it still has to be pleasant to use for hours. The concrete component
inventory:

| Need | Source | Notes |
|---|---|---|
| App shell: sidebar navigation, breadcrumbs, header, user/locale menu | #13–#21 | Commodity in every library |
| Status / health indicators | #13, #14, #19 | Needs a **shared status vocabulary**, not ad-hoc colours |
| Dense, sortable, filterable, paginated tables | #14, #19, #20 | Server-side pagination and filtering per #43 |
| Virtualized long lists | #19 (events, resources, logs) | Not available in most general-purpose libraries |
| Hierarchical tree navigation | #15 (catalog → schema → table → column) | Common, but must handle large trees |
| **Topology / DAG graph** | #16, #18 | **Specialist — no general UI library provides this** |
| **SQL editor with syntax highlighting** | #17 | **Specialist — no general UI library provides this** |
| Event timeline | #19 | Often bespoke |
| Log viewer | #19 | Virtualized; may link out to Loki instead |
| Cards / KPI tiles | #13 | Commodity |
| Forms, confirmation modals, dry-run preview | #21 | Commodity, but needs disciplined destructive-action patterns |
| Charts (light usage) | #13, #19 | Summary metrics only; no heavy analytics UI — Superset owns BI |
| Dark / light theme | #28 | Must be a token-level concern, not per-component overrides |
| Accessibility | #28 | Keyboard navigation and screen-reader semantics |
| `en-US` / `ko-KR` locales | README | Component-level locale packs and date/number formatting |

Two conclusions follow immediately:

1. **No component library covers the hard parts.** The graph renderer and the SQL editor will be
   specialist dependencies regardless of which design system is chosen, and they will need to be
   themed to match it. Roughly a third of the visual surface — the parts that make Beluga Manager
   distinctive — is bespoke either way.
2. **The status/health vocabulary is Beluga's own design problem.** `healthy / degraded / stale /
   unknown / unavailable` recurs across #13, #14, #19, #41 and #42, and the API is required to
   express degraded and stale states explicitly. That mapping — state → colour, icon, label,
   tooltip, accessible name — must be defined once in Beluga's own tokens and must not be
   improvised from whatever severity colours a library ships. **Non-colour encoding is mandatory**,
   since colour alone fails both accessibility and greyscale/projector conditions.

### Binding constraints

- **Air-gapped friendly** (`docs/architecture.md`, principle 7): no runtime CDN, no remote font
  fetching, no license servers that phone home, no telemetry. Fonts and icons must be vendored.
- **Apache-2.0 repository**; #26 names OSS license as an explicit criterion. This matters more than
  usual here because **the enterprise data-grid and graph markets are dominated by commercial
  licences** — see the trap list below.
- **Narwhal Portal is UX prior art, not a component source.** Every reference in #1, #18, #19 and
  #20 says "reference" and is paired with explicit redesign language. #28's own principle asks for
  an *independent* Beluga brand.
- **No existing design assets.** There is no logo usage guide, colour palette, type scale or Figma
  file in this repository. Whatever is chosen, the brand layer starts from zero.

### Licensing traps to avoid

These are widely recommended and would be **incompatible** with an Apache-2.0, self-hosted,
air-gapped posture unless dasomel deliberately budgets for commercial licences:

- **AG Grid Enterprise** — Community is MIT, but the features usually wanted (grouping, pivoting,
  advanced filters, Excel export) are commercial. Easy to adopt Community and then need Enterprise.
- **Highcharts** — free only for non-commercial use; commercial otherwise.
- **yFiles, GoJS, Syncfusion, Kendo UI, DevExtreme** — all commercial.
- **Chart.js is MIT and fine**; **Apache ECharts is Apache-2.0 and fine**; **D3 is ISC and fine**.
- **Cytoscape.js (MIT)**, **React Flow / xyflow (MIT core)**, **Monaco (MIT)**, **CodeMirror 6
  (MIT)**, **TanStack Table/Virtual (MIT)** are all clean.
- Note that **xyflow Pro** and similar "open core" projects put some features behind a commercial
  tier; confirm that the required feature set lives in the open tier before committing.

## Decision Drivers

1. **Coverage of the dense-table requirement** — the most-used component in the product.
2. **Themability toward an independent Beluga identity** — how hard the library fights a custom look.
3. **Accessibility quality out of the box** — focus management, ARIA semantics, keyboard navigation.
4. **Licence cleanliness across the full component set**, including grid and charts.
5. **Air-gap compatibility** — self-hostable fonts and assets, no runtime network dependency.
6. **`ko-KR` locale support** — built-in locale packs versus building the layer yourself.
7. **Bundle size and tree-shaking**, given an internal console that should still feel fast.
8. **Delivery speed versus long-term control** — the central trade-off in this ADR.
9. **Maintenance and upgrade risk** — major-version churn in someone else's design language.

## Considered Options

### Framework-agnostic prerequisite: the specialist layer

Whatever is chosen below, these are separate decisions and are largely framework-independent:

- **Graph/topology**: Cytoscape.js (MIT, strong layout algorithms, framework-agnostic, best for the
  Kubernetes infra topology in #18) and/or React Flow (MIT, best-in-class interaction and custom
  node rendering, React-only, best for the pipeline DAG in #16). D3 (ISC) underneath if fully
  bespoke layout is needed.
- **SQL editor**: Monaco (MIT; heavier, VS Code-grade, excellent SQL support) or CodeMirror 6 (MIT;
  much lighter, more modular, easier to theme). Both must be lazy-loaded.
- **Charts**: Apache ECharts (Apache-2.0) or Recharts/Chart.js (MIT). Usage is light.
- **Virtualization**: TanStack Virtual (MIT) or the framework's equivalent.

### If ADR-0001 selects React

#### Option R1 — shadcn/ui (Radix primitives + Tailwind CSS), vendored into the repository

Not a dependency in the usual sense: component source is copied into the repository and owned.

**Pros**

- **Maximum theming control**, which is what #28's "independent Beluga brand experience" asks for.
  There is no upstream design language to fight.
- **Radix primitives have excellent accessibility** — focus traps, ARIA semantics, keyboard
  interaction — without importing a visual identity.
- **Ideal air-gap profile**: the code is in the repository; Tailwind compiles locally; fonts are
  vendored by choice. Nothing is fetched at runtime.
- MIT throughout, with no open-core tier to trip over.
- Only what is used is shipped; no dead component weight.
- Upgrades cannot break the UI unexpectedly, because there is no upstream component version.

**Cons**

- **No data grid.** Tables come from TanStack Table (MIT), which is a headless engine, not a
  finished grid — sorting, filtering, pagination, column sizing and selection UI are all assembled
  by hand. Given how central dense tables are here, this is the largest cost.
- **No `ko-KR` locale pack and no date/number formatting layer.** Both must be built on
  `Intl`/`react-i18next`. Manageable, but it is work the batteries-included options include.
- Slowest path to a first polished screen; the team owns every component's bugs.
- Requires Tailwind, and design consistency then depends on token discipline rather than on a
  library enforcing it.
- Adopting it *is* committing to designing a design system, which requires someone to make visual
  decisions — and this repository currently has no design assets or designer signal.

#### Option R2 — Ant Design

**Pros**

- **The most complete enterprise component set of any option**, with a genuinely capable free table
  (sorting, filtering, fixed columns, expandable rows, row selection) — MIT, no enterprise tier.
- **`ko_KR` locale is built in**, as are date/number formatting conventions, form validation
  messages and a comprehensive form system.
- Fastest route to a dense, credible admin console; strong descriptions/statistics/tag/badge
  components that map directly onto #13's KPI cards and #14's status badges.
- Very widely used in Korea and China for exactly this class of product; large hiring familiarity.
- Includes a tree component suitable for #15's catalog navigation.

**Cons**

- **A strong, recognisable visual identity that actively resists rebranding.** Theming via design
  tokens (v5+) is much improved, but an Ant Design app tends to look like an Ant Design app — which
  is in direct tension with #28's independent-brand principle.
- **Largest bundle** of the options; tree-shaking helps but the baseline is heavy.
- Icons and some assets need care for a fully offline build.
- Accessibility is decent but not its strongest suit relative to Radix-based approaches.
- Major-version migrations have historically been substantial.

#### Option R3 — Mantine

**Pros**

- MIT, very large component set including a usable table, plus an excellent hooks library.
- **Theming is a first-class, well-documented concern** — considerably easier to rebrand than Ant
  Design while shipping far more than shadcn/ui.
- Good accessibility, good dark/light theming built on CSS variables (a natural fit for token-based
  status colours).
- Strong form handling, notifications, modals and date components; dates localize via dayjs.
- Genuinely the middle of the speed-versus-control axis.

**Cons**

- Its table is lighter than Ant Design's; dense enterprise grids still likely mean TanStack Table
  underneath, so the biggest component need is only partly solved.
- `ko-KR` coverage is thinner than Ant Design's built-in locale support; more of the i18n layer is
  yours.
- Smaller community than React itself implies; fewer Korean-language resources.
- Ships its own CSS layer, which must be reconciled if Tailwind is also wanted.

#### Option R4 — MUI (Material UI)

**Pros**

- Extremely mature, huge component set, excellent TypeScript support and documentation.
- Powerful theming system; strong accessibility track record; built-in locale support including
  Korean.
- Very large hiring pool.

**Cons**

- **Material Design is an opinionated, instantly recognisable visual language** — the hardest of
  these options to make *not* look like Google, which conflicts with #28's independent-brand goal.
- **MUI X licensing is the trap**: the Data Grid — the very component this product needs most — is
  open-core. `DataGrid` is MIT, but `DataGridPro`/`DataGridPremium` (virtualization at scale,
  grouping, tree data, Excel export) are commercial. It is easy to design toward Pro features and
  discover the licence requirement late.
- Emotion-based runtime styling carries a performance cost on very dense tables.
- Bundle size is significant.

### If ADR-0001 selects Vue

- **Naive UI** (MIT) — TypeScript-first, very complete, notably themable, strong tables. The closest
  Vue analogue to the Mantine position and generally the best fit for this product's needs.
- **PrimeVue** (MIT) — enormous component set with a genuinely powerful DataTable (the strongest
  free table in the Vue ecosystem) and an unstyled/pass-through mode enabling full custom theming.
- **Vuetify** (MIT) — mature and complete, but Material Design brings the same brand-identity
  tension as MUI.
- **Element Plus** (MIT) — mature and dense, with an Ant-Design-like trade-off profile.

Note that the Vue path meaningfully changes the **graph** decision: there is no Vue-native React Flow
peer of equal maturity (`vue-flow` is a smaller community port), so Cytoscape.js or a D3-based
bespoke renderer becomes the more likely choice. This is an input back into ADR-0001.

### If ADR-0001 selects Svelte

- **Skeleton** (MIT, Tailwind-based) or **bits-ui / Melt UI** (MIT, headless primitives — the
  closest Svelte analogue to the Radix/shadcn approach).
- The component ecosystem is the thinnest of the three frameworks; expect to build substantially
  more, particularly tables and anything grid-like.
- Framework-agnostic specialists (Cytoscape, Monaco, CodeMirror, ECharts, D3) integrate fine, so the
  specialist layer is not the problem — the commodity layer is.

### Option X — Fully bespoke design system (any framework)

Build everything on headless primitives with no component library at all.

**Pros**

- Complete brand control and zero third-party visual coupling.
- Smallest possible bundle; no unused component weight.

**Cons**

- Very large cost, and it is *recurring*: accessible menus, comboboxes, dialogs, date pickers and
  focus management are hard to get right and easy to get subtly wrong.
- Requires a dedicated designer and a real token/documentation practice to avoid drifting into
  inconsistency — the opposite of a design system.
- Not justified by the requirements. #28 asks for an independent brand experience, which a themed
  primitive layer already delivers at a fraction of the cost.

Recorded to close the question; not recommended for a team of this size.

## Decision Outcome

**Unblocked** — ADR-0001 selected React, so the option set below is R1–R4. **Still TBD pending
dasomel review** on the two questions the Multi-Model Review (below) narrowed this down to.

---

## Multi-Model Review (2026-09-21)

Codex (critic) and Gemini (research) reviewed this ADR against the now-Accepted ADR-0001 and the
actual repository state (`src/web/views/*.tsx` are plain Tailwind shells over `mockData.ts`, zero
component library installed yet). Findings, WebSearch-verified where flagged:

**R1 (shadcn/ui) still holds, and "nothing is built yet" strengthens rather than weakens it** —
switching cost is currently ~zero, and roughly a third of this UI (graphs, SQL editor, timeline) is
bespoke under any option, so independent-brand/air-gap/token control matters more than a library's
component count. **But the ADR understates R1's real cost**: shadcn/ui is a source-generation
model, not a finished design system — the team owns the table, date/number formatting, pagination,
virtualization, documentation and regression tests going forward. If the actual priority is a fast
MVP with no dedicated frontend/design owner, Ant Design is the better *conditional* answer, and
Mantine remains the defensible middle. This is exactly the fork the two questions below ask.

**Version/currency corrections** (verified via WebSearch, not just Gemini's report):
- **shadcn/ui** officially supports Tailwind v4 (`@theme`, OKLCH colors) and React 19 (`data-slot`
  pattern) — matches this repo's stack exactly. CLI-based install copies source at setup time; no
  runtime dependency or CDN call, fully air-gap compatible.
- **Ant Design** current major is **v6** (released late 2025). `ko_KR` locale is still built in, but
  translation completeness can lag for newly added components. De-branding away from the default Ant
  look remains a known community pain point even with v5+/v6 design tokens.
- **Mantine** current major is **v9** (H1 2026, requires React 19.2+). Correction to this ADR's
  characterization: `@mantine/core`'s bundled `Table` has **no sorting/filtering at all** — it's a
  styled `<table>` wrapper, not merely "lighter" than Ant Design's. A real data grid needs the
  separate **Mantine React Table (MRT)** package (built on TanStack Table v8, confirmed feature-complete:
  sorting/filtering/pagination/row-selection/column-resize — [docs](https://www.mantine-react-table.com/)).
- **MUI X**: open-core boundary unchanged (single-sort/basic-filter/paging = MIT `DataGrid`;
  multi-filter/column-pinning/resize/Excel-export = commercial `DataGridPro`/`DataGridPremium`), but
  Gemini reports the Pro/Premium licensing model shifted from per-developer to per-application
  pricing around April 2026 — re-check current pricing before committing if MUI is ever revisited.
- **xyflow (React Flow) correction**: the core package is genuinely MIT, but Pro examples/templates
  carry a separate license — don't describe "all of xyflow" as MIT without that distinction
  ([xyflow open source](https://xyflow.com/open-source), [Pro license](https://xyflow.com/pro-license)).
- TanStack Table, Cytoscape.js, CodeMirror 6, Apache ECharts: confirmed still MIT/Apache-2.0, no
  open-core traps, all bundle locally via Vite with no runtime CDN calls.

**Log viewer (open question 6): default to Loki link-out** — deep-link from Beluga with time
range/namespace/pod/workload preserved, show only recent events/status in-app. If a real in-app need
emerges, **`@patternfly/react-log-viewer`** (Red Hat/PatternFly, verified real and actively
maintained on npm — virtualized, ANSI, streaming, built for exactly this Kubernetes-console use case)
is a better-fitted starting point than building a custom `@tanstack/react-virtual` viewer from
scratch.

**Missing Decision Drivers**: server-side filter/sort and large-dataset performance; URL deep-linking
and browser back-button behavior; representing polling/stale/degraded state visually (not just as an
API field); RBAC and destructive-action safety in the component layer; keyboard-centric operability
for an ops console; testability of chosen components; a browser-support baseline; and a long-term
ownership/upgrade policy for whichever components or tokens are chosen.

**The two questions this narrows the decision to** (repo facts already resolve the rest — Tailwind is
already proven acceptable per its use in shipped views; no existing Beluga/Narwhal visual identity
exists to inherit, confirmed by checking the local `narwhal-portal` repo, which has no logo/palette/
type-scale/Figma, only a trivial theme cookie helper):

1. **Fast MVP with an off-the-shelf look, or invest in an independent Beluga brand?** This is really
   asking whether there's a dedicated frontend/design owner. No signal either way exists in this
   repository.
2. **Is there a formal accessibility target** (e.g. WCAG 2.2 AA), or best-effort for an internal
   tool? This meaningfully favors Radix-based options if formal, and needs a testing plan either way.

---

> ### 🏛 Architect's Recommendation *(advisory only — not the decision)*
>
> **Conditional on ADR-0001 selecting React: Option R1 — shadcn/ui (Radix + Tailwind), vendored —
> paired with TanStack Table for grids, React Flow and/or Cytoscape for graphs, and CodeMirror 6 for
> the SQL editor.**
>
> **Single strongest reason:** the three constraints that are actually binding here — air-gapped
> deployment, permissive licensing end to end, and #28's "independent Beluga brand experience" — all
> point the same direction, and vendored source satisfies all three by construction. The component
> code lives in the repository, so there is nothing to fetch at runtime, no open-core tier to
> discover late, and no upstream design language to fight while building Beluga's own identity.
>
> **Supporting reasons**
>
> - Radix supplies the genuinely hard, easy-to-get-wrong accessibility behaviour (#28 lists a11y in
>   scope) without bundling a visual identity.
> - Roughly a third of this UI — topology graphs, the SQL editor, the event timeline, the log viewer
>   — is bespoke under *any* option. A library that ships 200 components does not help with those,
>   and a fully-owned token layer makes theming the specialists to match much easier than reverse-
>   engineering a third-party theme.
> - Tailwind tokens map cleanly onto the status vocabulary (`healthy / degraded / stale / unknown /
>   unavailable`) that #42 and #43 require the API to express — one definition, used by badges,
>   graph nodes, table cells and charts alike.
>
> **The honest counter-argument, and when to take it:** Ant Design (R2) is the better choice if
> speed to a working console outweighs brand independence — most concretely because its free table
> and built-in `ko_KR` locale remove the two largest gaps in the shadcn path. If the team is one or
> two people and the goal is to prove the MVP's value quickly (#41's explicit purpose), **choose Ant
> Design and accept that it looks like Ant Design.** If neither pole is right, **Mantine (R3) is the
> defensible middle** and I would rank it second overall. I do not recommend MUI here, chiefly
> because MUI X Data Grid's open-core boundary sits directly on this product's most-used component.
>
> **Framework-independent recommendations I would make regardless of the above:**
>
> 1. **Define the status/health token set before building any screen.** State → colour, icon, label,
>    accessible name, defined once, always paired with a non-colour indicator. This is the single
>    highest-leverage design decision in the product and it is Beluga's own, not a library's.
> 2. **Choose CodeMirror 6 over Monaco** unless full IntelliSense-grade SQL completion is required.
>    #17 describes the query workspace as an entry point that hands context to Trino, not a
>    full IDE; CodeMirror is dramatically lighter and easier to theme.
> 3. **Split the graph decision by view.** React Flow suits #16's pipeline DAG (custom node
>    rendering, interaction); Cytoscape suits #18's Kubernetes topology (real layout algorithms over
>    larger, less linear graphs). Using both is defensible; forcing one to do both is not.
> 4. **Vendor all fonts and icons** into the repository from day one. Retrofitting this after
>    building against a CDN is tedious and it is exactly what the air-gap principle forbids.

---

## Consequences

**If a vendored/headless approach (R1 or equivalent) is chosen:**

- A token layer must be defined first: colour scales for light and dark, type scale, spacing scale,
  radii, elevation, and the status vocabulary. This is a prerequisite, not a follow-up.
- Someone must own visual decisions. There is no designer signal and no design asset in this
  repository today — this is a staffing question, not a technical one.
- A component inventory and usage documentation are needed, or the "system" becomes a folder of
  one-off components. Documentation is subject to this repository's bilingual rule.
- Accessibility must be verified rather than assumed: keyboard traversal of tables and graphs,
  focus-visible styling, and screen-reader labels for status indicators.

**If a batteries-included library (R2/R3/R4 or a Vue equivalent) is chosen:**

- Theming work should be front-loaded into the library's token system; avoid per-component CSS
  overrides, which do not survive major upgrades.
- The specialist components (graph, editor, timeline) must be themed to match, which means reading
  the library's tokens rather than hard-coding colours.
- Upgrade cadence becomes a maintenance commitment; major versions of these libraries are
  migrations, not bumps.
- Verify the offline build explicitly — icons, fonts and any lazily fetched assets.

**In all cases:**

- The graph renderer, SQL editor and virtualization libraries are separate dependencies with their
  own licence review; the traps listed above apply regardless of the design system.
- Charts stay deliberately light. Superset (6.1.0) is the platform's BI tool; Beluga Manager should
  not grow into a second one.
- Dark/light theme must be implemented as tokens from the start. Retrofitting themes onto
  hard-coded colours is a rewrite.
- Platform resource identifiers — topic names, table names, job names, namespaces — must never be
  translated, per the README, even when the surrounding UI is localized.
- Component-level locale coverage for `ko-KR` differs sharply between options and should be checked
  against the actual component list before deciding, not assumed.

## Open Questions for dasomel

1. **Who owns visual design?** The shadcn/headless recommendation assumes someone will make and
   maintain brand decisions. If no one will, a batteries-included library is the safer choice — this
   is the question that most affects the outcome, and the repository cannot answer it.
2. **How much does brand independence actually matter versus delivery speed?** #28 states both an
   independent Beluga experience and consistency with Narwhal patterns. These pull in opposite
   directions and the priority between them is a product call.
3. **Is there an existing Beluga or Narwhal visual identity to inherit** — logo, palette, type
   scale, Figma library? Nothing exists in this repository. If one exists elsewhere, it changes the
   starting point substantially.
4. **Is there a formal accessibility target** (e.g. WCAG 2.2 AA, or a public-sector requirement)?
   #28 lists accessibility in scope but sets no bar. A formal target would meaningfully favour
   Radix-based options and would require testing infrastructure.
5. **Is Tailwind acceptable as a project-wide styling approach?** Option R1 effectively commits to
   it. If there is an objection to utility-first CSS, R3 (Mantine) becomes the better fit.
6. **Is the log viewer (#19) in-app or a link-out to Loki?** An in-app virtualized viewer with
   search and tailing is a substantial bespoke component; linking out is nearly free. This affects
   scope more than it affects the library choice.
