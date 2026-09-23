# Development Guide

The repository is intentionally kept lightweight until the frontend and backend technology ADRs are completed.

## Current Foundation

- Separate English and Korean user-facing documentation
- Architecture documentation
- GitHub issue-driven development
- GitHub Actions CI foundation
- English/Korean i18n requirement from MVP
- Repository-owned deterministic verification through `make verify`

## Planned Application Structure

```text
beluga-manager/
├── apps/
│   ├── web/          # Frontend
│   └── api/          # Backend / Domain API
├── packages/
│   ├── domain/       # Shared domain contracts
│   └── adapters/     # OSS integration adapters
├── docs/
└── .github/
```

The exact language and framework choices will be recorded in ADRs before implementation.

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
services, pipelines, data assets, and events. No running Beluga platform or Docker/Podman
services are required for this fixture-based UI/API workflow. These fixtures do not prove
real upstream discovery or correlation. API documentation is available at
`http://localhost:8787/api/v1/docs`.

In Operations, select an event's related service or pipeline reference to open Services
with an ID search or Pipelines with the referenced item selected. A service search with no
matches shows an empty result; a missing pipeline shows a notice. Ordinary sidebar navigation
resets this event context; it is not persisted across reloads. Kubernetes Resources and Logs remain
outside this event-navigation slice.

## Local Verification

Run the same baseline locally and in CI:

```bash
make verify
```

The foundation checks cover repository structure and documentation:

- `make lint` — compile-check the Python verifier and its tests.
- `make test` — run verifier regression tests, including a fixture that proves invalid repositories fail non-zero.
- `make verify` — run lint + tests + live repository checks for required files, bilingual documentation pairs, README language switching, local Markdown links, and GitHub workflow structure.

CI also runs `npm run typecheck`, `npm test`, and `npm run build` for the application workspaces.
The root Vitest projects cover `packages/policy-compiler`, `packages/domain-api`, and
`packages/web`. Web tests use the Node environment for API response handling, runtime
configuration, locale preferences/fallbacks, and Operations event navigation mapping;
they do not render DOM components.
Run only these tests with `npm test -- --project @beluga-manager/web`.
`npm run build` type-checks the workspaces and builds the production web bundle.

Real Kafka/Flink/Iceberg/Trino/Airflow behavior, correlation correctness, authentication, and other upstream integration paths still require integration or runtime evidence against the actual services; `make verify` does not claim to prove them.

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
remain unchanged. Date/number formatting and remaining hard-coded UI strings are not covered
by this foundation.

## Documentation Convention

User-facing Markdown documentation uses separate language files:

- English: `<name>.md`
- Korean: `<name>-ko.md`

Examples:

- `README.md` / `README-ko.md`
- `docs/architecture.md` / `docs/architecture-ko.md`
- `docs/development.md` / `docs/development-ko.md`

English is the canonical filename and Korean uses the `-ko.md` suffix. Both versions must be kept semantically synchronized.

See the [Korean development guide](development-ko.md) for the Korean version.
