# Development Guide

English | [한국어](development-ko.md)

Local development and contribution instructions. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for the contribution workflow and commit conventions; this document focuses on the
command surface and verification levels.

## Command surface

```text
make up       # boot the full cluster + GitOps bootstrap (bash scripts/up.sh)
make status   # VM and K8s pod status
make test     # tests/run-all.sh — real-state E2E verification (requires a live cluster)
make lint     # shellcheck (scripts/, tests/, demo/) + helm lint
make validate # static manifest/YAML validation — no cluster required
make down     # vagrant destroy -f
make clean    # remove .kube/ cache
```

## Verification levels

Distinguish three levels when reporting whether something works — see
[AGENTS.md](../AGENTS.md) for the evidence-first rule this backs:

1. **Static** (`make lint`, `make validate`) — shellcheck, `helm lint`, `helm template`
   render, and YAML syntax checks. Proves the manifests are well-formed; proves nothing
   about runtime behavior. This is what CI runs on every PR
   ([.github/workflows/ci.yml](../.github/workflows/ci.yml)).
2. **Live E2E** (`make test`) — `tests/01-cluster-health.sh` through
   `tests/10-tls-identity-boundary.sh` (plus the standalone `tests/06-authz-defaults.sh`)
   query real cluster state (pod health, Kafka/CDC flow, Iceberg tables, Trino queries,
   Airflow DAGs, authz defaults, TLS/identity boundary). Requires a booted cluster;
   cannot run in GitHub Actions. The one exception is
   `tests/11-identity-plaintext-preflight.sh`: it renders the Helm charts with
   `helm template` and statically scans the output for plaintext identity endpoints, so
   it needs no live cluster and passes locally without one.
3. **Manual gateway/auth verification** — for auth and gateway changes, verify both
   direct component access and the documented user entry point (the APISIX gateway
   domain registry). See the 2026-08-25 `orch` entry in
   [docs/mistakes-log.md](mistakes-log.md) for why this distinction matters.

"Renders/lints successfully" and "actually works" are different claims. Do not conflate
them when reporting completion.

The offline dependency gate in `make validate` can also be run with
`python3 scripts/ci/check-dependency-integrity.py`. It requires exact pins and SHA-256
hashes in `requirements-ci.txt` and checks literal pip installation commands in
`.github/workflows/*.yml`, `Makefile`, `scripts/`, and `tests/`. Installations must use
`--require-hashes -r <local-file>`; referenced requirements receive the same validation.
Only quiet flags are additionally accepted. Exceptions require an exact path/command
and a reason in the checker; there are currently none. The supported syntax is
deliberately narrow (single lines or backslash continuations, including quoted commands).
Dynamic command construction is outside this static check. Temporary positive and
negative fixtures run every time, covering missing/malformed hashes, unpinned versions,
source substitution, missing hash enforcement, versioned pip executables
(`pip3.12`, `/usr/bin/pip3`), `python -m pip`/`-mpip` module invocation, `.yaml` (not
just `.yml`) workflow files, and shell redirection (`>`, `>>`, `2>&1`, `2>/dev/null`,
`| tee`) after a compliant install. This preserves CI's pip hash check; it does not
download artifacts, prove their provenance, or exercise Flink JAR checksums.

Known limitation: `-r <file>` arguments are always resolved relative to the repository
root, not to the working directory the invoking shell would actually use (e.g. a script
that `cd`s first, a Makefile recipe's directory, or a workflow step's
`working-directory:`). Every current call in this repository runs from the repository
root, so this does not produce false positives/negatives today, but a new call that
`cd`s elsewhere before using a relative `-r` path would not be checked correctly. Keep
new pip install calls rooted at the repository root, or update the checker's docstring
and this paragraph if that changes.

## OpenForge status

[.github/workflows/openforge-status.yml](../.github/workflows/openforge-status.yml)
publishes `.openforge/status.json` (the `openforge-project-status/v1` payload) to the
`dasomel/openforge` portfolio after CI succeeds on `main`, or on manual
`workflow_dispatch`. It requires the repository secret `OPENFORGE_STATUS_TOKEN`
(a narrowly-scoped token able to open a PR in `dasomel/openforge`); when the secret
is absent the workflow validates `.openforge/status.json` and logs a skip message
instead of failing. `.openforge/status.json`'s `revision` and `evidence.commit` fields
must be the verified SHA that CI actually ran against, not a later or unverified commit.
The workflow enforces this: `revision` must be a verified commit reachable from the
run's SHA (an ancestor of, or equal to, the checked-out commit); the job fails otherwise.

## Environment

- `configs/cluster.env` — committed, non-secret cluster topology (subnets, node IPs,
  domain registry). Edit directly for topology changes.
- `.env.example` — sanitized template for the optional shell-environment overrides
  `scripts/common/env.sh` honors (RAM-profile overrides, `KUBECONFIG` path). Never add
  real secrets here or anywhere in the repo.
- This host runs many concurrent Kubernetes sessions. Always create an isolated
  kubeconfig before touching the `beluga` context — see [CLAUDE.md](../CLAUDE.md).

## Before you start

Read, in order: [AGENTS.md](../AGENTS.md) -> [CLAUDE.md](../CLAUDE.md) ->
[README.md](../README.md) -> [VERSIONS.md](../VERSIONS.md) ->
[docs/mistakes-log.md](mistakes-log.md) -> the relevant architecture/spec document under
`docs/superpowers/` -> the issue/spec you are implementing.
