# 메달리온 레이크하우스 아키텍처 (Bronze / Silver / Gold)

[English](medallion-architecture.md) | 한국어

상태: **오너 검토용 설계 제안** (Issue #70). 설계 문서이며 매니페스트, 파이프라인, 정책, 카탈로그 변경은
포함하지 않는다. 현재 플랫폼에 대한 서술은 작성 시점의 저장소 기준으로 확인한 사실이고, **제안**으로
표시한 항목은 구현되지 않았다.

이슈에 기록된 오너 결정: *Databricks가 설명하는 메달리온 아키텍처를 확정한 뒤 이를 정의한다.* 따라서
1절은 Databricks가 실제로 말한 내용만 기록하고, 2절부터는 Beluga의 적용(adaptation)이며 둘을 섞지
않도록 분리했다.

## 1. Databricks가 말하는 내용

출처: [What is the medallion lakehouse architecture?](https://docs.databricks.com/aws/en/lakehouse/medallion)
(Databricks 문서, 2026-10-07 열람). 해당 페이지에 있는 내용만 Databricks의 주장으로 귀속한다.

**정의.** 레이크하우스에 저장된 데이터의 품질을 나타내는 일련의 데이터 계층("a series of data layers that
denote the quality of data stored in the lakehouse")이며 데이터를 논리적으로 조직하는 설계 패턴이다. 각
계층을 지나며 데이터의 구조와 품질을 점진적으로 개선하는 것이 목적이다. multi-hop 아키텍처라고도 한다.

**엄격한 규칙이 아닌 논리적 가이드.** "권장되는 모범 사례이지만 필수 요건은 아니다"(원문: "a recommended best
practice but not a requirement").

| | Bronze | Silver | Gold |
|---|---|---|---|
| 목적 / 데이터 상태 | 검증되지 않은 원시 데이터. 원천의 원래 형식 그대로의 상태 유지 | 검증, 정제, 보강된 데이터 | 소비 준비 완료. 분석, 대시보드, ML, 애플리케이션을 위한 고도로 정제된 뷰 |
| 대표 작업 | 점진적 append, 최소한의 검증, 출처 추적용 메타데이터 컬럼(예: 원천 파일명) 추가 | 스키마 강제, null/누락 처리, 중복 제거, 순서 뒤바뀜/지연 도착 데이터 해소, 품질 검사, 스키마 진화, 타입 변환, 조인, 반정형 데이터 모델링 | 차원 모델링과 집계, 도메인 비즈니스 로직, 집계 머티리얼라이즈, 성능 최적화 |
| 입력 | 객체 스토리지, 메시지 버스(예: Kafka), 연합 시스템의 스트리밍/배치 | 하나 이상의 Bronze 또는 Silver 테이블을 읽어 Silver 테이블에 기록 | 분석과 리포팅에 맞춘 집계 데이터 |
| 명시된 소비자 | 데이터 엔지니어, 데이터 운영, 컴플라이언스/감사 | 데이터 엔지니어, 데이터 분석가, 데이터 사이언티스트 | 비즈니스 분석가와 BI 개발자, 데이터 사이언티스트와 ML 엔지니어, 경영진, 운영 팀 |

페이지에 있는 추가 사항:

- Bronze는 "데이터 충실도를 보존하는 단일 진실 원천"이며 "모든 이력을 보존하여 재처리와 감사를 가능하게
  한다".
- Bronze 주의: 여기서는 정제와 검증을 제한한다. 예기치 않은 스키마 변경으로 데이터가 유실되지 않도록 대부분의
  필드를 string, VARIANT, binary로 저장하라고 권고한다 (VARIANT는 Databricks 타입이며 Iceberg에서의 결정은
  3절 참조).
- Silver는 "각 레코드의 검증된 비집계 표현을 항상 최소 하나 포함해야 한다".
- Silver 주의: 수집(ingestion)에서 Silver로 직접 쓰는 것은 권장하지 않는다. 스키마 변경이나 손상된 원천
  레코드로 실패가 발생하기 때문이며, Silver는 Bronze(또는 다른 Silver)에서 만든다.
- Gold는 자주 조회되므로 성능 최적화가 모범 사례이고, 대량의 과거 이력은 보통 Gold에 머티리얼라이즈하지 않고
  Silver에서 조회한다. 일부 고객은 업무 영역별(페이지는 HR, 재무, IT를 예로 듦)로 Gold를 여러 개 둔다.
- 페이지는 계층을 품질의 표지(Bronze 원시, Silver 검증, Gold 보강)로 설명하며, 계층별 검증과 변환 과정에서
  원자성, 일관성, 격리성, 지속성(ACID)을 보장한다고 서술한다. 이는 Delta 기반 Databricks 구현의 속성이다.
  Beluga는 테이블 단위 동등 속성을 Iceberg 커밋에 의존하며 계층 간 트랜잭션은 주장하지 않는다.
- 수집 주기(연속/트리거/배치)는 비용과 지연의 트레이드오프이다.

**페이지에 없는 내용 (Databricks에 귀속하지 않음):** 네임스페이스 명명, 보존 기간, PII 처리, 격리(quarantine)
테이블, 접근 제어 롤, 리니지 메커니즘, 엔진 배분. 이들은 3~9절의 Beluga 결정 사항이다.

## 2. Beluga 계층 정의 (제안)

계층은 논리적 구분이며 Lakekeeper 카탈로그의 Iceberg 네임스페이스로 표현한다. 별도 제품이 아니며, 세 단계를
모두 거칠 필요가 없는 데이터셋은 기록된 결정으로만 단계를 건너뛸 수 있다(질문 Q4).

| 계층 | Beluga 정의 | 쓰기 방식 | 소유자 | 주요 독자 |
|---|---|---|---|---|
| Bronze | 변경 불가, append 전용의 원천 충실도 + 수집 메타데이터. 원천에 다시 접속하지 않고 Silver를 재구축할 수 있는 수준 | append만 허용. 갱신/삭제 불가(통제된 purge 제외, 6절) | 플랫폼/데이터 엔지니어링(수집 파이프라인 소유자) | 데이터 엔지니어, 감사. 분석가는 제외 |
| Silver | 원천 단위(grain)에서 검증, 타입 정리, 중복 제거, 정합화된 현재 상태(필요 시 이력) 레코드. 비집계 표현 최소 1개 | 비즈니스 키 기준 upsert/merge. Bronze 또는 Silver로부터만 생성 | 도메인 데이터 엔지니어링 | 엔지니어. 정책이 허용하는 비민감 Silver는 분석가 |
| Gold | 비즈니스용 데이터 제품: 집계, 차원 마트, 피처 테이블. 각각 지정된 소유자와 소비자 보유 | Silver(또는 Gold)로부터 재구축 또는 증분 유지 | 데이터 제품 소유자 | 분석가, BI(Superset), 데이터 사이언스, DuckDB/Trino 사용자 |

엔진과 카탈로그는 변하지 않는다. **Lakekeeper가 거버넌스하는 Iceberg 테이블이 계층의 기반으로 유지**되고,
Trino, Superset, Airflow는 소비하며 Flink는 스트리밍 쓰기 엔진으로 유지된다.

## 3. Lakekeeper 네임스페이스와 테이블 명명 (제안)

[data-standards-ko.md](data-standards-ko.md)의 제약을 따른다: 소문자 `snake_case`, `_id`/`_at` 접미사 의미,
SQL 예약어 금지.

- **웨어하우스.** 기존 단일 웨어하우스 `lake`(버킷 `beluga-lake`)를 유지하고 계층은 그 안의 네임스페이스로
  둔다. 계층별 웨어하우스는 스토리지 경계가 더 강하지만 부트스트랩 범위가 두 배가 된다(Q2).
- **네임스페이스:** `<layer>_<domain>`, 예: `bronze_shop`, `silver_shop`, `gold_shop`, `gold_web`.
  `<layer>`는 `bronze`/`silver`/`gold`, `<domain>`은 원천 시스템 또는 비즈니스 도메인.
- **테이블:** Bronze는 원천 객체와 수집 방식 이름(`cdc_customers`, `clickstream_events`,
  `file_manifest_<class>`), Silver는 엔티티(`customers`, `orders`), Gold는 비즈니스 의미
  (`daily_orders_by_status`, `user_activity_1m`).
- **격리(quarantine):** Silver 네임스페이스의 `<silver_table>_quarantine`. 검증 실패 레코드에 PII가 있을 수
  있으므로 원천 Bronze와 같은 접근 등급을 적용한다.
- **파티셔닝 지침(출발점, #65 벤치마크로 검증):** Bronze는 수집일(`day(_ingest_ts)`), Silver는 테이블이
  충분히 클 때 주된 비즈니스 시간 컬럼, 그렇지 않으면 비파티션, Gold는 주된 대시보드 필터. 파일 크기나
  파티션 수 같은 수치는 여기서 정하지 않는다.
- **Bronze 메타데이터 컬럼(제안):** `_ingest_ts`, `_source_system`, `_source_ref`(Kafka
  topic/partition/offset, 파일 경로+체크섬, API 요청 id), `_batch_id`, 가공하지 않은 페이로드(`_raw`: string
  또는 binary). 현재 테이블은 variant 타입이 없는 Iceberg `format-version` 2를 쓰므로 string/binary가
  이식성 있는 선택이며, 조기 타입 지정을 피하라는 Databricks 권고와도 부합한다.
- **레지스트리:** 모든 계층의 모든 테이블은 `policies/data-standards.yaml`이 이미 요구하는 메타데이터(owner,
  classification, description, retention, freshness)를 갖는다. 계층은 네임스페이스로 알 수 있다.
- 기존 `lake` 네임스페이스는 레거시이며 이전 결정은 4절(Q1)을 따른다.

## 4. Beluga의 현재 상태 (확인됨)

현재 영속 Iceberg 테이블은 모두 웨어하우스 `lake`의 네임스페이스 `lake`에 있다
(`gitops/charts/beluga-data/files/flink-sql/*.sql`, `policies/resources.yaml`).

| 테이블 | 생성 | 입력 | 솔직한 계층 분류 |
|---|---|---|---|
| `lake.customers` | `cdc_customers.sql` (Flink) | Kafka 토픽 `cdc.shop.public.customers` (PostgreSQL Debezium JSON) | **Silver에 가까움.** 타입 변환(문자열 시각을 `TIMESTAMP(3)`로), 키 기반 upsert(`write.upsert.enabled`), 현재 상태만 보관. 스트림에서 바로 기록되어 원본 복사본, 격리, 품질 게이트가 없음. 분류 `pii`(email) |
| `lake.orders` | `cdc_orders.sql` (Flink) | Kafka 토픽 `cdc.shop.public.orders` | **Silver에 가까움**, 같은 결함. `total_amount`를 `DECIMAL(10, 2)`로 변환 |
| `lake.events_enriched` | `events_sessionization.sql` (Flink) | Kafka 토픽 `events.clickstream` (JSON) | **Gold에 가까운** 사용자별 1분 윈도 집계이나 스트림에서 직접 생성되어 Bronze/Silver를 건너뜀. Flink는 선언된 5초 워터마크보다 늦은 이벤트를 윈도에서 버릴 수 있고(Flink 이벤트 시간의 일반 동작이며 여기서 테스트하지 않음), 원본 이벤트를 저장하지 않으므로 거버넌스된 데이터로 재구축할 수 없음 |

계층과 관련된 기타 사실:

- **Bronze Iceberg 테이블은 없다.** 유일한 원본 사본은 Kafka 토픽이다. `beluga-data` 템플릿에는 명시적
  토픽 보존 설정이 없다(브로커 기본값 적용, 라이브 클러스터에서는 확인하지 않음). 따라서 Kafka는 거버넌스된
  Bronze가 아니다.
- Trino 카탈로그 이름은 `iceberg`(`dags/iceberg_maintenance.py`의
  `ALTER TABLE iceberg.lake.events_enriched ...`)이며 Superset 데이터셋과 정책은 `lake.*` 이름을 참조한다.
- 세 테이블의 선언된 보존은 `P365D`, 신선도는 `PT5M`(`policies/data-standards.yaml`)이며 data-standards
  문서는 목표 선언이 물리적 강제를 뜻하지 않는다고 명시한다. 발견된 물리적 수명주기 작업은
  `iceberg_maintenance.py`(컴팩션 및 `lake.events_enriched`에 대한 `7d` 임계값의 `expire_snapshots`)뿐이다.
- 인가: 사람의 Trino 접근은 `policies/`에서 컴파일된 OPA Rego로 강제하며 롤은 `analysts`, `engineers`
  (analysts 포함), `admins`(engineers 포함)이다. `12-lakekeeper-bootstrap.yaml`이 시드하는 Lakekeeper
  OpenFGA 할당은 서비스 계정 `service-account-trino`, `service-account-flink`에 대한 웨어하우스 수준
  (`describe`, `select`, `create`, `modify`)뿐이다. 웨어하우스 내부의 네임스페이스 수준 격리는 현재 없다.

**이슈 수락 기준 대비 격차**

| 격차 | 현재 |
|---|---|
| 원천 충실도와 재구축 메타데이터를 갖춘 Bronze | 없음 |
| Silver/Gold 게시 전 품질 게이트(#20, #56) | 파이프라인에 없음 |
| 유효하지 않은 레코드 격리 | 없음 |
| 반정형 파일, 비정형 흐름 | 없음(Kafka JSON과 Debezium CDC만 존재) |
| Silver에서 만든 Gold | 없음. 유일한 집계는 Kafka를 읽음 |
| DuckDB 소비 경로(#61-#65) | 검토한 흐름에 포함되지 않음 |
| 계층별 접근/분류/보존 테스트 | 없음. 테이블별 분류는 존재 |
| 종단 간 리니지(#19) | 현재 시연 불가 |

**기존 자산의 제안 매핑 (이 문서에서는 변경하지 않음):**

| 기존 | 목표 |
|---|---|
| Debezium 토픽 `cdc.shop.public.*` | 신규 `bronze_shop.cdc_customers`, `bronze_shop.cdc_orders`의 원천(원본 envelope, before/after, op, ts) |
| `lake.customers`, `lake.orders` | Bronze에서 공급받는 `silver_shop.customers`, `silver_shop.orders`가 됨 |
| `lake.events_enriched` | `bronze_web.clickstream_events`, `silver_web.clickstream_events`를 거쳐 만드는 Gold 제품(`gold_web.user_activity_1m`)이 됨 |

`lake.*` 이름 변경은 `policies/resources.yaml`, 컴파일된 Rego, Superset import, Trino 인가 테스트에 영향을
주며 `beluga-manager`와의 교차 저장소 접점이다. 따라서 오너 승인 후 별도 이슈로 진행한다(Q1).

## 5. 계층별 규칙 (제안)

### 5.1 스키마 진화

- Bronze: 스키마 관용. 페이로드를 가공하지 않고 보존하며 원천의 추가적 변경이 수집을 멈추게 해서는 안 된다.
  메타데이터 컬럼은 고정이다.
- Silver: 스키마는 계약이다. 추가(nullable 신규 컬럼)는 검토된 변경으로 허용하고, 타입 축소나 이름 변경은
  버전 관리된 변경과 Bronze 기반 백필 문서화가 필요하다. 더 이상 맞지 않는 레코드는 본 테이블이 아니라
  격리 테이블로 보낸다.
- Gold: 스키마는 공개된 인터페이스다. 호환성을 깨는 변경은 새 테이블 이름/버전과 지원 중단 기간이 필요하며
  기간은 오너 결정으로 여기서 정하지 않는다.

### 5.2 품질 게이트

게이트 정의, 규칙 문법, 임계값, 모니터링은 #20과 #56의 범위이며 여기서 만들지 않는다. 이 설계가 그들에게
요구하는 구조적 규칙은 다음과 같다.

- Bronze에서 Silver: 스키마/타입 검증, 키 존재, 중복 제거. 실패는 조용히 버리지 않고 격리 테이블에 기록한다.
- Silver에서 Gold: 게시 대상 기간의 Silver 입력이 게이트를 통과했을 때만 Gold 빌드/갱신을 실행한다. 게이트
  실패는 게시를 막고 이전 Gold 스냅샷을 유지한다.
- 각 게이트 결과(통과/실패, 건수, 실행 id)를 기록하여 리니지 증거(#19)로 제시할 수 있게 한다.

### 5.3 PII와 분류

- 분류(`policies/data-standards.yaml`의 `public`/`internal`/`pii`)는 Bronze에서 부여되어 모든 파생 테이블로
  전파된다. 마스킹, 토큰화, 집계 같은 문서화된 변환이 정당화하지 않는 한 파생 테이블의 분류는 가장 민감한
  입력 컬럼 이상이다.
- Bronze는 가공하지 않은 페이로드를 저장하므로 원시 PII를 보유한다. 엔지니어와 파이프라인 서비스 계정으로
  제한하며 분석가는 Bronze를 읽지 않는다.
- 컬럼 마스킹(현재 `email`)은 `policies/resources.yaml`(`sensitiveColumns`, `allowUnmasked`)과 동일하게
  Silver와 Gold에 적용한다.
- 변경 불가 Bronze에 대한 삭제/파기 요청은 #30이 다룬다(Q5).

### 5.4 보존 훅

계층별 보존 기간은 #18(PII 관련은 #30)이 정의한다. 이 문서는 훅만 정한다. 레지스트리의 테이블별 `retention`
값이 해당 계층의 기준이며, Bronze 보존은 Silver/Gold에 약속한 가장 긴 재구축 기간 이상이어야 하고, 약속된
재구축 기간을 깨는 Bronze purge는 기록된 결정이어야 한다. 수치는 정하지 않는다. Iceberg 스냅샷 만료와
데이터 purge는 별개 작업이며 #18이 둘 다 정의해야 한다.

### 5.5 롤별 접근 (제안, 기존 롤로 표현)

| 계층 | analysts | engineers | admins | 서비스 계정 |
|---|---|---|---|---|
| Bronze | 없음 | select(`allowUnmasked`인 경우 PII 원문) | engineers 경유 전체 | `flink`/수집: create, modify. `trino`: select |
| Silver | 비PII select. PII는 현재처럼 마스킹된 경우만 | select, insert, update, delete | 전체 | 파이프라인 계정이 기록 |
| Gold | select | select 및 소유 파이프라인을 통한 기록 | 전체 | 파이프라인 계정이 기록 |

강제 지점: 사람은 `policies/resources.yaml`에서 컴파일된 Trino OPA Rego(현재 존재), 카탈로그 작업은
Lakekeeper OpenFGA. 현재 OpenFGA는 웨어하우스 수준이므로 Lakekeeper에서 계층 격리를 하려면 네임스페이스
수준 할당 또는 별도 웨어하우스가 필요하다(Q2). 테넌트 격리는 #21이다.

## 6. 리니지, 재처리, 재구축 가능성 (제안)

- **리니지 체인:** 원천 객체, Bronze `_source_ref`/`_batch_id`, Silver 실행 id, Gold 제품 순. 모든
  Silver/Gold 쓰기는 입력 테이블의 스냅샷 id(카탈로그에서 조회 가능한 Iceberg 스냅샷 id)를 기록하여 Gold
  행 집합이 어느 Silver/Bronze 스냅샷에서 왔는지 추적할 수 있게 한다. 도구(OpenMetadata, OpenLineage 발행)는
  #19의 범위이다.
- **재구축 규칙:** Silver와 Gold는 결정적이고 멱등한 작업(비즈니스 키 merge 또는 파티션 덮어쓰기)을 Bronze에
  다시 실행하여 재생성할 수 있어야 한다. 변환은 실행에 기록하지 않은 비거버넌스 상태(현재 시각, 외부 조회)를
  읽어서는 안 된다.
- **변환 실패:** Bronze/Silver 스냅샷에서 Silver 또는 Gold를 다시 실행하며 원천에 다시 접속하지 않는다. 이슈의
  재처리 수락 기준에 해당한다.
- **정정, 지연 데이터, 삭제:** 정정과 지연 도착 레코드는 새로운 Bronze append로 들어오고 Silver가 키와 이벤트
  시간으로 해소한다. 원천 삭제는 Bronze 삭제 이벤트로 캡처하여 Silver에 반영한다(하드 삭제 또는 소프트 삭제
  플래그는 Q6). Flink 이벤트 시간 윈도는 제품별 허용 지연 결정이 필요하며 윈도로 만든 Gold 제품은 Silver에서
  재계산 가능해야 한다.

## 7. 원천 유형과 Bronze 적재 (제안)

| 원천 유형 | Bronze 적재 | Silver 단계 | 예시 흐름 |
|---|---|---|---|
| 관계형 / CDC | Debezium envelope(op, before, after, 원천 ts)을 가공 없이 Flink가 CDC 토픽에서 append | 키 기준 최신 상태 merge, 타입 변환, 검증 | PostgreSQL `public.customers`에서 `bronze_shop.cdc_customers`, `silver_shop.customers` (현재 `lake.customers`는 Bronze 없는 이 Silver 단계) |
| 스트리밍 이벤트 | 수신한 페이로드(string/binary)와 Kafka 좌표 | JSON 파싱, 검증, `event_id` 중복 제거, 타임스탬프 정합화 | `events.clickstream`에서 `bronze_web.clickstream_events`, `silver_web.clickstream_events`, `gold_web.user_activity_1m` |
| 반정형 파일(JSON/CSV/Parquet) | 파일을 객체 스토리지에 원본 그대로 두고, 레코드 또는 파일마다 `_source_ref`(경로, 체크섬)와 원문을 가진 Bronze 행 기록. Parquet은 그대로 등록 가능 | 스키마 추론을 제안하고 확정한 뒤 타입 테이블 생성 | Airflow 작업이 CSV를 적재하고 `bronze_<domain>.<file_class>`에 append |
| API / SaaS 내보내기 | 요청 파라미터와 id를 포함한 요청별 응답 본문 | 반정형과 동일 | 예약된 Airflow 수집 |
| 비정형(문서, 로그, 바이너리) | 객체를 S3(SeaweedFS)에 원본 그대로 저장. Iceberg 매니페스트 테이블 `bronze_<domain>.file_manifest_<class>`에 경로, 크기, 체크섬, 콘텐츠 유형, 수집 메타데이터 기록 | 추출 작업(텍스트, 파싱 필드, 로그 라인 파싱)이 매니페스트 행을 참조하는 Silver 테이블 작성 | 로그 아카이브 또는 PDF 모음: Bronze에 매니페스트, Silver에 파싱 레코드 |

이들은 #70 수락 기준에서 시연할 흐름이며 구현된 것은 없다. 비정형 바이너리는 테이블 행에 넣지 않고
거버넌스된 메타데이터만 넣으며 버킷 prefix 수준 정책 설계는 Q3이다.

## 8. 어떤 엔진이 어떤 변환을 수행하는가 (제안)

| 작업 | 엔진 | 이유 |
|---|---|---|
| Bronze로의 연속 수집, 스트림에서의 저지연 Silver | Flink | 이미 스트리밍 쓰기 엔진이며 체크포인트 커밋 Iceberg 싱크 |
| 예약 배치 Silver/Gold, 백필, 유지보수 | Airflow가 오케스트레이션하는 Trino SQL | 공유되고 OPA로 강제되는 경로. `iceberg_maintenance`가 이미 이 방식 |
| Gold(및 허용된 Silver)의 로컬/애드혹 탐색 | Iceberg를 읽는 DuckDB | #61/#62에 따라 호환성이 허용하는 범위 |
| 공유 BI와 연합 쿼리 | Trino(Superset) | 기존 구성. #63 라우팅의 폴백 대상 |

DuckDB도 동일한 카탈로그 인가를 거쳐서만 읽어야 하며 정책은 #63이다.

## 9. 비목표와 오너에게 묻는 질문

**이 문서의 비목표:** 파이프라인, 네임스페이스, 정책 구현. 품질 규칙 문법과 임계값(#20, #56). 보존
기간(#18, #30). 리니지 도구(#19). 테넌트 격리 메커니즘(#21). DuckDB 라우팅 규칙과 벤치마크(#61~#65). 기존
테이블 이름 변경. 4번째 계층.

**오너 결정 필요 사항:**

- Q1. 레거시 `lake` 네임스페이스를 계층 네임스페이스로 변경할지(정책 컴파일러와의 교차 저장소 이전), 새 계층을
  나란히 추가하고 `lake`를 나중에 폐기할지?
- Q2. 계층 격리: 단일 `lake` 웨어하우스 안의 네임스페이스와 네임스페이스 수준 OpenFGA 할당인지, 계층별
  웨어하우스(및 버킷 prefix/자격증명)인지?
- Q3. 비정형 객체: 단일 버킷의 prefix별 정책인지, 전용 버킷과 자격증명인지?
- Q4. 데이터셋이 단계를 건너뛸 수 있는가(현재처럼 스트리밍 집계를 바로 Gold로)? 가능하다면 Bronze에서 재구축할
  수 없게 되므로 어떤 기록된 결정 아래에서 허용하는가?
- Q5. Bronze가 원시 PII를 보유한다. 삭제 방식으로 암호 파기(crypto-shredding), Bronze 이전 토큰화, 제한된 원본
  보존 중 무엇을 승인하는가(#30과 함께)?
- Q6. Silver의 원천 삭제: 하드 삭제인지, 이력을 가진 소프트 삭제 플래그인지?
- Q7. 신규 원천 유형보다 먼저 Debezium 토픽의 Bronze 복사본을 첫 산출물로 삼아도 되는가?

## 출처

- Databricks, "What is the medallion lakehouse architecture?",
  https://docs.databricks.com/aws/en/lakehouse/medallion (2026-10-07 열람).
- 저장소(작성 시점 확인): `gitops/charts/beluga-data/files/flink-sql/`,
  `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml`,
  `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`, `policies/`,
  [data-standards-ko.md](data-standards-ko.md), [architecture-ko.md](architecture-ko.md).
- 이슈: #70, #18, #19, #20, #21, #30, #33, #34, #56, #61, #62, #63, #65.
