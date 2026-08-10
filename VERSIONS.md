# Beluga Component & Image Versions

이 문서는 Beluga 데이터 플랫폼에서 사용하는 모든 K8s 및 데이터 스택 컴포넌트, 오퍼레이터, 이미의 **단일 원천 (Single Source of Truth)**이다.
모든 Helm 차트 values 및 매니페스트는 본 문서의 버전을 참조한다.

---

## 1. 인프라 & 플랫폼 컴포넌트

| 컴포넌트 | 버전 | Helm 차트 / 이미지 | 비고 |
|----------|------|--------------------|------|
| Kubernetes | v1.35.0 | - | Vagrant K3s / kubeadm |
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
| Strimzi Kafka Operator | 0.45.0 | `strimzi/operator:0.45.0` | KRaft 모드 (Kafka 3.9.0) |
| Debezium | 3.0.0.Final | `debezium/connect:3.0.0.Final` | Kafka Connect CDC |
| CNPG PostgreSQL | 1.25.0 | `ghcr.io/cloudnative-pg/cloudnative-pg:1.25.0` | Postgres 17 (Shop DB & 메타 DB) |
| SeaweedFS | 3.80 | `chrislusf/seaweedfs:3.80` | S3 오브젝트 스토리지 |
| Iceberg REST Catalog (임시) | latest (미고정) | `tabulario/iceberg-rest:latest` | **D4 불일치** — 실제 배포 이미지는 Lakekeeper가 아님. Lakekeeper 교체 백로그 (mistakes-log 참조) |
| Flink K8s Operator | 1.10.0 | `apache/flink-kubernetes-operator:1.10.0` | Flink 1.20.0 (Java 17 / PyFlink) |
| Trino | 468 | `trinodb/trino:468` | Distributed SQL Query Engine |
| Airflow | 3.0.0 | `apache/airflow:3.0.0-python3.11` | KubernetesExecutor (호스트 포트 8085) |
| Superset | 4.1.1 | `apache/superset:4.1.1` | BI Dashboard |

---

## 3. 데모 이미지 & 라이브러리

| 컴포넌트 | 버전 | 이미지 / 패키지 | 비고 |
|----------|------|-----------------|------|
| Python | 3.11-slim | `python:3.11-slim` | 데모 생성기 기본 |
| kafka-python-ng | 2.2.2 | pip | 합성 클릭스트림 생성기 |
| psycopg2-binary | 2.9.9 | pip | Shop DB 시드 및 CDC 트리거 |
