# Contributing to Beluga

English | [한국어](CONTRIBUTING-ko.md)

Beluga is a personal/learning-scale IaC data platform. This guide covers local
development for anyone changing the Vagrant/K8s/GitOps/policy layers.

## Prerequisites

- Vagrant, `kubectl`, `helm`
- VMware Fusion (arm64) or VirtualBox (amd64) per `configs/cluster.env`
- `shellcheck` for the shell/lint workflow (`make lint`)
- 32GB+ host RAM (see [README.md](README.md#requirements))

## Local development

```bash
make up       # boot the full cluster + GitOps bootstrap
make status   # VM and pod status
make test     # tests/ E2E verification suite (requires a live cluster)
make lint     # shellcheck + helm lint
make validate # static manifest/YAML validation (no cluster required)
make down     # tear down all VMs
```

## Guidelines

- Read [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) before editing — they cover
  scope discipline, the version single source of truth (`VERSIONS.md`), shared-cluster
  safety rules, and GitOps self-heal behavior.
- Read [docs/mistakes-log.md](docs/mistakes-log.md) for known failure classes before
  touching cluster bootstrap, GitOps sync, or auth/gateway paths.
- Preserve GitOps ownership boundaries and the `VERSIONS.md` version source of truth.
  Component-version, GitOps-ownership, auth/gateway, and RBAC changes are design
  changes — call them out explicitly in the PR.
- For bugs: reproduce -> capture failing evidence -> minimal fix -> same evidence
  passes -> run the relevant regression suite (`tests/`).
- Distinguish static/manifest validation (`make lint`, `make validate`) from real
  cluster verification (`make test`). State which one you ran.
- Never commit real credentials — see [SECURITY.md](SECURITY.md) and
  [.env.example](.env.example).

## Commit convention

Conventional Commits: `<type>(<module>): <description>`, where `type` is one of
`feat`/`fix`/`chore`/`docs` and `module` is one of `cluster`, `gitops`, `ingest`,
`stream`, `lake`, `analytics`, `orch`, `demo`, `docs`.

## Pull requests

Use [.github/pull_request_template.md](.github/pull_request_template.md). Link the
related issue, describe the tests you ran, and call out any workflow/runtime/toolchain
impact.
