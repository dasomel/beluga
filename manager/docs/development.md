# Development Guide

The repository is intentionally kept lightweight until the frontend and backend technology ADRs are completed.

## Current Foundation

- Separate English and Korean user-facing documentation
- Architecture documentation
- GitHub issue-driven development
- GitHub Actions CI foundation
- English/Korean i18n requirement from MVP

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

Until the application stack is selected, repository validation can be run through GitHub Actions. Local development commands will be added together with the selected frontend/backend toolchains.

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
