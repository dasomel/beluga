# dasomel/openforge#54: beluga-manager-integration-contract replay

Replay date: 2026-09-23
Revision: `e6397c01944bfc346299b16c578ab58497fc6298` (origin/main), isolated worktree, no prior
session context.

## Scope

`.agents/skills/beluga-manager-integration-contract/SKILL.md` (`openforge-maturity: draft`,
`openforge-version: 1`). Acceptance bar for promotion is set both by the skill's own
Verification section and by beluga-manager#51's closing comment: "replay the integration
skill from a fresh session against one upstream-adapter -> correlation/domain API -> Manager
UI path, include one stale/uncertain-correlation or upstream-failure edge case, distinguish
static checks from real upstream integration evidence, then promote maturity only if the
replay passes."

## Static workflow check (steps 1, 2, 3, 5, 7)

Read `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/development.md` cold, then checked
the workflow's claims against the real tree:

- `packages/domain-api/src/routes/*.ts` (dataAssets, events, health, pipelines, services) serve
  from `packages/domain-api/src/stub-data/*`, not a live upstream client — matches the
  architecture doc's own statement that the repo is "an architecture and contract foundation."
- `packages/web/src/api/client.ts` only exposes a generic `apiGet(baseUrl, path)` against the
  Domain API; `grep -rniE "kafka|flink|iceberg|trino|airflow" packages/web/src` hits only
  labels/mock display strings (`mockData.ts`, `translations.ts`, view copy), never a direct
  upstream client call. Step 5 ("frontend consumes Beluga domain APIs; do not bypass them")
  holds for real, not just by convention.
- `docs/IMPLEMENTATION-STATUS.md:20,25,31` states explicitly: "No backend/API route or
  integration adapter has been implemented yet" and "Kafka/Flink/Iceberg/Trino/Airflow
  integration and cross-service domain views remain planned." No `adapter`, `correlation`, or
  `discovery` module exists under `packages/domain-api/src` (only `decision`, `lib`, `routes`,
  `schema`, `stub-data`).

No naming/path defect found in the skill text itself (contrast with the egovframe-launcher
replay, which found a step referencing a module that does not exist) — the workflow's claims
match the real repo.

## Deterministic verification (happy path)

```
$ make verify
python3 -m compileall -q scripts tests
python3 -m unittest discover -s tests -p 'test_*.py'
.......
Ran 7 tests in 0.081s
OK
python3 scripts/verify.py
Beluga Manager repository verification: PASS
```
Exit 0.

## Edge/failure case (real, not fabricated)

Appended a dangling local Markdown link to `docs/architecture.md` — link text
"broken-link-injected-for-replay", target `does-not-exist-issue54.md` (a file that does not
exist) — and re-ran the same command:

```
$ make verify
...
python3 scripts/verify.py
ERROR: Broken local link: docs/architecture.md -> ./does-not-exist-issue54.md
make: *** [verify] Error 1
```
Exit 2 (real, uncoerced failure). Reverted the file; `make verify` returned to PASS
(`git status --short` clean afterward, worktree untouched otherwise).

## Repository-owned contract gate

```
$ python3 <openforge>/templates/scripts/audit-agent-skills.py . --strict
skills: 1  findings: 0
SKILL .agents/skills/beluga-manager-integration-contract/SKILL.md: name=beluga-manager-integration-contract scope=project maturity=draft lines=68
```

## Why this does not clear the promotion bar

The happy path and the edge case above are real and both pass, and they are the entirety of
what the skill's own "Verification" section demands operationally (`make verify`). But
beluga-manager#51's closing comment set a stricter, repo-specific bar for *this* skill:
an actual upstream-adapter -> correlation/domain API -> Manager UI path, with a
stale/uncertain-correlation or upstream-failure edge case. That scenario cannot be replayed
today — not because the environment lacks a live service (the narwhal-verification/live-cluster
situation), but because no upstream adapter, correlation index, or live domain-API route exists
in this codebase yet (`docs/IMPLEMENTATION-STATUS.md`, confirmed above). There is nothing to
inject a stale-correlation or upstream-failure fault into.

This is not a defect in the skill's instructions — the skill's own Verification section already
states it "does not claim to prove real Kafka/Flink/Iceberg/Trino/Airflow behavior, correlation
correctness, authentication, or other upstream service paths." It is a real, structural gap
between what `openforge-maturity: verified` would claim and what the repository can currently
demonstrate.

## Decision

`openforge-maturity` stays `draft`. The deterministic/static tier of this skill is now formally
replayed and evidenced (this file); the domain-integration tier remains correctly gated on
`packages/domain-api` growing a real upstream adapter to replay against. Re-run this replay,
scoped to steps 2-4/6, once a first adapter (or the `packages/domain-api` -> live service path
for the "First Vertical Slice" in `docs/architecture.md`) lands.
