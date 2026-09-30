# Beluga Platform Asset Inventory & Lifecycle Governance

English | [한국어](platform-asset-inventory-ko.md)

This document establishes the declared-state operational platform asset inventory for the Beluga data platform, fulfilling the baseline requirements of [Issue #42](https://github.com/dasomel/beluga/issues/42) ("Establish platform asset inventory and lifecycle governance").

> [!IMPORTANT]
> **Declared-State Scope Disciplinary Invariant**
> This inventory is a **declared-state baseline** from GitOps Helm manifests rendered with `KUBECONFIG=/dev/null` across the profiles below and [VERSIONS.md](../VERSIONS.md). It covers workloads, custom resources, container images, and declared storage. Live cluster state and image support/EOL dates are not assessed; lifecycle means declared pin only. Runtime reconciliation and EOL review require separate evidence.
> Profiles: `default` (32GB), `48GB+` (`openmetadata.enabled=true`, `trino.workerEnabled=true`), `oauth` (`strimzi.oauthListener=true`), `acl` (`strimzi.aclAuthorizer=true`), `external` (`strimzi.externalListenerEnabled=true`), and `all-enabled` (all flags true). Reproducibility checks are scoped to CI-pinned Helm v3.16.4; local Helm versions may render differently.

---

## 1. Workloads Inventory

A total of 33 distinct declared workloads are rendered across the listed profiles. `Conditional` means absent from the default profile.

| Workload (Stable Identifier) | Kind | Namespace | Chart | Declared Replicas / Mode | Images | Profile | Declared Source |
|---|---|---|---|---|---|---|---|
| `Deployment/analytics/superset` | Deployment | `analytics` | `beluga-data` | 1 | `apache/superset:6.1.0` | default | [`beluga-data/templates/08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml) |
| `Deployment/analytics/trino-coordinator` | Deployment | `analytics` | `beluga-data` | 1 | `trinodb/trino:483` | default | [`beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml) |
| `Deployment/analytics/trino-worker` | Deployment | `analytics` | `beluga-data` | 1 | `trinodb/trino:483` | Conditional: 48GB+, all-enabled | [`beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml) |
| `Job/analytics/superset-dashboard-import` | Job | `analytics` | `beluga-data` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-data/templates/15-superset-import.yaml`](../gitops/charts/beluga-data/templates/15-superset-import.yaml) |
| `Job/database/db-roles-setup` | Job | `database` | `beluga-data` | Run-to-completion (1) | `ghcr.io/cloudnative-pg/postgresql:17.6` | default | [`beluga-data/templates/02c-db-roles.yaml`](../gitops/charts/beluga-data/templates/02c-db-roles.yaml) |
| `Job/database/shop-seed` | Job | `database` | `beluga-data` | Run-to-completion (1) | `ghcr.io/cloudnative-pg/postgresql:17.6` | default | [`beluga-data/templates/02b-shop-seed.yaml`](../gitops/charts/beluga-data/templates/02b-shop-seed.yaml) |
| `Deployment/governance/openmetadata` | Deployment | `governance` | `beluga-data` | 1 | `openmetadata/server:1.13.3` | Conditional: 48GB+, all-enabled | [`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml) |
| `Deployment/governance/opensearch` | Deployment | `governance` | `beluga-data` | 1 | `opensearchproject/opensearch:2.18.0` | Conditional: 48GB+, all-enabled | [`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml) |
| `Job/governance/openmetadata-migration` | Job | `governance` | `beluga-data` | Run-to-completion (1) | `openmetadata/server:1.13.3` | Conditional: 48GB+, all-enabled | [`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml) |
| `Deployment/iam/keycloak` | Deployment | `iam` | `beluga-platform` | 1 | `quay.io/keycloak/keycloak:26.7.1` | default | [`beluga-platform/templates/keycloak.yaml`](../gitops/charts/beluga-platform/templates/keycloak.yaml) |
| `Deployment/iam/opa` | Deployment | `iam` | `beluga-platform` | 1 | `openpolicyagent/opa:1.19.0-static` | default | [`beluga-platform/templates/opa.yaml`](../gitops/charts/beluga-platform/templates/opa.yaml) |
| `Deployment/iam/openfga` | Deployment | `iam` | `beluga-platform` | 1 | `ghcr.io/cloudnative-pg/postgresql:17.6`<br>`openfga/openfga:v1.18.3` | default | [`beluga-platform/templates/openfga.yaml`](../gitops/charts/beluga-platform/templates/openfga.yaml) |
| `Deployment/iam/openldap` | Deployment | `iam` | `beluga-platform` | 1 | `ghcr.io/dasomel/ldapium:nightly-4e85165` | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `Job/iam/keycloak-clients` | Job | `iam` | `beluga-platform` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-platform/templates/keycloak-clients.yaml`](../gitops/charts/beluga-platform/templates/keycloak-clients.yaml) |
| `Job/iam/keycloak-group-mapper` | Job | `iam` | `beluga-platform` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-platform/templates/keycloak-group-mapper.yaml`](../gitops/charts/beluga-platform/templates/keycloak-group-mapper.yaml) |
| `Job/iam/keycloak-ldap-federation` | Job | `iam` | `beluga-platform` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-platform/templates/keycloak-ldap-federation.yaml`](../gitops/charts/beluga-platform/templates/keycloak-ldap-federation.yaml) |
| `Job/iam/keycloak-role-migration` | Job | `iam` | `beluga-platform` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-platform/templates/keycloak-role-migration.yaml`](../gitops/charts/beluga-platform/templates/keycloak-role-migration.yaml) |
| `Job/iam/keycloak-users` | Job | `iam` | `beluga-platform` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-platform/templates/keycloak-users.yaml`](../gitops/charts/beluga-platform/templates/keycloak-users.yaml) |
| `Job/iam/openldap-init` | Job | `iam` | `beluga-platform` | Run-to-completion (1) | `ghcr.io/dasomel/ldapium:nightly-4e85165` | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `Deployment/lakehouse/lakekeeper` | Deployment | `lakehouse` | `beluga-data` | 1 | `quay.io/lakekeeper/catalog:v0.13.1` | default | [`beluga-data/templates/04-lakekeeper.yaml`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml) |
| `Job/lakehouse/lakekeeper-bootstrap` | Job | `lakehouse` | `beluga-data` | Run-to-completion (1) | `curlimages/curl:8.21.0` | default | [`beluga-data/templates/12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml) |
| `Job/lakehouse/lakekeeper-migrate` | Job | `lakehouse` | `beluga-data` | Run-to-completion (1) | `quay.io/lakekeeper/catalog:v0.13.1` | default | [`beluga-data/templates/04-lakekeeper.yaml`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml) |
| `Deployment/orchestration/airflow-webserver` | Deployment | `orchestration` | `beluga-data` | 1 | `apache/airflow:3.3.0-python3.11` | default | [`beluga-data/templates/07-airflow.yaml`](../gitops/charts/beluga-data/templates/07-airflow.yaml) |
| `Deployment/platform-system/apisix` | Deployment | `platform-system` | `beluga-platform` | 1 | `apache/apisix:3.17.0-debian` | default | [`beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml) |
| `Deployment/platform-system/apisix-etcd` | Deployment | `platform-system` | `beluga-platform` | 1 | `registry.k8s.io/etcd:3.5.31-0` | default | [`beluga-platform/templates/apisix-infra.yaml`](../gitops/charts/beluga-platform/templates/apisix-infra.yaml) |
| `Deployment/platform-system/apisix-ingress-controller` | Deployment | `platform-system` | `beluga-platform` | 1 | `apache/apisix-ingress-controller:1.8.0`<br>`curlimages/curl:8.21.0` | default | [`beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml) |
| `Job/platform-system/internal-ca-distribution` | Job | `platform-system` | `beluga-platform` | Run-to-completion (1) | `python:3.12-slim` | default | [`beluga-platform/templates/internal-ca-distribution.yaml`](../gitops/charts/beluga-platform/templates/internal-ca-distribution.yaml) |
| `StatefulSet/storage/seaweedfs` | StatefulSet | `storage` | `beluga-data` | 1 | `chrislusf/seaweedfs:4.41`<br>`curlimages/curl:8.21.0` | default | [`beluga-data/templates/01-seaweedfs.yaml`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml) |
| `Deployment/streaming/clickstream-gen` | Deployment | `streaming` | `beluga-data` | 1 | `python:3.12-slim` | default | [`beluga-data/templates/13-clickstream-gen.yaml`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml) |
| `Deployment/streaming/debezium-connect` | Deployment | `streaming` | `beluga-data` | 1 | `quay.io/debezium/connect:3.6.1.Final` | default | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `FlinkDeployment/streaming/flink-cluster` | FlinkDeployment | `streaming` | `beluga-data` | Operator-managed (JobManager + TaskManager) | `flink:1.20.0-scala_2.12-java17` | default | [`beluga-data/templates/05-flink-operator.yaml`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml) |
| `Job/streaming/debezium-register-shop` | Job | `streaming` | `beluga-data` | Run-to-completion (1) | `curlimages/curl:8.21.0` | default | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `Job/streaming/flink-sql-submit` | Job | `streaming` | `beluga-data` | Run-to-completion (1) | `flink:1.20.0-scala_2.12-java17` | default | [`beluga-data/templates/14-flink-jobs.yaml`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml) |

---

## 2. Custom Resources & Operator Managed Assets

A total of 37 distinct custom resources are declared across the listed profiles.

| Custom Resource Identifier | Kind | API Version | Namespace | Controlling Operator | Profile | Declared Source |
|---|---|---|---|---|---|---|
| `ApisixRoute/analytics/superset` | ApisixRoute | `apisix.apache.org/v2` | `analytics` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixRoute/analytics/trino` | ApisixRoute | `apisix.apache.org/v2` | `analytics` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/analytics/superset` | ApisixUpstream | `apisix.apache.org/v2` | `analytics` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/analytics/trino` | ApisixUpstream | `apisix.apache.org/v2` | `analytics` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `Certificate/analytics/trino-coordinator-tls` | Certificate | `cert-manager.io/v1` | `analytics` | cert-manager | default | [`beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml) |
| `Certificate/cert-manager/beluga-internal-ca` | Certificate | `cert-manager.io/v1` | `cert-manager` | cert-manager | default | [`beluga-platform/templates/cert-manager-issuer.yaml`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml) |
| `ClusterIssuer/cluster-scoped/beluga-internal-ca-issuer` | ClusterIssuer | `cert-manager.io/v1` | `cluster-scoped` | cert-manager | default | [`beluga-platform/templates/cert-manager-issuer.yaml`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml) |
| `ClusterIssuer/cluster-scoped/selfsigned-bootstrap` | ClusterIssuer | `cert-manager.io/v1` | `cluster-scoped` | cert-manager | default | [`beluga-platform/templates/cert-manager-issuer.yaml`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml) |
| `Cluster/database/postgres-main` | Cluster | `postgresql.cnpg.io/v1` | `database` | CloudNativePG Operator | default | [`beluga-data/templates/02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml) |
| `ScheduledBackup/database/postgres-main-backup` | ScheduledBackup | `postgresql.cnpg.io/v1` | `database` | CloudNativePG Operator | default | [`beluga-data/templates/02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml) |
| `ApisixRoute/governance/openmetadata` | ApisixRoute | `apisix.apache.org/v2` | `governance` | APISIX Ingress Controller | Conditional: 48GB+, all-enabled | [`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml) |
| `ApisixUpstream/governance/openmetadata` | ApisixUpstream | `apisix.apache.org/v2` | `governance` | APISIX Ingress Controller | Conditional: 48GB+, all-enabled | [`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml) |
| `ApisixRoute/iam/keycloak` | ApisixRoute | `apisix.apache.org/v2` | `iam` | APISIX Ingress Controller | default | [`beluga-platform/templates/keycloak.yaml`](../gitops/charts/beluga-platform/templates/keycloak.yaml) |
| `ApisixUpstream/iam/keycloak` | ApisixUpstream | `apisix.apache.org/v2` | `iam` | APISIX Ingress Controller | default | [`beluga-platform/templates/keycloak.yaml`](../gitops/charts/beluga-platform/templates/keycloak.yaml) |
| `Certificate/iam/openldap-tls` | Certificate | `cert-manager.io/v1` | `iam` | cert-manager | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `ApisixRoute/lakehouse/lakekeeper` | ApisixRoute | `apisix.apache.org/v2` | `lakehouse` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/lakehouse/lakekeeper` | ApisixUpstream | `apisix.apache.org/v2` | `lakehouse` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixRoute/orchestration/airflow` | ApisixRoute | `apisix.apache.org/v2` | `orchestration` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/orchestration/airflow` | ApisixUpstream | `apisix.apache.org/v2` | `orchestration` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixGlobalRule/platform-system/https-redirect` | ApisixGlobalRule | `apisix.apache.org/v2` | `platform-system` | APISIX Ingress Controller | default | [`beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml) |
| `ApisixRoute/platform-system/argocd` | ApisixRoute | `apisix.apache.org/v2` | `platform-system` | APISIX Ingress Controller | default | [`beluga-platform/templates/apisix-routes.yaml`](../gitops/charts/beluga-platform/templates/apisix-routes.yaml) |
| `ApisixTls/platform-system/apisix-gateway-tls` | ApisixTls | `apisix.apache.org/v2` | `platform-system` | APISIX Ingress Controller | default | [`beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml) |
| `ApisixUpstream/platform-system/argocd-server` | ApisixUpstream | `apisix.apache.org/v2` | `platform-system` | APISIX Ingress Controller | default | [`beluga-platform/templates/apisix-routes.yaml`](../gitops/charts/beluga-platform/templates/apisix-routes.yaml) |
| `Certificate/platform-system/apisix-gateway-tls` | Certificate | `cert-manager.io/v1` | `platform-system` | cert-manager | default | [`beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml) |
| `ApisixRoute/storage/seaweedfs-filer` | ApisixRoute | `apisix.apache.org/v2` | `storage` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixRoute/storage/seaweedfs-s3` | ApisixRoute | `apisix.apache.org/v2` | `storage` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/storage/seaweedfs-filer` | ApisixUpstream | `apisix.apache.org/v2` | `storage` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/storage/seaweedfs-s3` | ApisixUpstream | `apisix.apache.org/v2` | `storage` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixRoute/streaming/flink` | ApisixRoute | `apisix.apache.org/v2` | `streaming` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `ApisixUpstream/streaming/flink` | ApisixUpstream | `apisix.apache.org/v2` | `streaming` | APISIX Ingress Controller | default | [`beluga-data/templates/10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml) |
| `Certificate/streaming/beluga-kafka-oauth-ca` | Certificate | `cert-manager.io/v1` | `streaming` | cert-manager | Conditional: all-enabled, oauth | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `FlinkDeployment/streaming/flink-cluster` | FlinkDeployment | `flink.apache.org/v1beta1` | `streaming` | Flink Kubernetes Operator | default | [`beluga-data/templates/05-flink-operator.yaml`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml) |
| `Kafka/streaming/beluga-kafka` | Kafka | `kafka.strimzi.io/v1` | `streaming` | Strimzi Kafka Operator | default | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `KafkaNodePool/streaming/mixed` | KafkaNodePool | `kafka.strimzi.io/v1` | `streaming` | Strimzi Kafka Operator | default | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `KafkaUser/streaming/beluga-admin` | KafkaUser | `kafka.strimzi.io/v1` | `streaming` | Strimzi Kafka Operator | Conditional: acl, all-enabled, oauth | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `KafkaUser/streaming/beluga-analyst` | KafkaUser | `kafka.strimzi.io/v1` | `streaming` | Strimzi Kafka Operator | Conditional: acl, all-enabled, oauth | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |
| `KafkaUser/streaming/beluga-engineer` | KafkaUser | `kafka.strimzi.io/v1` | `streaming` | Strimzi Kafka Operator | Conditional: acl, all-enabled, oauth | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |

---

## 3. Container Images & Version Source of Truth

All 19 distinct container images from the listed profiles appear below. Matching expected versions come from [VERSIONS.md](../VERSIONS.md); `Unmapped` means no matching row pin.

| Component | Declared Image Tag | Expected Version in VERSIONS.md | License | Lifecycle | Profile | Consumer Workloads |
|---|---|---|---|---|---|---|
| **Airflow** | `apache/airflow:3.3.0-python3.11` | `3.3.0` | Apache-2.0 | Declared pin only; EOL not assessed | default | `airflow-webserver` |
| **APISIX** | `apache/apisix:3.17.0-debian` | `3.17.0` | Apache-2.0 | Declared pin only; EOL not assessed | default | `apisix` |
| **APISIX Ingress Controller** | `apache/apisix-ingress-controller:1.8.0` | `1.8.0` | Apache-2.0 | Declared pin only; EOL not assessed | default | `apisix-ingress-controller` |
| **curl (유틸)** | `curlimages/curl:8.21.0` | `8.21.0` | curl License (MIT류) | Declared pin only; EOL not assessed | default | `apisix-ingress-controller`, `lakekeeper-bootstrap`, `debezium-register-shop` (+1 more) |
| **Debezium** | `quay.io/debezium/connect:3.6.1.Final` | `3.6.1.Final` | Apache-2.0 | Declared pin only; EOL not assessed | default | `debezium-connect` |
| **etcd (APISIX용)** | `registry.k8s.io/etcd:3.5.31-0` | `3.5.31-0` | Apache-2.0 | Declared pin only; EOL not assessed | default | `apisix-etcd` |
| **Keycloak** | `quay.io/keycloak/keycloak:26.7.1` | `26.7.1` | Apache-2.0 | Declared pin only; EOL not assessed | default | `keycloak` |
| **Lakekeeper** | `quay.io/lakekeeper/catalog:v0.13.1` | `v0.13.1` | Apache-2.0 | Declared pin only; EOL not assessed | default | `lakekeeper`, `lakekeeper-migrate` |
| **OPA** | `openpolicyagent/opa:1.19.0-static` | `1.19.0-static` | Apache-2.0 | Declared pin only; EOL not assessed | default | `opa` |
| **OpenFGA** | `openfga/openfga:v1.18.3` | `v1.18.3` | Apache-2.0 | Declared pin only; EOL not assessed | default | `openfga` |
| **OpenMetadata** | `openmetadata/server:1.13.3` | `1.13.3` | Apache-2.0 | Declared pin only; EOL not assessed | Conditional: 48GB+, all-enabled | `openmetadata`, `openmetadata-migration` |
| **OpenSearch** | `opensearchproject/opensearch:2.18.0` | `2.18.0` | Apache-2.0 | Declared pin only; EOL not assessed | Conditional: 48GB+, all-enabled | `opensearch` |
| **PostgreSQL 컨테이너 이미지** | `ghcr.io/cloudnative-pg/postgresql:17.6` | `17.6` | PostgreSQL License | Declared pin only; EOL not assessed | default | `postgres-main`, `openfga`, `db-roles-setup` (+1 more) |
| **Python** | `python:3.12-slim` | `3.12-slim` | PSF License 2.0 | Declared pin only; EOL not assessed | default | `clickstream-gen`, `superset-dashboard-import`, `keycloak-clients` (+5 more) |
| **SeaweedFS** | `chrislusf/seaweedfs:4.41` | `4.41` | Apache-2.0 | Declared pin only; EOL not assessed | default | `seaweedfs` |
| **Superset** | `apache/superset:6.1.0` | `6.1.0` | Apache-2.0 | Declared pin only; EOL not assessed | default | `superset` |
| **Trino** | `trinodb/trino:483` | `483` | Apache-2.0 | Declared pin only; EOL not assessed | default | `trino-coordinator`, `trino-worker` |
| **Unmapped / Internal Tool** | `ghcr.io/dasomel/ldapium:nightly-4e85165` | `Unmapped` | Unmapped | Declared pin only; EOL not assessed | default | `openldap`, `openldap-init` |
| **Unmapped / Internal Tool** | `flink:1.20.0-scala_2.12-java17` | `Unmapped` | Unmapped | Declared pin only; EOL not assessed | default | `flink-cluster`, `flink-sql-submit` |

---

## 4. Persistent Storage Assets & Volume Claims

A total of 6 persistent volume claims, volume claim templates, and operator-managed cluster storage specifications are cataloged.

| Asset Name | Storage Type | Namespace | Declared Capacity | Consumer Workload | Profile | Declared Source |
|---|---|---|---|---|---|---|
| `postgres-main-storage` | CNPG Cluster Managed Storage | `database` | `5Gi` | `Cluster/database/postgres-main` | default | [`beluga-data/templates/02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml) |
| `openldap-config` | Standalone PVC | `iam` | `1Gi` | `Deployment/iam/openldap` | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `openldap-data` | Standalone PVC | `iam` | `2Gi` | `Deployment/iam/openldap` | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `apisix-etcd-data` | Standalone PVC | `platform-system` | `1Gi` | `Deployment/platform-system/apisix-etcd` | default | [`beluga-platform/templates/apisix-infra.yaml`](../gitops/charts/beluga-platform/templates/apisix-infra.yaml) |
| `seaweedfs (seaweedfs-data)` | StatefulSet VolumeClaimTemplate | `storage` | `5Gi` | `StatefulSet/storage/seaweedfs` | default | [`beluga-data/templates/01-seaweedfs.yaml`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml) |
| `kafka-mixed-jbod` | Strimzi KafkaNodePool Storage | `streaming` | `5Gi` | `KafkaNodePool/streaming/mixed` | default | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |

---

## 5. Profile-Gated & Conditional Workloads

These identifiers are derived from rendered manifests; the Profile column above records each gate:

- `Deployment/analytics/trino-worker` — Conditional: 48GB+, all-enabled ([`beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml))
- `Deployment/governance/openmetadata` — Conditional: 48GB+, all-enabled ([`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml))
- `Deployment/governance/opensearch` — Conditional: 48GB+, all-enabled ([`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml))
- `Job/governance/openmetadata-migration` — Conditional: 48GB+, all-enabled ([`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml))
- `ApisixRoute/governance/openmetadata` — Conditional: 48GB+, all-enabled ([`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml))
- `ApisixUpstream/governance/openmetadata` — Conditional: 48GB+, all-enabled ([`beluga-data/templates/11-openmetadata.yaml`](../gitops/charts/beluga-data/templates/11-openmetadata.yaml))
- `Certificate/streaming/beluga-kafka-oauth-ca` — Conditional: all-enabled, oauth ([`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml))
- `KafkaUser/streaming/beluga-admin` — Conditional: acl, all-enabled, oauth ([`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml))
- `KafkaUser/streaming/beluga-analyst` — Conditional: acl, all-enabled, oauth ([`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml))
- `KafkaUser/streaming/beluga-engineer` — Conditional: acl, all-enabled, oauth ([`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml))

---

## 6. Lifecycle Governance & Operational Policies

### A. Version Pinning and Immutability Invariant
- All deployed images MUST specify an explicit version tag or immutable SHA256 digest; the `:latest` tag is forbidden in platform manifests (enforced by `scripts/ci/check-image-tag-immutability.py`).
- Component versions and license compliance are strictly governed by [VERSIONS.md](../VERSIONS.md) and [policies/license-policy.yaml](../policies/license-policy.yaml) (enforced by `scripts/ci/check-version-consistency.py` and `scripts/ci/check-license-policy.py`).

### B. Asset Onboarding & Offboarding Lifecycle
1. **Onboarding**: Introducing a new platform asset requires: (1) Registering the component version and license in `VERSIONS.md`; (2) Declaring the Helm chart template with dedicated labels, resource limits, and NetworkPolicy; (3) Adding ApisixRoute and TLS Certificate if exposed externally; (4) Updating and verifying this asset inventory via `python3 scripts/generate_platform_asset_inventory.py --check`.
2. **Offboarding / Deprecation**: Deprecating or removing an asset requires: (1) Annotating the deprecation in `VERSIONS.md`; (2) Removing the Helm chart manifest; (3) Decommissioning associated PVCs and secrets; (4) Regenerating this inventory.

---

## 7. Issue #42 Acceptance Status

| Acceptance Criterion | Status | Implementation Evidence |
|---|---|---|
| **Criterion 1**: Critical assets are inventoried with stable identifiers. | **Complete** | Documented in this file (`docs/platform-asset-inventory.md` / `docs/platform-asset-inventory-ko.md`) with `<kind>/<namespace>/<name>` stable identifiers. |
| **Criterion 2**: Inventory can be generated from a clean deployment and compared with Git declarations. | **Static complete** | Generated from the listed Helm profiles with `KUBECONFIG=/dev/null`; `make validate` checks drift. Live cluster reconciliation remains unverified. |
| **Criterion 3**: Unsupported/EOL assets are flagged. | **Open** | Declared pins are listed; EOL/support dates are not assessed by this generator. |
| **Criterion 4**: Asset ownership and lifecycle status are visible. | **Partial** | Namespace and operator are listed; lifecycle is declared pin only, with EOL unassessed. |
| **Criterion 5**: Release inventory is retained as an operational artifact. | **Complete** | Maintained as version-controlled operational documents in `docs/platform-asset-inventory.md` and `docs/platform-asset-inventory-ko.md`, checked continuously in CI. |
