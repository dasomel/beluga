# dasomel/openforge#54: beluga-platform-change replay

Replay date: 2026-09-24
Revision: `4a992b279f5b3d1afae52352b0bafe958fca14ba` (origin/main), fresh isolated clone, no
prior session context. `beluga-manager` used as the sibling directory is a separate isolated
clone (`origin/main` `a39ea2e62df065fbddc618ca6fe0d1021ab69c17`, see "Blocker reproduction and
resolution" below).

## Scope

`.agents/skills/beluga-platform-change/SKILL.md` (`openforge-maturity: draft`,
`openforge-version: 1`). dasomel/openforge#54's second 2026-09-17 comment kept this skill at
`draft` because "`make validate` depends on beluga-manager's `policyctl`, which fails on an
uninstalled sibling with `ERR_MODULE_NOT_FOUND: tsx`, and this cross-repo dependency is
undocumented in the skill/mistakes-log with no escalation branch for it."

## 0. Blocker reproduction and resolution

Before starting the replay proper, the cited blocker was reproduced literally: cloning
`beluga-manager` completely fresh (before running `npm install`/`npm ci`) and running this
repo's `tests/14-policy-compiler-seam.sh` as-is fails exactly as described (`make` exit 2):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from .../beluga-manager/
```

The root cause was not a defect in `beluga-manager`'s `package.json`, lockfile, or workspace
config itself (`npm ci`/`npm install` install `tsx` correctly there and that repo's own CI was
green) — it was a sequencing gap: `policyctl` is also invoked as a cross-repo tool (by this
repo's test 14, among others), and those callers had no way to know `beluga-manager`'s own
dependencies had to be installed first. `dasomel/beluga-manager#76` ("bootstrap deps when tsx
is missing from a fresh clone", `a39ea2e62df065fbddc618ca6fe0d1021ab69c17`, merged during this
replay session) added self-healing `npm ci` bootstrap logic to the `policyctl` npm script when
`tsx` is missing. Re-running the identical clean-clone reproduction after that fix self-heals
and finishes with `[TEST 14] ... PASS`, exit 0. This was a dependency issue in the adjacent
repository, not a defect in this skill itself, so no skill-text edit was needed here.

## 1. Static workflow check (step 1)

Read `AGENTS.md`, `VERSIONS.md`, and `docs/mistakes-log.md` cold and cross-checked every
workflow step against the real repository. `AGENTS.md`'s cluster verification discipline
(isolated kubeconfig, ArgoCD selfHeal, FQDN, ConfigMap restarts, dual gateway verification)
matched the skill's 9-step workflow with no contradictions. Every path in the References
section (`configs/cluster.env`, `docs/mistakes-log.md`, `tests/`) exists. No naming/path
defect (of the kind the egovframe-launcher replay found — a step pointing at a non-existent
module) was found.

## 2. Happy path (steps 3, 4, 7) — a real component version bump

Executed workflow step 3 ("treat VERSIONS.md as the source of truth and update every
repository reference that must move with it") literally. Bumped `curlimages/curl:8.21.0`
(the shared bootstrap/registration-job utility image, `VERSIONS.md` line 44) to `8.22.0` —
first confirming the tag actually exists and ships arm64 (`linux/arm64/v8`) via
`docker manifest inspect curlimages/curl:8.22.0` (per the 2026-08-10 mistakes-log lesson that
a worker's "I verified it" claim is not evidence). Updated `VERSIONS.md` (1 row) and all 4
manifest occurrences
(`gitops/charts/beluga-platform/templates/apisix-gateway.yaml` x2,
`gitops/charts/beluga-data/templates/{01-seaweedfs,03-strimzi-kafka,12-lakekeeper-bootstrap}.yaml`
x1 each).

```
$ make validate
Rendering beluga-platform chart... OK
Rendering beluga-data chart... OK
Validating YAML syntax (policies/, gitops/apps/)... OK
Checking VERSIONS.md against rendered manifest image tags... OK
...
[TEST 14] Beluga <-> Beluga-Manager policy compiler seam check: PASS
```
Exit 0 — this time the beluga-manager-side policyctl compile actually succeeded and the seam
check ran to completion (the result of the fix in section 0).

`make lint` (shellcheck + helm lint) and `make test-agent` (8 Operations Agent static security
unit tests) were also run separately and both passed clean.

## 3. Failure/edge case (real, not fabricated) — a VERSIONS.md-only drift

Reproduced exactly the case the 2026-09-17 replay comment flagged: "a VERSIONS.md-only version
bump (without updating the corresponding manifest image string) is not caught by `make
validate`" (the same drift class already logged in the 2026-08-10 mistakes-log). Starting from
the happy-path state above, reverted just the 4 manifest occurrences back to `curl:8.21.0`
while leaving `VERSIONS.md` at `8.22.0`, creating a real drift:

```
$ python3 scripts/ci/check-version-consistency.py
[curlimages/curl] MISMATCH: VERSIONS.md=8.22.0  manifest=['8.21.0']
...
One or more images are deployed at a version that disagrees with VERSIONS.md.
$ make validate
...
make: *** [validate] Error 1
```
`make` exit 2 — a real, uncoerced failure. This drift class is now caught: the repository
already had `scripts/ci/check-version-consistency.py` wired into `make validate` (a gate merged
some time after the 2026-09-17 replay, not something this replay added). The gap that comment
identified is confirmed resolved — no edit to the skill or the verification script was needed.

Reverted the 4 manifest files (`git checkout --`), then reverted `VERSIONS.md`. Confirmed
`git status --short` is empty and `make validate` returns to exit 0 (no scratch change from
this replay remains in the working tree).

## 4. Out of scope — live cluster / gateway tier

Steps 2 (create an isolated kubeconfig, then do live work), the live half of step 4 (confirm a
real rollout via ArgoCD sync), step 6 (an actual ConfigMap-driven rollout restart), step 8
(measuring both direct component access and the documented domain-registry entry point), and
`make test` (`tests/run-all.sh`, which the skill's own `make help` text states requires a live
cluster) were not run in this session. `vagrant status` shows the master/worker VMs are simply
`not created`, and `kubectl --context=vagrant-beluga` times out connecting to
`192.168.77.10:6443` — there is no live Beluga cluster in this environment. No state was
fabricated.

## Decision

`openforge-maturity` stays `draft`. The specific blocker that had been gating this skill
(the beluga-manager policyctl/tsx cross-repo dependency) is resolved by
`dasomel/beluga-manager#76`, and the static/manifest tier (`make lint`, `make validate` happy
path plus a real injected failure, `make test-agent`) now replays cleanly end to end. But the
live-cluster and gateway/auth entry-path evidence classes that this skill's own Verification
section requires remain unexercisable in this session (no cluster VMs exist at all — the same
reason narwhal-verification stays `draft`). This skill is scoped to component/GitOps/gateway
changes, so promoting it to `verified` without any live-tier evidence would mean static
evidence standing in for a higher class, which is exactly what dasomel/openforge#54 itself
rules out. No defect was found in the skill text itself (no edit needed).

Re-promotion path: from a session with access to a live Beluga cluster, replay steps 2/4/6/8,
actually apply one gateway- or auth-adjacent change, measure both direct access and the
documented domain-registry entry point, and record a follow-up to this replay.
