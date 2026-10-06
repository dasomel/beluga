# Beluga 플랫폼 자산 인벤토리 및 수명주기 거버넌스

[English](platform-asset-inventory.md) | 한국어

본 문서는 [이슈 #42](https://github.com/dasomel/beluga/issues/42) ("Establish platform asset inventory and lifecycle governance")의 기본 요구사항을 충족하며, Beluga 데이터 플랫폼의 선언적 상태(declared-state) 운영 자산 인벤토리를 정의합니다.

> [!IMPORTANT]
> **선언적 상태 범위 규율 (Declared-State Scope Disciplinary Invariant)**
> 본 인벤토리는 아래 프로파일의 GitOps Helm 매니페스트(`KUBECONFIG=/dev/null`)와 [VERSIONS.md](../VERSIONS.md)로부터 생성한 **선언적 상태 기준선**입니다. 워크로드, 커스텀 리소스, 컨테이너 이미지와 선언된 스토리지를 기록합니다. 라이브 클러스터 상태와 이미지 지원 종료(EOL)는 평가하지 않았습니다. 수명주기 표시는 선언된 버전 핀만 뜻합니다.
> 프로파일: `default`(32GB), `48GB+`(`openmetadata.enabled=true`, `trino.workerEnabled=true`), `oauth`(`strimzi.oauthListener=true`), `acl`(`strimzi.aclAuthorizer=true`), `external`(`strimzi.externalListenerEnabled=true`), `all-enabled`(모든 플래그 활성). 재현성 검사는 CI 고정 Helm v3.16.4 범위이며 로컬 Helm 버전에 따라 렌더 결과가 다를 수 있습니다.

---

## 1. 워크로드 인벤토리 (Workloads Inventory)

프로파일 전체에서 고유한 선언 워크로드 총 33개가 렌더링됩니다. `Conditional`은 기본 프로파일에 없는 자산을 뜻합니다.

| 워크로드 (안정 식별자) | 종류 (Kind) | 네임스페이스 | 차트 | 선언된 복제본 / 실행 모드 | 컨테이너 이미지 | 프로파일 | 선언 매니페스트 출처 |
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

## 2. 커스텀 리소스 및 오퍼레이터 관리 자산 (Custom Resources & Operators)

프로파일 전체에서 고유한 커스텀 리소스 총 37개가 선언되어 있습니다.

| 커스텀 리소스 식별자 | 종류 (Kind) | API 버전 | 네임스페이스 | 제어 오퍼레이터 | 프로파일 | 선언 매니페스트 출처 |
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

## 3. 컨테이너 이미지 및 버전 단일 진실 원천 (Container Images & VERSIONS.md)

프로파일 전체에서 선언된 고유 컨테이너 이미지 19개를 기록합니다. [VERSIONS.md](../VERSIONS.md)의 버전 핀이 일치하지 않으면 `Unmapped`로 표시합니다.

| 컴포넌트 | 선언된 이미지 태그 | VERSIONS.md 기대 버전 | 라이선스 | 수명주기 | 프로파일 | 소비 워크로드 |
|---|---|---|---|---|---|---|
| **Airflow** | `apache/airflow:3.3.0-python3.11` | `3.3.0` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `airflow-webserver` |
| **APISIX** | `apache/apisix:3.17.0-debian` | `3.17.0` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `apisix` |
| **APISIX Ingress Controller** | `apache/apisix-ingress-controller:1.8.0` | `1.8.0` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `apisix-ingress-controller` |
| **curl (유틸)** | `curlimages/curl:8.21.0` | `8.21.0` | curl License (MIT류) | 선언된 핀만 확인; EOL 미평가 | default | `apisix-ingress-controller`, `lakekeeper-bootstrap`, `debezium-register-shop` (+1개 추가) |
| **Debezium** | `quay.io/debezium/connect:3.6.1.Final` | `3.6.1.Final` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `debezium-connect` |
| **etcd (APISIX용)** | `registry.k8s.io/etcd:3.5.31-0` | `3.5.31-0` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `apisix-etcd` |
| **Keycloak** | `quay.io/keycloak/keycloak:26.7.1` | `26.7.1` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `keycloak` |
| **Lakekeeper** | `quay.io/lakekeeper/catalog:v0.13.1` | `v0.13.1` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `lakekeeper`, `lakekeeper-migrate` |
| **OPA** | `openpolicyagent/opa:1.19.0-static` | `1.19.0-static` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `opa` |
| **OpenFGA** | `openfga/openfga:v1.18.3` | `v1.18.3` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `openfga` |
| **OpenMetadata** | `openmetadata/server:1.13.3` | `1.13.3` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | Conditional: 48GB+, all-enabled | `openmetadata`, `openmetadata-migration` |
| **OpenSearch** | `opensearchproject/opensearch:2.18.0` | `2.18.0` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | Conditional: 48GB+, all-enabled | `opensearch` |
| **PostgreSQL 컨테이너 이미지** | `ghcr.io/cloudnative-pg/postgresql:17.6` | `17.6` | PostgreSQL License | 선언된 핀만 확인; EOL 미평가 | default | `postgres-main`, `openfga`, `db-roles-setup` (+1개 추가) |
| **Python** | `python:3.12-slim` | `3.12-slim` | PSF License 2.0 | 선언된 핀만 확인; EOL 미평가 | default | `clickstream-gen`, `superset-dashboard-import`, `keycloak-clients` (+5개 추가) |
| **SeaweedFS** | `chrislusf/seaweedfs:4.41` | `4.41` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `seaweedfs` |
| **Superset** | `apache/superset:6.1.0` | `6.1.0` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `superset` |
| **Trino** | `trinodb/trino:483` | `483` | Apache-2.0 | 선언된 핀만 확인; EOL 미평가 | default | `trino-coordinator`, `trino-worker` |
| **Unmapped / Internal Tool** | `ghcr.io/dasomel/ldapium:nightly-4e85165` | `Unmapped` | Unmapped | 선언된 핀만 확인; EOL 미평가 | default | `openldap`, `openldap-init` |
| **Unmapped / Internal Tool** | `flink:1.20.0-scala_2.12-java17` | `Unmapped` | Unmapped | 선언된 핀만 확인; EOL 미평가 | default | `flink-cluster`, `flink-sql-submit` |

---

## 4. 영구 스토리지 자산 및 볼륨 클레임 (PVC & Storage Assets)

총 6개의 영구 볼륨 클레임(PVC), 볼륨 클레임 템플릿(VCT) 및 오퍼레이터 관리 클러스터 스토리지 사양이 등록되어 있습니다.

| 자산명 | 스토리지 종류 | 네임스페이스 | 선언 용량 | 소비 워크로드 | 프로파일 | 선언 매니페스트 출처 |
|---|---|---|---|---|---|---|
| `postgres-main-storage` | CNPG Cluster Managed Storage | `database` | `5Gi` | `Cluster/database/postgres-main` | default | [`beluga-data/templates/02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml) |
| `openldap-config` | Standalone PVC | `iam` | `1Gi` | `Deployment/iam/openldap` | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `openldap-data` | Standalone PVC | `iam` | `2Gi` | `Deployment/iam/openldap` | default | [`beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml) |
| `apisix-etcd-data` | Standalone PVC | `platform-system` | `1Gi` | `Deployment/platform-system/apisix-etcd` | default | [`beluga-platform/templates/apisix-infra.yaml`](../gitops/charts/beluga-platform/templates/apisix-infra.yaml) |
| `seaweedfs (seaweedfs-data)` | StatefulSet VolumeClaimTemplate | `storage` | `5Gi` | `StatefulSet/storage/seaweedfs` | default | [`beluga-data/templates/01-seaweedfs.yaml`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml) |
| `kafka-mixed-jbod` | Strimzi KafkaNodePool Storage | `streaming` | `5Gi` | `KafkaNodePool/streaming/mixed` | default | [`beluga-data/templates/03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml) |

---

## 5. 프로파일 조건부 워크로드 (Profile-Gated & Conditional Workloads)

다음 식별자는 렌더된 매니페스트에서 생성했으며, 위 프로파일 열에 조건이 표시됩니다:

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

## 6. 수명주기 거버넌스 및 운영 규율 (Lifecycle Governance Policies)

### A. 버전 고정 및 불변성 규율
- 모든 배포 이미지는 명시적인 버전 태그 또는 불변 SHA256 다이제스트를 지정해야 하며 `:latest` 태그는 엄격히 금지됩니다 (`scripts/ci/check-image-tag-immutability.py`에 의해 강제).
- 컴포넌트 버전 및 라이선스 준수 여부는 [VERSIONS.md](../VERSIONS.md) 및 [policies/license-policy.yaml](../policies/license-policy.yaml)에 의해 통제됩니다 (`scripts/ci/check-version-consistency.py` 및 `scripts/ci/check-license-policy.py`에 의해 강제).

### B. 자산 온보딩 및 오프보딩 수명주기 절차
1. **온보딩(신규 등록)**: 새로운 플랫폼 자산 추가 시: (1) `VERSIONS.md`에 컴포넌트 버전 및 라이선스 등록; (2) 전용 라벨, 리소스 상한, NetworkPolicy가 포함된 Helm 매니페스트 작성; (3) 외부 노출 필요 시 ApisixRoute 및 TLS Certificate 등록; (4) `python3 scripts/generate_platform_asset_inventory.py --check`를 통한 인벤토리 갱신 및 검증.
2. **오프보딩(폐기/삭제)**: 자산 폐기 시: (1) `VERSIONS.md`에 지원 종료 및 폐기 이력 기록; (2) Helm 매니페스트 삭제; (3) 잔여 PVC 및 Secret 정리; (4) 인벤토리 재생성.

---

## 7. 이슈 #42 인수 조건 충족 현황 (Acceptance Status)

| 인수 조건 (Acceptance Criterion) | 상태 (Status) | 구현 증거 (Implementation Evidence) |
|---|---|---|
| **기준 1**: Critical assets are inventoried with stable identifiers. (핵심 자산 안정 식별자 인벤토리화) | **완료 (Complete)** | 본 문서(`docs/platform-asset-inventory.md` / `docs/platform-asset-inventory-ko.md`)에 `<kind>/<namespace>/<name>` 안정 식별자로 체계적 인벤토리화. |
| **기준 2**: Inventory can be generated from a clean deployment and compared with Git declarations. (클린 배포 생성 및 Git 선언 대사) | **정적 검증 완료** | 명시된 Helm 프로파일을 `KUBECONFIG=/dev/null`로 렌더하고 `make validate`에서 드리프트 확인. 라이브 클러스터 대사는 미검증. |
| **기준 3**: Unsupported/EOL assets are flagged. (미지원/EOL 자산 식별) | **미완료** | 선언된 핀은 기록하지만 EOL/지원 종료일은 평가하지 않음. |
| **기준 4**: Asset ownership and lifecycle status are visible. (자산 소유권 및 수명주기 가시화) | **일부 완료** | 네임스페이스와 오퍼레이터를 표시하며 수명주기는 선언된 핀만 확인; EOL 미평가. |
| **기준 5**: Release inventory is retained as an operational artifact. (릴리스 인벤토리 운영 산출물 보존) | **완료 (Complete)** | `docs/platform-asset-inventory.md` 및 `docs/platform-asset-inventory-ko.md`로 버전 관리되며 CI에서 지속 검증; 릴리스마다 `platform-asset-inventory.{json,md}`가 attest된 증적 번들에 포함됨(`docs/development.md` Release evidence). 소유자, EOL, 보존 기간 데이터는 포함하지 않음. |
