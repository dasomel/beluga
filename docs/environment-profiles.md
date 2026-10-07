# Environment Profiles (development / test / production-style)

English | [한국어](environment-profiles-ko.md)

Design and evidence baseline for [Issue #24](https://github.com/dasomel/beluga/issues/24)
(separate development, test and production profiles). **Docs only for the profile design: nothing in this change adds a
profile switch, a preflight script or a values file** (the one code change is the `BELUGA_PROFILE` value check in `env.sh`, see P7). Every statement about the repository carries a
`file:line` reference read at the commit this document was written against; a cell that says
**not defined today** means no repository artifact defines it. Proposals are labelled **Proposed**;
numbers or choices the repository cannot supply are labelled **Owner decision**.

Owner decision already taken (issue #24): the **production-style profile uses the current
TLS/authentication-enabled configuration as its baseline** (everything that is already gated behind a
TLS/auth switch is ON; nothing is relaxed to make it fit smaller hosts).

---

## 1. What exists today

Only one profile axis exists: **host RAM** (32/48/64 GB). It is not an environment profile.

| Fact | Evidence |
|---|---|
| RAM profiles 32/48/64 GB; 48GB+ turns on OpenMetadata and the Trino worker | [`README.md:65`](../README.md#L65), [`README.md:76-80`](../README.md#L76-L80) |
| `BELUGA_PROFILE` selects VM sizing; an explicit non-empty value that reaches `apply_ram_profile` must be 32/48/64, otherwise it errors and fails (empty = unset = host auto-detect) (fixed in this PR). `configs/cluster.env` is sourced first (`env.sh:15`) and sets `BELUGA_PROFILE=64` (`cluster.env:25`), so an exported `BELUGA_PROFILE` is overridden by it (observed, unchanged); the check therefore guards the `cluster.env` value (and any edit of it) | [`scripts/common/env.sh:32-59`](../scripts/common/env.sh#L32-L59) (check `:36-39`, `32)` case `:53`) |
| Without `BELUGA_PROFILE`, host RAM is detected and a profile chosen | [`scripts/common/env.sh:60-83`](../scripts/common/env.sh#L60-L83) |
| `ENABLE_OPENMETADATA` / `TRINO_WORKER_ENABLED` are derived from `BELUGA_PROFILE >= 48` unless already set | [`scripts/common/env.sh:85-95`](../scripts/common/env.sh#L85-L95) |
| The checked-in default is `BELUGA_PROFILE=64`, provider `vmware_desktop`, subnet `192.168.77.x` | [`configs/cluster.env:7`](../configs/cluster.env#L7), [`:10-15`](../configs/cluster.env#L10-L15), [`:25`](../configs/cluster.env#L25) |
| The two feature flags reach Helm only through `--set` in the bootstrap script (`helm template ... \| kubectl apply`) | [`scripts/gitops/01-argocd-bootstrap.sh:358-361`](../scripts/gitops/01-argocd-bootstrap.sh#L358-L361), env passed at [`scripts/up.sh:64`](../scripts/up.sh#L64) |
| The ArgoCD Applications declare no Helm parameters/values, so a GitOps sync renders chart defaults (OpenMetadata off, Trino worker off) | [`gitops/apps/beluga-data.yaml:5-20`](../gitops/apps/beluga-data.yaml#L5-L20); defaults at [`gitops/charts/beluga-data/values.yaml:58-59`](../gitops/charts/beluga-data/values.yaml#L58-L59), [`:74`](../gitops/charts/beluga-data/values.yaml#L74) |
| Both combinations are rendered in CI | [`.github/workflows/sast.yml:80-92`](../.github/workflows/sast.yml#L80-L92), [`scripts/ci/check-networkpolicy-coverage.py:526-529`](../scripts/ci/check-networkpolicy-coverage.py#L526-L529), [`docs/development.md:124-131`](development.md#L124-L131) |
| Authoritative configuration sources and the two-tier drift model | [`docs/configuration-sources.md:13-20`](configuration-sources.md#L13-L20), [`:63-97`](configuration-sources.md#L63-L97) |

Observation (verified, relevant to promotion): bootstrap applies `--set openmetadata.enabled=true
trino.workerEnabled=true` on 48GB+, while the ArgoCD Applications (`selfHeal: true`, `prune: true`,
[`gitops/apps/beluga-data.yaml:19-22`](../gitops/apps/beluga-data.yaml#L19-L22)) track chart defaults. The
effective configuration of a 48/64GB cluster therefore depends on an input (environment variables of the
bootstrap shell) that is not version-controlled. This is the concrete gap behind the "effective
configuration can be reproduced from version-controlled inputs" criterion.

---

## 2. Profile matrix

Columns: **Development** = today's local defaults (verified). **Test** and **Production-style** =
**Proposed**; the "today" text in those columns states what the repository currently does for that
dimension so the gap is explicit. No cell below invents a number.

| Dimension | Development (today, verified) | Test (Proposed) | Production-style (Proposed; baseline = current TLS/auth-enabled config) |
|---|---|---|---|
| **TLS: edge** | APISIX HTTPS on 443 with a cert-manager `Certificate` (`duration: 2160h`, `renewBefore: 720h`) from a self-signed internal CA ([`apisix-gateway.yaml:29`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L29), [`:247-260`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L247-L260), [`cert-manager-issuer.yaml:12-18`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L12-L18), `isCA` at [`:28`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L28)) | Same as development | Same, but the issuer must not be the self-signed internal CA. **Owner decision**: external/enterprise CA. Not defined today |
| **TLS: in-cluster** | Mixed. Trino coordinator HTTPS enabled ([`06-trino.yaml:53-56`](../gitops/charts/beluga-data/templates/06-trino.yaml#L53-L56)) but the HTTP listener is kept ([`06-trino.yaml:41`](../gitops/charts/beluga-data/templates/06-trino.yaml#L41), comment `:51-52`); Keycloak `--http-enabled=true` behind the proxy ([`keycloak.yaml:332`](../gitops/charts/beluga-platform/templates/keycloak.yaml#L332)); Lakekeeper base URI is `http://` ([`04-lakekeeper.yaml:109-110`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L109-L110)); Postgres LDAP auth is plaintext, documented as accepted ([`02-cnpg.yaml:43`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L43), `:46-47`); OpenLDAP serves 389 and 636 together, plaintext cannot be disabled ([`openldap.yaml:22-23`](../gitops/charts/beluga-platform/templates/openldap.yaml#L22-L23)) | Not defined today | Not defined today as a requirement. Plain Kafka 9092 (`strimzi.listenerTls: false`, [`values.yaml:35`](../gitops/charts/beluga-data/values.yaml#L35), rendered at [`03-strimzi-kafka.yaml:64-67`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L64-L67)) is a baselined debt ([`check-kafka-listener-security.py:15-25`](../scripts/ci/check-kafka-listener-security.py#L15-L25)). By definition prod-style allows no plaintext or unauthenticated Kafka path; declaring it stays blocked until the Issue #6 follow-ups land (the current default render is a gap against this definition) |
| **Authentication** | Trino: OAuth2 (Keycloak) + PASSWORD ([`06-trino.yaml:81`](../gitops/charts/beluga-data/templates/06-trino.yaml#L81)); Lakekeeper: OIDC + OpenFGA, default `lakekeeper.openfga.enabled: true` ([`values.yaml:53-55`](../gitops/charts/beluga-data/values.yaml#L53-L55), gate at [`04-lakekeeper.yaml:49`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L49), [`:111`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L111)); Kafka: **none** by default (`oauthListener: false`, [`values.yaml:46`](../gitops/charts/beluga-data/values.yaml#L46)); Airflow runs `airflow standalone` with a local admin ([`07-airflow.yaml:161`](../gitops/charts/beluga-data/templates/07-airflow.yaml#L161), [`docs/privileged-access-inventory.md:26`](privileged-access-inventory.md#L26)) | Not defined today | **Requires** every TLS/auth switch ON: `lakekeeper.openfga.enabled=true`, Keycloak-backed auth, and Kafka `oauthListener=true` (with `aclAuthorizer`, `listenerTls`, no external listener). The current default render does **not** meet this (`oauthListener` defaults to `false`; enabling it removes plain 9092 and breaks the hard-coded consumers) - that is a gap against the profile definition, not part of it ([`values.yaml:39-46`](../gitops/charts/beluga-data/values.yaml#L39-L46), listener at [`03-strimzi-kafka.yaml:87-98`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L87-L98)). **Owner decision**: consumer migration order |
| **HA / replicas** | Singletons: Postgres `instances: 1` ([`02-cnpg.yaml:7`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L7)), Keycloak `replicas: 1` ([`keycloak.yaml:285`](../gitops/charts/beluga-platform/templates/keycloak.yaml#L285)), Lakekeeper ([`04-lakekeeper.yaml:69`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L69)), Trino coordinator ([`06-trino.yaml:235`](../gitops/charts/beluga-data/templates/06-trino.yaml#L235)), Trino worker 1 ([`06-trino.yaml:436`](../gitops/charts/beluga-data/templates/06-trino.yaml#L436)), SeaweedFS ([`01-seaweedfs.yaml:49`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L49)), APISIX ([`apisix-gateway.yaml:109`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L109)), OpenLDAP ([`openldap.yaml:112`](../gitops/charts/beluga-platform/templates/openldap.yaml#L112)), OpenFGA ([`openfga.yaml:9`](../gitops/charts/beluga-platform/templates/openfga.yaml#L9)). Kafka `replicas: 3` ([`values.yaml:25`](../gitops/charts/beluga-data/values.yaml#L25)) but replication factor / min.isr = 1 ([`03-strimzi-kafka.yaml:101-104`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L101-L104)) | Not defined today | Not defined today. **Owner decision**: HA targets per component (no number can be derived from the repository) |
| **Resource limits** | Declared per workload (17 template files contain `limits:`; 65 `limits:`/`memory:` lines across templates), per-profile VM capacity checked by `make validate` ([`docs/development.md:124-147`](development.md#L124-L147)); Kafka CR pods declare none (same section) | Same declared-state check | Same check; the report explicitly offers no production sizing ([`docs/development.md:147`](development.md#L147)). **Owner decision**: production sizing targets |
| **External exposure** | APISIX `LoadBalancer` on a MetalLB IP ([`apisix-gateway.yaml:230-232`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L230-L232), [`values.yaml:11-12`](../gitops/charts/beluga-platform/values.yaml#L11-L12)); Kafka external NodePort listener **off** by default but, if enabled, `tls: false` and anonymous ([`values.yaml:27-31`](../gitops/charts/beluga-data/values.yaml#L27-L31), [`03-strimzi-kafka.yaml:73-79`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L73-L79)); Vagrant forwards guest 30094 to the host unconditionally ([`Vagrantfile:80`](../Vagrantfile#L80)); Grafana `NodePort 30000` when `prometheusGrafana.enabled` (default true) ([`platform-services.yaml:8-19`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L19), [`values.yaml:18-19`](../gitops/charts/beluga-platform/values.yaml#L18-L19)). Six namespaces (iam, database, orchestration, streaming, analytics, platform-system) are baselined without default-deny ([`networkpolicy-baseline.yaml:22-48`](../scripts/ci/networkpolicy-baseline.yaml#L22-L48)) | Not defined today | Not defined today. Requirement (Proposed): no NodePort, no Kafka external listener, no unauthenticated listener |
| **Observability** | Prometheus/Grafana via a values flag ([`platform-services.yaml:8`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8), version `67.4.0` at [`values.yaml:18-22`](../gitops/charts/beluga-platform/values.yaml#L18-L22)); APISIX access log to stdout ([`docs/privileged-access-inventory.md:45`](privileged-access-inventory.md#L45)); no k8s/PostgreSQL/LDAP audit logging ([`docs/privileged-access-inventory.md:39-46`](privileged-access-inventory.md#L39-L46)) | Not defined today | Not defined today. Audit logging is Issue #44 scope (criteria 2-5 pending, [`docs/privileged-access-inventory.md:55-58`](privileged-access-inventory.md#L55-L58)) |
| **Data handling** | Synthetic data: shop seed ([`02b-shop-seed.yaml:1-2`](../gitops/charts/beluga-data/templates/02b-shop-seed.yaml#L1-L2)) and clickstream generator ([`13-clickstream-gen.yaml:1`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml#L1)); Postgres backup with `retentionPolicy: 30d`, schedule `0 0 2 * * *` ([`02-cnpg.yaml:71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L71), [`:81`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L81)); object-lock/WORM unverified ([`docs/configuration-sources.md:47`](configuration-sources.md#L47)); credentials generated by bootstrap with `openssl rand`, rotation not established ([`docs/privileged-access-inventory.md:37`](privileged-access-inventory.md#L37)) | Not defined today (Proposed: synthetic data only) | Not defined today. Requirement (Proposed): no seed/generator workloads; backup restore tested. **Owner decision**: retention and data classification |

---

## 3. Development-only settings (derived from the repository)

A setting is listed when the repository itself marks it as local/lightweight or as accepted debt, or
when it is structurally tied to the local Vagrant/MetalLB lab. These must not be selectable in the
production-style profile.

| # | Setting | Why development-only | Evidence |
|---|---|---|---|
| 1 | `VAGRANT_PROVIDER`, `SUBNET_PREFIX`, node IPs, `METALLB_IP_RANGE`, `APISIX_LB_IP` | Local VM lab network | [`configs/cluster.env:7-18`](../configs/cluster.env#L7-L18) |
| 2 | `BASE_DOMAIN=local.beluga.internal` + self-signed internal CA | Non-routable domain, internal CA | [`configs/cluster.env:37`](../configs/cluster.env#L37), [`cert-manager-issuer.yaml:1-4`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L1-L4) |
| 3 | `BELUGA_PROFILE` (RAM sizing) and the implicit OpenMetadata/Trino-worker toggles | RAM fit, not an environment | [`scripts/common/env.sh:32-95`](../scripts/common/env.sh#L32-L95) |
| 4 | `strimzi.listenerTls: false` (plain 9092) | Deliberate scope split to avoid breaking in-cluster consumers | [`values.yaml:32-35`](../gitops/charts/beluga-data/values.yaml#L32-L35) |
| 5 | `strimzi.externalListenerEnabled: true` (NodePort, no TLS, anonymous) | Host access from the lab; security debt | [`values.yaml:27-31`](../gitops/charts/beluga-data/values.yaml#L27-L31), [`Vagrantfile:80`](../Vagrantfile#L80) |
| 6 | Kafka replication factor / min.isr = 1 | Single-copy topics | [`03-strimzi-kafka.yaml:101-104`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L101-L104) |
| 7 | (not a profile choice) `strimzi.opaAuthorizer: true` | Invalid in every profile, including development: needs a custom image with the plugin JAR that does not exist, the broker fails to start (see P4). Listed only because the chart exposes the switch | [`03-strimzi-kafka.yaml:44-46`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L44-L46), [`values.yaml:36-37`](../gitops/charts/beluga-data/values.yaml#L36-L37) |
| 8 | `lakekeeper.openfga.enabled: false` | Disables the authorization backend (a weakening, not a default) | [`04-lakekeeper.yaml:49`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L49), exercised on/off by [`tests/15-lakekeeper-authz-render.sh:7-8`](../tests/15-lakekeeper-authz-render.sh#L7-L8) |
| 9 | Trino plain HTTP listener kept alongside HTTPS | Kept "until authentication switch" | [`06-trino.yaml:41`](../gitops/charts/beluga-data/templates/06-trino.yaml#L41), `:51-52` |
| 10 | Postgres LDAP simple-bind over plaintext, `0.0.0.0/0` | Documented as accepted in-cluster plaintext | [`02-cnpg.yaml:38`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L38), [`:46-47`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L46-L47) |
| 11 | Airflow `standalone` local admin | Single-process local mode | [`07-airflow.yaml:161`](../gitops/charts/beluga-data/templates/07-airflow.yaml#L161) |
| 12 | `prometheusGrafana` NodePort 30000 | Direct node access | [`platform-services.yaml:12-19`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L12-L19) |
| 13 | Shop seed and clickstream generator workloads; `flink.sqlJobsEnabled` pipelines on synthetic topics | Synthetic data sources | [`02b-shop-seed.yaml:1-2`](../gitops/charts/beluga-data/templates/02b-shop-seed.yaml#L1-L2), [`13-clickstream-gen.yaml:1`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml#L1), [`14-flink-jobs.yaml:2`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L2) |
| 14 | `instances: 1` / `replicas: 1` singletons | No HA | see matrix, HA row |

Not development-only but relevant: `oauthListener: true` is REQUIRED by production-style (section 2, authentication row) and is a security feature that is *incompatible
with the current plain-9092 consumers* ([`values.yaml:39-46`](../gitops/charts/beluga-data/values.yaml#L39-L46));
it is a migration blocker, not a dev setting.

---

## 4. Invalid combinations that must fail preflight (requirements, design only)

No script is added here. **Proposed home:** one checker `scripts/ci/check-environment-profile.py`
(same shape as the existing ratchets, e.g. [`check-kafka-listener-security.py`](../scripts/ci/check-kafka-listener-security.py)),
run from `make validate` ([`Makefile:50`](../Makefile#L50), next to the existing render-based gates) and
registered in the CI stage-parity check ([`scripts/ci/check-ci-stage-parity.py`](../scripts/ci/check-ci-stage-parity.py)).
A second entry point runs the same function at the top of `scripts/up.sh` before VMs are created
(today `up.sh` has no validation step; env derivation is `scripts/common/env.sh`). The checker takes
the profile name and the effective values (helm `--set` + env), renders both charts like
[`scripts/generate_sizing_report.py`](../scripts/generate_sizing_report.py) does, and fails closed.

| ID | Invalid combination | Applies to | Where the check reads it |
|---|---|---|---|
| P1 | production-style with any rendered Kafka listener that has `tls: false` or no authentication (today: `plain` and `external`) | prod-style | rendered `Kafka` CR; the same data the existing baseline freezes ([`check-kafka-listener-security.py:15-25`](../scripts/ci/check-kafka-listener-security.py#L15-L25)). P1 is part of the prod-style definition: a render that fails P1 is not a valid prod-style render, and declaring prod-style stays blocked until Issue #6 closes. Today's default render violates it (a gap). Only the sequencing is open (**Owner decision**: when the checker starts failing the build, and the order in which Kafka consumers migrate) |
| P2 | `strimzi.externalListenerEnabled=true` | test, prod-style | values; rendered listener `type: nodeport` |
| P3 | `lakekeeper.openfga.enabled=false` | test, prod-style | values; absence of `LAKEKEEPER__AUTHZ_BACKEND=openfga` in rendered Lakekeeper env ([`04-lakekeeper.yaml:111-113`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L111-L113)) |
| P4 | `strimzi.opaAuthorizer=true` without a custom image | all | values; rendered Kafka image |
| P5 | `strimzi.oauthListener=true` while any consumer still targets `beluga-kafka-kafka-bootstrap:9092` | all | rendered Deployments/Jobs env scan (Debezium, clickstream-gen) vs rendered listeners ([`values.yaml:39-43`](../gitops/charts/beluga-data/values.yaml#L39-L43)) |
| P6 | `certManager.enabled=false` while the gateway `Certificate` is still rendered | all | the issuer file is gated ([`cert-manager-issuer.yaml:5`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L5)) but `apisix-gateway.yaml` has no gate around its `Certificate` ([`:247-260`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L247-L260)); rendered `Certificate` -> `ClusterIssuer` reference check |
| P7 | `BELUGA_PROFILE` not in {32,48,64} | all | env; **fixed**: `apply_ram_profile` now rejects the value that reaches it (exit 1, allowed values named; an exported value is first overridden by `cluster.env`, see section 1), guarded by `tests/18-profile-validation.sh`. Previously 128 took the 32GB sizing branch yet satisfied `-ge 48` (OpenMetadata on) |
| P8 | prod-style with `BASE_DOMAIN=local.beluga.internal`, the self-signed internal CA, or MetalLB/Vagrant provider vars | prod-style | env + rendered `ClusterIssuer` `selfSigned` ([`cert-manager-issuer.yaml:18`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L18)) |
| P9 | prod-style with `prometheusGrafana` NodePort Service, or any `type: NodePort` | prod-style | rendered Services |
| P10 | helm `--set` / env inputs that differ from the ArgoCD Application source (bootstrap vs GitOps divergence for `openmetadata.enabled`, `trino.workerEnabled`) | test, prod-style | compare `01-argocd-bootstrap.sh:358-361` inputs with the Application manifest; fails until the Applications carry the profile values (see section 6) |
| P11 | a profile name that is not one of `development`, `test`, `production-style` | all | the checker's own argument |

Rendered-manifest policy checks required by the issue (profile-specific): P1, P2, P3, P6, P8, P9 are
render-time assertions on `helm template` output, evaluated per profile; P7 and P10 are input checks.

---

## 5. Effective-configuration provenance

Existing mechanism to reuse: the release evidence bundle. Today it contains `manifest.json`
(`schema`, `version`, `commit`, SBOM and inventory file names), the CycloneDX SBOM, the license and
declared-state platform asset inventories, NOTICE and LICENSE, plus `SHA256SUMS`, and verification is
offline and fail-closed ([`scripts/release/evidence_bundle.py:1-15`](../scripts/release/evidence_bundle.py#L1-L15),
[`:35`](../scripts/release/evidence_bundle.py#L35), [`:87-89`](../scripts/release/evidence_bundle.py#L87-L89)).
The release gate runs it ([`.github/workflows/release.yml:1-8`](../.github/workflows/release.yml#L1-L8), `make release-evidence` at [`Makefile:133-141`](../Makefile#L133-L141)).

**Not recorded today:** the profile, `BELUGA_PROFILE`, the two feature flags, helm `--set` values,
`configs/cluster.env`, or a hash of the rendered manifests. The asset inventory is "declared state"
rendered by helm for a fixed set of combinations (`default`, `48GB+`, `oauth`, `acl`, `external`, `all-enabled`,
[`generate_platform_asset_inventory.py:30-40`](../scripts/generate_platform_asset_inventory.py#L30-L40)) with each asset tagged by profile
membership. It therefore covers the 48GB+ bootstrap combination, but it does not record **which** combination a
release or cluster actually used, nor combinations outside that list (e.g. `lakekeeper.openfga.enabled=false`,
`strimzi.listenerTls=true`, `strimzi.opaAuthorizer`, `flink.sqlJobsEnabled=false`), nor env-derived inputs.

**Proposed** (a release must record, as additional bundle files covered by `SHA256SUMS`):

1. profile name and the full effective values file (a version-controlled file, see section 6), plus
   the list of any `--set` overrides (should be empty);
2. `configs/cluster.env` content hash and `scripts/common/env.sh` hash (they determine sizing and flags);
3. SHA-256 of each rendered chart (`helm template`) and the helm version (the bundle already pins helm at CI version `v3.16.4`, [`evidence_bundle.py:75`](../scripts/release/evidence_bundle.py#L75));
4. chart `version`/`appVersion` and image digests (the rendered image set is already inventoried);
5. the result of the profile preflight (section 4) as pass/fail with the checker version.

Reproducibility test (**Proposed**): today `evidence_bundle.py verify` does not re-render. It checks checksums, manifest/SBOM identity and
that shipped files match the checkout, and explicitly does not regenerate the asset inventory
([`evidence_bundle.py:5-12`](../scripts/release/evidence_bundle.py#L5-L12)). The proposed check is therefore new work: a separate step
that re-renders both charts from the release commit with the recorded profile values file (needs helm at the pinned version) and compares
the result to the recorded rendered-manifest hashes.

---

## 6. Promotion development -> test -> production-style

**Proposed mechanism** (design only): one version-controlled values file per profile, e.g.
`gitops/profiles/{development,test,production-style}.yaml`, referenced by the ArgoCD Applications
(`helm.valueFiles`) and by the bootstrap `helm template -f`, replacing the two ad-hoc `--set` flags.
This removes the bootstrap-vs-GitOps divergence in section 1.

| Step | What changes | How each step is testable (existing + proposed) |
|---|---|---|
| dev -> test | Switch values file; security features that are ON in development must stay ON; HA/sizing may stay small | Existing: `make validate` ([`Makefile:50-124`](../Makefile#L50-L124)) incl. NetworkPolicy ratchet, K8s security baseline, TLS certificate inventory, image immutability; CI renders both RAM combos ([`sast.yml:80-92`](../.github/workflows/sast.yml#L80-L92)). Proposed: preflight P2-P4, P7, P10 for `test` |
| test -> prod-style | Replace internal CA, remove dev-only items (section 3), enable HA per owner targets, close listeners per P1/P5 | Proposed: preflight P1-P11 all pass; `make drift-live` against the cluster ([`Makefile:152`](../Makefile#L152), [`docs/configuration-sources.md:106`](configuration-sources.md#L106)) reports no unauthorized drift; evidence bundle with the new provenance files verifies offline |
| Any step | Record the promotion | Release evidence bundle (section 5); the independent-review status rule in `AGENTS.md` still applies |

---

## 7. Gaps and owner decisions

Gaps vs the Issue #24 acceptance criteria:

| Criterion | Status after this document |
|---|---|
| Supported profiles are documented | Documented (design); no mechanism enforces them |
| Production-style profile has explicit secure defaults | Not met: values/profile file does not exist; current defaults still contain plaintext Kafka listener and Postgres LDAP plaintext |
| Invalid profile combinations fail preflight | Not met: requirements listed (section 4), no script |
| Effective configuration reproducible from version-controlled inputs | Not met: bootstrap `--set` / env inputs are not version-controlled (section 1) |
| Promotion documented and testable | Documented (section 6); the proposed tests do not exist yet |

Owner decisions needed: (1) sequencing and timing only: when P1 is enforced and the consumer migration order for Issue #6 (the definition is fixed: prod-style cannot be declared while Kafka `plain`/`external` exist); (2) production CA and domain
(P8); (3) HA, resource and retention targets (no repository value exists); (4) profile file layout and
whether ArgoCD Applications should carry the values (section 6); (5) whether `test` must mirror
prod-style security fully (recommended: yes, differing only in size/HA).
