# dasomel/beluga#123: beluga-platform-change fresh-session replay

Date: 2026-11-09. Branch: `chore/123-skill-replay`. Tracks dasomel/openforge#54.
Scope: offline/static replay of `.agents/skills/beluga-platform-change/SKILL.md` against a
hypothetical chart value change. No manifests or runtime behavior were changed.

## Plan

- Goal: replay activation, happy-path instructions and the self-heal/user-entry-path edge case.
- Files: this report and the skill's replay pointer only.
- Approach: inspect the skill and repository-owned checks, execute offline gates, report evidence
  by class. Leave charts, versions and cluster state untouched.
- Out of scope: live kubeconfig, `kubectl`, `helm` cluster operations, auth/gateway mutation,
  runtime changes and `make test` (live suite).
- Verification: run `make lint`, `make validate`, and the existing version consistency check.

## Replay trace

This replay was performed in the task's fresh session by reading `AGENTS.md` first, then the
skill. It is an execution trace of repository gates, not an independent fresh runtime or live
cluster replay.

| Step | Instruction / evidence class | Command or inspection | Result |
|---|---|---|---|
| Activation | `AGENTS.md` routes GitOps/platform changes to the skill; replay class | Read `AGENTS.md`, then the skill | PASS; correct skill selected for hypothetical chart value change |
| Happy path / ownership | Static | Read `VERSIONS.md`, version validator and Makefile validate recipe | PASS; `VERSIONS.md` is canonical for image/chart versions; existing gate checks rendered pins. No version changed. |
| Kubeconfig isolation | Live procedure; not executed | `kubectl --kubeconfig .kube/config config view --minify --flatten > /tmp/beluga-kubeconfig.yaml` | NOT EXECUTED by offline-only scope; no cluster access or isolation is claimed. |
| GitOps ownership / self-heal | Static/replay edge | Inspected `AGENTS.md` and skill workflow step 4; assessed ad-hoc apply to self-healed Application | PASS as an instruction-level regression: ad-hoc apply is not persistent; durable state must be committed in owning Git source and confirmed via ArgoCD. No apply/revert was performed. |
| Namespace service contract | Static | Inspected skill step 5 and `tests/16-lakehouse-netpol.sh` | PASS; cross-namespace references use `<service>.<namespace>.svc.cluster.local`. |
| ConfigMap restart | Static | Inspected skill step 6 and AGENTS rule | PASS; explicitly assess workload restart after ConfigMap changes. No ConfigMap change occurred. |
| Gateway/auth entry path | Static/replay edge | Inspected skill step 8 and AGENTS domain registry | PASS as a required check: direct component plus documented domain entry path; Pod/ArgoCD health alone is insufficient. NOT EXECUTED live. |
| Evidence separation | Static | Inspected Verification section and AGENTS evidence tiers | PASS; static/render, live and manual user-path evidence are distinct. |
| Existing checks | Static/render | `make lint`; `make validate`; `python3 scripts/ci/check-version-consistency.py` | PASS; details below. |

## Verification results

- `make lint`: PASS (exit 0; shellcheck and both Helm chart lints).
- `make validate`: FAIL (exit 2) at `tests/14-policy-compiler-seam.sh`: npm policyctl could not
  load `tsx` (`ERR_MODULE_NOT_FOUND`). Earlier render, YAML, VERSIONS and static checks in the
  target completed; installing dependencies was prohibited, so the run was not retried.
- `python3 scripts/ci/check-version-consistency.py`: PASS (exit 0; rendered image tags conform
  to `VERSIONS.md`).
- Existing validator self-test (`module.self_test()`): PASS (exit 0; includes matched, missing,
  allowlisted, stale allowlist and mismatched version cases). The repository integration gate
  already covers VERSIONS drift, so no second validator was added.

## Evidence boundary and findings

Evidence above is static/render except where explicitly labeled replay decision-rule. Self-heal
and health-vs-user-path outcomes were not observed live. No `kubectl`, cluster `helm`, `make test`,
ArgoCD sync, direct gateway request or documented-domain request was run. Those classes remain
NOT EXECUTED.

No stale command/path requiring a skill change was found. The skill already limits `verified` to
static/render and explicitly excludes live evidence. No maturity promotion is claimed; the skill
remains `verified` at its documented static/render tier. Live replay of isolation,
self-heal/ArgoCD persistence, restart behavior, and direct plus documented-domain entry path
remains outstanding.
