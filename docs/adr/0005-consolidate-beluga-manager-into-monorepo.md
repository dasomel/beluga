# ADR-0005: Consolidate beluga-manager into the beluga monorepo

- Status: Accepted
- Date: 2026-10-15
- Supersedes: [manager/docs/adr/0005](../../manager/docs/adr/0005-deployment-gitops-integration.md) (Deployment & GitOps Integration with Beluga)
- Superseded by: —

Decision IDs: D-MONO-1 (CI), D-MONO-2 (policy seam), D-MONO-3 (this ADR). The repository
import and its CI/seam wiring are in the `feat/import-beluga-manager` branch.

## Context

`beluga` (Kubernetes data platform: Bash/Helm/Python) and `beluga-manager` (TypeScript/Node
npm-workspaces control plane: `domain-api`, `policy-compiler`, `web`) lived in two repositories
and were coordinated by an umbrella workspace that is not itself a Git repository.

- **manager has no standalone deployment target.** Its upstream hosts are hardcoded
  `*.local.beluga.internal` names, its adapters are stub-only, and the chart/`Application`
  proposed by its own ADR-0005 was never implemented. It only makes sense next to the platform
  that defines those hosts.
- **The policy seam was held together by a pin.** `policies/` is compiled by manager's
  `policy-compiler` into `trino.rego` and the `db-roles.sql` generated body, and test 14 diffs
  the result. `ci.yml` and `release.yml` checked out beluga-manager at two different pinned SHAs;
  the `ci.yml` pin (`a63db0b`) had drifted 96 commits behind manager's main, and a
  compiler-contract change needed a manual pin bump in a second repository.
- Cross-repo changes (compiler plus regenerated artifacts) needed two PRs that could not be
  reviewed or merged atomically.

## Decision

1. Import beluga-manager, with full history, into `manager/` of this repository.
2. **D-MONO-1:** `manager/` keeps its own `package.json`/lockfile and gets a path-filtered
   workflow `.github/workflows/manager-ci.yml` (`manager/**` only, `working-directory: manager`)
   plus an npm Dependabot entry for `/manager`. Beluga's workflows keep covering shared
   concerns (docs, SAST, supply chain).
3. **D-MONO-2:** test 14 and `ci.yml`/`release.yml` run the policy compiler from `manager/` in
   the same tree. The pinned beluga-manager checkout is removed.
4. **D-MONO-3:** this ADR supersedes manager's ADR-0005. A separate manager deployment
   chart/`Application` is not pursued; any in-cluster deployment of manager will be a new ADR
   under `docs/adr/` of this repository.

## Consequences

- Compiler changes and regenerated `trino.rego`/`db-roles.sql` land in one PR; the seam gate
  cannot drift from the compiler.
- Manager still releases independently of the platform: its CI is path-filtered and its
  versioning is unchanged. Beluga-only PRs do not run manager CI.
- Repository-wide checks (lint, validate, docs, research, SAST) now also see `manager/`; a
  check that duplicates a manager-owned equivalent is scoped out, a security scan never is.
- Pending owner confirmation (not done by this change): transfer open beluga-manager issues
  to this repository, and archive `dasomel/beluga-manager` with a pointer to `manager/`.
- Follow-ups left open: a separate OpenForge status for manager
  (`manager/.openforge/status.json`) and manager's research-evidence gate
  (`manager/research/`) are not wired into beluga's workflows yet.

## Alternatives considered

- **Keep two repositories and bump the pin more often** — rejected: it keeps the non-atomic
  cross-repo change and a manual step that had already been missed 96 commits.
- **Publish the compiler as a versioned npm package** — rejected: adds a release pipeline for
  a tool with a single consumer.
- **Git submodule** — rejected: still a pin, and awkward for contributors and CI.
