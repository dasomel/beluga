# Development Guide

Frontend and backend technology choices are recorded in the ADRs linked below; the workspace structure section describes what is implemented today.

## Current Foundation

- Separate English and Korean user-facing documentation
- Architecture documentation
- GitHub issue-driven development
- GitHub Actions CI foundation
- English/Korean i18n requirement from MVP
- Repository-owned deterministic verification through `make verify`

## Application Structure

The repository is structured as an npm workspace under `packages/`:

```text
beluga-manager/
├── packages/
│   ├── web/              # Frontend (React 19 + Vite SPA)
│   ├── domain-api/       # Backend / Domain API (Hono + @hono/zod-openapi)
│   └── policy-compiler/  # Beluga policy compiler and policyctl CLI
├── docs/
│   └── adr/              # Architecture Decision Records
└── .github/              # CI workflows and automation
```

### Workspace Packages

- `packages/web` (`@beluga-manager/web`): React 19 single-page application built with Vite and Tailwind CSS. Provides the Beluga Manager web console across Overview, Services, Pipelines, Data Assets, Operations, and Policy views. Architectural choices follow [ADR-0001](adr/0001-frontend-technology.md) and [ADR-0003](adr/0003-ui-design-system.md).
- `packages/domain-api` (`@beluga-manager/domain-api`): Backend Domain API service built on Node.js and Hono, using `@hono/zod-openapi` for REST endpoints and schema definitions. Serves domain resources (services, pipelines, data assets, events) with local fixtures, exports shared domain schema definitions (`./schema`), and houses the System-1 decision provider boundary (`src/decision/`). Architectural choices follow [ADR-0002](adr/0002-backend-api-technology.md).
- `packages/policy-compiler` (`@beluga-manager/policy-compiler`): Policy declaration compiler and `policyctl` CLI. Validates Beluga platform YAML policy declarations with Zod, compiles them into Keycloak configuration, Trino OPA Rego policies, and PostgreSQL DDL/role artifacts, and verifies policy drift.

Architecture and technology decisions are recorded in [Architecture Decision Records](adr/README.md) ([ADR-0001](adr/0001-frontend-technology.md), [ADR-0002](adr/0002-backend-api-technology.md), [ADR-0003](adr/0003-ui-design-system.md)).

## Local Development

Use Node.js 22 or newer and install the workspace dependencies from the repository root:

```bash
npm install
```

Start the frontend and Domain API in separate terminals, both from the repository root:

```bash
# Terminal 1: Vite frontend at http://localhost:5180
npm run dev

# Terminal 2: Domain API at http://localhost:8787 (tsx watch)
npm run dev:api
```

Open `http://localhost:5180`. The frontend reads `apiBaseUrl` from
`packages/web/public/config.json`, which defaults to `http://localhost:8787`.
The API currently allows the frontend origin `http://localhost:5180` through CORS;
use that hostname and keep port 5180 available. Both servers accept a `PORT` override,
but changing the API port also requires updating `apiBaseUrl`, and changing the frontend
origin requires updating the API's CORS configuration.

The Domain API serves local fixtures from `packages/domain-api/src/stub-data/`, including
services, pipelines, data assets, events, and Kubernetes resources. No running Beluga platform or Docker/Podman
services are required for this fixture-based UI/API workflow. These fixtures do not prove
real upstream discovery or correlation. API documentation is available at
`http://localhost:8787/api/v1/docs`.

In Operations, switch between the event timeline, Kubernetes resources, and Decisions (System-1).
Decisions uses fixed telemetry fixture projections from `/api/v1/decisions`; confidence is labeled
advisory and uncalibrated, and no automatic action runs. Abstained records show a localized label
for their locale-neutral abstain code. Resource rows link to
related events, services, and pipelines. Events with a resource reference have a resource pill that
opens the resource list with that item highlighted. A resource opens its logs in a new tab only when
`logsUrl` is present; fixtures leave it null because no observability endpoint is configured.
Manager does not store logs. These are stub fixtures, not live Kubernetes discovery.

## Containerized Local Stack (Docker / Podman)

`compose.yaml` runs the Domain API and the web console as containers, using the existing
`packages/*/Dockerfile` images. No Beluga platform, credentials, or secrets are needed.

