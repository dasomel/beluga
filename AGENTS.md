# AGENTS.md

Read `CLAUDE.md` first. It contains Beluga's source map, version source-of-truth, shared-kubeconfig safety rules, GitOps self-heal behavior, and cluster verification gotchas.

Also read `README.md`, `VERSIONS.md`, relevant architecture/spec documents, and the issue/spec before editing.

- Make the smallest coherent change that solves the requested problem.
- Do not auto-fix unrelated findings; report them separately.
- Preserve GitOps ownership, namespace/service boundaries, version source-of-truth, and shared-environment safety rules.
- Treat component-version changes, GitOps ownership changes, auth/gateway behavior, RBAC/permission widening, destructive cluster actions, and source-of-truth changes as design changes.
- Let formatter/linter/Helm/YAML tooling own deterministic style; do not duplicate such rules in prompt text.
- Comments explain why, invariants, operational hazards, or compatibility constraints.
- For bugs, prefer: reproduce -> failing test/evidence -> minimal fix -> same test passes -> relevant regression suite.
- Distinguish static/manifest tests from real cluster verification. For gateway/auth changes, verify both direct component access and the documented user entry path as required by `CLAUDE.md`.
- Do not claim completion without stating which checks and real-state validations ran. Distinguish evidence classes explicitly — static/lint (`make lint`, `make validate`), live cluster verification (`make test`, `tests/*.sh`), and manual gateway/auth checks — and never imply a lower class proves a higher one.
- End substantive work as one of three states:
  - **A — Complete**: the intended behavior works on the relevant path and appropriate verification passes.
  - **B — Meaningful progress**: not complete, but one verified blocker was removed and the next blocker is isolated with evidence.
  - **C — Stop**: further work would require unjustified scope expansion, fragile patches, unsupported assumptions, or unacceptable risk — report the evidence and stop.
- Activity is not progress. A failed attempt is useful only when it narrows the problem, improves evidence, or justifies stopping (C).

Reference: https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
