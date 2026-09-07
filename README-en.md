# Beluga

Beluga is a personal/learning project that builds an independent Kubernetes cluster directly on local VMs and deploys, as IaC (Vagrantfile + Helm + ArgoCD GitOps), a data platform that flows from Kafka(+CDC) → Flink → Iceberg lakehouse → Trino/Superset → Airflow.
It does not build or vendor binaries directly—all components are fetched unchanged from their own upstream registries at deployment time.

Together with narwhal (K8s IDP) and kubemetal (Apple Silicon MLOps), it forms the author's platform trilogy and covers the data domain. See the [platform design specification](docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md) for the detailed design background.

> **This is a personal/learning-scale project.** It does not claim to be “production-ready.” Known limitations and work in progress are recorded as-is in the [Current status](#current-status) section.

---

## Table of contents

- [What is this?](#what-is-this)
- [Architecture at a glance](#architecture-at-a-glance)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Operation check (validation)](#operation-check-validation)
- [Credentials](#credentials)
- [Repository structure](#repository-structure)
- [Current status](#current-status)
- [License and third-party notices](#license-and-third-party-notices)

---

## What is this?

With one `vagrant up`, it creates a k3s cluster with one master and three workers, then deploys through ArgoCD app-of-apps, using GitOps, a stack spanning streaming ingest, CDC, stream processing, an Iceberg lakehouse, distributed SQL queries, BI dashboards, and orchestration.
Its goal is to demonstrate end-to-end operation with two demos: a synthetic clickstream event pipeline and a Postgres CDC pipeline.

## Architecture at a glance

[VERSIONS.md](VERSIONS.md) is the single source of truth for versions, images, and licenses. The following is a layer summary; always follow that document for exact versions.

| Layer | Components | Role |
|-------|------------|------|
| Cluster | k3s(v1.36 channel), Cilium, MetalLB | Kubernetes distribution, CNI, LoadBalancer |
| Gateway | APISIX + etcd | Unifies all HTTP UIs at `*.local.beluga.internal:80` |
| GitOps | ArgoCD | Deploys all workloads through app-of-apps |
| SSO/accounts | Keycloak + OpenLDAP | Single source for authentication and groups (Keycloak), account store (OpenLDAP, WRITABLE federation) |
| Policy | OPA + OpenFGA | Central policy engine for Trino/Kafka (OPA), Lakekeeper authorization (OpenFGA) |
| Ingest | Strimzi(Kafka, KRaft) + Debezium | Event streaming and CDC source |
| Stream processing | Flink Kubernetes Operator | Sessionization/aggregation and CDC upsert mirroring |
| Catalog | Lakekeeper | Iceberg REST Catalog |
| Storage | SeaweedFS | S3-compatible object storage |
| DB | CloudNativePG(PostgreSQL) | CDC source DB (`shop`) and consolidated metadata DBs |
| Analytics | Trino | Distributed SQL query engine over Iceberg |
| BI | Superset | Dashboards |
| Orchestration | Airflow 3(KubernetesExecutor) | Compaction and aggregation DAGs |
| Governance (optional) | OpenMetadata + OpenSearch | Catalog and lineage—enabled by default only on 48GB+ profiles |
| Observability | Prometheus Stack | Metrics |

Everything is Helm/Operator based and split into two charts—`gitops/charts/beluga-platform` (platform layer) and `gitops/charts/beluga-data` (data layer)—which ArgoCD deploys.

## Requirements

This project brings up four VMs and the full data stack; it is not a lightweight demo.

- **Host RAM**: At least 32GB. `scripts/common/env.sh` detects host RAM and chooses a profile automatically.
  - 32GB: default profile (Trino coordinator only, OpenMetadata off)
  - 48GB+: more worker memory plus OpenMetadata and a Trino worker enabled
  - 64GB+: further worker-memory increase
- **VM sizing**: master-1 (2 vCPU/4GB) + worker-1 to worker-3 (4 vCPU/8–12GB, depending on profile)—14 vCPU / 28GB total for the 32GB profile
- **Disk**: Space for four VMs and container images (tens of GB recommended)
- **Hypervisor**: VMware Fusion (arm64) or VirtualBox (amd64), selected with `VAGRANT_PROVIDER` in `configs/cluster.env`
- **Tools**: Vagrant, kubectl, helm

Even with the 32GB profile, the always-on memory budget closely fits available capacity. On a host without headroom, avoid running it alongside other heavy VMs or clusters.

## Quick start

```bash
git clone <this-repo>
cd beluga

# 1. Start the cluster (automatic RAM profile detection → Vagrant VMs → k3s → Cilium/MetalLB
#    → local DNS → ArgoCD GitOps bootstrap, five stages)
make up
# Internally runs bash scripts/up.sh
```

After startup, configure host DNS once so service domains resolve. Use one of the following.

**Option A — macOS `/etc/resolver` (recommended)**

```bash
sudo mkdir -p /etc/resolver
echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal
```

**Option B — add entries directly to `/etc/hosts`**

```
127.0.0.1 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal argocd.local.beluga.internal
```

> In an actual deployment, these domains point to `192.168.77.200` (the MetalLB LB IP attached to APISIX). The example in `CLAUDE.md` is a placeholder for viewing documents locally without the cluster. See [docs/access-guide.md](docs/access-guide.md) for the detailed IP and DNS architecture.

Key services after startup:

- Trino: `https://trino.local.beluga.internal`
- Airflow: `https://airflow.local.beluga.internal`
- Superset: `https://superset.local.beluga.internal`
- Lakekeeper (Iceberg REST): `https://catalog.local.beluga.internal`
- SeaweedFS S3: `https://s3.local.beluga.internal`
- ArgoCD: `https://argocd.local.beluga.internal`
- Keycloak SSO: `https://sso.local.beluga.internal`

> Issue #2: Port 80 always redirects to 443 (HTTPS) with 301, and certificates are issued by the cluster-internal CA. Register that CA as trusted in the browser/curl or provide it with `curl --cacert`. See [tests/10-tls-identity-boundary.sh](tests/10-tls-identity-boundary.sh) for how to obtain the CA certificate.

Other commands:

```bash
make status   # Check VM and Kubernetes pod status
make test     # Run all tests/ validation scripts
make lint     # shellcheck + helm lint
make down     # Delete all VMs
```

## Operation check (validation)

“Rendering passes” and “actually works” are distinct—the repository has separate validation scripts that query real state ([docs/mistakes-log.md](docs/mistakes-log.md) exists for this reason).

`bash tests/run-all.sh` (= `make test`) runs the following in order.

| Script | What it checks |
|--------|----------------|
| `tests/01-cluster-health.sh` | Kubernetes node and core-pod status |
| `tests/02-ingest-cdc.sh` | Strimzi Kafka and Debezium CDC pipeline |
| `tests/03-stream-iceberg.sh` | Flink Operator and Lakekeeper Iceberg REST Catalog |
| `tests/04-trino-query.sh` | Trino query engine and Iceberg connector |
| `tests/05-airflow-dag.sh` | Airflow orchestration and Superset service |
| `tests/06-authz-defaults.sh` | Whether default analyst permissions do not leak to newly created tables (authorization regression validation) |

`tests/06-authz-defaults.sh` is not included in `run-all.sh`; run it separately.

## Credentials

**No passwords are committed to the repository.** Every value is randomly generated with `openssl rand` at bootstrap and stored in the Kubernetes Secret (`beluga-credentials`); Helm charts receive values only through `--set`. All values defaults in the repository are `SET-AT-BOOTSTRAP` placeholders.

```bash
bash scripts/credentials.sh          # Print a summary of URLs, accounts, and passwords by service
bash scripts/credentials.sh --raw    # key=value form (for scripts/pipes)
```

To retrieve the original Secret directly:

```bash
kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d
```

## Repository structure

| Path | Contents |
|------|----------|
| `Vagrantfile` | Defines master-1 and worker-1 to worker-3 VMs |
| `Makefile` | Wrappers for `up`/`down`/`status`/`test`/`lint` |
| `VERSIONS.md` | Single source of truth for versions, images, and licenses of all components |
| `configs/cluster.env` | Subnet, node IPs, RAM-sizing defaults, and domain registry |
| `scripts/` | Bootstrap entry point (`up.sh`), node provisioning (`cluster/`), GitOps bootstrap (`gitops/`), and kubeconfig, credential, and SBOM utilities |
| `gitops/` | ArgoCD app-of-apps manifests and the `beluga-platform`/`beluga-data` Helm charts |
| `demo/` | Clickstream generator (Python) and Flink SQL pipeline definitions. The remaining demo artifacts—Shop DB seed, dashboard exports, and so on—are colocated in the relevant component Helm chart `templates/` and `files/`. |
| `policies/` | YAML declaring group, role, and resource permissions—the source compiled by the companion repository (policy compiler) into three outputs: Keycloak, Rego, and PostgreSQL DDL |
| `tests/` | E2E validation scripts that query real state |
| `docs/` | Design specification, mistakes log (`mistakes-log.md`), access guide (`access-guide.md`), and implementation plan |

## Current status

The real state at the time this repository is cloned is not hidden.

- **The local cluster is currently down** (`vagrant status` shows all four VMs as `not running`). Some recent changes have not been revalidated on a live cluster.
- The **core data platform** (Kafka/CDC → Flink → Iceberg → Trino/Superset/Airflow, k3s + ArgoCD GitOps bootstrap) is implemented and validated through clean-install E2E.
- **Policy-compiler integration is in progress.** The compiler itself (Tasks 1–12), which compiles declarative YAML in `policies/` into Keycloak/Rego/PostgreSQL outputs, is implemented and reviewed in a separate companion repository. However, the stage that actually deploys and validates its outputs in this cluster (Tasks 13–19—Trino LDAP group provider, policy cutover, Superset role mapping, catalog-browsing operation gaps, and so on) still requires a live cluster.
- Known limits and defects, along with their causes and resolutions, continue to accumulate in [docs/mistakes-log.md](docs/mistakes-log.md)—the repository’s principle is not to record only successes.

## License and third-party notices

This repository itself is licensed under [LICENSE](LICENSE) (Apache License 2.0).

Rather than duplicating the licenses of each deployed component, [VERSIONS.md](VERSIONS.md) is the single source of truth through its license column. [NOTICE](NOTICE) explains how this project does not build or vendor binaries and instead references components only over the network, the boundary when deploying copyleft components this way, and how to generate an SBOM for a live cluster (`bash scripts/generate-sbom.sh`).