```bash
make dev-up      # build images, start, and wait until both healthchecks pass
make dev-down    # stop and remove containers and the network

# Podman: make dev-up COMPOSE="podman compose"   (v2 compose provider; unverified)
```

| Service | URL (host, loopback only) | Healthcheck |
|---------|---------------------------|-------------|
| web (nginx, uid 101) | `http://localhost:5180` | `GET /` |
| domain-api (node, uid 1000) | `http://localhost:8787` (`/api/v1/health`, `/api/v1/docs`) | `GET /api/v1/health` |

- **Ports are fixed**: the web bundle ships `apiBaseUrl: http://localhost:8787` and the API's CORS
  allows only `http://localhost:5180`, so the host ports must stay 5180 and 8787 (free them first).
- **Supported forms**: `docker compose` and `podman compose` (v2 provider; `up --wait` is required, so `podman-compose` is not supported). Podman remains unverified.
- **Privileged port**: nginx binds `:80` as uid 101 with `cap_drop: ALL`, relying on `net.ipv4.ip_unprivileged_port_start` (default in Docker 20.10+/Podman); older engines may need a higher internal port.
- **Environment**: `PORT` (API) and the optional, default-off Flink adapter settings (`BELUGA_FLINK_*`, see [API reference](api-reference.md)) are read; there are no secrets or `.env` files.
- **Hardening**: both containers run non-root with a read-only root filesystem, all capabilities
  dropped, and `no-new-privileges`.
- **Mock vs. real**: the Domain API always uses the stub adapter registry and the fixtures in
  `packages/domain-api/src/stub-data/`. There is no real-upstream mode yet, so this stack proves
  UI/API behavior against fixtures only, not integration with a running Beluga platform.
- After code changes run `make dev-up` again to rebuild; for hot reload use the `npm run dev` flow above.

## Local Verification

Run the same baseline locally and in CI:

```bash
make verify
```

The foundation checks cover repository structure and documentation:

- `make lint` — compile-check the Python verifier and its tests.
- `make test` — run verifier regression tests, including a fixture that proves invalid repositories fail non-zero.
- `make audit` — run production dependency vulnerability scanning and license policy checks.
- `make verify` — run lint + tests + live repository checks for required files, bilingual documentation pairs, README language switching, local Markdown links, and GitHub workflow structure.

CI also runs `npm run typecheck`, `npm test`, and `npm run build` for the application workspaces.
The root Vitest projects cover `packages/policy-compiler`, `packages/domain-api`, and
`packages/web`.
`npm run build` type-checks the workspaces and builds the production web bundle.

Real Kafka/Flink/Iceberg/Trino/Airflow behavior, correlation correctness, authentication, and other upstream integration paths still require integration or runtime evidence against the actual services; `make verify` does not claim to prove them.

### Web test strategy (issue #30)

`packages/web` tests run under Vitest's **Node** environment (`packages/web/vitest.config.ts`) —
there is no jsdom or `@testing-library/react` dependency, so tests render with
`react-dom/server#renderToStaticMarkup` and assert on the resulting HTML string instead of
simulating clicks or other DOM events. Run only these tests with
`npm test -- --project @beluga-manager/web`.

Coverage layers:

- **Pure-function/unit tests** — one `*.test.ts` per module colocated with the code it covers
  (e.g. `catalogSql.test.ts`, `decisionLabels.test.ts`, `eventNavigation.test.ts`,
  `safeExternalUrl.test.ts`, the `i18n/` helpers). These are the fastest and most exhaustive
  layer and are used to cover branches a static render can't reach (e.g. which section a click
  would switch `OperationsView` to).
- **View/component tests** — one `*.test.tsx` per view under `src/views/` (`OverviewView`,
  `ServicesView`, `PipelinesView`, `ArchitectureView`, `OperationsView`, `DataCatalogView`,
  `QueryWorkspaceView`, `PolicyView`). Each mocks `../api/hooks` with `vi.mock` and a
  `vi.hoisted` fixture object so tests control the query result per case, then render the view via
  `renderToStaticMarkup`. Coverage varies by view: most query-backed views assert loading, error,
  empty, and loaded states in `en-US`, with at least one Korean-locale check per view (not every
  state repeated in Korean); `QueryWorkspaceView` has no server query and no loading/error/empty
  states of its own, so its tests instead cover its rendering variants (default preset, a
  caller-provided `initialSql`, and the catalog-source breadcrumb) plus one Korean check. Fixtures
  are hand-written, schema-shaped literals — not verbatim copies of the `domain-api` stub data
  (`packages/domain-api/src/stub-data/`, which is outside that package's public surface; it only
  exports `./schema`) — and some intentionally diverge from the stub values to exercise a specific
  branch, e.g. `OperationsView.test.tsx` gives a resource an `https://` `logsUrl` (the stub's
  matching resource has `logsUrl: null`) to render the "view logs" link, and the journey fixture
  below trims a table to 3 columns instead of the stub's 7 since column count isn't relevant there.
