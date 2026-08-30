# Beluga

English | [한국어](README-ko.md)

Beluga builds an independent Kubernetes cluster directly on local VMs and deploys a
Kafka(+CDC) -> Flink -> Iceberg lakehouse -> Trino/Superset -> Airflow data platform on
top of it as IaC (Vagrantfile + Helm + ArgoCD GitOps). It is a personal/learning project.
No binary is built or vendored — every component is pulled at deploy time from its own
upstream registry, as-is.

Together with narwhal (K8s IDP) and kubemetal (Apple Silicon MLOps), Beluga owns the
data domain of the author's platform trilogy. See the
[platform design document](docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md)
for the full design background.

> **This is a personal/learning-scale project.** It does not claim to be "production
> ready." Known limitations and work in progress are listed as-is in the
> [Current Status](#current-status) section.

---

## Table of Contents

- [What is this](#what-is-this)
- [Architecture at a glance](#architecture-at-a-glance)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Verification](#verification)
- [Credentials](#credentials)
- [Repository layout](#repository-layout)
- [Current status](#current-status)
- [License and third-party notices](#license-and-third-party-notices)

---

## What is this

A single `vagrant up` builds a k3s cluster (1 master + 3 workers), and an ArgoCD
app-of-apps deploys a stack spanning streaming ingestion, CDC, stream processing, an
Iceberg lakehouse, distributed SQL querying, a BI dashboard, and orchestration on top of
it, all through GitOps. Two demos — a synthetic clickstream event pipeline and a
Postgres CDC pipeline — prove end-to-end behavior.

## Architecture at a glance

The single source of truth for versions, images and licenses is
[VERSIONS.md](VERSIONS.md). The table below is a per-layer summary; exact versions
always follow that document.

| Layer | Component | Role |
|-------|-----------|------|
| Cluster | k3s (v1.36 channel), Cilium, MetalLB | Kubernetes distribution, CNI, LoadBalancer |
| Gateway | APISIX + etcd | Unifies every HTTP UI under `*.local.beluga.internal:80` |
| GitOps | ArgoCD | Deploys the entire workload set app-of-apps style |
| SSO / accounts | Keycloak + OpenLDAP | Auth/group source of truth (Keycloak), account store (OpenLDAP, WRITABLE federation) |
| Policy | OPA + OpenFGA | Central policy engine for Trino/Kafka (OPA), Lakekeeper authorization (OpenFGA) |
| Ingestion | Strimzi (Kafka, KRaft) + Debezium | Event streaming + CDC source |
| Stream processing | Flink Kubernetes Operator | Sessionization/aggregation, CDC upsert mirroring |
| Catalog | Lakekeeper | Iceberg REST Catalog |
| Storage | SeaweedFS | S3-compatible object storage |
| Database | CloudNativePG (PostgreSQL) | CDC source DB (shop) + consolidated meta DB for every component |
| Analytics | Trino | Distributed SQL query engine over Iceberg |
| BI | Superset | Dashboards |
| Orchestration | Airflow 3 (KubernetesExecutor) | Compaction/aggregation DAGs |
| Governance (optional) | OpenMetadata + OpenSearch | Catalog/lineage — enabled by default only on 48GB+ profiles |
| Observability | Prometheus Stack | Metrics |

Everything is Helm/Operator-based, split across two charts —
`gitops/charts/beluga-platform` (platform layer) and `gitops/charts/beluga-data` (data
layer) — that ArgoCD deploys.

## Requirements

This project boots 4 VMs and the full data stack at once — it is not a lightweight demo.

- **Host RAM**: 32GB minimum. `scripts/common/env.sh` detects host RAM and picks a
  profile automatically.
  - 32GB: baseline profile (Trino coordinator only, OpenMetadata off)
  - 48GB+: increased worker memory + OpenMetadata/Trino worker enabled
  - 64GB+: further increased worker memory
- **VM sizing**: master-1 (2 vCPU/4GB) + worker-1..3 (4 vCPU/8-12GB depending on
  profile) — 14 vCPU / 28GB total on the 32GB profile
- **Disk**: room for 4 VMs plus container images (tens of GB recommended)
- **Hypervisor**: VMware Fusion (arm64) or VirtualBox (amd64) — selected via
  `VAGRANT_PROVIDER` in `configs/cluster.env`
- **Tools**: Vagrant, kubectl, helm

Even on the 32GB profile the steady-state memory budget is tight — avoid running other
heavy VMs/clusters on the same host at the same time.

## Quick start

```bash
git clone <this-repo>
cd beluga

# 1. Boot the cluster (auto-detect RAM profile -> Vagrant VMs -> k3s ->
#    Cilium/MetalLB -> local DNS -> ArgoCD GitOps bootstrap, 5 stages)
make up
# internally runs bash scripts/up.sh
```

Once boot finishes, the host DNS needs to be pointed once so service domains resolve.
Use one of the two options below.

**Option A — macOS `/etc/resolver` (recommended)**

```bash
sudo mkdir -p /etc/resolver
echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal
```

**Option B — direct `/etc/hosts` entries**

```
127.0.0.1 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal argocd.local.beluga.internal
```

> In an actual deployment those domains point at `192.168.77.200` (the MetalLB LB IP
> attached to APISIX). The example above is a placeholder for viewing the docs locally
> without a cluster — see [docs/access-guide.md](docs/access-guide.md) for the full
> IP/DNS architecture.

Main services after boot:

- Trino: `https://trino.local.beluga.internal`
- Airflow: `https://airflow.local.beluga.internal`
- Superset: `https://superset.local.beluga.internal`
- Lakekeeper (Iceberg REST): `https://catalog.local.beluga.internal`
- SeaweedFS S3: `https://s3.local.beluga.internal`
- ArgoCD: `https://argocd.local.beluga.internal`
- Keycloak SSO: `https://sso.local.beluga.internal`

> Issue #2: port 80 always redirects to 443 (HTTPS) with a 301, and certificates are
> issued by the cluster's internal CA — the browser/curl must trust that CA, or you must
> pass `curl --cacert`. See
> [tests/10-tls-identity-boundary.sh](tests/10-tls-identity-boundary.sh) for how to
> retrieve the CA certificate.

Other commands:

```bash
make status   # check VM and K8s pod status
make test     # run the full tests/ verification suite
make lint     # shellcheck + helm lint
make down     # destroy all VMs
```

## Verification

We distinguish "renders successfully" from "actually works" — this repo keeps separate
verification scripts that query real state (that is exactly why
[docs/mistakes-log.md](docs/mistakes-log.md) exists).

`bash tests/run-all.sh` (= `make test`) runs the following in order.

| Script | Checks |
|--------|--------|
| `tests/01-cluster-health.sh` | K8s node/core pod status |
| `tests/02-ingest-cdc.sh` | Strimzi Kafka + Debezium CDC pipeline |
| `tests/03-stream-iceberg.sh` | Flink Operator + Lakekeeper Iceberg REST Catalog |
| `tests/04-trino-query.sh` | Trino query engine + Iceberg connector |
| `tests/05-airflow-dag.sh` | Airflow orchestration + Superset service |
| `tests/06-authz-defaults.sh` | Default analyst permissions do not leak into new tables (authz regression check) |

`tests/06-authz-defaults.sh` is not part of `run-all.sh` and is run separately.

## Credentials

**No password is ever committed to this repository.** Every value is generated randomly
with `openssl rand` at bootstrap time and stored in a Kubernetes Secret
(`beluga-credentials`); Helm charts only receive it via `--set`. The repo's values
defaults are all `SET-AT-BOOTSTRAP` placeholders.

```bash
bash scripts/credentials.sh          # print a per-service URL/account/password summary
bash scripts/credentials.sh --raw    # key=value form (for scripts/pipes)
```

To read the underlying Secret directly:

```bash
kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d
```

## Repository layout

| Path | Contents |
|------|----------|
| `Vagrantfile` | master-1 + worker-1..3 VM definitions |
| `Makefile` | `up`/`down`/`status`/`test`/`lint` wrappers |
| `VERSIONS.md` | Single source of truth for every component's version/image/license |
| `configs/cluster.env` | Subnet, node IPs, RAM sizing defaults, domain registry |
| `scripts/` | Bootstrap entrypoint (`up.sh`), node provisioning (`cluster/`), GitOps bootstrap (`gitops/`), kubeconfig/credentials/SBOM utilities |
| `gitops/` | ArgoCD app-of-apps manifests plus the `beluga-platform`/`beluga-data` Helm charts |
| `demo/` | Clickstream generator (Python) and Flink SQL pipeline definitions. The remaining demo artifacts (shop DB seed, dashboard export, etc.) live alongside each component's Helm chart `templates/`/`files/` |
| `policies/` | YAML declaring groups/roles/resource permissions — the source a companion repo (policy compiler) compiles into Keycloak/Rego/PostgreSQL DDL outputs |
| `tests/` | E2E verification scripts that query real state |
| `docs/` | Design docs, [mistakes log](docs/mistakes-log.md), [access guide](docs/access-guide.md), implementation plans |

## Current status

We do not hide the actual state of the repo at clone time.

- **The local cluster is currently down** (`vagrant status` shows all 4 VMs as
  `not running`). Some recent changes have not been re-verified against a live cluster.
- **The core data platform** (Kafka/CDC -> Flink -> Iceberg -> Trino/Superset/Airflow,
  k3s + ArgoCD GitOps bootstrap) has been implemented and clean-install E2E verified.
- **Policy compiler integration is in progress.** The compiler itself (Task 1-12) that
  turns the declarative YAML in `policies/` into Keycloak/Rego/PostgreSQL outputs has
  been implemented and reviewed in a separate companion repo, but the stage that
  actually deploys and verifies those outputs against this cluster (Task 13-19 — Trino
  LDAP group provider, policy cutover, Superset role mapping, catalog-browsing operation
  gaps, etc.) still needs a live cluster and remains outstanding.
- Known limitations and defects, along with their causes and how they were resolved, are
  accumulated in [docs/mistakes-log.md](docs/mistakes-log.md) as they happen — this repo
  intentionally does not record only successes.

## License and third-party notices

This repository itself is licensed under [LICENSE](LICENSE) (Apache License 2.0).

Which license each deployed component carries is not duplicated here — the "License"
column in [VERSIONS.md](VERSIONS.md) is the single source of truth. How this project
references components purely over the network without building/vendoring binaries, the
boundaries of distributing copyleft components this way, and how to generate a live
cluster SBOM (`scripts/generate-sbom.sh`) are documented in [NOTICE](NOTICE).
