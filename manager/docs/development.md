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

The `manager/` directory of the beluga monorepo is structured as an npm workspace under `packages/`:

```text
manager/
├── packages/
│   ├── web/              # Frontend (React 19 + Vite SPA)
│   ├── domain-api/       # Backend / Domain API (Hono + @hono/zod-openapi)
│   └── policy-compiler/  # Beluga policy compiler and policyctl CLI
├── docs/
│   └── adr/              # Architecture Decision Records
└── (CI: ../.github/workflows/manager-ci.yml and manager-images.yml at the monorepo root)
```

### Workspace Packages

- `packages/web` (`@beluga-manager/web`): React 19 single-page application built with Vite and Tailwind CSS. Provides the Beluga Manager web console across Overview, Services, Pipelines, Data Assets, Operations, and Policy views. Architectural choices follow [ADR-0001](adr/0001-frontend-technology.md) and [ADR-0003](adr/0003-ui-design-system.md).
- `packages/domain-api` (`@beluga-manager/domain-api`): Backend Domain API service built on Node.js and Hono, using `@hono/zod-openapi` for REST endpoints and schema definitions. Serves domain resources (services, pipelines, data assets, events) with local fixtures, exports shared domain schema definitions (`./schema`), and houses the System-1 decision provider boundary (`src/decision/`). Architectural choices follow [ADR-0002](adr/0002-backend-api-technology.md).
- `packages/policy-compiler` (`@beluga-manager/policy-compiler`): Policy declaration compiler and `policyctl` CLI. Validates Beluga platform YAML policy declarations with Zod, compiles them into Keycloak configuration, Trino OPA Rego policies, and PostgreSQL DDL/role artifacts, and verifies policy drift.

Architecture and technology decisions are recorded in [Architecture Decision Records](adr/README.md) ([ADR-0001](adr/0001-frontend-technology.md), [ADR-0002](adr/0002-backend-api-technology.md), [ADR-0003](adr/0003-ui-design-system.md)).

## Local Development

Use Node.js 22 or newer and install the workspace dependencies from the `manager/` directory (the npm workspace root; `cd manager` from the beluga repository root):

```bash
npm install
```

Start the frontend and Domain API in separate terminals, both from `manager/`:

```bash
# Terminal 1: Vite frontend at http://localhost:5180
npm run dev

# Terminal 2: Domain API at http://localhost:8787 (tsx watch)
npm run dev:api
```

Or run both in one terminal with `npm run dev:all` (`scripts/dev-all.mjs`, no extra dependency). `dev:all` always uses the fixed pair 5180/8787 (CORS and `config.json` require it) and removes `PORT` from the children's environment, so a `PORT` override is ignored. Ctrl-C/SIGTERM stops both process trees. If a child process exits on its own the other is stopped and the command exits non-zero; however `tsx watch` does not exit when the API crashes (for example `EADDRINUSE`), it waits for a file change and restarts, so `dev:all` stays up after an API crash.

**D-MDEV-1: `dev:api` runs with authentication disabled.** An unset `AUTH_MODE` means `oidc`, which needs `OIDC_ISSUER`, so a bare `tsx watch` could not start locally. The root `dev:api` script therefore sets `NODE_ENV=development AUTH_MODE=disabled LISTEN_HOST=127.0.0.1` (shell env prefix, macOS/Linux; no cross-env). This is dev-only and loopback-only: the optional `LISTEN_HOST` env (not `HOST`, which shells commonly export as the machine hostname; default unchanged, all interfaces, as in containers) is set to `127.0.0.1` so the unauthenticated API is not reachable from the LAN. Note the Vite dev server (`host: true`) still listens on the LAN. `start` and `start:dist` are unchanged and the server still refuses `AUTH_MODE=disabled` when `NODE_ENV=production`. Escape hatch: set `AUTH_MODE=oidc` and `OIDC_ISSUER` yourself and run `npm run dev --workspace=packages/domain-api`.

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