- **Critical journey test** — `catalogToQueryJourney.test.tsx` covers "Catalog → Table → Query"
  end to end through the real production functions, not a re-derivation of them: it calls
  `handleOpenInQuerySelection` (the exact function `DataCatalogView`'s "Open in Query" button
  invokes) with a real `onSelectQuery` spy and asserts the SQL/table it was called with, then
  feeds that captured payload into `mapCatalogQueryTargetToWorkspaceProps` (the exact function
  `App.tsx` uses to wire the `query` tab) and renders `QueryWorkspaceView` with the result,
  asserting the SQL and catalog-source breadcrumb. Both functions are exported from production
  code specifically so this chain can be tested without simulating a click (no jsdom).
- **Known gap**: interactions that only change state via an `onClick` with no seedable prop (for
  example `OperationsView`'s events/resources/decisions tab switch beyond the `initialResourceId`
  / `initialEventId` seams) cannot be driven from this test layer; only the tab affordance itself
  is asserted, and the underlying selection logic is unit-tested separately. Closing this gap
  would require adding jsdom/testing-library, which is out of scope for this slice.

All web fixtures are hand-authored, deterministic, and require no network access, matching the
air-gapped requirement in issue #30.

### Dependency Vulnerability & License Policy Scanning

Beluga Manager enforces dependency security and license compliance gates for production dependencies (`--omit=dev`):

1. **Dependency Vulnerability Scan** (`scripts/ci/check-dependency-vulnerabilities.mjs`):
   - Runs `npm audit --omit=dev --json` against the installed lockfile.
   - Fails loudly on any `high` or `critical` severity vulnerability. Informational, low, and moderate findings are summarized without failing the check.
   - Suppresses reviewed, time-boxed exceptions listed in [`policies/vulnerability-exceptions.json`](../policies/vulnerability-exceptions.json).
