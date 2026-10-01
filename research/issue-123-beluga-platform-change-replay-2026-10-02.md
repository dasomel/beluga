# dasomel/beluga#123: beluga-platform-change fresh-session replay (no-cluster tier)

Date: 2026-10-02. Revision: `baabb21` (origin/main). Tracks dasomel/openforge#54.
Skill: `.agents/skills/beluga-platform-change/SKILL.md` (`openforge-maturity: draft`, version 1).
Environment: the live Beluga cluster is DOWN. No kubectl/helm-to-cluster command was run and
`~/.kube/config` was never used. Replays are fresh headless Claude sessions run in a clean
`git archive` copy of the revision (no prior context), with Bash disabled
(`--disallowedTools Bash`), so answers come only from repository files.
Raw traces: `research/evidence/issue-123-replay/*.json`; index rows in `research/evidence/2026-10.jsonl`.

Evidence-class labels: **static** = repo/lint/render; **replay** = fresh-session agent behavior
(plan-level, no execution); **live** = real cluster. No live claim is made anywhere below.

## Results per criterion

| Criterion | Class | Result | Basis |
|---|---|---|---|
| Activation (platform change loads skill) | replay | PASS | s1 stated it loaded the skill via the AGENTS.md route; s3 committed to reading it before execution |
| Non-activation (docs typo) | replay | PASS | s4 handled directly, no cluster/kubectl, no `make lint` |
| VERSIONS.md ownership + happy path | replay | PASS | s1 named `VERSIONS.md` as owner and found all 4 manifest pins plus tests/ and docs inventory (EN/KO) references, tag/arm64 check, `make lint`/`make validate` |
| Isolated kubeconfig | replay | PASS | s1, s2, s3 all: `kubectl --context=beluga config view --minify --flatten` to a /tmp copy, `KUBECONFIG=` per call, shared `~/.kube/config` untouched |
| GitOps selfHeal awareness | replay | PASS | s1, s2, s3: ad-hoc apply gets reverted; persistent fix = commit + push + ArgoCD sync |
| Cross-namespace FQDN | replay | PASS | s3: `<svc>.<ns>.svc.cluster.local`, measured service/ns/port rather than guessed |
| Direct + documented-domain validation | replay | PASS | s1, s2, s3 require both direct and `*.local.beluga.internal` entry path |
| Edge: ad-hoc apply / Pod+ArgoCD health insufficient | replay | PASS | s2 disagreed that "Running + Healthy" means fixed; required revert check, ConfigMap rollout restart, repro via the sso domain and Keycloak directly, git fix, mistakes-log entry |
| Evidence-class separation | replay | PASS | s1, s2, s3 each reported static / live / entry-path separately and refused to let a lower class stand in |
| Repository-owned checks | static | PASS | `make lint` and `make validate` (see PR) |
| Recorded report/trace | static | PASS | this file + traces + jsonl rows |

## Caveats (why replay is weaker than it looks)

- `AGENTS.md` carries the same cluster-discipline rules as the skill, so s2/s3/s4 cannot prove the
  skill (as opposed to AGENTS.md) caused the behavior. Only s1 shows explicit skill loading.
- All scenarios are plan-level. No agent executed an apply, so "not treated as a persistent fix" is
  a stated intention, not an observed action.
- s1 flagged that the 2026-09-24 replay bump (curl 8.22.0) was reverted and 8.21.0 remains; that is
  expected (scratch change), not a defect.
- No skill-text defect was exposed; the skill is unchanged except the Verification pointer.

## Decision

`openforge-maturity` stays `draft`. The skill's own Verification section requires a session with
live cluster access to replay steps 2/4/6/8 against an actual gateway/auth-adjacent change, and
openforge#54 forbids static/replay evidence standing in for live evidence. That bar cannot be met
now. Outstanding (all **live**, none done): (1) create the isolated kubeconfig against the real
cluster (step 2); (2) apply a gateway/auth-adjacent change via git and confirm the ArgoCD rollout,
and observe selfHeal reverting an ad-hoc apply (step 4); (3) a real ConfigMap rollout restart
(step 6); (4) measure direct component access and the documented domain-registry entry point
(step 8); (5) `make test` (`tests/run-all.sh`) against the live cluster. After those, flip
maturity to `verified` and bump the version in a follow-up PR.
