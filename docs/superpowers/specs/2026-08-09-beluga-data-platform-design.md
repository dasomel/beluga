# Beluga — 데이터 플랫폼 설계서

- 작성일: 2026-08-09
- 상태: 승인됨 (브레인스토밍 완료, 구현 계획 수립 전)
- 자매 프로젝트: [narwhal](https://github.com/dasomel/narwhal) (K8s IDP), kubemetal (Apple Silicon MLOps)

## 1. 개요

**Beluga**는 Vagrant 기반 독립 Kubernetes 클러스터 위에 구축하는 풀스택 데이터 플랫폼이다.
수집(Kafka) → 스트림 처리(Flink) → 저장(Iceberg 레이크하우스) → 분석(Trino/Superset) →
오케스트레이션(Airflow)까지 업계 표준 스택을 K8s Operator 생태계로 완성하고,
**이벤트 스트리밍 + CDC 복합 데모**로 엔드투엔드를 증명한다.

narwhal의 골격(Vagrant + `dasomel/ubuntu-26.04-xfs` 박스 + K8s v1.35 + ArgoCD GitOps)을
재사용하되, 서비스메시·시크릿 관리는 의도적으로 제외한다 — 그것은 narwhal의 영역이다.
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
| D6 | Kafka = Strimzi KRaft 3-브로커, CDC = Kafka Connect + Debezium | ZooKeeper 제거(KRaft), Strimzi가 Connect까지 CR로 관리 | 리소스 부족 시 1-브로커 축소 프로파일 |
| D7 | 오케스트레이션 = Airflow 3 + KubernetesExecutor | Celery/Redis 불필요 — 파드 스폰 방식으로 상시 리소스 최소화 | — |
| D8 | 호스트 RAM 감지 기반 VM 사이징 프로파일 (kubemetal D4 응용) | 32GB/48GB/64GB+ 호스트별 프로파일, 하드코딩 금지 | cluster.env 수동 오버라이드 |
| D9 | CNPG PostgreSQL 단일 오퍼레이터로 CDC 소스 DB + 메타 DB(Airflow/Superset/Lakekeeper) 통합 | 오퍼레이터 1개로 DB 전부 관리, narwhal에서 검증됨 | 메타 DB 분리는 Cluster CR 추가로 가능 |
| D10 | 구현 실행 체계 = Fable 지휘 오케스트레이션 + agy 워커 적극 활용 (Agent Team Harness, §7) | 오케스트레이터 컨텍스트는 판단·리뷰·통합에 집중, 기계적 구현은 워커 레인으로 — 토큰 효율 + 병렬 처리량 | 하네스 정의(§7) 수정으로 조정, agy 소진 시 네이티브 서브에이전트 |
| D11 | 접근 통일 = 자체 APISIX 게이트웨이(+etcd) + MetalLB LB(`.200`) — 전 HTTP UI를 `*.local.beluga.internal:80`으로 | NodePort 개별 포워딩 제거로 호스트 포트 충돌 원천 차단, narwhal 검증 패턴 재사용, 독립 구동 | Kafka(9094)는 비HTTP라 NodePort 유지. Cilium Gateway API로 교체 가능 |
| D12 | 거버넌스 카탈로그 = OpenMetadata (DataHub·Atlas 기각) | arm64 전 태그 확인, Kafka 의존 없음, 메타 DB PostgreSQL → CNPG(D9) 통합, 공식 Helm. ingestion은 K8s CronJob — Airflow 3 플러그인 비호환(OpenMetadata#23556) 우회 | 커넥터가 표준 API 기반이라 DataHub 교체 가능. 32GB 프로파일 기본 off / 48GB+ 기본 on (D8) |
| D13 | SSO = beluga 자체 Keycloak — 인증 + 그룹/역할의 단일 원천, 전 UI OIDC 통합 | narwhal 비의존 독립성. Keycloak 그룹→앱 롤 매핑(Superset 검증됨), arm64 공식 이미지, 외부 PG=CNPG 전제 ~1.25GB | Airflow 3 롤 매핑은 알려진 버그(§9) — 로그인만 통합, 롤은 수동 시작 |
| D14 | 데이터 접근제어 = 중앙 OPA 서버 1개(Trino+Kafka, 단일 Rego 번들 + 결정 로그) + OpenFGA(Lakekeeper 전용) — Ranger 기각 | Ranger·Strimzi Keycloak 인가 모두 KRaft 미지원이라 D6과 충돌. opa-kafka-plugin·Trino OPA 모두 원격 OPA HTTP 호출이라 중앙 서버 1개로 성립. Lakekeeper는 OPA 독립 백엔드 미지원 → OpenFGA 필수 | Lakekeeper OPA Bridge로 Trino 정책이 Iceberg 권한 조회 가능. OpenFGA → Cedar 교체 가능 |

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

## 9. 리스크

| 리스크 | 대응 |
|--------|------|
| 28GB 예산 초과 (JVM 스택 중첩) | D6 축소 프로파일, Trino worker 제거, JVM 힙 상한 명시 |
| arm64 이미지 미지원 컴포넌트 | 선정 단계에서 arm64 매니페스트 확인을 게이트로 (narwhal harbor `exec format error` 교훈) |
| Flink-Iceberg-Lakekeeper 버전 매트릭스 불일치 | VERSIONS.md에 호환 매트릭스 명시, 업그레이드는 매트릭스 검증 후 |
| Strimzi/Flink Operator CRD 대형화로 ArgoCD sync 부담 | ServerSideApply 옵션, CRD는 별도 app으로 분리 |
| Airflow 3 Keycloak 롤 매핑 오동작(apache/airflow#54098), 전용 Keycloak auth manager는 alpha | 로그인만 SSO 통합, Airflow 롤은 수동 관리로 시작 — 이슈 해소 후 매핑 확장 |
| OpenMetadata OIDC 롤 매핑 미문서화 | 데모 범위를 로그인 통합까지로 한정, 매핑은 실검증 후 확장 |
| Trino JWT groups→OPA 전달 엣지케이스(trinodb/trino#28571) | tests/에 허용·거부 양방향 검증 스크립트 포함 |
| ~~현 구현이 D4 불일치 — `tabulario/iceberg-rest:latest`~~ (해소: `quay.io/lakekeeper/catalog:v0.14.0` 교체 완료) | — |
| 고정 dev 자격증명이 리포에 커밋됨 (CNPG·Keycloak admin·OIDC 클라이언트 secret 등) | 로컬 데모 전용 전제를 문서·매니페스트 주석에 명시. Secret 리소스 경유로 패턴 통일. 외부 노출 환경 전환 시 전면 재발급이 전제 조건 |