2. **License Policy Scan** (`scripts/ci/check-license-policy.mjs`):
   - Scans installed production dependencies from `node_modules` (resolved via `package-lock.json`).
   - Validates declared licenses against the approved list in [`policies/license-policy.json`](../policies/license-policy.json) (`0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `ISC`, `MIT`).
   - Rejects unapproved, missing, or unparseable licenses, unless a valid reviewed exception exists in the policy.
   - Executes built-in synthetic fixture self-tests on every run to prevent regression.

#### Running Checks Locally

```bash
# Run both dependency vulnerability and license policy checks:
make audit
# or
npm run audit

# Run individually:
node scripts/ci/check-dependency-vulnerabilities.mjs
node scripts/ci/check-license-policy.mjs
# Inspect license inventory as JSON:
node scripts/ci/check-license-policy.mjs --json
```

#### Adding a Vulnerability Exception

When a high or critical finding cannot be immediately resolved by an upstream update (e.g. false positive, sandboxed usage, or patch pending), add a time-boxed reviewed exception to [`policies/vulnerability-exceptions.json`](../policies/vulnerability-exceptions.json):

```json
[
  {
    "advisoryId": "GHSA-xxxx-xxxx-xxxx",
    "package": "example-pkg",
    "reason": "Not reachable in runtime context; patch tracked in issue #XX",
    "reviewedBy": "security-team",
    "expiresAt": "2026-12-31"
  }
]
```

All fields (`advisoryId`, `package`, `reason`, `reviewedBy`, `expiresAt`) are required. If `expiresAt` is in the past, the check will fail loudly to prevent stale suppression. An exception only matches the specific `advisoryId` it names — a finding npm audit reports without a parseable advisory id (a via-chain reference only) is never matched by wildcard and always fails until resolved, unless the exception explicitly sets `"advisoryId": "*"` to knowingly suppress every high/critical finding on that package.

#### Adding a License Policy Exception

If a dependency uses a license not in the approved list, add a reviewed exception to `exceptions` in [`policies/license-policy.json`](../policies/license-policy.json):

```json
{
  "approvedLicenses": [
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "ISC",
    "MIT"
  ],
  "exceptions": [
    {
      "package": "example-pkg",
      "license": "Custom-License",
      "reason": "Permissive terms reviewed and approved for use",
      "reviewedBy": "legal-security",
      "expiresAt": "2026-12-31"
    }
  ]
}
```

Expired exceptions (`expiresAt` in the past) fail automatically.

## OpenForge status

`.github/workflows/openforge-status.yml` publishes `.openforge/status.json` (the
`openforge-project-status/v1` payload) to the `dasomel/openforge` portfolio after CI
succeeds on `main`, or on manual `workflow_dispatch`. It requires the repository secret
`OPENFORGE_STATUS_TOKEN` (a narrowly-scoped token able to open a PR in
`dasomel/openforge`); when the secret is absent the workflow validates
`.openforge/status.json` and logs a skip message instead of failing. The `revision` and
`evidence.commit` fields in `.openforge/status.json` must be the verified SHA that CI
actually ran against. The workflow enforces this: `revision` must be a verified commit
reachable from the run's SHA (an ancestor of, or equal to, the checked-out commit); the
job fails otherwise.

## Internationalization

All user-facing strings must use translation keys. Add both English and Korean translations when introducing a new UI string. API/domain objects must remain locale-neutral.

The web app restores a supported manual choice from localStorage (`beluga_locale`) before
checking `navigator.language`: Korean language tags use `ko-KR`; English and unsupported
languages use `en-US`. Only manual choices are saved. Unavailable or blocked storage falls
back to the browser language on the next load and does not prevent changing the current session.
Missing messages fall back to English, then the dotted translation key. The web Vitest suite
checks that English and Korean have identical nested key sets. Resource names and identifiers
remain unchanged. Date, number, and percent formatting are handled by `packages/web/src/i18n/format.ts`,
and plural-aware count strings are supported by `interpolateCount` in `packages/web/src/i18n/interpolate.ts` (English count keys use an explicit `(s)` suffix, e.g. `{count} row(s)`).
User-facing strings are protected against hardcoded literals by the AST guard in `packages/web/src/i18n/hardcodedStringGuard.ts`.

### Adding a New Locale

To add a new locale to Beluga Manager:

1. **Add the locale type**: Add the new locale identifier (e.g., `'ja-JP'`) to the `Locale` union type in `packages/web/src/i18n/translations.ts`.
2. **Provide translations**: Add the new locale catalog to `translations` in `packages/web/src/i18n/translations.ts`. It must match the `Translations` interface shape exactly; TypeScript enforces key parity across all locales at compile time.
3. **Locale detection and persistence**: Browser language detection, storage key (`beluga_locale`), fallback logic, and persistence reside in `packages/web/src/i18n/locale.ts` (`getInitialLocale`, `persistLocale`). Update `getInitialLocale` to map browser language tags to the new locale if automatic detection is desired.
4. **Verification**:
   - Run `npm test` to execute translation key parity checks (`packages/web/src/i18n/getTranslations.test.ts`), locale detection and persistence tests (`packages/web/src/i18n/locale.test.ts`), interpolation tests (`packages/web/src/i18n/interpolate.test.ts`), formatting tests (`packages/web/src/i18n/format.test.ts`), and the hardcoded string guard (`packages/web/src/i18n/hardcodedStringGuard.test.ts`).
   - Run `npm run typecheck` to confirm TypeScript validates complete key coverage and type conformance.

## Documentation Convention

User-facing Markdown documentation uses separate language files:

- English: `<name>.md`
- Korean: `<name>-ko.md`

Examples:

- `README.md` / `README-ko.md`
- `docs/architecture.md` / `docs/architecture-ko.md`
- `docs/development.md` / `docs/development-ko.md`
- `docs/api-reference.md` / `docs/api-reference-ko.md`
- `docs/troubleshooting.md` / `docs/troubleshooting-ko.md`

English is the canonical filename and Korean uses the `-ko.md` suffix. Both versions must be kept semantically synchronized.

See the [Korean development guide](development-ko.md) for the Korean version.
