# dasomel/openforge#54: beluga-platform-change verification replay (static/render tier)

Date: 2026-10-05. Base: `main` @ `2dc40eb`. Skill: `.agents/skills/beluga-platform-change/SKILL.md`, version 1.
Runtime: Claude Sonnet 5.5 subagent in a fresh session; read only `AGENTS.md`, `CLAUDE.md` and the skill first.
Evidence class: **static/render only**. The Beluga cluster was not used; no `kubectl`, no `~/.kube/config`.

## Activation

`AGENTS.md` routes component/version/GitOps/gateway/auth changes to this skill, and the skill's description and
"Use When" match a component image bump. Selected without reading any other platform document.

## Step 2 - happy path (scratch, reverted)

Task: bump the shared `curlimages/curl` utility image 8.21.0 -> 8.22.0 following workflow step 3
(`VERSIONS.md` is the source of truth; update every reference that moves with it).
`grep` found 11 references (VERSIONS.md, 4 chart templates, 4 `tests/*.sh`, EN/KO asset inventory). All were
moved together; `python3 scripts/ci/check-version-consistency.py` exited 0 and listed `curl | 8.22.0` across all
four templates as OK. Working tree was then restored with `git checkout -- .`.

## Step 3 - edge case: manifest/VERSIONS.md drift (reverted)

Invariant named by the skill (step 3): `VERSIONS.md` owns versions. Mutation: bump only
`gitops/charts/beluga-data/templates/01-seaweedfs.yaml` to `curl:8.22.0`. The repository's own check failed:

```
curl (유틸) | 8.21.0 | ...: 8.21.0, 8.22.0 | MISMATCH
FAIL: - rendered image curlimages/curl (curl (유틸)) expected 8.21.0, found 8.21.0, 8.22.0
edge_rc=1
```

After `git checkout -- .` the same check exited 0. An existing gate catches this edge case, so no new test was added.

## Step 4 - `make validate`

Exit 0, including `tests/14-policy-compiler-seam.sh` against the sibling `beluga-manager` checkout
(`trino.rego 0 diff`, seam negative fixtures reported as expected). Local helm is v4.3.0; CI pins v3.16.4.

## Not verified

Steps 2/4/6/8 live: isolated kubeconfig against a real cluster, ArgoCD selfHeal revert of an ad-hoc apply,
a ConfigMap rollout restart, and direct vs domain-registry entry-path measurement for a gateway/auth change.
`make test` / `tests/*.sh` against a live cluster. Replay is plan-level for steps 2/6/8 (see issue-123 notes);
`AGENTS.md` repeats the same rules, so the skill's causal contribution beyond AGENTS.md is not isolated.
