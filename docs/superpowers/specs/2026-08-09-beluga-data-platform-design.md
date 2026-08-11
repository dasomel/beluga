# Beluga — 데이터 플랫폼 설계서

- 작성일: 2026-08-09
- 상태: 승인됨 (브레인스토밍 완료, 구현 계획 수립 전)
- 자매 프로젝트: [narwhal](https://github.com/dasomel/narwhal) (K8s IDP), kubemetal (Apple Silicon MLOps)

## 1. 개요

**Beluga**는 Vagrant 기반 독립 Kubernetes 클러스터 위에 구축하는 풀스택 데이터 플랫폼이다.
수집(Kafka) → 스트림 처리(Flink) → 저장(Iceberg 레이크하우스) → 분석(Trino/Superset) →
오케스트레이션(Airflow)까지 업계 표준 스택을 K8s Operator 생태계로 완성하고,
**이벤트 스트리밍 + CDC 복합 데모**로 엔드투엔드를 증명한다.

narwhal의 골격(Vagrant + `dasomel/ubuntu-26.04-xfs` 박스 + ArgoCD GitOps)을 재사용하되,
K8s 배포판은 **k3s v1.36 (채널 고정)**을 쓴다(D16 — narwhal의 kubeadm 대비 경량·단순).
서비스메시·시크릿 관리는 의도적으로 제외한다 — 그것은 narwhal의 영역이다.
SSO(Keycloak)와 API 게이트웨이(APISIX)는 원래 제외였으나 **narwhal 없이 단독 구동하는
독립성**을 위해 자체 편입한다 (D11, D13).

### 목표

1. 정석 데이터 플랫폼 아키텍처를 단일 `vagrant up`으로 재현
2. 이벤트 스트리밍과 CDC라는 실무 대표 패턴 2종의 동작 증명
3. narwhal·kubemetal과 함께 플랫폼 3부작(인프라 / AI / 데이터) 완성

### 비범위 (Out of Scope)

- OpenBao, Istio — narwhal의 영역. SSO(Keycloak)·API 게이트웨이(APISIX)는 **독립 구동성
  확보를 위해 자체 편입** (D11, D13) — narwhal 인스턴스를 참조하지 않는다
- HA 컨트롤플레인 — 데이터 플랫폼의 증명 포인트가 아님 (D2)
- ML feature store / kubemetal 연동 — 차후 확장 후보로만 기록
- 에어갭 번들 — narwhal 패턴 존재, 필요 시 후속

## 2. 결정 레지스트리 (D-Registry)

| ID | 결정 | 근거 | 탈출구 |
|----|------|------|--------|
| D1 | 서브넷 `192.168.77.x` (VIP 없음, LB pool `.200~.220`) | narwhal(`192.168.56.x`) 및 타 클러스터와 동시 기동 시 충돌 방지 | cluster.env에서 변경 가능 |
| D2 | 싱글 마스터 (master-1) + 워커 3대 | 단독 구동 전제에서 RAM을 데이터 워크로드에 집중. HA는 증명 포인트 아님 | 마스터 증설은 Vagrantfile 노드 정의 추가로 가능 |
| D3 | 스트림 엔진 = Flink (Spark 아님) | 진짜 스트리밍(레코드 단위) 데모 가치 + Flink SQL로 이벤트·CDC 파이프라인 통일 | 배치 전용 작업이 커지면 Spark 추가 검토 |
| D4 | Iceberg REST 카탈로그 = Lakekeeper | Rust 기반 경량(수백 MB급 JVM 카탈로그 대비), arm64 지원, REST 표준 | Polaris/Nessie로 교체 시 카탈로그 URL만 변경 |
| D5 | 오브젝트 스토리지 = SeaweedFS S3 | narwhal·kubemetal과 동일 — 시리즈 일관성, 검증된 운영 경험 | S3 API 표준이라 MinIO 교체 가능 |
| D6 | Kafka = Strimzi(1.x, KRaft 전용) 3-노드(controller+broker 혼합 KafkaNodePool), CDC = **독립 Deployment의 Debezium Connect** + REST 멱등 등록 Job | ZooKeeper 제거(KRaft). ~~Strimzi가 Connect까지 CR 관리~~ → E2E 실측 수정: KafkaConnect CR은 Strimzi 빌드 이미지 전용 런처를 강제해 독립 debezium/connect 이미지와 비호환, 레지스트리 없는 로컬에선 spec.build도 불가 | 리소스 부족 시 1-노드 축소 프로파일. 레지스트리 도입 시 KafkaConnect CR + build로 복귀 가능 |
| D7 | 오케스트레이션 = Airflow 3 + KubernetesExecutor | Celery/Redis 불필요 — 파드 스폰 방식으로 상시 리소스 최소화 | — |
| D8 | 호스트 RAM 감지 기반 VM 사이징 프로파일 (kubemetal D4 응용) | 32GB/48GB/64GB+ 호스트별 프로파일, 하드코딩 금지 | cluster.env 수동 오버라이드 |
| D9 | CNPG PostgreSQL 단일 오퍼레이터로 CDC 소스 DB + 메타 DB(Airflow/Superset/Lakekeeper) 통합 | 오퍼레이터 1개로 DB 전부 관리, narwhal에서 검증됨 | 메타 DB 분리는 Cluster CR 추가로 가능 |
| D10 | 구현 실행 체계 = Fable 지휘 오케스트레이션 + agy 워커 적극 활용 (Agent Team Harness, §7) | 오케스트레이터 컨텍스트는 판단·리뷰·통합에 집중, 기계적 구현은 워커 레인으로 — 토큰 효율 + 병렬 처리량 | 하네스 정의(§7) 수정으로 조정, agy 소진 시 네이티브 서브에이전트 |
| D11 | 접근 통일 = 자체 APISIX 게이트웨이(+etcd) + MetalLB LB(`.200`) — 전 HTTP UI를 `*.local.beluga.internal:80`으로 | NodePort 개별 포워딩 제거로 호스트 포트 충돌 원천 차단, narwhal 검증 패턴 재사용, 독립 구동 | Kafka(9094)는 비HTTP라 NodePort 유지. Cilium Gateway API로 교체 가능 |
| D12 | 거버넌스 카탈로그 = OpenMetadata (DataHub·Atlas 기각) | arm64 전 태그 확인, Kafka 의존 없음, 메타 DB PostgreSQL → CNPG(D9) 통합, 공식 Helm. ingestion은 K8s CronJob — Airflow 3 플러그인 비호환(OpenMetadata#23556) 우회 | 커넥터가 표준 API 기반이라 DataHub 교체 가능. 32GB 프로파일 기본 off / 48GB+ 기본 on (D8) |
| D13 | SSO = beluga 자체 Keycloak — 인증 + 그룹/역할의 단일 원천, 전 UI OIDC 통합 | narwhal 비의존 독립성. Keycloak 그룹→앱 롤 매핑(Superset 검증됨), arm64 공식 이미지, 외부 PG=CNPG 전제 ~1.25GB | Airflow 3 롤 매핑은 알려진 버그(§9) — 로그인만 통합, 롤은 수동 시작 |
| D14 | 데이터 접근제어 = 중앙 OPA 서버 1개(Trino+Kafka, 단일 Rego 번들 + 결정 로그) + OpenFGA(Lakekeeper 전용) — Ranger 기각 | Ranger·Strimzi Keycloak 인가 모두 KRaft 미지원이라 D6과 충돌. opa-kafka-plugin·Trino OPA 모두 원격 OPA HTTP 호출이라 중앙 서버 1개로 성립. Lakekeeper는 OPA 독립 백엔드 미지원 → OpenFGA 필수 | Lakekeeper OPA Bridge로 Trino 정책이 Iceberg 권한 조회 가능. OpenFGA → Cedar 교체 가능 |
| D15 | 자격증명 = 부트스트랩 시 랜덤 생성 (narwhal 패턴 승계) — `openssl rand`로 생성해 K8s Secret(`beluga-credentials`)에 저장, 차트에는 `--set`으로만 주입. 리포에 실값 커밋 금지, values 기본값은 `SET-AT-BOOTSTRAP` 플레이스홀더 | 고정 자격 커밋은 로컬 데모라도 배제 — 시리즈 공통 규율. 조회는 `kubectl get secret ... \| base64 -d` | 재생성은 Secret 삭제 후 재부트스트랩 |
| D16 | K8s 배포판 = k3s (INSTALL_K3S_CHANNEL 고정, 현 v1.36) — narwhal의 kubeadm 골격 대신 채택 | 구현이 k3s로 진행됐고 클린 인스톨 E2E가 이 위에서 검증 완료. kubeadm 회귀는 재검증 비용 대비 이득 없음 (2026-08-10 사용자 승인) | 채널 값은 cluster.env K8S_VERSION. kubeadm 필요 시 narwhal scripts/cluster 골격 이식 |
| D20 | 계정 통합 = **OpenLDAP(저장소) + Keycloak(관리·발급 접점, WRITABLE 페더레이션)**. OIDC 앱은 Keycloak, Kafka는 Keycloak OAuth, PostgreSQL은 LDAP 직접(`pg_hba ldap`) — 계정 하나로 전 계층 (§10.3) | PG 18 OAuth는 서버는 되나 **클라이언트 생태계(JDBC/psycopg/DBeaver)가 OAUTHBEARER 미지원**이라 단독 불가(조사 확인). LDAP은 PG가 네이티브 지원하는 유일한 디렉터리 프로토콜. Keycloak은 LDAP 서버가 못 되므로 저장소는 OpenLDAP이 맡고 운영 접점은 Keycloak 콘솔로 단일화 | 클라이언트 생태계가 OAUTHBEARER를 지원하면 LDAP 제거 가능. LDAP 이미지 유지보수 리스크는 §9 |
| D19 | 권한 모델 = **사용자 → 그룹 → 롤(컴포지트 상속)** 3계층. 사용자는 그룹에만 속하고, 그룹이 롤을 받으며, 롤은 하위 롤을 포함해 상속한다 (§10.1) | 사용자에게 권한을 직접 붙이지 않아 인사 변경이 그룹 이동 한 번으로 끝난다. 상속을 **토큰 발급 시점에 확장**해 각 계층은 "이 롤이 있나"만 보면 되고 상속 계산을 하지 않는다 — 계층별 구현 편차 제거 | 롤 추가는 컴포지트 체인에 한 줄. 상속이 부담되면 컴포지트를 풀어 평면 롤로 되돌릴 수 있다 |
| D18 | 권한 매트릭스 = Keycloak 그룹 3종(admin/engineer/analyst)을 **단일 주체 축**으로, 앱·데이터·DB 전 계층에 동일 의미로 투영 (§10) | 주체를 한 곳(Keycloak)에서 정의하고 각 계층은 집행만 — 그룹 추가 시 매트릭스 한 줄로 확장. PII 경계는 `lake.customers`/`shop.customers`로 통일 | 계층별 집행 수단은 교체 가능(OPA↔Ranger, PG role↔RLS). 그룹 축은 유지 |
| D17 | 버전 정책 = 가급적 전 컴포넌트 **최신 안정판을 핀** (2026-08-10 사용자 지시) — 승급 게이트: 태그 실존 + arm64 manifest inspect + 호환 매트릭스(Flink↔Iceberg↔Kafka, 오퍼레이터↔K8s) 검증 통과 | latest 태그 사용 금지(핀 필수)와 양립 — "최신을 골라 핀". 미고정 채널 드리프트·EOL 비호환(Strimzi 0.45 사례) 예방 | 호환 불가 컴포넌트는 사유를 VERSIONS.md 비고에 명시하고 하위 버전 유지 |

### 접근 레지스트리 (D11)

모든 HTTP UI/API는 APISIX 게이트웨이를 거쳐 `http://<서브도메인>.local.beluga.internal`
(호스트 포트 80 통일)로 접근한다 — 서브도메인 표는 §4. 비HTTP·예외만 아래에 남긴다.

| 예외 서비스 | 접근 | 비고 |
|------------|------|------|
| Kafka bootstrap | 호스트 9094 (NodePort 30094 포워드) | 비HTTP — 클라이언트 직접 연결 |
| Grafana / Prometheus | NodePort 30000 / 30090 (노드 IP 직접) | 도메인 편입은 후속 — `docs/access-guide.md` 참조 |

충돌 원칙: 새 HTTP 서비스는 §4 도메인 표에 서브도메인을 먼저 유일하게 배정한다.
예외 포트 추가 시 이 표를 갱신한다.

## 3. 클러스터 토폴로지

```
master-1   192.168.77.10   2 CPU, 4GB    control plane, dnsmasq
worker-1   192.168.77.21   4 CPU, 8GB    데이터 워크로드
worker-2   192.168.77.22   4 CPU, 8GB    데이터 워크로드
worker-3   192.168.77.23   4 CPU, 8GB    데이터 워크로드
──────────────────────────────────────────────
합계 14 CPU / 28GB VM  (32GB+ 호스트, narwhal 미기동 전제)
```

- 네트워킹: Cilium CNI + MetalLB (LB pool 192.168.77.200~220, APISIX LB = `.200`)
- 프로바이더: VMware Fusion(arm64) / VirtualBox(amd64) — narwhal과 동일한 이중 지원
- D8 사이징: `up.sh`가 호스트 RAM을 감지해 프로파일 선택
  - 32GB 호스트: 위 기본값 (Trino coordinator 단독, OpenMetadata off)
  - 48GB+: 워커 10GB + Trino worker 1 + OpenMetadata on (D12)
  - 64GB+: 워커 12GB + Flink TaskManager/Trino worker 증설

## 4. 컴포넌트 스택

전부 K8s Operator/Helm 기반, ArgoCD app-of-apps로 배포.

| 서비스 | 도메인 (`*.local.beluga.internal`) | 백엔드 K8s Service | 외부 접속 포트 |
|--------|------------------------------------|-------------------|----------------|
| Trino Coordinator | `http://trino.local.beluga.internal` | `trino:8080` | **80 (통일)** |
| Airflow 3 UI | `http://airflow.local.beluga.internal` | `airflow:8080` | **80 (통일)** |
| Superset BI | `http://superset.local.beluga.internal` | `superset:8088` | **80 (통일)** |
| Flink JobManager | `http://flink.local.beluga.internal` | `flink-cluster-rest:8081` | **80 (통일)** |
| Lakekeeper REST | `http://catalog.local.beluga.internal` | `lakekeeper:8181` | **80 (통일)** |
| SeaweedFS S3 | `http://s3.local.beluga.internal` | `seaweedfs-s3:8333` | **80 (통일)** |
| SeaweedFS Filer | `http://filer.local.beluga.internal` | `seaweedfs-s3:8888` | **80 (통일)** |
| ArgoCD Server | `http://argocd.local.beluga.internal` | `argocd-server:80` | **80 (통일)** |
| Keycloak SSO (D13) | `http://sso.local.beluga.internal` | `keycloak:8080` | **80 (통일)** |
| OpenMetadata (D12) | `http://metadata.local.beluga.internal` | `openmetadata:8585` | **80 (통일)** — 48GB+ 프로파일 |

> **호스트 `/etc/hosts` 바인딩** (`192.168.77.200` — MetalLB APISIX LB IP):
> `192.168.77.200 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal flink.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal filer.local.beluga.internal argocd.local.beluga.internal sso.local.beluga.internal metadata.local.beluga.internal`

| 레이어 | 컴포넌트 | 배포 방식 | 상시 RAM 예산 |
|--------|----------|-----------|---------------|
| 수집 | Kafka (KRaft, 3 브로커) + Kafka Connect + Debezium | Strimzi Operator | ~4GB |
| 스트림 처리 | Flink (JobManager 1 + TaskManager 2) | Flink Kubernetes Operator | ~5GB |
| 카탈로그 | Lakekeeper (Iceberg REST) | Helm | ~0.5GB |
| 스토리지 | SeaweedFS (S3) | Helm | ~1GB |
| 분석 | Trino (32GB: coordinator 단독 / 48GB+: + worker 1) | Helm | ~2–4GB |
| BI | Superset | Helm | ~1.5GB |
| 오케스트레이션 | Airflow 3 (KubernetesExecutor) | Helm | ~2GB |
| DB | CNPG PostgreSQL (shop 소스 DB + 메타 DB) | CNPG Operator | ~1.5GB |
| 플랫폼 | ArgoCD, Prometheus + Grafana, cert-manager | narwhal 패턴 | ~3GB |
| 게이트웨이 | APISIX + etcd + Ingress Controller (D11) | 자체 매니페스트 | ~0.8GB |
| SSO | Keycloak (메타 DB = CNPG) (D13) | Helm/Operator | ~1.25GB |
| 정책 | OPA 중앙 서버 + OpenFGA(Lakekeeper용) (D14) | 매니페스트 | ~0.3GB |
| 거버넌스 카탈로그 | OpenMetadata + OpenSearch 단일노드 (D12) | Helm | ~3.5GB — 48GB+ 프로파일만 |

상시 예산(32GB 프로파일): 게이트웨이·SSO·정책 편입(+~2.4GB), Trino worker 제외(−2GB)를 반영해
**~22.9GB / 가용 28GB** — 시스템 오버헤드(kubelet, Cilium 등) 감안 시 빠듯하지만 성립.
OpenMetadata(+3.5GB)는 48GB+ 프로파일에서만 기본 활성(D12). 초과 시 D6 축소 프로파일(1-브로커)
→ JVM 힙 상한 명시가 다음 조정 수단.

## 5. 데이터 흐름 — 복합 데모

### ① 이벤트 파이프라인

```
클릭스트림 생성기(Python Deployment, 합성 이벤트)
  → Kafka `events.clickstream`
  → Flink SQL (세션화 · 윈도우 집계)
  → Iceberg `lake.events_enriched`
```

### ② CDC 파이프라인

```
CNPG `shop` DB (orders / customers 테이블 + 시드 생성기)
  → Debezium (Kafka Connect) → Kafka `cdc.shop.*`
  → Flink SQL (upsert 미러링)
  → Iceberg `lake.orders`, `lake.customers`
```

### 공통 하류

- **Trino**: 이벤트 ⨝ 주문 조인 쿼리, Iceberg 타임트래블
- **Superset**: 조인 결과 대시보드 (데모 대시보드 export를 `demo/`에 포함)
- **Airflow**: 시간별 Iceberg 컴팩션·스냅샷 만료 DAG, 일별 집계 테이블 DAG

### ③ 거버넌스 데모 (D12~D14)

- **SSO**: Keycloak OIDC로 Superset 로그인 → Keycloak 그룹 변경 → Superset 롤 반영 확인
- **정책**: 중앙 OPA에 Rego 배포 → `analyst` 그룹의 Trino `lake.customers` 조회 차단과
  Kafka 토픽 쓰기 거부를 각각 관측, OPA 결정 로그로 통합 감사 확인
- **리니지** (48GB+): OpenMetadata 커넥터(Trino·Kafka·Superset)로 메타데이터 수집 →
  Kafka→Flink→Iceberg→Superset 리니지 그래프 확인

## 6. 리포 구조 (narwhal 미러링)

```
beluga/
├── Vagrantfile
├── Makefile
├── VERSIONS.md                  # 모든 컴포넌트 버전의 단일 원천
├── configs/cluster.env          # 서브넷·노드 사이징 (D1, D8)
├── scripts/
│   ├── up.sh                    # 진입점 (RAM 감지 → 프로파일 선택)
│   ├── cluster/                 # 노드 프로비저닝
│   ├── gitops/                  # ArgoCD 부트스트랩
│   └── common/
├── gitops/
│   ├── apps/app-of-apps.yaml
│   └── charts/
│       ├── beluga-platform/     # ArgoCD, 관측, cert-manager, MetalLB
│       └── beluga-data/         # Strimzi, Flink, Lakekeeper, Trino, Superset, Airflow, CNPG
├── demo/
│   ├── clickstream-gen/         # 합성 이벤트 생성기 (Python)
│   ├── shop-seed/               # CDC 소스 DB 시드 + 변경 생성기
│   ├── flink-sql/               # 파이프라인 SQL 정의
│   ├── superset/                # 대시보드 export
│   └── airflow-dags/
├── tests/                       # 검증 스크립트 (실상태 조회)
└── docs/
    ├── mistakes-log.md
    └── superpowers/specs/       # 본 문서
```

## 7. 프로젝트 규약

### 문서 체계 (kubemetal 승계)

- `CLAUDE.md`는 주제별 canonical 파일을 가리키는 **Source Map** 구조 — 같은 사실을 두 곳에 쓰지 않는다
- **D-레지스트리**(§2)가 결정의 단일 원천. 결정 변경 시 영향받는 문서를 같은 태스크에서 일괄 갱신
- **Mistakes Log**(`docs/mistakes-log.md`) 1일차부터 운영 — 작업 영역 섹션을 먼저 읽고, 새 실수는 행 추가
- bilingual 문서: README/README_ko, CHANGELOG/CHANGELOG_ko (Keep a Changelog, 릴리스 시점 갱신)

### 단일 진실 원천

- 컴포넌트/이미지 버전은 `VERSIONS.md` 하나에서 관리, 차트 values가 참조
- 버전 드리프트를 잡는 검증 스크립트를 `tests/`에 포함 (narwhal·kubemetal 공통 실패 패턴 예방)
- 포트 레지스트리(§2)를 서비스 추가 전에 갱신

### 검증 규율 (kubemetal "Never fabricate state" 승계)

- 검증 스크립트는 실제 상태를 조회해 실패를 그대로 노출 — 성공 출력 하드코딩 금지
- green gate ≠ 동작하는 기능: E2E는 Superset에 실데이터가 뜨는 것까지 관측
- 버그 수정은 재현부터: 실패를 재현하는 검증을 먼저 만들고, 수정 후 통과 확인

### 테스트 전략

| 대상 | 검증 | 도구 |
|------|------|------|
| 셸 스크립트 | lint | shellcheck |
| Helm 차트 | lint + 스키마 | helm lint, kubeconform |
| 데모 코드 | 단위 테스트 | pytest |
| E2E | 클린 인스톨 + 데모 파이프라인 관측 | tests/ 검증 스크립트 |

### 에이전트 실행 체계 — Agent Team Harness (D10)

구현 전 단계(스캐폴딩부터 데모·테스트까지)는 아래 하네스로 진행한다.

- **오케스트레이터 = Fable** (세션 최상위 모델): 레인 분해, 아키텍처 판단, 결과 검증·통합,
  최종 승인만 담당. 기계적 코드 작성(>20줄)은 워커 레인으로 위임 — 오케스트레이터가 직접
  구현하는 것은 미스라우팅으로 간주.
- **워커 풀 = agy 우선**: 독립 실행·코드/차트/스크립트 생성·대용량 컨텍스트 레인은 `agyp`로
  디스패치 (`--model` 명시, Flash 계열 → 소진 시 Opus Thinking 로테이션). 워커 출력은 파일로
  받아 읽고, stdout을 메인 컨텍스트로 흘리지 않는다.
- **네이티브 서브에이전트 보완**: superpowers/OMC 스킬 실행, 구조화 도구(Read/Edit/Grep) 접근,
  세션 내 조정이 필요한 레인. 기본 sonnet, 아키텍처·보안 판단만 상위 티어.
- **병렬 규칙**: 독립 레인은 한 번에 디스패치(동시 최대 5), 장기 빌드/테스트는 background,
  파일이 겹치는 레인은 worktree 격리.
- **작성·검증 분리**: 같은 레인이 자기 결과를 승인하지 않는다. 검증 레인은 §7 검증 규율대로
  실상태 조회 증거를 제출해야 통과.

| 레인 유형 | 라우팅 |
|-----------|--------|
| Vagrantfile·스크립트·Helm values·데모 코드 작성 | agy 워커 (병렬) |
| 계획 수립·D-레지스트리 변경·리뷰 승인 | Fable 직접 |
| 스킬 기반 작업(writing-plans 등)·lint/검증 실행 | 네이티브 서브에이전트 |

### 브랜치 · 커밋

```
main
 └── feat/<module>/<desc>   fix/<module>/<desc>   chore/<module>/<desc>
```

- 브랜치 타입은 3종 고정. `refactor`·`docs`·`test` 등은 커밋 타입으로만
- Conventional Commits + 모듈 스코프:
  `<type>(<module>): <desc>` — module: `cluster | gitops | ingest | stream | lake | analytics | orch | demo | docs`
- 태스크 단위 커밋, **LOCAL only** — push는 명시 요청 시에만
- 파일 ~300줄 초과 시 분리

## 8. 검증 기준 (완료 정의)

1. `vagrant up` → 전 파드 Running (narwhal 방식 클린 인스톨 iteration 검증)
2. 이벤트 데모: 생성기 가동 후 10분 내 Superset 대시보드에 집계 결과 표시
3. CDC 데모: `shop` DB에 UPDATE 실행 → Iceberg 미러 테이블에 반영 확인 (Trino 조회)
4. Trino에서 Iceberg 타임트래블 쿼리 동작
5. Airflow 컴팩션 DAG 1회 이상 성공 이력
6. shellcheck / helm lint / kubeconform / pytest 전체 통과
7. 위 전부를 `tests/` 검증 스크립트가 실상태 조회로 확인 (수동 관측 의존 최소화)
8. 전 HTTP UI가 `*.local.beluga.internal:80` 도메인으로 응답 (APISIX 경유, D11)
9. Keycloak OIDC로 Superset 로그인 + 그룹→롤 매핑 동작 (D13)
10. OPA 정책의 허용/거부가 Trino·Kafka 양쪽에서 관측되고 결정 로그에 남음 (D14)
11. (48GB+ 프로파일) OpenMetadata 리니지 그래프에 데모 파이프라인 표시 (D12)

## 10. 권한 체계 (D18 매트릭스 · D19 모델)

### 10.1 주체 모델 — 사용자 → 그룹 → 롤 (D19)

권한은 사용자에게 직접 붙이지 않는다. 세 계층으로 분리한다.

```
사용자           그룹                    롤 (컴포지트 상속)
beluga-admin  →  /beluga/admins     →   beluga-admin
                                          └─ includes beluga-engineer
beluga-eng    →  /beluga/engineers  →   beluga-engineer
                                          └─ includes beluga-analyst
beluga-analyst→  /beluga/analysts   →   beluga-analyst   (기본 롤)
```

- **사용자**는 그룹에만 속한다. 권한 변경 = 그룹 이동.
- **그룹**은 조직 단위이며 롤을 부여받는다. 새 팀이 생기면 그룹을 만들어 기존 롤을 매핑한다.
- **롤**은 권한 묶음이고 **컴포지트로 상속**한다: `admin ⊃ engineer ⊃ analyst`.
  상위 롤 보유자는 하위 롤의 권한을 자동으로 갖는다.

**상속은 토큰 발급 시점에 확장된다.** Keycloak이 `roles` 클레임에 실효 롤 전부를 넣으므로
(admin 사용자 → `["beluga-admin","beluga-engineer","beluga-analyst"]`), 각 집행 계층은
"이 롤이 목록에 있나"만 확인하면 되고 상속 관계를 스스로 계산하지 않는다. 계층마다 상속을
다르게 구현해 생기는 편차를 원천 차단하는 것이 이 설계의 핵심이다.

**정책 작성 규칙 (상속과 충돌 방지)**: 정책은 **allow-by-role**로만 쓴다.
"analyst는 customers 금지" 같은 deny 규칙을 롤에 걸면 상속받은 상위 롤까지 막히므로,
"engineer 이상은 customers 허용"으로 뒤집어 표현한다. 기본은 거부, 허용만 롤로 부여.

### 10.3 계정 통합 경로 (D20)

```
                 ┌──────────────┐  WRITABLE federation   ┌────────────┐
   관리자 ──────▶│   Keycloak   │◀──────────────────────▶│  OpenLDAP  │
   (콘솔에서 생성) └──────┬───────┘   (사용자 write-back)   └─────┬──────┘
                        │ OIDC / OAuth                          │ LDAP bind
        ┌───────────────┼───────────────┬──────────────┐        │
   Superset         Airflow      OpenMetadata      Kafka        │
     Trino                                    (SASL OAUTH)      │
                                                          PostgreSQL
                                                        (pg_hba ldap)
```

- **계정 저장소 = OpenLDAP**, **운영 접점 = Keycloak 콘솔**(WRITABLE이라 Keycloak에서 만든
  사용자가 LDAP에 저장된다). 사용자는 어디서든 같은 아이디·비밀번호를 쓴다.
- **PostgreSQL**: `pg_hba`의 `ldap` 방식으로 비밀번호 검증만 LDAP에 위임한다. PG는 롤을
  자동 생성하지 않으므로 D19 롤(`beluga_analyst/engineer/admin`)을 사전 생성해 두고,
  로그인 계정명이 그 롤과 일치하도록 맞춘다.
- **Kafka**: Strimzi KRaft에서 listener `authentication.type: oauth`가 완전 지원되므로
  LDAP을 거치지 않고 Keycloak 토큰을 직접 검증한다.
- **한계**: LDAP 비밀번호는 평문 전송이므로 `ldaptls=1` 또는 `ldaps`가 전제다.

### 10.2 계층별 집행 (D18)

각 계층은 위 롤을 **집행만** 한다. 롤의 의미:

- **beluga-analyst** — 분석가. 읽기 전용. PII(`customers` 계열) 제외.
- **beluga-engineer** — 데이터 엔지니어. analyst 권한 + 데이터 쓰기 + PII 접근.
- **beluga-admin** — 플랫폼 운영자. engineer 권한 + 플랫폼 설정·관리.

아래 표의 상위 롤 칸은 **하위 칸의 권한을 이미 포함**한다(중복 표기하지 않는다).

| 계층 / 앱 | 집행 지점 | admin | engineer | analyst |
|---|---|---|---|---|
| Superset (BI) | Keycloak 그룹 → FAB 롤 (구현됨) | `Admin` | `Alpha` (데이터셋 생성) | `Gamma` (읽기 전용) |
| Airflow (오케스트레이션) | FAB auth manager | `Admin` | `Op` (DAG 트리거) | `Viewer` |
| OpenMetadata (카탈로그) | `AUTHORIZER_ADMIN_PRINCIPALS` + 롤 | Admin | DataSteward | DataConsumer |
| Trino (쿼리) | 중앙 OPA — JWT `groups` 클레임 | 전체 허용 | `lake` 읽기/쓰기 | `lake` 읽기, **`customers` 차단** |
| Kafka (스트리밍) | opa-kafka-plugin (게이트 off — 후속) | 전체 | 토픽 읽기/쓰기 | 토픽 **읽기만** |
| Iceberg/Lakekeeper | OpenFGA (기본 off — 후속) | warehouse 관리 | 네임스페이스 쓰기 | 읽기 |
| **PostgreSQL (CNPG)** | PG 롤 + GRANT (**네이티브 상속**: `GRANT beluga_analyst TO beluga_engineer` 등) | `beluga_admin` (소유자) | `beluga_engineer` — analyst 상속 + 전 테이블 R/W + `customers` 접근 | `beluga_analyst` — 읽기 전용, `customers` 제외 |
| ArgoCD / Flink / SeaweedFS | (미연동) | 로컬 admin | — | — |

**PII 경계 정의**: `shop.customers`(원본)와 `lake.customers`(CDC 미러)는 이메일을 포함하므로
analyst 계열에서 전 계층 차단한다. `orders`·`events_enriched`는 분석 대상이므로 허용.

**상속 구현 수단(계층별)**: PostgreSQL은 롤 상속이 네이티브(`GRANT role TO role` + INHERIT).
OPA는 확장된 `roles` 클레임을 그대로 검사. Superset/Airflow(FAB)는 롤 상속이 없으므로
그룹 매핑에 하위 롤을 함께 나열해 등가로 구현한다.

**집행 상태**: Superset·Trino·PostgreSQL은 즉시 집행. Airflow는 로그인만 통합(§9 롤 매핑 버그),
Kafka·Iceberg는 게이트가 열리면 동일 매트릭스가 그대로 적용된다(정책은 미리 작성).

## 9. 리스크

| 리스크 | 대응 |
|--------|------|
| 28GB 예산 초과 (JVM 스택 중첩) | D6 축소 프로파일, Trino worker 제거, JVM 힙 상한 명시 |
| arm64 이미지 미지원 컴포넌트 | 선정 단계에서 arm64 매니페스트 확인을 게이트로 (narwhal harbor `exec format error` 교훈) |
| Flink-Iceberg-Lakekeeper 버전 매트릭스 불일치 | VERSIONS.md에 호환 매트릭스 명시, 업그레이드는 매트릭스 검증 후 |
| Strimzi/Flink Operator CRD 대형화로 ArgoCD sync 부담 | ServerSideApply 옵션, CRD는 별도 app으로 분리 |
| ~~OpenLDAP 이미지 유지보수 리스크 (osixia)~~ (해소: `vegardit/openldap:2.6.10` 전환, 2026-08-11) — osixia 방치를 레지스트리 실조회로 확정: `stable`/`latest`/`1.5.0`이 모두 **2021-02-19 = OpenLDAP 2.4.57**, `2.6.10-alpha`는 2026-04-27 이후 alpha 미승격. 기존 D17 예외(2.6-alpha의 `OPENLDAP_BOOTSTRAP_*` 계약 개편으로 `LDAP_DOMAIN` 무시 실측 → 1.5.0 유지)는 **"문서화된 계약이 동작할 것"이라는 요구를 2.4.57에 묶는 대가**였는데, vegardit이 2.6.10에서 그 요구를 충족해 예외가 불필요해짐 | vegardit = 2026-08-10 재빌드, `manifest inspect` amd64+arm64+armv7 실검증, Apache-2.0, 주간 자동 재빌드, `LDAP_INIT_*` 계약 문서화. **잔여 리스크 2건**: ⑴ Debian trixie `slapd` 패키지 기반이라 상류 LTS(현 2.6.14) 추종 약속 없이 데비안 보안 백포트에 의존 ⑵ 첫 기동 시 데모 계정·그룹(`employee1`/`guest1`/`machine1`, `groupOfUniqueNames` 4종)을 시드하므로 `/opt/ldifs` 오버라이드로 억제 필요 — 억제 실패 시 D18 그룹 축 오염 |
| LDAP 대안 경로가 좁음 — §9 상단 폴백이던 389ds는 quay 최신이 2025-06-22로 정체 + 쓸 만한 Helm 차트 없음(표준이던 `jp-gouin/helm-openldap`은 2026-01-31 아카이브), LLDAP·GLAuth·Kanidm은 **LDAP 와이어 상 읽기 전용**이라 D20의 WRITABLE 페더레이션 불가 | 교체 비용은 "낮음"이 아님을 인정하고 vegardit 유지. 최후 수단인 자체 빌드는 법적으로 자유(OLDAP-2.8 퍼미시브·OSI·GPL 호환, `back-sql`만 끄면 카피레프트 0) — 제약은 라이선스가 아니라 **레지스트리 부재**(D6에서 KafkaConnect `spec.build`를 포기한 것과 동일 원인) |
| ~~LDAP 계정 저장소가 휘발성(`emptyDir`)이라 파드 재시작 시 Keycloak WRITABLE로 생성한 계정 소실~~ (해소: PVC 2종 + `strategy: Recreate` 전환, 2026-08-11) | — |
| LDAPS 미구성 — Service가 389만 노출하고 `pg_hba`에 `ldaptls=1`이 없어 **LDAP 비밀번호가 평문 전송**. §10.3이 전제한 TLS 조건 미충족 | cert-manager가 아직 미설치(VERSIONS.md)라 즉시 해결 불가 → 백로그. 현재는 클러스터 내부 ClusterIP 통신으로 한정된다는 점을 완화 요인으로만 인정하고, 해소 전까지 "충족"으로 표기 금지 |
| Airflow 3 Keycloak 롤 매핑 오동작(apache/airflow#54098), 전용 Keycloak auth manager는 alpha | 로그인만 SSO 통합, Airflow 롤은 수동 관리로 시작 — 이슈 해소 후 매핑 확장 |
| OpenMetadata OIDC 롤 매핑 미문서화 | 데모 범위를 로그인 통합까지로 한정, 매핑은 실검증 후 확장 |
| Trino JWT groups→OPA 전달 엣지케이스(trinodb/trino#28571) | tests/에 허용·거부 양방향 검증 스크립트 포함 |
| ~~현 구현이 D4 불일치 — `tabulario/iceberg-rest:latest`~~ (해소: `quay.io/lakekeeper/catalog:v0.14.0` 교체 완료) | — |
| ~~고정 dev 자격증명이 리포에 커밋됨~~ (해소: D15 — 부트스트랩 랜덤 생성으로 전환) | — |
