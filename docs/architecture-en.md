# Beluga Architecture Overview

Beluga is a personal, learning-scale project that deploys a data platform on an independent k3s cluster created with Vagrant. It runs a fixed topology of 4 VMs (one master `master-1` plus three workers `worker-1`–`worker-3`) with the full data stack; only worker memory and whether OpenMetadata/Trino worker are enabled scale automatically with host RAM (32/48/64GB+). ArgoCD deploys the `beluga-platform` and `beluga-data` Helm charts through the app-of-apps GitOps pattern. This document is a reader-facing summary; see the [platform design specification](superpowers/specs/2026-08-09-beluga-data-platform-design.md) for design rationale and detail.

> This is a **personal, learning-scale project**. It does not claim to be production-ready. Operational limits and cautions discovered during work are accumulated in the [mistakes log](mistakes-log.md).

## Data flow

```text
Kafka / Debezium CDC
        → Flink
        → Iceberg lakehouse (Lakekeeper catalog + SeaweedFS S3)
        → Trino / Superset
        → Airflow orchestration
```

- **Clickstream demo**: A Python synthetic clickstream generator creates Kafka events; Flink SQL sessionizes and window-aggregates them before storing them in Iceberg tables.
- **Postgres CDC demo**: Debezium sends changes from CNPG PostgreSQL `shop` to Kafka; Flink SQL performs upsert mirroring to create Iceberg order and customer tables.
- **Shared downstream**: Trino queries Iceberg, Superset provides dashboards, and Airflow orchestrates compaction and aggregation work.

## Deployment and access boundary

Vagrant creates the VMs and prepares k3s, Cilium, and MetalLB. `scripts/gitops/01-argocd-bootstrap.sh` then applies ArgoCD and the app-of-apps root. The domain registry for HTTP UIs and APIs is `*.local.beluga.internal`, unified on HTTPS 443 through the APISIX gateway. HTTP 80 redirects to HTTPS with 301. Follow the [access guide](access-guide.md) for real service URLs and DNS setup.

## Repository layout

| Path | Contents |
|------|----------|
| `configs/` | Cluster environment variables and defaults for nodes, domains, and resources |
| `demo/` | Demo artifacts including the clickstream generator and Flink SQL |
| `docs/` | Design, access, validation, and mistakes-log documents |
| `gitops/` | ArgoCD app-of-apps manifests and platform/data Helm charts |
| `policies/` | YAML declarations of group, role, and resource permissions |
| `scripts/` | Bootstrap, node provisioning, GitOps, kubeconfig, credential, and SBOM utilities |
| `tests/` | E2E validation scripts that query actual cluster state |

## Versions and detailed design

[VERSIONS.md](../VERSIONS.md) is the single source of truth for every component version, image, and license. This document intentionally does not duplicate the version table. Consult the [platform design specification](superpowers/specs/2026-08-09-beluga-data-platform-design.md) for decisions and trade-offs, and the [mistakes log](mistakes-log.md) for known operational pitfalls.
