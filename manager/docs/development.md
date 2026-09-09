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

## Local Verification

Run the same baseline locally and in CI:

```bash
make verify
```

The current foundation does not yet have an application build or type-check because no frontend/backend stack has been selected. The owned checks are therefore limited to what the repository actually implements today:

- `make lint` — compile-check the Python verifier and its tests.
- `make test` — run verifier regression tests, including a fixture that proves invalid repositories fail non-zero.
- `make verify` — run lint + tests + live repository checks for required files, bilingual documentation pairs, README language switching, local Markdown links, and GitHub workflow structure.

When application code is introduced, its native build/type/lint/test commands should be added behind these repository-owned targets rather than creating a second verification path.

Real Kafka/Flink/Iceberg/Trino/Airflow behavior, correlation correctness, authentication, and other upstream integration paths still require integration or runtime evidence against the actual services; `make verify` does not claim to prove them.

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
