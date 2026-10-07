# 거버넌스 기반 변환 프레임워크, 엔진 선정 및 시맨틱 레이어 (제안)

[English](transformation-and-semantic-layer.md) | 한국어

관련 이슈: #72, #86 (이슈 #61, #63, #65, #70, #95, #96에 기반).

> **상태: 제안 (PROPOSAL). 문서 전용.** 본 문서로 변경되는 매니페스트, DAG, 스크립트, 정책, 레지스트리 또는 `VERSIONS.md` 값은 없으며, 어떠한 엔진이나 시맨틱 서비스도 배포되지 않습니다. 저장소 관련 서술은 `origin/main` 커밋 `d424c38` 기준 `file:line` 실측에 근거합니다. 라이브 클러스터 사실은 2026-10-08 지정된 격리 kubeconfig(`/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`)로 실행한 읽기 전용 조회에 기반하며, 실측하지 못한 항목은 **라이브 미검증(not verified live)**으로 명시합니다. 외부 엔진 문서 및 라이선스는 2026-10-08 열람한 공식 자료에 근거합니다([참고 문헌](#9-참고-문헌)). **제안(Proposed)**으로 표기된 항목은 설계 제안이며 현재 구현되어 있지 않습니다.

관련 문서:
- [`medallion-architecture-ko.md`](medallion-architecture-ko.md) (브론즈, 실버, 골드 레이어 정의, 8절 엔진 할당 및 미결 결정 Q1–Q7)
- [`adr/0004-duckdb-complementary-analytics-engine-ko.md`](adr/0004-duckdb-complementary-analytics-engine-ko.md) (DuckDB 채택 결정, REST 카탈로그 연결, MIT 라이선스)
- [`data-standards-ko.md`](data-standards-ko.md) 및 [`policies/data-standards.yaml`](../policies/data-standards.yaml) (명명 규칙, 필수 메타데이터, 분류값 `internal` 및 `pii`)
- [`data-contract-standard-ko.md`](data-contract-standard-ko.md) (기계 판독 가능한 데이터 계약 표준)
- [`data-quality-framework-ko.md`](data-quality-framework-ko.md) (품질 차원, 게이트 메커니즘 및 격리 처리)
- [`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md) (리니지 추적 및 OpenLineage/OpenMetadata 연동)
- [`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md) (데이터 민감도 및 마스킹 규칙)

---

## 1. 목적 및 이슈 매핑

본 제안은 긴밀히 연결된 데이터 처리 및 소비 관련 두 가지 이슈를 해결합니다:
1. **이슈 #72**: Apache Flink SQL, Trino SQL, DuckDB (ADR-0004), Apache Spark (이슈 #96 평가 대상), dbt Core (이슈 #95 평가 대상) 전반의 재사용 가능한 실버/골드 변환 프레임워크 및 엔진 선정.
2. **이슈 #86**: BI 도구, DuckDB/Trino 사용자, AI 클라이언트 전반에서 메트릭, 차원, 엔티티, 조인 경로 및 공유 비즈니스 정의를 일관되게 제공하는 거버넌스 기반 시맨틱 레이어.

| 이슈 | 인수 조건 (Acceptance Criterion) | 다루는 절 |
|---|---|---|
| #72 | 변환 클래스 및 엔진 선정 의사결정 매트릭스 문서화 | 4.1, 4.2 |
| #72 | 지원되는 각 실행 모드별로 최소 1개의 대표 실버 파이프라인 구동 | 4.1, 8 (과제 2) |
| #72 | 증분, 재시도 및 백필 동작의 결정론적 보장 | 4.3 |
| #72 | 변환 산출물에 재현 가능한 리니지 및 소스/런타임 메타데이터 포함 | 4.3 |
| #72 | 실버 품질 및 스키마 게이트를 통해 부적합한 골드 발행 차단 | 4.4 |
| #72 | 골드 발행을 통해 Trino와 DuckDB에서 조회 가능한 거버넌스 데이터셋 생성 | 4.4 |
| #72 | 데이터 계약을 변경하지 않고 지원 엔진 간 워크로드 이전 가능 | 4.2, 5.2 |
| #86 | 대표 비즈니스 메트릭을 단 1회 정의하고 둘 이상의 클라이언트 경로에서 일관되게 소비 | 5.1, 5.2 |
| #86 | 메트릭 정의에 소유자, 버전, 원천, 신선도 및 리니지 명시 | 5.1 |
| #86 | 파괴적(breaking) 시맨틱 변경 감지 및 승인 절차 수립 | 5.1 |
| #86 | 비인가 소비자가 시맨틱 접근 정책을 우회할 수 없도록 강제 | 5.3 |
| #86 | 공인(certified) 메트릭의 품질 및 신선도 상태 노출 | 5.1, 5.3 |
| #86 | 대표 Trino 및 DuckDB 쿼리가 동일한 거버넌스 메트릭 정의로 해석됨 | 5.2 |

---

## 2. 현재 상태 (검증됨)

### 2.1 저장소 아티팩트 (코드 및 매니페스트)

저장소는 현재 Flink SQL 기반 스트리밍 변환, Trino 기반 대화형 쿼리, Airflow 기반 초기 유지보수 DAG를 갖추고 있으나, 배치 실버/골드 파이프라인 및 중앙 시맨틱 레이어는 부재합니다:

- **현재 변환 상태 (스트리밍 전용)**:
  - 변환 작업은 Flink SQL 스트리밍 잡으로만 구현되어 있습니다(`gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`, `events_sessionization.sql:1-62`).
  - `cdc_customers.sql` 및 `cdc_orders.sql`은 Kafka의 Debezium CDC 토픽(`cdc.shop.public.*`)을 읽어 문자열 타임스탬프를 변환한 후, `write.upsert.enabled = 'true'` 설정으로 `lake` 네임스페이스의 Iceberg 테이블로 직접 적재합니다(`cdc_customers.sql:50-58`).
  - `events_sessionization.sql`은 `events.clickstream` 토픽(`:19`)을 읽고 이벤트 시간 워터마크 `WATERMARK FOR timestamp AS timestamp - INTERVAL '5' SECOND`(`:16`)를 정의하여, 1분 텀블링 윈도우 집계(`:56-62`)를 수행한 뒤 `lakekeeper.lake.events_enriched`(`:45-54`)에 기록합니다.
  - [`medallion-architecture-ko.md`](medallion-architecture-ko.md) 4절(`:100-138`)에서 확인된 바와 같이, 브론즈 테이블은 전혀 존재하지 않으며 현재 테이블들은 멀티홉 단계를 건너뛰어 스트림에서 곧바로 실버 또는 골드 유사 테이블로 쓰이고 있습니다.
- **배포된 쿼리/연산 엔진**:
  - **Trino**: 코디네이터 및 워커로 배포되어 있으며(`gitops/charts/beluga-data/templates/06-trino.yaml:1-120`) 버전은 `483`(`VERSIONS.md:35`, Apache-2.0)입니다. Keycloak 기반 OAuth2 인증을 통해 `lake` 웨어하우스의 Lakekeeper REST 카탈로그에 연결합니다(`06-trino.yaml:15`). 사용자 접근은 컴파일된 OPA Rego 정책(`policies/resources.yaml`)을 통해 인가됩니다.
  - **DuckDB**: [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)에서 상호보완적 경량 엔진으로 채택되었습니다(MIT 라이선스). `ATTACH ... (TYPE ICEBERG)` 및 SeaweedFS S3를 통해 Lakekeeper REST 카탈로그에 연결합니다. 현재 클러스터 내 상주 서비스로 배포되어 있지 않으며, 로컬·CI 및 보조 분석 워크로드를 위한 임베디드 쿼리 엔진 패턴으로 정의되어 있습니다.
  - **Airflow**: `KubernetesExecutor`로 배포되어 구동 중이며(`gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`) 버전은 `3.3.0`(`VERSIONS.md:36`, Apache-2.0)입니다. `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`에서 `KubernetesPodOperator`를 통해 Trino SQL을 실행합니다.
  - **Apache Spark**: 이슈 #96에 따라 대규모 분산 배치 처리 엔진으로 평가 중입니다. 현재 저장소에 Spark 오퍼레이터, 클러스터 또는 잡 매니페스트는 존재하지 않습니다.
  - **dbt**: 이슈 #95에 따라 SQL 변환 모델링 도구로 평가 중입니다. 현재 저장소에 `dbt_project.yml`, 모델 또는 dbt 어댑터 매니페스트는 존재하지 않습니다.
- **시맨틱 정의 및 소비 현황**:
  - 플랫폼에 중앙화된 시맨틱 레이어가 존재하지 않습니다.
  - 메트릭 계산이 SQL에 하드코딩되어 있습니다. `events_sessionization.sql:59-62`에 `event_count` (`COUNT(event_id)`)와 `total_duration_ms` (`SUM(duration_ms)`)가 고정되어 있으며, Superset 대시보드(`gitops/charts/beluga-data/templates/15-superset-import.yaml:1-200`)는 공유 시맨틱 모델 없이 Trino 테이블에 직접 차트를 정의합니다.
  - Superset 6.1.0(`VERSIONS.md:37`)은 `sqlalchemy-trino`를 통해 Trino에 연결됩니다(`15-superset-import.yaml:160-178`).
  - 테이블 스키마, 소유자, 설명, 보존 기간, 신선도는 [`policies/data-standards.yaml`](../policies/data-standards.yaml)(`:25-32`)에 정적으로 기록되어 있습니다.

### 2.2 라이브 클러스터 상태 (2026-10-08 실측)

지정된 kubeconfig를 통해 다음 사실을 읽기 전용으로 확인했습니다:
- **활성 엔진 워크로드**:
  - `analytics` 네임스페이스: 파드 `trino-coordinator-76cf9f6b9-rkksm` 실행 중(`Running`, 1/1); 파드 `trino-worker-5d75dd75b-g95l4` 실행 중(`Running`, 1/1); 파드 `superset-6956cb4889-ndskf` 실행 중(`Running`, 1/1).
  - `streaming` 네임스페이스: 파드 `flink-cluster-787f4dd587-gjl4r` 실행 중(`Running`, 1/1); TaskManager 파드 `flink-cluster-taskmanager-2-1` 및 `2-2` 실행 중(`Running`, 1/1).
  - `orchestration` 네임스페이스: 파드 `airflow-webserver-798bf8db59-2nzgt` 실행 중(`Running`, 1/1).
  - `lakehouse` 네임스페이스: 파드 `lakekeeper-66bbf6776c-dtpcx` 실행 중(`Running`, 1/1).
- **미배포 컴포넌트**: 어느 네임스페이스에도 Spark 오퍼레이터나 파드가 없으며, 클러스터에 dbt 실행기나 Cube 서비스도 존재하지 않습니다.

---

## 3. 인수 조건 대비 격차 분석

| 식별자 | 내용 | 근본 원인 및 현재 상태 |
|---|---|---|
| G-TR-1 | 재사용 가능한 배치 실버/골드 변환 프레임워크 부재 (#72) | 변환이 Flink SQL 스트리밍 잡에 국한되어 있습니다. 배치 SQL 변환, 증분 머지, 이력 백필을 위한 표준 프레임워크가 없습니다. |
| G-TR-2 | 객관적인 엔진 선정 기준 매트릭스 부재 (#72) | Flink, Trino, DuckDB, Spark, dbt 중 적합한 엔진을 선택하기 위한 문서화된 기준 매트릭스가 없어 엔진 할당이 임시방편으로 이뤄졌습니다. |
| G-TR-3 | 변환 메타데이터 및 리니지 추적 누락 (#72) | Flink SQL 잡이 입력 스냅샷 ID, 실행 잡 ID, 코드 Git 커밋 해시를 대상 Iceberg 메타데이터에 남기지 않습니다. |
| G-TR-4 | 골드 발행 품질 게이트 부재 (#72) | 골드 테이블(`lake.events_enriched`)이 스트림에서 연속 적재되며 발행 전 스키마/품질 검증이 없습니다. 윈도우 연산 실패 시 골드 발행을 중단하는 장치가 없습니다. |
| G-TR-5 | 도구별로 파편화된 시맨틱 정의 (#86) | 비즈니스 메트릭(사용자 활동, 주문 금액 등)이 Flink SQL, Superset 차트 설정, 분석가 SQL에 제각각 중복 작성되어 있습니다. |
| G-TR-6 | 다중 엔진 간 시맨틱 일관성 결여 (#86) | DuckDB, Trino, Superset에서 실행된 쿼리가 동일한 시맨틱 모델을 공유하지 못해 동일 메트릭에 대해 상이한 수치가 산출될 위험이 있습니다. |
| G-TR-7 | 메트릭 거버넌스 및 공인 라이프사이클 부재 (#86) | 메트릭에 대한 공식 소유자, 버전, 신선도 SLA, 사용 중단(deprecated) 상태 및 접근 권한 경계가 정의되어 있지 않습니다. |

---

## 4. 실버/골드 변환 프레임워크 및 엔진 선정 (이슈 #72)

### 4.1 변환 라이프사이클 및 레이어별 역할

[`medallion-architecture-ko.md`](medallion-architecture-ko.md) 2, 5, 6절에 따른 레이어 간 흐름:

```
[브론즈: 불변 원본]
         |
         |---> (실버 변환: 스키마 정합, 중복 제거, 유효성 검증, 타입 캐스팅)
         v
[실버: 원천 단위의 정제된 엔티티]
         |
         |---> (골드 변환: 차원 모델링, 집계 집성, 비즈니스 메트릭 산출)
         v
[골드: 거버넌스 데이터 프로덕트]
```

1. **브론즈에서 실버로의 변환**:
   - 브론즈 Iceberg 테이블에서 원본 레코드(`_raw`, `_source_ref`, `_ingest_ts`)를 읽습니다.
   - 페이로드를 파싱하고 엄격한 스키마 타입을 적용하며 기본키 검증 및 지연 도착 레코드 중복 제거를 수행합니다.
   - 유효성 검사 또는 비즈니스 키 제약에 실패한 레코드는 `<silver_table>_quarantine`으로 격리합니다.
   - 결과: 각 엔티티의 검증되고 비집계된 표준 레코드 생성(`silver_shop.customers`, `silver_shop.orders`).
2. **실버에서 골드로의 변환**:
   - 하나 이상의 정제된 실버 테이블을 결합합니다.
   - 차원 조인, 비즈니스 롤업, 윈도우 집계 및 메트릭 계산을 적용합니다.
   - 발행 전 품질 게이트를 강제합니다. 품질 검사가 실패하면 트랜잭션이 롤백되고 이전 골드 스냅샷이 그대로 유지됩니다(`medallion-architecture.md:170-172`).
   - 결과: 조회에 최적화된 비즈니스 데이터 마트 생성(`gold_shop.daily_revenue`, `gold_web.user_activity_1m`).

### 4.2 엔진 선정 의사결정 매트릭스

플랫폼은 기술적 기준에 따라 5개 실행 엔진을 평가합니다. 본 표는 일방적 결론이 아니라 기술 기준과 저장소의 현 상태를 객관적으로 기록합니다:

| 엔진 | 실행 모델 | 핵심 적합 영역 | 확장성 및 셔플 한계 | 지연시간 프로파일 | 리소스 점유 특성 | 라이선스 (OSI 허용) | 현재 저장소 상태 |
|---|---|---|---|---|---|---|---|
| **Apache Flink SQL** | 연속 스트리밍 및 마이크로배치 | 연속 스트림→실버 적재, 이벤트 시간 윈도우 연산, 1분 미만 지연 | 상태 기반 스트리밍 특화; 대규모 다자간 과거 이력 배치 셔플 시 RocksDB 상태 튜닝 부담 | 초 단위 ~ 1분 미만 (`cdc_customers.sql:2` 30초 체크포인트) | 상시 구동 클러스터 (`flink-cluster` JobManager + TaskManager; ~2–4 GiB RAM) | **Apache-2.0** (`VERSIONS.md:34`) | **배포 및 활성** (`files/flink-sql/*.sql`) |
| **Trino SQL** | 분산 MPP 대화형 및 배치 SQL | 공유 페더레이션 쿼리, BI 대시보드 가속(Superset), Iceberg 대상 스케줄 배치 SQL | 메모리 기반 분산 셔플; 클러스터 메모리를 초과하는 대규모 조인 시 디스크 스필 또는 실패 | 수 초 ~ 수 분 | 상시 구동 JVM 코디네이터 및 워커 (`06-trino.yaml`; ~4–8 GiB RAM) | **Apache-2.0** (`VERSIONS.md:35`) | **배포 및 활성** (`06-trino.yaml`, `iceberg_maintenance.py`) |
| **DuckDB** | 인프로세스 컬럼형 OLAP 엔진 | 로컬 임시 분석, 임베디드 CI 검증, 단일 노드 소/중규모 배치 ETL/ELT | 단일 노드 전용 (멀티스레드, 디스크 스필링); 다중 K8s 노드로 수평 분산 불가 | 1초 미만 ~ 수 초 | 임베디드 프로세스; 유휴 클러스터 데몬 비용 0 | **MIT** (`docs/adr/0004...:46`) | **ADR-0004로 채택**; 클라이언트 라이브러리 패턴 |
| **Apache Spark** | 분산 드라이버/익스큐터 배치 처리 | 초대형 배치 셔플 (>100 GB/배치), 복잡한 반복 알고리즘, 분산 PySpark ML/그래프 파이프라인 | 디스크 기반 고복원력 셔플; Trino 메모리 한계를 넘는 수 테라바이트 처리 적합 | 수 분 ~ 수 시간 | 무거운 드라이버 및 익스큐터 파드; 높은 메모리/CPU 요구 | **Apache-2.0** (공식 Apache License 2.0) | **이슈 #96 평가 대상**; 미배포 |
| **dbt Core** | SQL 변환 모델링 및 DAG 오케스트레이터 | 선언적 SQL 모델링, Jinja 템플릿, 자동화된 테스트 및 의존성 DAG 관리 | SQL로 컴파일됨; 연산 확장성은 대상 엔진(Trino 또는 DuckDB)에 전적으로 의존 | 대상 엔진에 종속 | 경량 CLI / 컨테이너 (실행당 ~256 MiB RAM); 일회성 실행 | **Apache-2.0** (dbt Core Apache-2.0) | **이슈 #95 평가 대상**; 미배포 |

#### 4.2.1 워크로드별 엔진 선택 가이드라인

```
워크로드 요구사항 판별:
├── 1분 미만의 초저지연 또는 이벤트 시간 스트림 윈도우가 필요한가?
│   └── 예 ──> Apache Flink SQL 선택
│
├── 로컬 실행, CI 테스트 검증, 또는 JVM 없는 경량 소규모 ETL인가?
│   └── 예 ──> DuckDB 선택 (ADR-0004 준수)
│
├── 대규모 분산 셔플 (>100 GB) 또는 복잡한 PySpark ML/그래프 작업인가?
│   └── 예 ──> Apache Spark on K8s 선택 (온디맨드 잡, 이슈 #96)
│
└── Iceberg 대상 표준 분석용 실버/골드 배치 변환인가?
    ├── 선언적 SQL 모델링 및 테스트 프레임워크 ──> dbt Core (이슈 #95)
    └── 실제 연산 실행 백엔드 ───────────────────> Trino SQL (Airflow 오케스트레이션)
```

**지양해야 할 안티패턴**:
1. *Trino에서의 스트리밍 ETL*: Trino는 실시간 레코드 단위 스트리밍용이 아닙니다. 지속적인 스트림 처리는 Flink에 남겨두어야 합니다.
2. *소형 프로파일에서의 상시 Spark 클러스터*: 소규모/개발 환경에서 Spark 클러스터를 상시 띄워두는 것은 메모리 낭비입니다. Spark 도입 시 반드시 온디맨드 일회성 잡(`SparkApplication` 또는 Airflow `spark-submit`)으로 실행해야 합니다.
3. *대규모 분산 데이터셋에 대한 단일 노드 DuckDB 강제*: DuckDB는 노드 간 수평 확장이 불가하므로 단일 노드 용량을 초과하는 워크로드는 Trino나 Spark로 넘겨야 합니다.

### 4.3 멱등성, 백필 및 스냅샷 리니지 추적

모든 배치 실버 및 골드 변환은 결정론적 멱등성을 보장해야 합니다:
- **쓰기 시맨틱**:
  - 실버 엔티티 테이블은 비즈니스 식별자를 기준으로 Iceberg `MERGE INTO`를 사용합니다.
  - 골드 집계 테이블은 일자/윈도우 파티션 단위 원자적 교체(`INSERT OVERWRITE`)를 사용합니다.
- **변환 메타데이터 열 (제안)**:
  모든 실버 및 골드 테이블은 표준 변환 추적 열을 갖추어야 합니다:

| 열 이름 | 타입 | 설명 |
|---|---|---|
| `_transform_id` | `STRING` | 변환 실행 배치의 고유 UUID. |
| `_transform_engine` | `STRING` | 변환을 실행한 엔진 (`trino`, `flink`, `duckdb`, `spark`). |
| `_code_version` | `STRING` | 변환 SQL 또는 모델 코드의 Git 커밋 SHA. |
| `_input_snapshots` | `STRING` | 본 실행이 참조한 원천 Iceberg 테이블 스냅샷 ID 목록 (쉼표 구분). |
| `_transformed_at` | `TIMESTAMP(6)` | 변환 작업이 완료된 UTC 타임스탬프. |

### 4.4 발행 품질 게이트

실버 테이블이 승격되거나 골드 데이터셋이 조회용으로 외부에 공개되기 전, 자동화된 품질 게이트가 실행됩니다([`data-quality-framework-ko.md`](data-quality-framework-ko.md) 및 [`medallion-architecture-ko.md:163-173`](medallion-architecture-ko.md) 준수):
- **발행 전 검증 항목**:
  1. 기본키 고유성 및 not-null 단언 (`완전성 = 100%`).
  2. 선언된 외래키 간 참조 무결성.
  3. 비즈니스 메트릭 유효 범위 (음수 금액 검출, 상태 코드 유효성).
  4. 이상 볼륨 감지 (예상 레코드 수 범위 내 존재 여부).
- **게이트 강제 방식**:
  - 검증 통과 시: 해당 Iceberg 스냅샷 커밋이 정상 발행 처리됩니다.
  - 임계 품질 검사 실패 시: 트랜잭션이 롤백되거나 후보 스냅샷이 만료 처리되며, OpenMetadata에 인시던트가 등록되고 하류 BI 조회의 기준 스냅샷은 직전 유효 스냅샷으로 유지됩니다.

---

## 5. 거버넌스 기반 시맨틱 레이어 아키텍처 (이슈 #86)

### 5.1 시맨틱 모델링 기본 요소

시맨틱 레이어는 비즈니스 정의를 중앙에서 단 한 번 정의하여 BI, DuckDB, Trino, AI 클라이언트 간 계산 불일치를 원천 차단합니다:
- **엔티티 (Entities)**: 고유 기본키를 갖는 비즈니스 대상 (예: `Customer`, `Order`).
- **차원 (Dimensions)**: 그룹화 및 필터링에 사용되는 범주형 또는 시간 속성 (예: `order_date`, `customer_city`, `product_category`).
- **측정값 / 메트릭 (Measures / Metrics)**: 차원 위에서 평가되는 집계 값:
  - 가산적 (Additive): `SUM(total_amount)`, `COUNT(order_id)`.
  - 준가산적 / 비가산적 (Non-additive): `COUNT(DISTINCT customer_id)`, `AVG(duration_ms)`.
  - 파생 / 복합 (Derived): `total_revenue / count_orders` (평균 주문 금액).
- **조인 경로 (Join Paths)**: 엔티티 간의 명시적 방향성 관계 (예: `Order` → `Customer` on `customer_id`)를 사전에 정의하여 모호한 조인, chasm trap 및 fan-out 연산 오류를 방지합니다.
- **메트릭 공인(Certification) 라이프사이클**:
  - `Draft (초안)`: 개발 중인 제안 상태.
  - `In Review (검토 중)`: 도메인 스튜어드가 적합성을 검토 중인 상태.
  - `Certified (공인됨)`: 소유자, 신선도 SLA, 품질 상태를 갖춘 단일 진실 원천으로 승인된 상태.
  - `Deprecated (사용 중단)`: 후속 대체 경로가 제시되고 폐기 예정으로 표시된 상태.

### 5.2 시맨틱 레이어 기술 후보 비교

Beluga는 오픈소스 및 OSI 허용 라이선스를 만족하는 세 가지 시맨틱 아키텍처 대안을 비교 평가합니다:

| 평가 항목 | 대안 A: Trino 거버넌스 뷰 및 머티리얼라이즈드 뷰 | 대안 B: Cube Core (범용 시맨틱 레이어) | 대안 C: dbt Semantic Layer / MetricFlow |
|---|---|---|---|
| **라이선스** | **Apache-2.0** (`VERSIONS.md:35`) | **Apache-2.0 / MIT** (`LICENSE` 실측) | **Apache-2.0** (2025년 10월 오픈소스화, `LICENSE` 실측) |
| **아키텍처 모델** | 데이터베이스 네이티브 SQL 뷰 및 Iceberg 머티리얼라이즈드 뷰 | 코드 기반(YAML/JS/Python) 모델링의 독립 시맨틱 서비스 | dbt 프로젝트 YAML에 선언된 라이브러리 컴파일 모델 |
| **쿼리 인터페이스** | 표준 Trino SQL (Superset, JDBC/ODBC, CLI에서 조회) | **SQL API** (PostgreSQL 와이어 프로토콜), REST API, GraphQL API | MetricFlow CLI, Python API, dbt Semantic Layer JDBC |
| **엔진 변환** | Trino 네이티브 엔진 단독 실행 | 시맨틱 쿼리를 네이티브 SQL로 변환하여 Trino로 푸시다운 | 기저 대상 엔진(Trino 또는 DuckDB)에 맞는 네이티브 SQL 생성 |
| **캐싱 / 사전 집계** | Trino Iceberg 머티리얼라이즈드 뷰 (`REFRESH MATERIALIZED VIEW`) | 멀티레벨 캐시를 갖춘 내장 사전 집계(Pre-aggregations) 엔진 | dbt 프로젝트 내 집계 테이블 모델링 |
| **신규 인프라** | **신규 컴포넌트 0개** (기존 Trino 클러스터 재사용) | Cube 서비스 신규 배포 필요 (Node.js 런타임 및 캐시) | dbt Core 도입 필요 (#95) |
| **동적 슬라이싱** | 뷰별 고정 프로젝션; 복잡한 드릴다운 시 신규 뷰 정의 필요 | 완전 동적 다차원 슬라이싱, 메트릭 드릴다운 및 필터링 지원 | 완전 동적 차원 메트릭 쿼리 지원 |

#### 5.2.1 단계별 구현 평가

1. **1단계 (즉시 적용 기준선)**: **Trino 거버넌스 뷰 및 머티리얼라이즈드 뷰**.
   - 골드 네임스페이스 내에 공인 메트릭을 Trino 뷰로 구현(`gold_shop.view_daily_revenue`).
   - 머티리얼라이즈드 뷰는 Iceberg 스토리지(`CREATE MATERIALIZED VIEW`, Lakekeeper 관리 하의 Iceberg 테이블로 저장)를 활용하며, Airflow 작업(`REFRESH MATERIALIZED VIEW`)을 통해 주기적으로 갱신.
   - 장점: 추가 클러스터 리소스 소모가 전혀 없고, 기존 OPA 인가 정책(`policies/resources.yaml`)을 그대로 승계하며, Superset에서 즉시 활용 가능.
2. **2단계 (확장성 평가)**: **Cube Core (Apache-2.0)**.
   - 네임스페이스 `analytics`에 Cube Core를 거버넌스 서비스로 배포.
   - Cube의 PostgreSQL 호환 SQL API(`:5432`)를 Superset 및 DuckDB에 노출하고 무거운 쿼리는 Trino로 푸시다운.
   - 장점: 코드 기반 YAML 모델과 사전 집계 가속을 통해 다중 클라이언트(REST, GraphQL, AI 에이전트)에 걸쳐 비즈니스 정의를 완벽히 단일화.

### 5.3 시맨틱 접근 제어 및 카탈로그 리니지 연동

- **접근 권한 강제**:
  - 시맨틱 레이어는 기저 보안 정책을 절대 우회할 수 없습니다.
  - Trino 뷰를 통한 조회는 Trino OPA Rego 규칙(`policies/resources.yaml`)을 강제 적용받으며, `pii`로 분류된 열은 역할(`analysts` 대 `engineers`)에 따라 마스킹되거나 차단됩니다.
  - 2단계에서 Cube Core를 도입할 경우, 인증된 Keycloak 사용자 식별자가 Trino 세션 속성으로 전달되어 쿼리 시점에 OPA 정책이 엄격히 적용되어야 합니다.
- **카탈로그 및 리니지 연동**:
  - 모든 공인 메트릭은 OpenMetadata 1.13.3(`11-openmetadata.yaml:1-348`)에 공인 비즈니스 용어 및 메트릭 자산으로 등록됩니다.
  - 엔드투엔드 리니지를 통해 시맨틱 메트릭이 기반 골드 Iceberg 테이블, 실버 엔티티 테이블 및 브론즈 원본 좌표로 역추적될 수 있어야 합니다.

---

## 6. 검증 및 테스트 아이디어

### 6.1 테스트 1: 엔진 간 쿼리 일관성 검증 (Trino 대 DuckDB)
- **목표**: 동일한 Iceberg 골드 스냅샷을 조회할 때 Trino와 DuckDB가 완전히 동일한 메트릭 결과를 산출하는지 확인.
- **방법**: `lakekeeper.lake.events_enriched` 대상 집계 쿼리를 작성하여, Trino SQL과 DuckDB(`ATTACH ... (TYPE ICEBERG)`)에서 각각 실행.
- **기대 결과**: 지정된 시간 범위 내 `user_id`, `event_count`, `total_duration_ms` 수치가 100% 동일하게 일치.

### 6.2 테스트 2: 멱등한 배치 백필 테스트
- **목표**: 실버/골드 변환 작업을 재실행해도 중복 레코드가 발생하지 않음을 검증.
- **방법**: 가상의 실버 데이터셋에 대해 Airflow 배치 머지 작업을 실행한 후, 동일 입력 스냅샷 ID로 잡을 재실행.
- **기대 결과**: 대상 Iceberg 테이블의 총 레코드 수가 증가하지 않고 기존 키가 멱등하게 갱신됨.

### 6.3 테스트 3: 발행 전 품질 게이트 차단 검증
- **목표**: 품질 기준에 미달하는 변환 결과물이 골드로 발행되지 않도록 차단하는지 확인.
- **방법**: 핵심 비즈니스 메트릭에 null 값이 유입되도록 조작된 가상 골드 빌드 작업 실행.
- **기대 결과**: 발행 게이트가 위반을 감지하고 Iceberg 트랜잭션을 롤백하여 경보를 남기며, 소비자는 기존 골드 스냅샷을 계속 조회.

### 6.4 테스트 4: 시맨틱 PII 마스킹 보호 검증
- **목표**: 시맨틱 메트릭 뷰가 비인가 역할에 원본 PII를 노출하지 않는지 확인.
- **방법**: 고객 속성이 포함된 거버넌스 시맨틱 뷰를 `analysts` 역할 계정으로 조회.
- **기대 결과**: 비PII 측정값은 정상 반환되나, 민감 PII 열(`name`, `email`)은 `policies/resources.yaml`에 따라 마스킹 처리되어 반환됨.

---

## 7. 소유자 미결 결정 사항

| 결정 ID | 항목 | 검토된 대안 | 권고안 | 권고 근거 |
|---|---|---|---|---|
| **OD-TR-1** | 배치 변환 모델링 표준 | (A) Airflow에서 직접 Trino SQL 스크립트 실행<br>(B) Airflow가 dbt Core 모델을 오케스트레이션 (#95) | **대안 B: dbt Core 모델링 + Trino 연산** | dbt의 모듈형 Jinja SQL, 자동 스키마 테스트, DAG 의존성 관리 및 Git 형상 관리가 우수함. |
| **OD-TR-2** | Spark 도입 범위 (#96) | (A) 상시 가동 Spark 클러스터 배포<br>(B) 온디맨드 일회성 Spark-on-K8s 파드만 허용<br>(C) Spark 도입 전면 보류 | **대안 B: 온디맨드 일회성 잡만 허용** | 소규모 프로파일의 리소스 낭비를 막으면서 Trino 메모리를 초과하는 대규모 셔플에 대응할 수 있음. |
| **OD-TR-3** | 시맨틱 레이어 엔진 선정 (#86) | (A) Trino 거버넌스 뷰 및 머티리얼라이즈드 뷰 (1단계)<br>(B) Cube Core 전용 서비스 도입 (2단계)<br>(C) dbt Semantic Layer / MetricFlow | **1단계 A 도입, 2단계 B 검토** | 1단계는 클러스터 오버헤드가 전혀 없으며, 향후 다중 프로토콜(REST/AI/BI) 수요 시 Cube를 검토함. |
| **OD-TR-4** | 메트릭 공인(Certification) 주체 | (A) 데이터 엔지니어링 팀 단독<br>(B) 도메인 프로덕트 오너 + 거버넌스 스튜어드 공동 서명 | **대안 B: 공동 서명** | 비즈니스 정의의 일치성과 플랫폼 거버넌스 규칙 준수를 동시에 담보할 수 있음. |
| **OD-TR-5** | 시맨틱 사전 집계 저장 백엔드 | (A) Lakekeeper 관리 하의 표준 Iceberg 골드 테이블<br>(B) 엔진 자체 독점 캐시 스토리지 | **대안 A: Iceberg 골드 테이블** | 모든 소비 엔진과 카탈로그 도구에서 단일 원천 데이터로 조회 가능하도록 보장함. |

---

## 8. 후속 구현 과제 (단계별)

1. **과제 1: 데이터 표준에 변환 메타데이터 규격 반영**
   - `policies/data-standards.yaml`에 필수 변환 추적 열(`_transform_id`, `_code_version`, `_input_snapshots`) 규격 추가.
   - *인수 테스트 아이디어*: 신규 실버/골드 테이블 정의에 필수 메타데이터 열이 누락된 경우 CI 정적 검사가 실패함을 확인.
2. **과제 2: 배치 실버 업서트 참조 Airflow DAG 작성**
   - 브론즈 레코드를 읽어 실버 테이블로 멱등하게 `MERGE INTO`하는 Trino SQL 실행 Airflow DAG 개발.
   - *인수 테스트 아이디어*: 연속 2회 실행 후 기본키 중복 건수가 0건임을 단언.
3. **과제 3: Trino 거버넌스 메트릭 뷰 프로토타입 작성**
   - 골드 네임스페이스에 열 레벨 코멘트와 OPA 분류 태그가 적용된 대표 메트릭 뷰(`gold_shop.view_customer_order_summary`) 생성.
   - *인수 테스트 아이디어*: Trino 및 Superset에서 쿼리 성공 확인 및 `analysts` 조회 시 마스킹 검증.
4. **과제 4: Trino 및 DuckDB 대상 dbt Core PoC 구축 (#95)**
   - 실버 1개, 골드 1개 모델을 포함하는 프로토타입 dbt 프로젝트를 생성하여 Trino 및 로컬 DuckDB 대상 테스트.
   - *인수 테스트 아이디어*: `dbt run` 및 `dbt test`가 Lakekeeper 관리 Iceberg 테이블을 대상으로 성공 완료됨을 확인.

---

## 9. 참고 문헌

### 9.1 외부 공식 문서 및 규격
- [S1] Stichting DuckDB Foundation, *DuckDB Documentation and Iceberg Extension*, https://duckdb.org/docs/current/core_extensions/iceberg/overview (2026-10-07 열람). MIT 라이선스.
- [S2] Trino Software Foundation, *Trino Documentation: Iceberg Connector & Materialized Views*, https://trino.io/docs/current/connector/iceberg.html (2026-10-08 열람). Apache License 2.0.
- [S3] Cube Dev, Inc., *Cube Documentation & Architecture*, https://cube.dev/docs (2026-10-08 열람); *Cube License*, https://raw.githubusercontent.com/cube-js/cube/master/LICENSE (2026-10-08 열람). Apache License 2.0 / MIT.
- [S4] dbt Labs, *MetricFlow License & Documentation*, https://raw.githubusercontent.com/dbt-labs/metricflow/main/LICENSE (2026-10-08 열람). Apache License 2.0.
- [S5] Apache Spark, *Apache Spark Documentation*, https://spark.apache.org/docs/latest/ (2026-10-08 열람). Apache License 2.0.
- [S6] Databricks, *What is the medallion lakehouse architecture?*, https://docs.databricks.com/aws/en/lakehouse/medallion (2026-10-07 열람).

### 9.2 저장소 원천 (커밋 `d424c38` 기준 실측)
- Flink SQL 스트리밍 잡: `gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`, `events_sessionization.sql:1-62`.
- Trino 배포: `gitops/charts/beluga-data/templates/06-trino.yaml:1-120`.
- Airflow 배포 및 DAG: `gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`, `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`.
- Superset Trino 연결: `gitops/charts/beluga-data/templates/15-superset-import.yaml:150-180`.
- DuckDB 아키텍처 결정: `docs/adr/0004-duckdb-complementary-analytics-engine-ko.md:1-226`.
- 데이터 표준 및 거버넌스: `policies/data-standards.yaml:1-117`.
- 컴포넌트 버전: `VERSIONS.md:1-60`.

### 9.3 라이브 클러스터 검증 (2026-10-08 실측)
- kubeconfig `/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`를 통해 Trino(`trino-coordinator`, `trino-worker`), Flink(`flink-cluster`, taskmanagers), Airflow(`airflow-webserver`), Lakekeeper(`lakekeeper`), Superset(`superset`) 파드의 정상 실행 상태 확인.
- *라이브 미검증 항목*: K8s 상에서의 실제 Spark 잡 실행(Spark 미프로비저닝), 실제 Cube Core 서비스 배포, 고동시성 부하 환경에서의 엔진 간 벤치마크 성능 수치.
