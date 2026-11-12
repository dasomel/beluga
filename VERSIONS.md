# Beluga Component & Image Versions

이 문서는 Beluga 데이터 플랫폼에서 사용하는 모든 K8s 및 데이터 스택 컴포넌트, 오퍼레이터, 이미의 **단일 원천 (Single Source of Truth)**이다.
모든 Helm 차트 values 및 매니페스트는 본 문서의 버전을 참조한다. 라이선스 열도 이 원칙을 따른다 — 개별
컴포넌트의 라이선스 사실을 다른 문서에 중복 기재하지 않고, [LICENSE](LICENSE)/[NOTICE](NOTICE)가 본 표를
가리킨다. 허용 라이선스와 자체 프로젝트 표식은 [machine-readable 정책](policies/license-policy.yaml)에서 관리한다.

---

## 1. 인프라 & 플랫폼 컴포넌트

| 컴포넌트 | 버전 | Helm 차트 / 이미지 | 라이선스 | 비고 |
|----------|------|--------------------|----------|------|
| Kubernetes | v1.36.x (k3s 채널 v1.36) | - | Apache-2.0 | k3s 확정 (D16, 2026-08-10 승인) — 채널은 cluster.env K8S_VERSION |
| Ubuntu Box | 26.04 | `dasomel/ubuntu-26.04-xfs` | 해당 없음 — 자체 프로젝트 | narwhal 동일 박스. 라이선스/NOTICE는 [kube-ready-box](https://github.com/dasomel/kube-ready-box) 리포 참고 |
| Cilium | 1.20.0 | `cilium/cilium` (helm) | Apache-2.0 | CNI — D17 최신 핀, quay+chart 확인 |
| MetalLB | 0.16.1 | `metallb/metallb` (helm) | Apache-2.0 | LoadBalancer — narwhal 동일 버전 |
| cert-manager | 1.21.1 | 공식 install.yaml (`cert-manager.yaml`) | Apache-2.0 | Task 15 — 실측 확인(2026-08-21, GitHub Releases API): 최신 stable, 지원 K8s 범위 1.33–1.36으로 k3s 1.36.3 커버. Trino 코디네이터 TLS(D-E) 전제 |
| ArgoCD | 3.5.0 | 공식 install.yaml | Apache-2.0 | GitOps — D17 승급 |
| VictoriaMetrics | v1.155.0 | `victoriametrics/victoria-metrics:v1.155.0` | Apache-2.0 | 관측성 메트릭 저장소(single-node, 보존 7d, PVC 5Gi) — 오너 결정 2026-11-09(#366). `beluga-platform` 차트가 `@sha256:f60dc268b54ecf87f6e09d740c2b732838aa9193090cc741417c9f6386a130df` digest(멀티아치 인덱스 amd64/arm64)로 고정한다. 내장 `-promscrape.config` 스크레이프(vmagent 없음) |
| vmalert | v1.155.0 | `victoriametrics/vmalert:v1.155.0` | Apache-2.0 | 오너 결정 2026-11-13(#408), VM과 같은 릴리스. 차트는 멀티아치 amd64/arm64 `@sha256:3256cba5ddaca5974eae6141105cec4ce37871f1c213f0a5c267ec0111bc68e1`로 고정; 규칙 평가·상태 remote-write/read |
| Alertmanager | v0.34.2 | `quay.io/prometheus/alertmanager:v0.34.2` | Apache-2.0 | 오너 결정 2026-11-13(#408). 4일 된 v0.35.0 대신 v0.34.2 선택(D-ALERT-2). 멀티아치 amd64/arm64 `@sha256:39d8bb3966c694a124428a3a88fbcffd40bd069129ecd47c059f8a3f17c55f3b` 고정; 내부 전용·기본 null 수신자·PVC 256Mi |
| Grafana | 13.3.0 | `grafana/grafana:13.3.0` | AGPL-3.0 | 관측성 대시보드 — 오너 결정 2026-11-09(#366), **AGPL-3.0 라이선스 예외는 Grafana 한정**(`policies/license-policy.yaml` `license_change_reviews`). 차트는 `@sha256:488984b716c0862639f91a698adbe2862677a5a07bad42da5f03f3030883b205` digest(멀티아치 인덱스)로 고정. 조건: (1) 수정 없는 업스트림 이미지만(소스 패치·커스텀 이미지 빌드 금지, 하면 AGPL §13 재검토); (2) 설정·프로비저닝·대시보드 JSON·SSO 설정은 코드 수정이 아님; (3) 재배포하지 않고 업스트림을 참조 — 오프라인/에어갭 번들 포함·제3자 미러링 시 AGPL 전문과 소스 제공 고지를 먼저 추가; (4) 서드파티 플러그인은 별도 라이선스 검토 |

---

## 2. 데이터 플랫폼 컴포넌트

| 컴포넌트 | 버전 | 오퍼레이터 / 이미지 | 라이선스 | 비고 |
|----------|------|--------------------|----------|------|
| Strimzi Kafka Operator | 1.1.0 | `quay.io/strimzi/operator:1.1.0` | Apache-2.0 | KRaft 전용 (Kafka 4.3.0) — 0.45는 K8s 1.36 비호환 실측 |
| Debezium | 3.6.1.Final | `quay.io/debezium/connect:3.6.1.Final` | Apache-2.0 | Kafka Connect CDC — D17 승급, arm64 확인 |
| CNPG PostgreSQL | 1.30.0 | `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0` | Apache-2.0 (오퍼레이터) / PostgreSQL License (엔진) | Postgres 17.6 (Shop DB & 메타 DB) — arm64 확인 |
| PostgreSQL 컨테이너 이미지 | 17.6 | `ghcr.io/cloudnative-pg/postgresql:17.6` | PostgreSQL License | CNPG Shop DB/메타 DB 엔진 및 초기화 Job |
| SeaweedFS | 4.41 | `chrislusf/seaweedfs:4.41` | Apache-2.0 | S3 오브젝트 스토리지 — D17 승급 |
| Lakekeeper | v0.13.1 | `quay.io/lakekeeper/catalog:v0.13.1` | Apache-2.0 | Iceberg REST Catalog (D4) — 2026-08-10 manifest inspect로 amd64+arm64 확인 |
| Flink K8s Operator | 1.15.0 | `apache/flink-kubernetes-operator:1.15.0` | Apache-2.0 | Helm 설치(웹훅 off), arm64 확인. 1.10은 Apache 미러에서 내려감. Flink 런타임은 Beluga Flink 이미지(아래 행; 베이스는 Docker 공식 flink 1.20.0-scala_2.12-java17 — apache/ 리포는 amd64 전용) |
| Beluga Flink | sha-7b897d214759c3c0989b4338fa91b4bac05c3dab | `ghcr.io/dasomel/beluga-flink:sha-7b897d214759c3c0989b4338fa91b4bac05c3dab` | Apache-2.0 | GHCR published image; multi-arch amd64/arm64 + attestations. FlinkDeployment와 SQL 제출 Job에 배포. 베이스 Docker 공식 flink 1.20.0-scala_2.12-java17 (digest 고정은 images/flink/Dockerfile), Kafka SQL 3.4.0-1.20, Iceberg Flink runtime/AWS bundle 1.7.1, Hadoop uber 2.8.3-10.0. 라이선스 열은 상위 프로젝트 기준; 전이 의존성의 BSD/MIT/CDDL 등 원문은 JAR META-INF 보존(NOTICE 참조) 차트는 `@sha256:d3a9b60ac8e0ae919787d67da21ab10aaeea2aa06fba3c6d2d489e088eb030c7` digest로 고정한다. |
| Trino | 483 | `trinodb/trino:483` | Apache-2.0 | Distributed SQL Query Engine — D17 승급 |
| Beluga dbt | sha-2af38b5ed0f76a8f66e822ff1553b45671ad201a | `ghcr.io/dasomel/beluga-dbt:sha-2af38b5ed0f76a8f66e822ff1553b45671ad201a` | Apache-2.0 | GHCR published image; dbt Core 1.12.6 + dbt-trino 1.11.0. Airflow dbt_shop_medallion and iceberg_table_maintenance DAGs use multi-arch index digest `@sha256:09df094a8f83d3dc728607ad949c9ef6abdb1a030865eb0fcd681c3e9ec6d81a` (D-DBT-10, D-MAINT-3; issues #95, #387). |
| Airflow | 3.3.0 | `apache/airflow:3.3.0-python3.11` | Apache-2.0 | 실행 executor는 LocalExecutor(단일 파드 다중 프로세스); KubernetesExecutor 전환은 D-AIRFLOW-EXECUTOR 탈출구(orchestration ns RBAC, pod template, kubernetes_executor.namespace) 필요 — D17 승급 |
| Superset | 6.1.0 | `apache/superset:6.1.0` | Apache-2.0 | BI Dashboard — D17 승급 (OAuth/import API 변화는 E2E로 검증) |
| Keycloak | 26.7.1 | `quay.io/keycloak/keycloak:26.7.1` | Apache-2.0 | SSO — 인증·역할 단일 원천 (D13) |
| OpenLDAP | 2.6.15 (ldapium 0.2.0) | `ghcr.io/dasomel/ldapium:0.2.0` | OpenLDAP Public License 2.8 / Apache-2.0 (ldapium image project) | 계정 원천 (D20) — **GHCR published image**. vegardit의 demo seed/`LDAP_INIT_*` 계약을 제거하고 ldapium의 명시적 `LDAP_ROOT_DN`/`LDAP_ADMIN_*`/`LDAP_SEED_DIR` 계약으로 전환. OpenLDAP 2.6.15 source-built image, first launch sample data 없음 |
| ldapium UI | 0.2.0 | `ghcr.io/dasomel/ldapium-ui:0.2.0` | Apache-2.0 | LDAP DIT browser 및 user/group CRUD 관리 UI — **GHCR published image**. Beluga의 LDAP 서버와 동일 ldapium release 계열. 현재 Beluga 매니페스트에서는 별도 UI 배포를 아직 활성화하지 않음 |
| OPA | 1.19.0-static | `openpolicyagent/opa:1.19.0-static` | Apache-2.0 | 중앙 정책 엔진 (D14) — -static만 arm64 |
| OpenFGA | v1.18.3 | `openfga/openfga:v1.18.3` | Apache-2.0 | Lakekeeper 인가 백엔드 (D14) — D17 승급 |
| Beluga Manager domain-api | sha-ea2720063a992e25a3ae58d578a9c637621058bf | `ghcr.io/dasomel/beluga-manager-domain-api:sha-ea2720063a992e25a3ae58d578a9c637621058bf` | Apache-2.0 | 컨트롤 플레인 API (이 레포 `manager/`, ADR-0009 롤아웃 ②b) — **GHCR published image**, main 492b7ef 빌드. 차트는 `@sha256:022e1cf7dfb2a0d879182797bcbae530bebdd13a5b7a2a890c52711961be6b28` digest로 고정한다 |
| Beluga Manager web | sha-ea2720063a992e25a3ae58d578a9c637621058bf | `ghcr.io/dasomel/beluga-manager-web:sha-ea2720063a992e25a3ae58d578a9c637621058bf` | Apache-2.0 | 컨트롤 플레인 SPA (nginx:alpine 정적 서빙, `manager/`) — **GHCR published image**, main 492b7ef 빌드. 차트는 `@sha256:cc68de56cf5303c0dd050c525d0c1bd59cace04fc0b9cc2081a11bc8e8cd731e` digest로 고정한다 |
| OpenMetadata | 1.13.3 | `openmetadata/server:1.13.3` | Apache-2.0 | 거버넌스 카탈로그 (D12, 48GB+ 프로파일) |
| OpenSearch | 2.18.0 | `opensearchproject/opensearch:2.18.0` | Apache-2.0 | OpenMetadata 검색엔진 (D12) |
| curl (유틸) | 8.21.0 | `curlimages/curl:8.21.0` | curl License (MIT류) | 부트스트랩/등록 Job 공용 — arm64 확인 |
| kubectl (유틸) | - | - | Apache-2.0 | 내부 CA 배포는 Python Kubernetes API 클라이언트를 사용하며 kubectl 컨테이너 이미지는 배포하지 않음 |
| APISIX | 3.17.0 | `apache/apisix:3.17.0-debian` | Apache-2.0 | 게이트웨이 (D11) — D17 승급, arm64 확인 |
| APISIX Ingress Controller | 1.8.0 | `apache/apisix-ingress-controller:1.8.0` | Apache-2.0 | **D17 보류** — 2.x는 아키텍처 개편(ADC)이라 라우팅 검증 후 별도 승급 |
| etcd (APISIX용) | 3.5.31-0 | `registry.k8s.io/etcd:3.5.31-0` | Apache-2.0 | **D17 보류** — 3.5 라인 안정성 유지 (감사 권고) |

---

## 3. 데모 이미지 & 라이브러리

| 컴포넌트 | 버전 | 이미지 / 패키지 | 라이선스 | 비고 |
|----------|------|-----------------|----------|------|
| Python | 3.12-slim | `python:3.12-slim` | PSF License 2.0 | 데모 생성기 기본 — gitops 매니페스트(keycloak-*, internal-ca-distribution, clickstream-gen 등)와 demo/clickstream-gen/Dockerfile 전부 3.12-slim 사용 중; 이전에 이 표만 3.11-slim으로 뒤처져 있었음 |
| kafka-python-ng | 2.2.2 | pip | Apache-2.0 | 합성 클릭스트림 생성기 |
