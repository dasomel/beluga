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
재사용하되, IDP 관심사(SSO, 서비스메시, 시크릿 관리, API 게이트웨이)는 의도적으로 제외한다 —
그것은 narwhal의 영역이고, beluga는 데이터 스택 증명에 집중한다.

### 목표

1. 정석 데이터 플랫폼 아키텍처를 단일 `vagrant up`으로 재현
2. 이벤트 스트리밍과 CDC라는 실무 대표 패턴 2종의 동작 증명
3. narwhal·kubemetal과 함께 플랫폼 3부작(인프라 / AI / 데이터) 완성

### 비범위 (Out of Scope)

- SSO(Keycloak), OpenBao, Istio, APISIX — narwhal의 영역
- HA 컨트롤플레인 — 데이터 플랫폼의 증명 포인트가 아님 (D2)
- ML feature store / kubemetal 연동 — 차후 확장 후보로만 기록
- 에어갭 번들 — narwhal 패턴 존재, 필요 시 후속

## 2. 결정 레지스트리 (D-Registry)

| ID | 결정 | 근거 | 탈출구 |
|----|------|------|--------|
| D1 | 서브넷 `192.168.57.x` (VIP 없음, LB pool `.200~.220`) | narwhal(`192.168.56.x`)과 동시 기동 시 충돌 방지 | cluster.env에서 변경 가능 |
| D2 | 싱글 마스터 (master-1) + 워커 3대 | 단독 구동 전제에서 RAM을 데이터 워크로드에 집중. HA는 증명 포인트 아님 | 마스터 증설은 Vagrantfile 노드 정의 추가로 가능 |
| D3 | 스트림 엔진 = Flink (Spark 아님) | 진짜 스트리밍(레코드 단위) 데모 가치 + Flink SQL로 이벤트·CDC 파이프라인 통일 | 배치 전용 작업이 커지면 Spark 추가 검토 |
| D4 | Iceberg REST 카탈로그 = Lakekeeper | Rust 기반 경량(수백 MB급 JVM 카탈로그 대비), arm64 지원, REST 표준 | Polaris/Nessie로 교체 시 카탈로그 URL만 변경 |
| D5 | 오브젝트 스토리지 = SeaweedFS S3 | narwhal·kubemetal과 동일 — 시리즈 일관성, 검증된 운영 경험 | S3 API 표준이라 MinIO 교체 가능 |
| D6 | Kafka = Strimzi KRaft 3-브로커, CDC = Kafka Connect + Debezium | ZooKeeper 제거(KRaft), Strimzi가 Connect까지 CR로 관리 | 리소스 부족 시 1-브로커 축소 프로파일 |
| D7 | 오케스트레이션 = Airflow 3 + KubernetesExecutor | Celery/Redis 불필요 — 파드 스폰 방식으로 상시 리소스 최소화 | — |
| D8 | 호스트 RAM 감지 기반 VM 사이징 프로파일 (kubemetal D4 응용) | 32GB/48GB/64GB+ 호스트별 프로파일, 하드코딩 금지 | cluster.env 수동 오버라이드 |
| D9 | CNPG PostgreSQL 단일 오퍼레이터로 CDC 소스 DB + 메타 DB(Airflow/Superset/Lakekeeper) 통합 | 오퍼레이터 1개로 DB 전부 관리, narwhal에서 검증됨 | 메타 DB 분리는 Cluster CR 추가로 가능 |

### 포트 레지스트리 (호스트 port-forward 규약)

클러스터 내부는 서비스별 ClusterIP라 컨테이너 포트 중복이 무해하지만, 호스트에서
port-forward로 접근할 때의 **로컬 포트 규약**은 유일해야 한다. Trino·Airflow가 모두
컨테이너 기본 8080이므로 호스트 포트로 구분한다.

| 서비스 | 호스트 포트 | 컨테이너 기본 |
|--------|------------|---------------|
| Kafka bootstrap | 9094 (MetalLB external listener) | 9092 |
| Lakekeeper REST | 8181 | 8181 |
| Trino coordinator | 8080 | 8080 |
| Airflow API/UI | 8085 | 8080 (Trino와 겹쳐 호스트에서 재배정) |
| Superset | 8088 | 8088 |
| Flink JobManager UI | 8081 | 8081 |
| SeaweedFS S3 / Filer | 8333 / 8888 | kubemetal D1과 동일 |
| Grafana / Prometheus | 3000 / 9090 | 3000 / 9090 |
| ArgoCD | 8443 | 8080/8083 |