**D-MDEV-2: the mock/real boundary is visible at runtime.** `GET /api/v1/health` reports `components.flink`, `components.lakekeeper` (`stub` | `live`) and `components.trinoQueryHistory` (`disabled` | `live`) and `components.fixtures` (events, resources, decisions, policies and non-Flink services; always `stub` today) from the adapters actually wired at startup (all default to stub/disabled). While any component is `stub`, the web header shows a "Fixture data" badge so fixture data is not mistaken for live state. See the [API reference](api-reference.md).

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
- **Authentication in dev**: compose sets `NODE_ENV=development` and `AUTH_MODE=disabled` explicitly (an unset `AUTH_MODE` means `oidc`, and `production` refuses `disabled`), so the local stack runs with authentication disabled. Never publish this stack beyond loopback.
- **Authentication in a cluster**: `AUTH_MODE=oidc`, `OIDC_ISSUER`, optional `OIDC_AUDIENCE`, `SSO_SOURCE=github`, and `NODE_EXTRA_CA_CERTS` pointing to the internal CA bundle (mounted file) because the JWKS and GitHub calls verify TLS against Node's trust store. See [API reference](api-reference.md#authentication-and-sso-source-d-msso-6-d-msso-12).
- **Environment**: `PORT` (API), the authentication and SSO source settings, and the optional, default-off upstream adapter settings are read: `BELUGA_FLINK_*` (Flink), `BELUGA_TRINO_*` (query history; needs a bearer token and `BELUGA_TRINO_HISTORY_ACK`), `BELUGA_LAKEKEEPER_*` (catalog; needs a bearer token and `BELUGA_LAKEKEEPER_WAREHOUSES`) and the shared `BELUGA_UPSTREAM_*`. Meanings, defaults and the fail-fast rules are in the [API reference](api-reference.md). The default stack sets none of them and has no secrets or `.env` files; the optional fake-upstream setup below passes a dummy token (`dev-dummy-token`, not a secret) through compose environment variables.
- **Hardening**: both containers run non-root with a read-only root filesystem, all capabilities
  dropped, and `no-new-privileges`.
