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
- Do not claim completion without stating which checks and real-state validations ran.
- End substantive work as A) complete/verified, B) meaningful verified progress with the next blocker isolated, or C) stop with evidence when further work requires unjustified scope, fragile patches, unsupported assumptions, or unacceptable risk.

Reference: https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
