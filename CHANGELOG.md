# Changelog

English | [한국어](CHANGELOG-ko.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
starting with 0.1.0. Pre-1.0, `main` is the only supported line. Versions describe the
platform definition (IaC), not any single component — see [RELEASING.md](RELEASING.md).

## [Unreleased]

## [0.2.0] - 2026-11-14

### Added

- [Colima single-node lab guide](docs/colima-single-node.md): macOS API/gateway access,
  live-test prerequisites, Vagrant differences and recovery after an unclean shutdown.
- Kakao Cloud deployment path under `csp/kakao-cloud/` (OpenTofu VPC/VMs/NLB/bastion,
  `kakao-up.sh` bootstrap, ArgoCD overlay). Private nodes egress through a bastion squid
  proxy; the gateway is exposed as NLB -> worker NodePort 31080/31443 -> APISIX. The default
  Vagrant path and the default `beluga-platform` render are unchanged. Applied live once
  on 2026-10-16 (see Fixed).
- Kakao Cloud public IPs are now stable across VM/NLB recreation (D-KAKAO-12): the bastion
  uses a standalone network interface and both `kakaocloud_public_ip` resources ignore
  `related_resource` changes. NLB re-association after replacement is a manual console step
  (`csp/kakao-cloud/README.md`). Verified live 2026-10-16.
- Kakao Cloud keeps its own platform domain `kakao.beluga.internal`, separate from the Vagrant
  `local.beluga.internal` (`gitops/values/domain-kakao.yaml`, checked against terraform
  `base_domain` by `tests/19`).
- Beluga Manager runs on the cluster behind `manager.<baseDomain>` with Keycloak PKCE login and
  bearer-JWT API authentication. Manager images are built and published to GHCR from `main`
  (arm64 on native runners, #359) and pinned by digest in the chart. Unauthenticated users go
  straight to SSO sign-in (#342); the user menu shows groups from the verified access token via
  `GET /api/v1/me` (#348).
- Manager reads live platform state instead of fixtures: service health and events from the
  Kubernetes API (#347), workloads, resources, policies and audit decisions on the overview
  (#365; decisions are admins-only), Flink pipelines (#344), Grafana/VictoriaMetrics health
  (#366), and Lakekeeper data-asset names through a describe-only service identity (#372,
  [ADR-0010](docs/adr/0010-manager-lakekeeper-read-identity.md)). Local development runs against
  fake upstreams (#252).
- SSO change requests through a GitHub pull request (ADR-0009, see
  [manager/docs/adr](manager/docs/adr/0009-sso-change-requests-via-git-pr.md)): read-only SSO view
  backed by `gitops/values/sso.yaml` (label form, resolved against `BASE_DOMAIN`), audit database
  with preview/submit (step 3), and a GitHub App pull-request writer with reconciler, cancel and UI
  (step 4). Live acceptance in `tests/23` and `tests/24`.
- Gateway and application SSO ([ADR-0006](docs/adr/0006-gateway-sso-oidc-architecture.md)): OIDC at
  the gateway for UIs without their own login, ArgoCD SSO (D-SSO-1..4), per-route `allowedGroups`
  for Flink and the filer (D-MSSO-14), working app-level logins for OpenMetadata, Airflow, the
  Trino UI and the Lakekeeper UI, and a Beluga-branded Keycloak login theme (#343).
- dbt Core transformation layer ([ADR-0007](docs/adr/0007-dbt-core-transformation-layer.md), #95):
  DuckDB CI and a digest-pinned runtime image (#381), the `dbt_shop_medallion` Airflow DAG running
  in-cluster as the `svc-dbt` service identity limited to `silver_shop`/`gold_shop` (#382,
  `tests/27`), and a per-node run audit in `gold_shop.dbt_run_audit` (#395).
- Iceberg table maintenance runs under a procedure-only identity
  ([ADR-0008](docs/adr/0008-iceberg-maintenance-service-identity.md), #387): the `maintenance`
  Keycloak client and `maintainers` group are limited to `optimize` and `expire_snapshots` on five
  tables via wildcard-free `procedureGrants` in the policy compiler (`tests/28`). The DAG had never
  run before.
- Data-contract tooling: ODCS contract with DDL drift validator for `lake.events_enriched` (#91),
  OpenAPI source-contract drift validator (#78), shop CDC source manifest with connector preflight
  (#71), and static column-level lineage extracted from Flink SQL (#88). dbt lineage visibility and
  a Silver publish gate are proposed in docs (#396).
- Observability: VictoriaMetrics and Grafana (SSO-only, group-mapped roles) at
  `grafana.<baseDomain>` (#366; the AGPL-3.0 Grafana exception is recorded as a license review),
  and vmalert + Alertmanager with node filesystem, PVC fill and CDC replication-slot WAL rules
  ([ADR-0011](docs/adr/0011-alerting-vmalert-alertmanager.md), #408, `tests/31`).
- 48/64GB profile components (OpenMetadata, Trino worker) are managed by ArgoCD through
  `gitops/values/profile-full.yaml` and the `gitops/profiles/full` overlay (#333); bootstrap applies
  only the root Application when switching profiles.
- Flink runs on a Beluga image with the connector JARs built in, so pod starts no longer download
  from Maven Central (#361, #362, #364).
- CI: weekly GitHub Actions research-evidence backfill (#375), a manager compose runtime smoke
  test, and Dependabot ignores semver-major Docker base bumps.

### Fixed

- Live-test fixes (#413): `tests/01` accepts `EXPECTED_NODES` (default 4; use 1 on Colima),
  `tests/03` fails instead of skipping when Flink is declared but down, and `tests/10` uses
  OpenSSL with a public-root bundle for the negative TLS check independently of macOS login
  keychain trust.
- Kakao Cloud first live apply (2026-10-16): attach an internet gateway to the VPC (D-KAKAO-13,
  public IP association failed with 409), route the subnets through a `0.0.0.0/0 -> igw` route
  table (D-KAKAO-14, bastion SSH timed out), filter AAAA in a bastion-local dnsmasq for squid
  (D-KAKAO-15, `CONNECT` 503 over IPv6), and default `bastion_ip_offset` to 11 with validation
  (`.5` is Kakao-reserved). The LB module now also waits for the network and the bastion NIC.
- `tests/01-cluster-health.sh` follows the gateway exposure mode (`BELUGA_LB_MODE` or the live
  `apisix-gateway` Service type): NodePort mode needs no MetalLB and expects 80:31080/443:31443.
- Kakao Cloud bastion: the VPC DHCP DNS (169.254.169.253) timed out from every VM live (second
  deployment, 2026-10-16), so cloud-init `packages` failed and squid never ran. A `bootcmd` now adds
  `bastion_upstream_dns` (default 1.1.1.1, 8.8.8.8; `[]` disables) to systemd-resolved (D-KAKAO-16).
  A `user_data` change does not replace an existing bastion; use `-replace`.
- CDC replication slot WAL growth (#399, #401): on 2026-11-12 an idle `shop` database let the
  Debezium slot retain 22.85 GB of WAL and the full disk evicted pods in every namespace. Debezium
  now writes a 10 s heartbeat, CNPG sets `max_slot_wal_keep_size=1GB` (a lagging slot is then
  invalidated and needs a re-snapshot), debezium-connect logs to console with bounded ephemeral
  storage, and `tests/29` checks slot state and node headroom. Incident record under
  `research/incidents/2026-11-12-cdc-slot-wal-disk-pressure`.
- Flink survives JobManager restarts: Kubernetes HA with durable checkpoints on SeaweedFS and
  Kafka sources that resume from committed offsets, so resubmission no longer re-reads topics and
  re-appends to Iceberg (#350).
- ArgoCD now sees Sync-hook-only changes: each chart renders a `*-hook-revision` ConfigMap holding a
  hash per hook, so such a commit makes the Application OutOfSync and re-runs hooks (#404).
- Live dbt run findings: keycloak-clients crash loop on Keycloak 26 mapper defaults (D-DBT-12),
  Trino system metadata rules (D-DBT-13), TLS verification enabled for dbt-trino (D-DBT-14), and
  read access to analytics pod events for the Airflow pod operator (#383, #384, #385).
- Iceberg maintenance policy matched to Trino's live input shape: upper-case procedure names and
  the zero-column scan planned by `optimize` (#391, #393).
- OpenMetadata is rolled out only after its migration hook completes (#329); fresh installs assign
  the missing default scopes to `beluga-manager` (#331); Trino rolls on config change and the
  OpenMetadata auth config is reseeded; client-origin reconcile works by replacement with
  per-domain hosts; Airflow stays on LocalExecutor.
- Manager compose web container serves the real nginx config (CSP, SPA fallback) and the Vite dev
  server binds to loopback (#252).
- Demo `clickstream-gen` image builds from the chart's producer script.

### Changed

- `csp/kakao-cloud` documents the live verification (public IP stability, import, NLB source IP,
  tests, bootstrap timing) and operational gotchas; `tests/19` asserts the new contracts.
- `csp/kakao-cloud` records measured deployment timings (apply ~8 min, `kakao-up.sh` 21 min,
  ~38 min end to end) in place of the earlier ~13 min bootstrap estimate.
- Ephemeral storage is bounded across both charts (#403, #408; sizing in
  [docs/ephemeral-storage-bounds.md](docs/ephemeral-storage-bounds.md)): every disk-backed
  `emptyDir` has a `sizeLimit`, every container an ephemeral-storage request/limit,
  KubernetesPodOperator, CNPG and Flink job pods carry bounds, and chart-owned namespaces get an
  ephemeral-storage LimitRange default. Both single-instance CNPG clusters restart when this syncs.
- Dockerfile base images are pinned by digest (#103), and Trivy HIGH findings are now blocking (#117).
- Routine dependency updates (Manager npm packages, GitHub Actions) were merged through Dependabot
  without individual entries.

### Security

- VictoriaMetrics admin endpoints (`delete_series`, `snapshot`, `flags`, `pprof`, ...) require a
  random key from a bootstrap-generated Secret (#369).
- keycloak-clients no longer logs client secret prefixes (#386); the identity bootstrap checker
  rejects secret-derived output and propagates taint (#394).
- Read-only root filesystem for Airflow, Superset, flink-sql-submit and the OpenMetadata init
  containers (#117, KSV-0014).
- Manager audit decisions are restricted to the `admins` group (#365). Service identities for dbt,
  Iceberg maintenance and the Manager catalog reader are scoped to their own secrets and grants.

### Known limitations

- Flink HA cannot recover automatically from an unreadable checkpoint handle after unclean
  storage loss, and there is no Flink alert yet (#412).
- The changes since 0.1.0 were verified live on a single-node colima k3s cluster. Re-validation on
  the Vagrant multi-node reference environment is deferred.
- Alertmanager ships with a null receiver: alerts fire and are visible in Grafana and Alertmanager
  but are not delivered anywhere until a notification channel is configured (#408).
- Namespace LimitRange defaults apply to pods at creation. Operator-created pods that existed
  before the upgrade stay unbounded until they are restarted.
- Risk-accepted issues #6 (Kafka TLS-only and authentication) and #103 (fail-closed build
  dependencies) remain open.

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

[Unreleased]: https://github.com/dasomel/beluga/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dasomel/beluga/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dasomel/beluga/releases/tag/v0.1.0