- **Mock vs. real**: by default (`make dev-up`) the Domain API uses the stub adapter registry and the fixtures in
  `packages/domain-api/src/stub-data/`, so the stack proves UI/API behavior against fixtures only. The opt-in
  upstream adapters (Flink, Trino query history, Lakekeeper catalog) are off unless their variables are set; in this
  stack only the [fake upstreams](#fake-upstreams) below set them. Integration with a running Beluga platform is not
  covered by either mode.
- After code changes run `make dev-up` again to rebuild; for hot reload use the `npm run dev` flow above.

### Fake upstreams

`packages/domain-api/dev/mock-upstreams.mjs` is a dependency-free Node server that fakes the three upstreams the opt-in adapters read, so you can exercise them without a Beluga cluster. It serves fixed dummy data (Flink reuses the recorded fixtures in `packages/domain-api/tests/fixtures/flink-1.20/`; Trino and Lakekeeper use spec-derived shapes in `packages/domain-api/dev/mock-upstreams/`), answers `GET` only (other methods get 405), and answers 401 for Trino and Lakekeeper unless the `Authorization` header is `Bearer dev-dummy-token`. The Flink adapter sends no credential, so the fake Flink needs none. The token is a dummy literal, not a secret; never point the fake at real services or reuse a real token with it.

| Upstream | Default address | Adapter variables |
|----------|-----------------|-------------------|
| Flink | `127.0.0.1:8781` | `BELUGA_FLINK_REST_URL` |
| Trino query history | `127.0.0.1:8780` | `BELUGA_TRINO_ENABLED`, `BELUGA_TRINO_BASE_URL`, `BELUGA_TRINO_TOKEN`/`BELUGA_TRINO_TOKEN_FILE`, `BELUGA_TRINO_HISTORY_ACK=shared-service-credential` |
| Lakekeeper catalog | `127.0.0.1:8782` (base path `/catalog`) | `BELUGA_LAKEKEEPER_ENABLED`, `BELUGA_LAKEKEEPER_BASE_URL`, `BELUGA_LAKEKEEPER_WAREHOUSES=beluga_lake`, `BELUGA_LAKEKEEPER_TOKEN`/`BELUGA_LAKEKEEPER_TOKEN_FILE` |

Without a container, from `manager/` (the host process uses loopback, so `BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER` is not needed):

```bash
npm run dev:upstreams                       # terminal 1: fake upstreams on 8780-8782
(set -a; . packages/domain-api/dev/mock-upstreams.env; set +a; npm run dev:api)   # terminal 2: Domain API wired to them
```

[`packages/domain-api/dev/mock-upstreams.env`](../packages/domain-api/dev/mock-upstreams.env) holds the variables (including `NODE_ENV=development` and `AUTH_MODE=disabled`) and a token-file variant. The checked-in token file `packages/domain-api/dev/mock-upstreams/dev-token` is mode 0644, so a `*_TOKEN_FILE` setup logs a world-readable warning at startup; that is expected for a dummy.

With compose, the `upstreams` profile starts a `mock-upstreams` container (`node` image as in the Domain API Dockerfile, non-root, read-only root filesystem, all capabilities dropped, `no-new-privileges`, no published ports) and `compose.upstreams.yaml` points `domain-api` at it. The override sets `BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER=true` because the compose service name is not loopback. Use both together; `make dev-up` is unchanged:

```bash
docker compose -f compose.yaml -f compose.upstreams.yaml --profile upstreams up --build --wait -d
docker compose -f compose.yaml -f compose.upstreams.yaml --profile upstreams down --remove-orphans
```

Check with `curl http://localhost:8787/api/v1/pipelines`, `/api/v1/query-history` and `/api/v1/data-assets`. A wrong token makes query history and data assets answer 503 (the adapter's degraded behavior). `packages/domain-api/tests/upstream-mock-server.test.ts` runs the real adapters against the fake in `npm test`.

**What this proves**: adapter wiring only (environment contract, request paths, bearer header, response parsing, degradation on 401). It does **not** prove real Flink, Trino or Lakekeeper behavior (versions, authorization, pagination, vended credentials, latency); that needs integration evidence against a running platform.

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

### Web login (OIDC Authorization Code + PKCE)

The web app signs users in against Keycloak and sends `Authorization: Bearer <access_token>`
on every Domain API request (ADR-0009 D-MSSO-6; decisions D-MLOGIN-1..4 in the code comments).
Configuration is the optional `oidc` section of the runtime `/config.json`:

```json
{
  "apiBaseUrl": "https://manager.example/api",
  "oidc": {
    "issuer": "https://sso.local.beluga.internal/realms/beluga",
    "clientId": "beluga-manager",
    "redirectPath": "/auth/callback",
    "scope": "openid profile email groups"
  }
}
```

- No `oidc` section: login is disabled (local development). The header shows a "Login disabled"
  badge and requests carry no credentials. Only `issuer` is required; the other values above
  are the defaults.
- Library: `oidc-client-ts` pinned to `3.5.0` (Apache-2.0, selected over a hand-written flow;
  it always sends PKCE `S256`, `state` and `nonce`). The Keycloak client `beluga-manager` must be
  a public client with the exact redirect URI `https://<manager host>/auth/callback` and the
  manager origin as a web origin (CORS for discovery and token requests); Keycloak settings are
  *not verified* against a live realm.
- Tokens live in memory only (D-MLOGIN-1); a page reload requires one click on "Sign in". Only the
  in-flight PKCE state uses `sessionStorage`; `localStorage` is never used. A refresh token is
  used for renewal only if Keycloak issues one to the public client (*not verified*); otherwise
  the session ends at access-token expiry.
- HTTP 401 clears the session and shows the sign-in screen with an expiry notice (no automatic
  redirect, to avoid a loop when the API keeps rejecting a valid token). HTTP 403 keeps the
  session and shows an access-denied panel in the affected view. Neither is retried.
- `/auth/callback` is handled in `AuthProvider` by `location.pathname`; nginx serves `index.html`
  for it through the generic `try_files` fallback.
- The image template (`packages/web/nginx.conf`, rendered with `envsubst`) sets a CSP
  (`script-src` allows only the inline theme bootstrap by SHA-256 hash), `Referrer-Policy:
  no-referrer` (the callback URL carries the authorization code) and `nosniff`. `connect-src`
  comes from the `CSP_CONNECT_SRC` container variable (default `'self'`); set it to `'self'`
  plus the issuer origin, and the Domain API origin when it differs, e.g.
  `-e CSP_CONNECT_SRC="'self' https://sso.local.beluga.internal"`. It must agree with
  `/config.json`. Verified with a real `nginx:alpine` container (headers and callback fallback);
  a live Keycloak login in a browser is *not verified* here.
- *Not verified, deferred to the deployment PR*: the Keycloak `beluga-manager` client itself (public
  client, `groups` client scope, web origin, and the audience mapper adding `beluga-manager` to
  `aud`) is not created or checked by this change.
- `/config.json` is validated at boot: a present `oidc` key needs an `https` `issuer`, a non-empty
  `clientId`, and a `redirectPath` starting with `/`; otherwise the configuration error screen
  is shown instead of silently disabling login. `CSP_CONNECT_SRC` is validated by an entrypoint
  script (only `'self'` and `http(s)://host[:port]` sources); a bad value fails the container start.

### Web test strategy (issue #30)

`packages/web` tests run under Vitest's **Node** environment (`packages/web/vitest.config.ts`) —
view tests render with `react-dom/server#renderToStaticMarkup` and assert on the resulting HTML
string instead of simulating clicks. The login flow is the exception: `jsdom` and
`@testing-library/react` are devDependencies, and only files that need real DOM events opt in
with a `// @vitest-environment jsdom` docblock (`src/App.auth.test.tsx`, `src/auth/*.test.ts`). Run only these tests with
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

## Container Images (GHCR)

`../.github/workflows/manager-images.yml` builds `packages/domain-api/Dockerfile` and `packages/web/Dockerfile` (context `manager/`). Pull requests only build (no push); pushes to `main` and manual runs publish `ghcr.io/dasomel/beluga-manager-domain-api` and `ghcr.io/dasomel/beluga-manager-web` for `linux/amd64` and `linux/arm64` with provenance and SBOM attestations. The only tag is `sha-<40-char commit SHA>` (no `latest`); the job summary prints each image digest, and charts must pin by that digest. After the first publish the owner must set each GHCR package visibility to public (manual step).

## OpenForge status

Since the monorepo consolidation (root `docs/adr/0005`), manager no longer has its own
OpenForge portfolio entry. Its `policy-compiler` capability is reported in the repository
root `.openforge/status.json` under project `beluga`, published by the root
`.github/workflows/openforge-status.yml`; see the root `docs/development.md` for the
publishing rules.

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
