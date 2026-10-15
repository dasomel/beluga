# Changelog

English | [한국어](CHANGELOG-ko.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
starting with 0.1.0. Pre-1.0, `main` is the only supported line. Versions describe the
platform definition (IaC), not any single component — see [RELEASING.md](RELEASING.md).

## [Unreleased]

### Added

- Kakao Cloud deployment path under `csp/kakao-cloud/` (OpenTofu VPC/VMs/NLB/bastion,
  `kakao-up.sh` bootstrap, ArgoCD overlay). Private nodes egress through a bastion squid
  proxy; the gateway is exposed as NLB -> worker NodePort 31080/31443 -> APISIX. The default
  Vagrant path and the default `beluga-platform` render are unchanged. Applied live once
  on 2026-10-16 (see Fixed).
- Kakao Cloud public IPs are now stable across VM/NLB recreation (D-KAKAO-12): the bastion
  uses a standalone network interface and both `kakaocloud_public_ip` resources ignore
  `related_resource` changes. NLB re-association after replacement is a manual console step
  (`csp/kakao-cloud/README.md`). Verified live 2026-10-16.

### Fixed

- Kakao Cloud first live apply (2026-10-16): attach an internet gateway to the VPC (D-KAKAO-13,
  public IP association failed with 409), route the subnets through a `0.0.0.0/0 -> igw` route
  table (D-KAKAO-14, bastion SSH timed out), filter AAAA in a bastion-local dnsmasq for squid
  (D-KAKAO-15, `CONNECT` 503 over IPv6), and default `bastion_ip_offset` to 11 with validation
  (`.5` is Kakao-reserved). The LB module now also waits for the network and the bastion NIC.
- `tests/01-cluster-health.sh` follows the gateway exposure mode (`BELUGA_LB_MODE` or the live
  `apisix-gateway` Service type): NodePort mode needs no MetalLB and expects 80:31080/443:31443.

### Changed

- `csp/kakao-cloud` documents the live verification (public IP stability, import, NLB source IP,
  tests, bootstrap timing) and operational gotchas; `tests/19` asserts the new contracts.

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