충돌 원칙: 새 서비스 추가 시 이 표를 먼저 갱신한다. 같은 호스트 포트의 이중 할당은 커밋 전에 잡는다.

## 3. 클러스터 토폴로지

```
master-1   192.168.57.10   2 CPU, 4GB    control plane, dnsmasq
worker-1   192.168.57.21   4 CPU, 8GB    데이터 워크로드
worker-2   192.168.57.22   4 CPU, 8GB    데이터 워크로드
worker-3   192.168.57.23   4 CPU, 8GB    데이터 워크로드
──────────────────────────────────────────────
합계 14 CPU / 28GB VM  (32GB+ 호스트, narwhal 미기동 전제)
```

- 네트워킹: Cilium CNI + MetalLB (LB pool 192.168.57.200~220)
- 프로바이더: VMware Fusion(arm64) / VirtualBox(amd64) — narwhal과 동일한 이중 지원
- D8 사이징: `up.sh`가 호스트 RAM을 감지해 프로파일 선택
  - 32GB 호스트: 위 기본값
  - 48GB+: 워커 10GB
  - 64GB+: 워커 12GB + Flink TaskManager/Trino worker 증설

## 4. 컴포넌트 스택

전부 K8s Operator/Helm 기반, ArgoCD app-of-apps로 배포.

| 레이어 | 컴포넌트 | 배포 방식 | 상시 RAM 예산 |
|--------|----------|-----------|---------------|
| 수집 | Kafka (KRaft, 3 브로커) + Kafka Connect + Debezium | Strimzi Operator | ~4GB |
| 스트림 처리 | Flink (JobManager 1 + TaskManager 2) | Flink Kubernetes Operator | ~5GB |
| 카탈로그 | Lakekeeper (Iceberg REST) | Helm | ~0.5GB |
| 스토리지 | SeaweedFS (S3) | Helm | ~1GB |
| 분석 | Trino (coordinator 1 + worker 1) | Helm | ~4GB |
| BI | Superset | Helm | ~1.5GB |
| 오케스트레이션 | Airflow 3 (KubernetesExecutor) | Helm | ~2GB |
| DB | CNPG PostgreSQL (shop 소스 DB + 메타 DB) | CNPG Operator | ~1.5GB |
| 플랫폼 | ArgoCD, Prometheus + Grafana, cert-manager | narwhal 패턴 | ~3GB |

예산 합계 ~22.5GB / 가용 28GB — 시스템 오버헤드(kubelet, Cilium 등) 감안 시 빠듯하지만 성립.
초과 시 D6 축소 프로파일(1-브로커) 또는 Trino worker 제거가 1차 조정 수단.

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
- 버그 수정은 재현부터 (cloudbro 승계): 실패를 재현하는 검증을 먼저 만들고, 수정 후 통과 확인

### 테스트 전략 (cloudbro 표의 인프라 레포 축소판)

| 대상 | 검증 | 도구 |
|------|------|------|
| 셸 스크립트 | lint | shellcheck |
| Helm 차트 | lint + 스키마 | helm lint, kubeconform |
| 데모 코드 | 단위 테스트 | pytest |
| E2E | 클린 인스톨 + 데모 파이프라인 관측 | tests/ 검증 스크립트 |

### 브랜치 · 커밋 (cloudbro 승계)

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

## 9. 리스크

| 리스크 | 대응 |
|--------|------|
| 28GB 예산 초과 (JVM 스택 중첩) | D6 축소 프로파일, Trino worker 제거, JVM 힙 상한 명시 |
| arm64 이미지 미지원 컴포넌트 | 선정 단계에서 arm64 매니페스트 확인을 게이트로 (narwhal harbor `exec format error` 교훈) |
| Flink-Iceberg-Lakekeeper 버전 매트릭스 불일치 | VERSIONS.md에 호환 매트릭스 명시, 업그레이드는 매트릭스 검증 후 |
| Strimzi/Flink Operator CRD 대형화로 ArgoCD sync 부담 | ServerSideApply 옵션, CRD는 별도 app으로 분리 |
