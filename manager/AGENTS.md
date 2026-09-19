# AGENTS.md

Beluga Manager follows the OpenForge model-agnostic agent engineering model.

Inspect repository guidance, architecture, development docs, integration/domain contracts, and the issue/spec relevant to the current task before editing. Do not preload unrelated documentation or skills.

## Instruction routing

- `AGENTS.md` is the canonical portable repository contract.
- Load detailed documents and `.agents/skills/` only when relevant to the current task.
- Tool-specific adapters contain runtime-specific behavior only and must not duplicate this contract.
- Prefer scripts, tests, linters, policy, or CI for deterministic enforcement.

For upstream OSS adapters, discovery/correlation, Beluga domain/API, or Manager UI integration work, load `.agents/skills/beluga-manager-integration-contract/SKILL.md` when relevant.

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


## Risk-scaled change workflow

- Class A documentation-only changes use the Issue/PR as the change record.
- Class B internal behavior changes require explicit acceptance criteria; use a Change Package when the work is complex, cross-component, or operationally risky.
- Class C dependency/runtime/toolchain/build-contract changes and Class D release/deployment/security-boundary changes require an accepted Change Package before broad implementation.
- For Class C/D or complex Class B work, load `.agents/skills/change-package-workflow/SKILL.md` and use `templates/change/CHANGE.md` plus `templates/change/TASKS.md` when a versioned working artifact is useful.
- Keep requirement → acceptance scenario → task → evidence traceability. Material scope changes require package update and re-review.
- At completion, synchronize durable truth into code/tests, normative docs, ADRs, evidence, and portfolio/status records; do not maintain a duplicate long-lived specification tree.
