# AGENTS.md

Beluga Manager follows the OpenForge agent engineering model; change classes and completion states are defined in https://github.com/dasomel/openforge/blob/main/docs/change-management.md and https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md.

## Boundaries

- Keep the boundary between upstream OSS APIs, integration adapters, correlation/discovery, Beluga domains, unified API, and Manager UI. The UI must not bypass the domain API to call upstream OSS directly unless the architecture explicitly permits it.
- Domain-model changes, correlation authority, upstream adapter contracts, auth/RBAC, destructive operations, and public API changes are design changes.
- Uncertain inferred relationships must not be presented as authoritative facts.
- Do not auto-fix unrelated findings; report them separately.

## Verification

- `make verify` is the canonical baseline (`make lint` / `make test` isolate failures). It covers required repository files, bilingual doc pairs, README language switcher, local Markdown links, workflow structure, Python syntax, and verifier tests. It does not prove real upstream OSS/API behavior; use integration evidence for cross-service correlation and upstream API behavior.
- Shared/production/destructive/release/credential/permission/external mutations need explicit authorization.

## Skills

For upstream OSS adapters, discovery/correlation, Beluga domain/API, or Manager UI integration work, load `.agents/skills/beluga-manager-integration-contract/SKILL.md`.
