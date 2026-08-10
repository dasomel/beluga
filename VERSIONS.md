# Beluga Component & Image Versions

이 문서는 Beluga 데이터 플랫폼에서 사용하는 모든 K8s 및 데이터 스택 컴포넌트, 오퍼레이터, 이미의 **단일 원천 (Single Source of Truth)**이다.
모든 Helm 차트 values 및 매니페스트는 본 문서의 버전을 참조한다.

---

## 1. 인프라 & 플랫폼 컴포넌트

| 컴포넌트 | 버전 | Helm 차트 / 이미지 | 비고 |
|----------|------|--------------------|------|
| Kubernetes | v1.36.x (k3s 채널 v1.36) | - | k3s 확정 (D16, 2026-08-10 승인) — 채널은 cluster.env K8S_VERSION |
| Ubuntu Box | 26.04 | `dasomel/ubuntu-26.04-xfs` | narwhal 동일 박스 |
| Cilium | 1.16.5 | `cilium/cilium` | CNI |
| MetalLB | 0.14.9 | `metallb/metallb` | LoadBalancer Provider |
| cert-manager | 1.16.2 | `jetstack/cert-manager` | TLS 인증서 관리 |
| ArgoCD | 2.14.0 | `argo/argo-cd` | GitOps 오케스트레이션 |
| Prometheus Stack | 67.4.0 | `prometheus-community/kube-prometheus-stack` | 관측성 |

---

## 2. 데이터 플랫폼 컴포넌트

| 컴포넌트 | 버전 | 오퍼레이터 / 이미지 | 비고 |
|----------|------|--------------------|------|
| Strimzi Kafka Operator | 1.1.0 | `quay.io/strimzi/operator:1.1.0` | KRaft 전용 (Kafka 4.3.0) — 0.45는 K8s 1.36 비호환 실측 |
| Debezium | 3.3.0.Final | `quay.io/debezium/connect:3.3.0.Final` | Kafka Connect CDC — arm64 manifest 확인 |
| CNPG PostgreSQL | 1.25.0 | `ghcr.io/cloudnative-pg/cloudnative-pg:1.25.0` | Postgres 17 (Shop DB & 메타 DB) |
| SeaweedFS | 3.80 | `chrislusf/seaweedfs:3.80` | S3 오브젝트 스토리지 |
| Lakekeeper | v0.13.1 | `quay.io/lakekeeper/catalog:v0.13.1` | Iceberg REST Catalog (D4) — 2026-08-10 manifest inspect로 amd64+arm64 확인 |
| Flink K8s Operator | 1.10.0 | `apache/flink-kubernetes-operator:1.10.0` | Flink 런타임은 `flink:1.20.0-scala_2.12-java17` (Docker 공식 리포 — apache/ 리포는 amd64 전용) |
| Trino | 468 | `trinodb/trino:468` | Distributed SQL Query Engine |
| Airflow | 3.0.0 | `apache/airflow:3.0.0-python3.11` | KubernetesExecutor (호스트 포트 8085) |
| Superset | 4.1.1 | `apache/superset:4.1.1` | BI Dashboard |
| Keycloak | 26.7.1 | `quay.io/keycloak/keycloak:26.7.1` | SSO — 인증·역할 단일 원천 (D13) |
| OPA | 1.1.0-static | `openpolicyagent/opa:1.1.0-static` | 중앙 정책 엔진 — Trino·Kafka (D14). -static만 arm64 지원 |
| OpenFGA | v1.8.3 | `openfga/openfga:v1.8.3` | Lakekeeper 인가 백엔드 (D14) |
| OpenMetadata | 1.13.3 | `openmetadata/server:1.13.3` | 거버넌스 카탈로그 (D12, 48GB+ 프로파일) |
| OpenSearch | 2.18.0 | `opensearchproject/opensearch:2.18.0` | OpenMetadata 검색엔진 (D12) |
| curl (유틸) | 8.12.1 | `curlimages/curl:8.12.1` | Lakekeeper 부트스트랩 Job — manifest inspect로 arm64 확인 |

---

## 3. 데모 이미지 & 라이브러리

| 컴포넌트 | 버전 | 이미지 / 패키지 | 비고 |
|----------|------|-----------------|------|
| Python | 3.11-slim | `python:3.11-slim` | 데모 생성기 기본 |
| kafka-python-ng | 2.2.2 | pip | 합성 클릭스트림 생성기 |
| psycopg2-binary | 2.9.9 | pip | Shop DB 시드 및 CDC 트리거 |
