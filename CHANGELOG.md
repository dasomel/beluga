# Changelog

English | [한국어](CHANGELOG-ko.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project intends to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once a first tagged release is cut. Pre-1.0, `main` is the only supported line and
history is tracked narratively here rather than per-version.

## [Unreleased]

### Added

- Core data platform: Kafka(+CDC) -> Flink -> Iceberg lakehouse -> Trino/Superset ->
  Airflow, deployed via Vagrant + k3s + ArgoCD GitOps. Clean-install E2E verified.
- Two end-to-end demos: a synthetic clickstream event pipeline and a Postgres CDC
  pipeline.
- Bootstrap-time random credential generation into a Kubernetes Secret (no committed
  credentials — see [SECURITY.md](SECURITY.md)).
- SBOM generation against live cluster images (`scripts/generate-sbom.sh`).
- OpenForge compliance baseline: bilingual documentation set, `docs/adr/`, GitHub
  templates, and CI workflows (lint, static validation, doc/ADR pairing check,
  supply-chain policy check, IaC static analysis).

### In progress

- Policy compiler integration (declarative YAML in `policies/` compiled to
  Keycloak/Rego/PostgreSQL outputs) — compiler implemented in a companion repo; live
  deployment/verification against this cluster (Trino LDAP group provider, policy
  cutover, Superset role mapping, catalog-browsing gaps) is outstanding.

See [docs/mistakes-log.md](docs/mistakes-log.md) for the detailed, dated record of
defects found and fixed during development.

[Unreleased]: https://github.com/dasomel/beluga/commits/main
