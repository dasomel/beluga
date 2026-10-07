# Portfolio integration matrix

English | [한국어](portfolio-integration-matrix-ko.md)

First documentation-only slice of [issue #99](https://github.com/dasomel/beluga/issues/99).
It maps every Beluga capability to its owner, names duplicate-implementation
candidates with one source of truth each, and tabulates the five per-project
boundaries (Narwhal, KubeMetal, kube-ready-box, ldapium, nfs-quota-agent).

It extends, and does not replace, [cross-oss-integration-contracts.md](cross-oss-integration-contracts.md)
(Beluga's side of each boundary). The decision this matrix rests on is
[ADR-0003](adr/0003-beluga-data-platform-plane.md) (Proposed).

## Sources and rules

- Ownership source of truth: OpenForge `portfolio/capability-ownership.json`
  (`openforge-capability-ownership/v1`, updated 2026-09-10) and
  `docs/portfolio-capability-ownership.md`. Capability ids below are quoted from it.
- Registry rule: a project that needs a capability owned elsewhere writes an
  integration / adapter / consumer-contract issue instead of reimplementing it.
- Capability taxonomy: issue #97. AI is optional (#90): no row below may make a
  core data-platform path depend on KubeMetal or any model runtime.
- Seam preserved: the Beluga / beluga-manager OIDC, OPA and Keycloak boundary
  (`AGENTS.md`, `bash tests/14-policy-compiler-seam.sh`) is not changed by this slice.
- Evidence pointers are `path` (this repository) or `repo:path` (a sibling
  repository, read-only reference, checked 2026-10-02). The Narwhal repository
  is not checked out locally; its pointers were read through `gh api` from
  `dasomel/narwhal` `main`.

**Status semantics (issue #99).** `supported` = a contract surface exists on both
sides and Beluga uses it. `partial` = used, but incomplete, workaround-backed or
only one direction. `unavailable` = no usable surface yet (a surface marked
*proposed* is Beluga's expectation, not negotiated with the sibling, and its
names are not API commitments). `not-applicable` = intentionally outside the
current Beluga profile.

## 1. Capability ownership matrix

Beluga row = what this repository actually deploys or documents today.

| # | Beluga capability | Beluga evidence | Owner (registry id or upstream) | Beluga role | Status |
|---|---|---|---|---|---|
| 1 | CDC ingestion, Kafka, streaming (Strimzi, Debezium, Flink) | `VERSIONS.md`, `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml`, `14-flink-jobs.yaml` | beluga (`data-platform-lakehouse`) on upstream Apache projects | owns integration + semantics | `supported` |
| 2 | Lakehouse storage and catalog (SeaweedFS S3, Lakekeeper Iceberg REST) | `01-seaweedfs.yaml`, `04-lakekeeper.yaml` | beluga (`data-platform-lakehouse`) | owns | `supported` |
| 3 | Query and analytics (Trino, Superset), orchestration (Airflow) | `06-trino.yaml`, `08-superset.yaml`, `07-airflow.yaml` | beluga (`data-platform-lakehouse`) | owns | `supported` |
| 4 | Governance catalog (OpenMetadata, 48GB+ profile) | `11-openmetadata.yaml`, design D12 | beluga (`data-platform-lakehouse`) | owns | `partial` (conditional profile) |
| 5 | Data access policy (OPA, OpenFGA) and policy-compiler seam | `policies/`, `tests/14-policy-compiler-seam.sh` | beluga + beluga-manager (control surface) | owns | `supported` |
| 6 | Medallion layers, data quality, data products, semantic layer (#70, #85, #86, #92) | backlog only (#97) | beluga (`data-platform-lakehouse`) | owns | `unavailable` |
| 7 | Management control surface | `.openforge/status.json` (`beluga-manager` provides) | beluga-manager (`control_surfaces` of `data-platform-lakehouse`) | consumed by the surface | `supported` |
| 8 | Cluster lifecycle: k3s, Cilium, MetalLB, ArgoCD bootstrap | `scripts/cluster/`, `scripts/gitops/01-argocd-bootstrap.sh`, `scripts/up.sh` | narwhal (`kubernetes-platform-control-plane`) | standalone self-bootstrap, see D1 below | `not-applicable` (peer, ADR-0003 Q1) |
| 9 | Identity provider and SSO (Keycloak) | `gitops/charts/beluga-platform/templates/keycloak.yaml`, design D13 | narwhal (platform security scope) / upstream Keycloak | self-hosted for the data-platform realm, see D2 | `partial` |
| 10 | API gateway (APISIX + etcd) | `apisix-gateway.yaml`, design D11 | narwhal (platform scope) / upstream APISIX | self-hosted, see D3 | `partial` |
| 11 | Certificates (cert-manager, internal CA) | `internal-ca-distribution.yaml`, `openldap.yaml` | narwhal (platform security scope) / upstream cert-manager | uses upstream directly | `partial` |
| 12 | Metrics, logs, traces | `VERSIONS.md` lists Prometheus Stack; only a `grafana-external` Service shim in `platform-services.yaml`; no Prometheus/Loki/Tempo workload in `docs/platform-asset-inventory.md` | narwhal (observability scope) | none deployed | `unavailable` |
| 13 | PostgreSQL (CNPG) and its backup to object storage | `02-cnpg.yaml`, `scripts/ci/check-postgres-backup-config.py` | upstream CloudNativePG; backup config owned by beluga | owns data-plane backups | `supported` |
| 14 | Node OS image and readiness | `Vagrantfile`, `configs/cluster.env`, `scripts/up.sh` | kube-ready-box (`node-runtime-foundation`) | consumer | `partial` |
| 15 | LDAP directory data plane | `openldap.yaml`, `VERSIONS.md` | ldapium (`directory-identity-data-plane`) | consumer | `partial` |
| 16 | Local / edge AI runtime | none (no AI in repo) | kubemetal (`local-edge-ai-runtime`) | optional consumer (#90) | `unavailable` |
| 17 | Filesystem / NFS quota enforcement | none (no NFS or RWX class) | nfs-quota-agent (`filesystem-quota-enforcement`) | would-be consumer | `not-applicable` |
| 18 | Engineering standards, portfolio state, evidence | `.openforge/status.json`, `.github/workflows/openforge-status.yml` | openforge (`portfolio-engineering-governance`) | consumer | `supported` |

Row 8 caveat: the registry lists `beluga` as a consumer of
`kubernetes-platform-control-plane`, while Beluga records Narwhal as `peer` /
`not-applicable` (design D11/D13, `.openforge/status.json`). ADR-0003 Q1 is decided:
Beluga is a `peer`; the registry's consumer entry is corrected in OpenForge.

## 2. Duplicate-implementation candidates

One assigned source of truth (SoT) per candidate. "Beluga keeps" lists what
stays in this repository and why; every exception carries a sunset condition.

| ID | Candidate | Where it duplicates | Assigned SoT | Beluga keeps | Sunset / escape hatch |
|---|---|---|---|---|---|
| D1 | Cluster bootstrap and GitOps lifecycle | `scripts/cluster/*.sh`, `scripts/gitops/01-argocd-bootstrap.sh` vs Narwhal cluster lifecycle (`narwhal:README.md`: ArgoCD + Gitea app-of-apps, Cilium, MetalLB) | narwhal for the capability in general; Beluga's scripts are a documented standalone-profile exception | standalone Vagrant + k3s bootstrap (ADR-0001) | revisit if a Narwhal-hosted Beluga profile is approved (ADR-0003 Q1) |
| D2 | Identity provider (Keycloak) | `keycloak.yaml` vs Narwhal Keycloak and its group contract (`narwhal:docs/common/oidc-rbac-contract.md`: `cluster-admin`, `developer`, `viewer`, `guest`) | beluga Keycloak is SoT for the data-platform realm and Beluga role names (LDAP group names, `AGENTS.md` seam); Narwhal's contract is SoT for Kubernetes API / ArgoCD / Portal authorization | data-platform realm, role mappers | shared realm only after ADR-0003 Q2 is decided |
| D3 | API gateway | `apisix-gateway.yaml` vs Narwhal APISIX OIDC gateway | beluga for `*.local.beluga.internal` routes; Narwhal for its own domain | route set in the domain registry (`AGENTS.md`) | none planned |
| D4 | Node preparation | `scripts/cluster/01-node-prep.sh` (swap, `overlay`/`br_netfilter`, sysctls) vs `kube-ready-box:docs/node-readiness-attestation.md` (cgroup v2, swap, modules, sysctls, containerd) | kube-ready-box | script stays as an idempotent safety net | remove duplicated checks once `kube-ready-readiness/v1` evidence is consumed by default |
| D5 | LDAP workload packaging | Beluga-rendered Deployment/Service/PVCs/Job in `openldap.yaml` vs `ldapium:charts/ldapium` (TLS, backup CronJob, replication) | ldapium for directory lifecycle (TLS, ACL, replication, backup/restore); Beluga for the Keycloak federation settings | seed LDIF, `openldap-init` Job, `postStart` TLS workaround (`openldap.yaml:192-241`) | drop `postStart` workaround when ldapium converges TLS on a bootstrapped volume; adopt-chart-vs-template is ADR-0003 Q4 |
| D6 | Keycloak LDAP federation tuning | `keycloak-ldap-federation.yaml` vs `ldapium:docs/changes/keycloak-federation/CHANGE.md` (`LDAP_LIMITS_DNS`, `LDAP_REFINT_NOTHING`, ppolicy finding H3) | ldapium for directory-side settings and evidence; beluga for the Keycloak-side job | federation job | re-verify against Beluga's Keycloak 26.7.1 (ldapium evidence ran 26.0.7) |
| D7 | Backup | Beluga CNPG barman to SeaweedFS vs Narwhal "Velero + CNPG barman" (`narwhal:README.md`) | beluga for data-plane data (PostgreSQL, Iceberg data); narwhal for cluster-level backup | `02-cnpg.yaml` backup config | none planned; no Velero in Beluga |
| D8 | Observability stack | `VERSIONS.md` Prometheus Stack entry vs Narwhal Prometheus/Loki/Tempo (`narwhal:docs/common/unified-observability-contract.md`, itself partly PROPOSED) | narwhal | nothing deployed; VERSIONS.md entry is a drift candidate | resolve in a follow-up (ADR-0003 Q5) |
| D9 | Capacity / quota evidence | no implementation; `nfs-quota-agent` exposes metrics and PV annotations | nfs-quota-agent for enforcement and quota evidence | consumer schema only (see section 3.5) | n/a |
| D10 | Local AI runtime | no implementation | kubemetal | none; optional adapter only (#90) | n/a |
| D11 | Management UI | beluga-manager vs Narwhal Portal | each manages only its own platform (registry: control surfaces own presentation, not the capability) | beluga-manager | none |

## 3. Per-pair integration boundaries

Columns: contract surface; direction (arrow = who depends on whom); status;
evidence on the Beluga side and on the sibling side. A surface labelled
*proposed* is not evidenced in the sibling repository.

### 3.1 Narwhal (registry: `kubernetes-platform-control-plane`, consumers include beluga)

| Contract surface | Direction | Status | Beluga evidence | Narwhal evidence |
|---|---|---|---|---|
| Cluster lifecycle / GitOps as Beluga's substrate | Beluga -> Narwhal | `not-applicable` | design spec lines 17, 29; `.openforge/status.json` (`peer`) | `narwhal:README.md` (cluster lifecycle, GitOps) |
| OIDC `groups` claim to Kubernetes RBAC / ArgoCD / Portal | Narwhal -> Beluga (would-be) | `not-applicable` | `AGENTS.md` (roles = LDAP group names, own Keycloak) | `narwhal:docs/common/oidc-rbac-contract.md` |
| Unified observability signals (metrics, logs, traces) | Beluga -> Narwhal (proposed) | `unavailable` | none | `narwhal:docs/common/unified-observability-contract.md` (current vs PROPOSED split) |
| Versioned management API / event envelope | Beluga -> Narwhal (proposed) | `unavailable` | none | `narwhal:docs/common/versioned-management-api-contract.md` (static contract baseline, not a live API), `narwhal:schemas/event-envelope-1.0.schema.json` |
| AI/LLMOps extension boundary | n/a | `not-applicable` | `docs/cross-oss-integration-contracts.md` section 4 (#90) | `narwhal:docs/common/ai-llmops-extension-contract.md` (draft, KubeMetal explicitly out of scope) |
| Network coexistence (192.168.77.x vs 192.168.56.x) | both | `supported` | design D1 (`docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md:38`) | `narwhal:README.md` (Vagrant, ARM64) |
| Kubernetes version alignment | none | `not-applicable` | `VERSIONS.md:14` (k3s v1.36.x) | `narwhal:README.md` (v1.35, kubeadm HA) |
| Reverse rule: Iceberg/Trino/Flink and data-product semantics never move to Narwhal | Narwhal does not own | `supported` | `.openforge/status.json`; registry `data-platform-lakehouse` (owner beluga, `consumers: []`) | `openforge:portfolio/capability-ownership.json` |

### 3.2 KubeMetal (registry: `local-edge-ai-runtime`, consumers include beluga)

| Contract surface | Direction | Status | Beluga evidence | KubeMetal evidence |
|---|---|---|---|---|
| OpenAI-compatible inference endpoint (`/v1`, `/v1/models`) | Beluga -> KubeMetal | `unavailable` | no AI consumer exists in this repo; backlog #73, #79, #80 | `kubemetal:docs/11-local-inference-runtime.md` (OpenAI base URL, `GET /v1/models`) |
| Runtime health probe and non-AI fallback | Beluga -> KubeMetal | `unavailable` | none (fallback path undefined) | `kubemetal:docs/11-local-inference-runtime.md` (`/health`, `/v1/models` probe) |
| Reachability from the Vagrant cluster to a macOS host runtime | Beluga -> KubeMetal | `unavailable` | none | `kubemetal:docs/11-local-inference-runtime.md` (opt-in `mac-gpu-service` bridge for K3s clients) |
| Per-invocation provenance (model, version, runtime, run id) | KubeMetal -> Beluga (proposed) | `unavailable` | `docs/cross-oss-integration-contracts.md` section 4 (sketch only) | `kubemetal:evidence/local-inference/*/manifest.json` exist; schema not verified |
| AI vs non-AI resource/cost telemetry | KubeMetal -> Beluga (proposed) | `unavailable` | none | none verified |
| AI-optional rule: core path works with KubeMetal absent | Beluga | `supported` | no AI dependency anywhere in repo (`docs/cross-oss-integration-contracts.md` section 4) | n/a |
| Compute backend contract (`ComputeBackend`) | n/a | `not-applicable` | none | `kubemetal:README.md` (host-mlx default, others experimental) |

### 3.3 kube-ready-box (registry: `node-runtime-foundation`, consumers narwhal, beluga)

| Contract surface | Direction | Status | Beluga evidence | kube-ready-box evidence |
|---|---|---|---|---|
| Vagrant box `dasomel/ubuntu-26.04-xfs` | Beluga -> box | `supported` | `Vagrantfile:51`, `configs/cluster.env:22`, `VERSIONS.md:15` | `kube-ready-box:README.md` (26.04 xfs box on Vagrant Cloud) |
| License/NOTICE ownership delegated to the box repo | Beluga -> box | `supported` | `VERSIONS.md:15` | `kube-ready-box:LICENSE`, `kube-ready-box:NOTICE` |
| Opt-in readiness-evidence gate (`ready` + `findings[]`) | box -> Beluga | `partial` | `scripts/up.sh:25-45` (`KUBE_READY_BOX_EVIDENCE_FILE`, warn-only) | `kube-ready-box:docs/evidence-contracts.md` (`kube-ready-readiness/v1`), `kube-ready-box:docs/node-readiness-attestation.md` |
| Producing evidence for Beluga nodes by default | box -> Beluga | `unavailable` | gate no-ops when env var is unset | `kube-ready-box:tools/node-readiness-attest.sh` runs on a booted box; not wired to Beluga's `vagrant up` |
| Box digest / checksum verification | Beluga -> box | `unavailable` | none (referenced by name only) | `kube-ready-box:docs/node-readiness-attestation.md` (manifest binds box `info.json` digest) |
| Node preparation ownership | box -> Beluga | `partial` | `scripts/cluster/01-node-prep.sh:12-34` duplicates box tuning | `kube-ready-box:docs/node-readiness-attestation.md` (D4 above) |
| Storage profile evidence (XFS, quota) | box -> Beluga | `unavailable` | none | `kube-ready-box:docs/evidence-contracts.md` (`kube-ready-storage/v1`) |

Note: the Beluga gate reads only `ready` and `findings[]`; it is not the
`kube-ready-readiness/v1` schema. Mapping between the two is an open follow-up.

### 3.4 ldapium (registry: `directory-identity-data-plane`, consumers narwhal, beluga)

| Contract surface | Direction | Status | Beluga evidence | ldapium evidence |
|---|---|---|---|---|
| Server image and env contract (`LDAP_*`, mounts, UID 999) | Beluga -> ldapium | `supported` | `VERSIONS.md:39`, `openldap.yaml` | `ldapium:README.md`, `ldapium:image/` |
| Keycloak LDAPS federation (`ou=users`, WRITABLE) | Keycloak -> ldapium | `partial` | `keycloak-ldap-federation.yaml:186-191` | `ldapium:docs/changes/keycloak-federation/CHANGE.md` (48 PASS, 1 XFAIL H3; Keycloak 26.0.7, Beluga runs 26.7.1) |
| TLS convergence on an already-bootstrapped volume | ldapium -> Beluga | `partial` | `openldap.yaml:192-241` (`postStart` `ldapmodify`) | `ldapium:docs/changes/openldap-2.6-hardening` (not verified for this case) |
| Stable release tags | ldapium -> Beluga | `partial` | nightly pin + allowlist line (`.github/image-tag-allowlist.txt`) | `ldapium:README.md` (status: prototype; registry publication to be verified) |
| Backup / restore | ldapium -> Beluga | `unavailable` | no backup wiring for LDAP | `ldapium:charts/ldapium/values.yaml` (`backup:`), `ldapium:scripts/backup.sh`, `ldapium:scripts/restore.sh` |
| Replication / HA | ldapium -> Beluga | `not-applicable` | single replica, one profile | `ldapium:docs/ha-profile.md` |
| Audit export (pull-based NDJSON) | ldapium -> Beluga | `unavailable` | none; see #35, #44 | `ldapium:docs/audit-event-schema.md`, `ldapium:scripts/export-audit-log.sh` |
| Helm chart reuse vs Beluga-rendered manifests | Beluga -> ldapium | `unavailable` | `openldap.yaml` is self-templated | `ldapium:charts/ldapium` (D5 above) |
| Management UI (`ldapium-ui`) | ldapium -> Beluga | `unavailable` | pinned, not deployed (`VERSIONS.md:40`) | `ldapium:ui/` |

Version note: `VERSIONS.md:39` states OpenLDAP 2.6.14 for `nightly-4e85165`;
`ldapium:README.md` advertises 2.6.15 as current. Which one the pinned nightly
contains is not verified here.

### 3.5 nfs-quota-agent (registry: `filesystem-quota-enforcement`, consumers narwhal, beluga)

| Contract surface | Direction | Status | Beluga evidence | nfs-quota-agent evidence |
|---|---|---|---|---|
| Quota enforcement on NFS PVs | agent -> Beluga | `not-applicable` | no NFS/RWX class; only four PVCs, k3s default provisioner (`docs/cross-oss-integration-contracts.md` section 5) | `nfs-quota-agent:README.md` (watches NFS PVs, `--provisioner-name`) |
| Filesystem prerequisite (XFS/ext4 `prjquota` on the NFS server node) | node -> agent | `not-applicable` | `dasomel/ubuntu-26.04-xfs` is XFS; `prjquota` mount option not configured in this repo | `nfs-quota-agent:README.md` (Supported Filesystems) |
| Capacity evidence: Prometheus `nfs_quota_used_bytes{directory}`, `nfs_quota_limit_bytes` on `:9090/metrics` | agent -> Beluga | `unavailable` | no Prometheus workload (row 12) | `nfs-quota-agent:README.md` (Prometheus Metrics) |
| PV annotations `nfs.io/quota-status`, `nfs.io/enforced-limit-bytes` | agent -> Beluga | `unavailable` | none | `nfs-quota-agent:README.md` (PV Annotations), `nfs-quota-agent:docs/IMPLEMENTATION-STATUS.md` |
| Producer-agnostic per-PVC capacity record `{namespace, claim, storage_class, used_bytes, limit_bytes, source, observed_at}` | any producer -> Beluga (proposed) | `unavailable` | `docs/cross-oss-integration-contracts.md` section 5 | none; agent keys metrics by `directory`, not PVC, so a mapping is needed |
| Namespace quota policy (`LimitRange`, annotations) | Beluga -> agent | `not-applicable` | no `ResourceQuota`/`LimitRange` in repo | `nfs-quota-agent:README.md` (Namespace Quota Policy) |

## 4. Classification counts

Counted from the Status columns of sections 1 and 3 (rows 1-18 and the five
boundary tables).

| Status | Section 1 (capabilities) | Section 3 (boundary cells) | Total |
|---|---|---|---|
| `supported` | 7 | 6 | 13 |
| `partial` | 6 | 5 | 11 |
| `unavailable` | 3 | 17 | 20 |
| `not-applicable` | 2 | 9 | 11 |
| Total | 18 | 37 | 55 |

## 5. What this slice does not do

- It defines no schema, endpoint or API name for any boundary; every *proposed*
  surface above needs an owner-negotiated contract first.
- It changes no manifest, script, version or `.openforge/status.json` entry.
- It does not adopt `ldapium` charts, deploy observability, or wire KubeMetal.

Remaining work per boundary is tracked as open questions in
[ADR-0003](adr/0003-beluga-data-platform-plane.md).
