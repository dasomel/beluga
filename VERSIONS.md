# Beluga Component & Image Versions

이 문서는 Beluga 데이터 플랫폼에서 사용하는 모든 K8s 및 데이터 스택 컴포넌트, 오퍼레이터, 이미의 **단일 원천 (Single Source of Truth)**이다.
모든 Helm 차트 values 및 매니페스트는 본 문서의 버전을 참조한다. 라이선스 열도 이 원칙을 따른다 — 개별
컴포넌트의 라이선스 사실을 다른 문서에 중복 기재하지 않고, [LICENSE](LICENSE)/[NOTICE](NOTICE)가 본 표를
가리킨다.

---

## 1. 인프라 & 플랫폼 컴포넌트

| 컴포넌트 | 버전 | Helm 차트 / 이미지 | 라이선스 | 비고 |
|----------|------|--------------------|----------|------|
| Kubernetes | v1.36.x (k3s 채널 v1.36) | - | Apache-2.0 | k3s 확정 (D16, 2026-08-10 승인) — 채널은 cluster.env K8S_VERSION |
| Ubuntu Box | 26.04 | `dasomel/ubuntu-26.04-xfs` | 해당 없음 — 자체 프로젝트 | narwhal 동일 박스. 라이선스/NOTICE는 [kube-ready-box](https://github.com/dasomel/kube-ready-box) 리포 참고 |
| Cilium | 1.20.0 | `cilium/cilium` (helm) | Apache-2.0 | CNI — D17 최신 핀, quay+chart 확인 |
| MetalLB | 0.16.1 | `metallb/metallb` (helm) | Apache-2.0 | LoadBalancer — narwhal 동일 버전 |
| cert-manager | (미설치) | — | 해당 없음 | 설치 메커니즘 부재 — Flink 오퍼레이터는 웹훅 off로 우회, 백로그 |
| ArgoCD | 3.5.0 | 공식 install.yaml | Apache-2.0 | GitOps — D17 승급 |
| Prometheus Stack | 67.4.0 | `prometheus-community/kube-prometheus-stack` | Apache-2.0 | 관측성 |

---

## 2. 데이터 플랫폼 컴포넌트

| 컴포넌트 | 버전 | 오퍼레이터 / 이미지 | 라이선스 | 비고 |
|----------|------|--------------------|----------|------|
| Strimzi Kafka Operator | 1.1.0 | `quay.io/strimzi/operator:1.1.0` | Apache-2.0 | KRaft 전용 (Kafka 4.3.0) — 0.45는 K8s 1.36 비호환 실측 |
| Debezium | 3.6.1.Final | `quay.io/debezium/connect:3.6.1.Final` | Apache-2.0 | Kafka Connect CDC — D17 승급, arm64 확인 |
| CNPG PostgreSQL | 1.30.0 | `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0` | Apache-2.0 (오퍼레이터) / PostgreSQL License (엔진) | Postgres 17.6 (Shop DB & 메타 DB) — arm64 확인 |
| SeaweedFS | 4.41 | `chrislusf/seaweedfs:4.41` | Apache-2.0 | S3 오브젝트 스토리지 — D17 승급 |
| Lakekeeper | v0.13.1 | `quay.io/lakekeeper/catalog:v0.13.1` | Apache-2.0 | Iceberg REST Catalog (D4) — 2026-08-10 manifest inspect로 amd64+arm64 확인 |
| Flink K8s Operator | 1.15.0 | `apache/flink-kubernetes-operator:1.15.0` | Apache-2.0 | Helm 설치(웹훅 off), arm64 확인. 1.10은 Apache 미러에서 내려감. Flink 런타임은 `flink:1.20.0-scala_2.12-java17` (Docker 공식 리포 — apache/ 리포는 amd64 전용) |
| Trino | 483 | `trinodb/trino:483` | Apache-2.0 | Distributed SQL Query Engine — D17 승급 |
| Airflow | 3.3.0 | `apache/airflow:3.3.0-python3.11` | Apache-2.0 | KubernetesExecutor — D17 승급 |
| Superset | 6.1.0 | `apache/superset:6.1.0` | Apache-2.0 | BI Dashboard — D17 승급 (OAuth/import API 변화는 E2E로 검증) |
| Keycloak | 26.7.1 | `quay.io/keycloak/keycloak:26.7.1` | Apache-2.0 | SSO — 인증·역할 단일 원천 (D13) |
| OpenLDAP | 2.6.14 | `ghcr.io/dasomel/ldapium:0.1.0` | OpenLDAP Public License 2.8 / Apache-2.0 (ldapium image project) | 계정 원천 (D20) — vegardit의 demo seed/`LDAP_INIT_*` 계약을 제거하고 ldapium의 명시적 `LDAP_ROOT_DN`/`LDAP_ADMIN_*`/`LDAP_SEED_DIR` 계약으로 전환. OpenLDAP 2.6.14 source-built image, first launch sample data 없음 |
| OPA | 1.19.0-static | `openpolicyagent/opa:1.19.0-static` | Apache-2.0 | 중앙 정책 엔진 (D14) — -static만 arm64 |
| OpenFGA | v1.18.3 | `openfga/openfga:v1.18.3` | Apache-2.0 | Lakekeeper 인가 백엔드 (D14) — D17 승급 |
| OpenMetadata | 1.13.3 | `openmetadata/server:1.13.3` | Apache-2.0 | 거버넌스 카탈로그 (D12, 48GB+ 프로파일) |
| OpenSearch | 2.18.0 | `opensearchproject/opensearch:2.18.0` | Apache-2.0 | OpenMetadata 검색엔진 (D12) |
| curl (유틸) | 8.21.0 | `curlimages/curl:8.21.0` | curl License (MIT류) | 부트스트랩/등록 Job 공용 — arm64 확인 |
| APISIX | 3.17.0 | `apache/apisix:3.17.0-debian` | Apache-2.0 | 게이트웨이 (D11) — D17 승급, arm64 확인 |
| APISIX Ingress Controller | 1.8.0 | `apache/apisix-ingress-controller:1.8.0` | Apache-2.0 | **D17 보류** — 2.x는 아키텍처 개편(ADC)이라 라우팅 검증 후 별도 승급 |
| etcd (APISIX용) | 3.5.31-0 | `registry.k8s.io/etcd:3.5.31-0` | Apache-2.0 | **D17 보류** — 3.5 라인 안정성 유지 (감사 권고) |
| Flink 커넥터 | kafka 3.4.0-1.20 / iceberg 1.7.1 / hadoop-uber 2.8.3-10.0 | Maven Central (initContainer 주입) | Apache-2.0 | **D17 보류** — Flink 2.x 커넥터 Maven 부재로 1.20 스택 유지 |

---

## 3. 데모 이미지 & 라이브러리

| 컴포넌트 | 버전 | 이미지 / 패키지 | 라이선스 | 비고 |
|----------|------|-----------------|----------|------|
| Python | 3.11-slim | `python:3.11-slim` | PSF License 2.0 | 데모 생성기 기본 |
| kafka-python-ng | 2.2.2 | pip | Apache-2.0 | 합성 클릭스트림 생성기 |
