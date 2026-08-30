# ADR-0002: Bootstrap-time random credential generation

- Status: Accepted
- Date: 2026-08-10
- Supersedes: implicit "fixed committed dev credentials" assumption used briefly during
  early implementation (never itself recorded as an ADR)
- Superseded by: —

## Context

During an early security review round, fixed development credentials committed to the
repository (`SET-AT-BOOTSTRAP`-style placeholders that were actually static values such
as `beluga-<client>-secret`, `admin`/`admin`) were misjudged as "repo convention" and
accepted through three review rounds. The actual sibling-project convention (narwhal)
generates credentials with `openssl rand` at install time and stores them only in a
Kubernetes Secret — it does not commit fixed values. This was discovered by direct user
correction, not by the review process (`docs/mistakes-log.md`, 2026-08-10 `gitops`
entry).

## Decision

No service credential is ever committed to the repository. Every credential (PostgreSQL,
Keycloak admin, Superset admin, APISIX admin key, per-role user passwords) is generated
with `openssl rand` during bootstrap (`scripts/gitops/*.sh`) and written only to the
Kubernetes Secret `beluga-credentials` in the `platform-system` namespace. Helm charts
receive these values exclusively via `--set` at apply time; every values-file default is
a `SET-AT-BOOTSTRAP` placeholder that is never itself a usable credential.
`scripts/credentials.sh` is the sanctioned read path for retrieving them after
bootstrap.

## Alternatives considered

- **Fixed dev credentials committed to values files** — rejected: this was the actual
  mistake this ADR corrects; committed credentials are a standing exposure even in a
  personal/learning-scale project, and normalize a pattern that would be actively
  dangerous if the repo were later made more broadly accessible.
- **External secret manager (e.g. Vault, SOPS-encrypted values)** — rejected for now:
  adds an operational dependency disproportionate to a single-host learning project;
  revisit if Beluga ever needs credentials to survive cluster recreation across hosts.
- **`.env` file with real secrets, git-ignored** — rejected: still requires a human or
  script to choose and persist a value somewhere outside version control with no
  rotation guarantee; bootstrap-time generation removes the "someone has to pick a
  password" step entirely.

## Rationale

Bootstrap-time generation removes the credential from the trust boundary of the
repository entirely — there is no fixed value to leak, screenshot, or accidentally
publish. It matches the pattern already proven in the sibling `narwhal` project, keeping
the platform trilogy consistent.

## Consequences

### Positive

- No credential exposure risk from repository history, forks, or accidental publication.
- Every environment gets fresh, unique credentials automatically.
- `scripts/credentials.sh` gives a single sanctioned retrieval path instead of scattered
  manual `kubectl get secret` calls.

### Negative / trade-offs

- Credentials do not survive `beluga-credentials` Secret deletion or namespace
  recreation without re-running the generation step — there is no backup/restore story
  for credentials by design.
- Any future automation (CI E2E against a live cluster, external tooling) must call
  `scripts/credentials.sh` rather than assume a known value, which is a small integration
  cost compared to the status quo ante.

## Affected standards, templates, and projects

- `scripts/gitops/`, `scripts/credentials.sh`, `gitops/charts/*/values.yaml` defaults
- `SECURITY.md`, `.env.example`

## Migration / adoption

Already fully adopted at the time of this record — the repository has never shipped a
committed real credential since the correction. This ADR formalizes the decision
retroactively as part of the OpenForge compliance baseline (2026-08).

## Evidence and references

- Incident record: `docs/mistakes-log.md`, 2026-08-10 `gitops` entry
- Reference implementation: sibling project `narwhal`
- Related ADRs: ADR-0001
