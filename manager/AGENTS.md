# AGENTS.md

Beluga Manager follows the OpenForge model-agnostic agent engineering model.

Inspect repository guidance, architecture, development docs, integration/domain contracts, and the issue/spec relevant to the current task before editing. Do not preload unrelated documentation or skills.

- Make the smallest coherent change that solves the requested problem.
- Do not auto-fix unrelated findings; report them separately.
- Preserve the boundary between upstream OSS APIs, integration adapters, correlation/discovery, Beluga domains, unified API, and Manager UI.
- Do not bypass the domain API from the UI to call upstream OSS directly unless the architecture explicitly permits it.
- Treat domain-model changes, correlation authority, upstream adapter contracts, auth/RBAC, destructive operations, and public API changes as design changes.
- Uncertain inferred relationships must not be presented as authoritative facts.
- Let formatter/linter rules own deterministic style. Comments explain why, invariants, trust boundaries, or non-obvious constraints.
- For bugs, prefer: reproduce -> failing test/evidence -> minimal fix -> same test passes -> relevant regression suite.
- Use integration evidence for cross-service correlation and upstream API behavior when unit tests cannot prove the real path.
- Run `make verify` as the canonical repository-owned baseline before claiming completion. `make lint` and `make test` are narrower owners when isolating failures.
- The current foundation verifier covers repository files, bilingual documentation pairs, README language switching, local Markdown links, workflow structure, Python syntax, and verifier regression tests. It does not prove real upstream OSS/API behavior.
- Choose verification proportional to task risk and user impact. Safe local/disposable inspect-edit-build-test-fix-retest work may proceed within scope; shared/production/destructive/release/credential/permission/external mutations require explicit authorization unless already granted.
- Do not claim completion without stating which checks actually ran and their scope.
- End substantive work as A) complete/verified, B) meaningful verified progress with the next blocker isolated, or C) stop with evidence when further work requires unjustified scope, fragile patches, unsupported assumptions, or unacceptable risk.

References:
- https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
- https://github.com/dasomel/openforge/blob/main/docs/model-agnostic-agent-instructions.md
- https://github.com/dasomel/openforge/blob/main/docs/user-centric-validation.md
