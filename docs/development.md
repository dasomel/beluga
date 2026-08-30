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
2. **Live E2E** (`make test`) — `tests/*.sh` query real cluster state (pod health,
   Kafka/CDC flow, Iceberg tables, Trino queries, Airflow DAGs, authz defaults). Requires
   a booted cluster; cannot run in GitHub Actions.
3. **Manual gateway/auth verification** — for auth and gateway changes, verify both
   direct component access and the documented user entry point (the APISIX gateway
   domain registry). See the 2026-08-25 `orch` entry in
   [docs/mistakes-log.md](mistakes-log.md) for why this distinction matters.

"Renders/lints successfully" and "actually works" are different claims. Do not conflate
them when reporting completion.

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
