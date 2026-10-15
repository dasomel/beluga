# Changelog

English | [한국어](CHANGELOG-ko.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
starting with 0.1.0. Pre-1.0, `main` is the only supported line. Versions describe the
platform definition (IaC), not any single component — see [RELEASING.md](RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-10-15

First tagged release.

### Added

- Core data platform: Kafka(+CDC) -> Flink -> Iceberg lakehouse -> Trino/Superset ->
  Airflow, deployed via Vagrant + k3s + ArgoCD GitOps. Clean-install E2E verified.
- Two end-to-end demos: a synthetic clickstream event pipeline and a Postgres CDC
  pipeline.
- Gateway and identity: APISIX unifies the HTTP UIs under `*.local.beluga.internal`;
  Keycloak + OpenLDAP provide SSO and accounts; Lakekeeper authorization via OpenFGA
  (#159).
- `manager/` control plane (TypeScript npm workspaces: `domain-api`, `policy-compiler`,
  `web`), consolidated into this repository from `beluga-manager` (#261,
  [ADR-0005](docs/adr/0005-consolidate-beluga-manager-into-monorepo.md)).
- Policy compiler: declarative YAML in `policies/` compiles to OPA Rego
  (`trino.rego`), the generated body of `db-roles.sql` and Keycloak outputs; seam test
  `tests/14-policy-compiler-seam.sh` recompiles in-repo and diffs the generated files.
- Tag-triggered release pipeline (#100, #181): gate on main ancestry, vulnerability
  scans, `make lint` and `make validate` (including the license-change gate), then a
  CycloneDX SBOM, license inventory, platform asset inventory and checksummed evidence
  bundle with GitHub build provenance. See `docs/development.md` "Release evidence".
- Independent-review merge gate: SHA-bound `independent-review` commit status
  (#201, `scripts/ci/mark-review-pass.py`).
- Bootstrap-time random credential generation into a Kubernetes Secret (no committed
  credentials — see [SECURITY.md](SECURITY.md)).
- SBOM generation against live cluster images (`scripts/generate-sbom.sh`).
- OpenForge compliance baseline: bilingual documentation set, `docs/adr/`, GitHub
  templates, and CI workflows (lint, static validation, doc/ADR pairing check,
  supply-chain policy check, IaC static analysis).

### Security

- APISIX request-size limit (#165) and PostgreSQL backup retention (#166).

### Known limitations

- Live deployment/verification of the policy compiler outputs against a cluster (Trino
  LDAP group provider, policy cutover, Superset role mapping, catalog-browsing gaps) is
  outstanding. The live suite (`tests/01`-`18`) passed against the local cluster on
  2026-10-15 for this release, but it covers those paths only statically (group-name
  seam, `tests/14`), not end to end.
- Kafka listeners are not yet TLS-only and authenticated (#6); the platform assumes a
  single-host local lab network.
- Fail-closed build dependency and upstream artifact verification is not complete
  (#103); image-digest attestation against a live cluster and tag signing are not
  covered by the release evidence.

See [docs/mistakes-log.md](docs/mistakes-log.md) for the detailed, dated record of
defects found and fixed during development.

[Unreleased]: https://github.com/dasomel/beluga/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dasomel/beluga/releases/tag/v0.1.0
