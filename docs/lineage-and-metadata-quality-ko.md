# 데이터 리니지와 메타데이터 품질 통제 (제안)

[English](lineage-and-metadata-quality.md) | 한국어

이슈 #19("데이터 리니지와 메타데이터 품질 통제 수립")를 참조한다.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 매니페스트, DAG, 스크립트, 정책, `VERSIONS.md` 값을 변경하지 않는다.
> 저장소에 관한 서술은 커밋 `9f74c2b`에서 읽은 `file:line`을 붙였다. "라이브" 서술은 2026-10-07에 읽기 전용
> `kubectl`로 확인한 값이며, 그 밖의 런타임 사실은 **라이브 미검증**으로 표시한다. 외부 사실은 `[S#]`로 인용하며
> ([출처](#출처) 참고, 접근일 2026-10-07), 업스트림이 침묵하는 곳은 **공식 권고 없음** 또는
> **읽은 페이지에 없음**으로 적는다. **제안**으로 표시한 항목은 구현되지 않았다.

관련 문서: [`medallion-architecture-ko.md`](medallion-architecture-ko.md)(5.1, 5.2, 6절), [`data-standards-ko.md`](data-standards-ko.md),
[`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md)(2.6절, 카탈로그 메타데이터), [`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md),
[`data-quality-framework-ko.md`](data-quality-framework-ko.md), [`data-contract-standard-ko.md`](data-contract-standard-ko.md).

## 1. 목적과 이슈 매핑

| 이슈 #19 인수 기준 | 절 |
|---|---|
| 필수 메타데이터 계약이 문서화된다 | 2.1, 4.1 |
| 대표적인 종단 간 리니지가 보인다 | 2.2, 2.4, 4.2 |
| 스키마 변경이 문서화된 정책에 따라 감지되고 처리된다 | 2.1, 4.3 |
| 오래되었거나 고아가 된 메타데이터를 식별하고 조정할 수 있다 | 4.5 |
| 데이터셋 소유권, 분류, 최신성을 질의할 수 있다 | 2.3, 4.4, 4.6 |

## 2. 현재 상태 (검증됨)

### 2.1 존재하는 메타데이터: Git 레지스트리, 정적 전용

- [`policies/data-standards.yaml`](../policies/data-standards.yaml)은 테이블별로 `owner, classification, description, retention, freshness`를, 컬럼별로 `description, classification`을 요구한다
  (`:25-28`); `retention`/`freshness`는 ISO-8601 기간이다(`:30`). 5개 테이블이 등록되어 있으며(`:33-112`) 모두 `owner: data-platform`, `freshness: PT5M`이다.
- `scripts/ci/check-data-standards.py`(`make validate`의 일부, `Makefile:68`)는 미등록 `CREATE TABLE`, 오래된 레지스트리 항목, 필드 누락, 잘못된 분류에서 실패한다. 스스로 레지스트리가 "런타임 카탈로그 상태가 아니다"라고 밝힌다
  (`check-data-standards.py:29-31`). 이것이 저장소의 유일한 스키마 변경 감지기이며 **Git DDL과 Git 레지스트리**를 비교할 뿐 실행 중인 카탈로그는 비교하지 않는다.
- 최신성은 선언된 목표일 뿐이다: 저장소의 어떤 잡, DAG, 쿼리도 이를 측정하지 않는다(레지스트리와 그 검사기 밖에서 `freshness` grep: 일치 없음). `docs/data-standards.md`는 물리적 집행이 함의되지 않는다고 밝힌다.
- 레지스트리에는 `steward`, 레이어/네임스페이스, 업스트림, 스키마 버전 필드가 없다.

### 2.2 존재하는 리니지: 기록된 것 없음

- 읽은 파일 기준 실제 데이터 경로: PostgreSQL `shop` -> Debezium 토픽 `cdc.shop.public.{customers,orders}` -> Flink SQL(`cdc_customers.sql`, `cdc_orders.sql`) -> Lakekeeper를 통한 Iceberg `lake.customers`/`lake.orders`;
  `events.clickstream` -> Flink SQL(`events_sessionization.sql`) -> `lake.events_enriched`; Trino가 Iceberg를 읽고; Superset이 Trino를 읽는다(여기서 재검증하지 않음). Airflow는
  `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`만 실행한다(`events_enriched`와 `orders`에 `optimize`, `events_enriched`에 `expire_snapshots`, `:30`, `:44`).
- 저장소 어디에도 OpenLineage 설정이 없다(언급은 `medallion-architecture.md` 6절과 데이터와 무관한 설계 계보 메모뿐). `medallion-architecture.md`는 이미 리니지 도구를 이 이슈에 배정한다.
- 레지스트리 범위는 Kafka 토픽과 커넥터 로컬 Flink 테이블을 설계상 제외한다(`docs/data-standards.md`, "Scope"); 따라서 토픽 리니지 노드는 별도 선언이 필요하다(4.2).

### 2.3 카탈로그 계층: OpenMetadata

- 선택적(`openmetadata.enabled: false` 기본, `values.yaml:58-59`; `README.md:65,78-79`에 따라 48GB 이상 프로파일에서만 활성). **라이브:** `governance` 네임스페이스에서 `openmetadata`와 `opensearch`(1.13.3)가 실행 중이며, 어떤 네임스페이스에도 이름에 `ingest`가 들어간 파드는 없다.
- 저장소에는 수집(ingestion) 워크플로, 리니지 워크플로, 분류 동기화가 정의되어 있지 않다(`11-openmetadata.yaml`은 서버, 검색, OIDC 로그인, 네트워크 정책만 배포). 라이브 카탈로그에 엔티티가 있는지는 **라이브 미검증**이다(API 토큰 미사용).
- Lakekeeper는 Iceberg REST 카탈로그이며 테이블 존재와 스키마의 권위다(`06-trino.yaml:10-16`, Flink `CREATE CATALOG lakekeeper`). OpenMetadata는 그 메타데이터의 두 번째 사본이 되며 현재 동기화되지 않는다.

### 2.4 업스트림이 문서화한 것 (도구 선택지)

| 기능 | 업스트림 진술 | Beluga에 대한 결과 |
|---|---|---|
| OpenMetadata 리니지 생성 | 쿼리 로그 리니지 워크플로, 수집 중 뷰 리니지, UI 수동 리니지, dbt, CSV 쿼리 로그; 해당 페이지의 지원 서비스: BigQuery, Snowflake, MSSQL, Redshift, Clickhouse, PostgreSQL, Databricks [S1] | Trino와 Iceberg는 **그 목록에 없다**; Trino 커넥터 페이지는 별도로 `Lineage`와 `Column-level Lineage`를 나열하지만 얻는 방법은 밝히지 않는다 [S2]. 의존하기 전에 테스트 실행으로 확인한다 |
| OpenMetadata OpenLineage 커넥터 | Kafka 또는 Kinesis에서 OpenLineage 이벤트를 소비; OpenLineage 1.7.0까지 통합; Airflow와 Spark 설정 문서화; Flink 언급 없음; 파이프라인 상태, 소유자, 태그 미지원 [S3] | Airflow 이벤트에는 사용 가능한 런타임 경로가 있고 Flink에는 문서화된 경로가 없다 |
| Flink용 OpenLineage | Flink 1.x 통합은 "Flink SQL을 지원하지 않는다"; Flink 2.x는 Flink 네이티브 리니지 인터페이스(FLIP-314)를 쓰고 잡 코드 변경이 필요 없으며 Flink SQL을 지원한다 [S4] | Beluga는 Flink 1.20을 쓰며 2.x 커넥터가 없어 유지한다(`VERSIONS.md:34,50`); 잡은 SQL이다. 따라서 문서화된 1.x 통합으로는 Flink 런타임 OpenLineage를 **쓸 수 없다** |
| Airflow용 OpenLineage | Airflow 2.7+용 네이티브 프로바이더 [S5] | Beluga는 Airflow 3.3.0을 쓴다(`VERSIONS.md:36`); 3.x 지원은 **읽은 페이지에 명시되어 있지 않다**; 유일한 DAG는 유지보수이며 데이터 리니지를 만들지 않는다 |
| Iceberg 최신성 원천 | Trino는 `committed_at`, `snapshot_id`, `parent_id`, `operation`, `summary`가 있는 `"<table>$snapshots"`를 노출한다 [S6] | 새 인프라 없이 카탈로그에서 최신성을 계산할 수 있다 |

## 3. 인수 기준 대비 격차

| ID | 격차 | 기준 |
|---|---|---|
| G1 | 메타데이터 계약이 레지스트리 필드로만 존재; steward/레이어/업스트림 없음; 런타임에 질의 불가 | 계약, 질의 가능 |
| G2 | 기록된 리니지가 어디에도 없음; 문서화된 1.x 통합으로는 Flink SQL이 OpenLineage를 내보낼 수 없음 | 종단 간 리니지 |
| G3 | 스키마 변경이 정적으로만 감지됨(Git DDL 대 Git 레지스트리); 실행 중 카탈로그 드리프트 검사 없음 | 스키마 변경 |
| G4 | 최신성은 선언(`PT5M`)만 되고 측정되지 않음 | 최신성 |
| G5 | 레지스트리, Lakekeeper/Iceberg, OpenMetadata 간 조정 없음; 고아/오래된 항목 보고서 없음 | 오래됨/고아 |

## 4. 제안 (제안)

원칙: **Git은 거버넌스 필드(owner, steward, classification, retention, 최신성 목표, 선언된 리니지)의 권위이고, Lakekeeper/Iceberg는 물리적 존재와 스키마의 권위이며, OpenMetadata는 파생된 뷰다.**
조정은 분류를 완화하거나 접근을 부여하지 않는다([`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md) 참고).

### 4.1 필수 메타데이터 계약

| 필드 | 수준 | 상태 |
|---|---|---|
| `owner`, `classification`, `description`, `retention`, `freshness` | 테이블 | 존재 |
| `description`, `classification` | 컬럼 | 존재 |
| `steward` | 테이블 | 제안(필수) |
| `layer` (`bronze|silver|gold`, 메달리온 기준) | 테이블 | 제안; 메달리온 Q1이 결정되기 전까지 현재 `lake` 네임스페이스는 `legacy` |
| `derived_from` (레지스트리 테이블 id 또는 선언된 전송 원천의 목록) | 테이블 | 제안 |
| 스키마 | 테이블 | DDL에서 도출(존재); 버전 번호는 여기서 제안하지 **않으며** 계약([`data-contract-standard-ko.md`](data-contract-standard-ko.md))에 속한다 |

같은 필드가 데이터 계약에 공급되며, 계약은 이를 재정의해서는 안 된다.

### 4.2 리니지

- **L1, 선언된 리니지(첫 산출물).** 테이블별 `derived_from`과 작은 `transport_sources` 목록(데이터셋이 아닌 노드로서의 Kafka 토픽과 Flink 잡 이름). 정적 검사가 참조된 모든 id의 존재를 확인한다.
  런타임 도구 없이 5개 테이블 전부의 테이블 단위 리니지를 제공하며 Flink 1.20 SQL에서도 동작한다.
- **L2, 카탈로그 가시성.** OpenMetadata가 활성일 때 reconcile 잡이 L1 간선을 푸시한다(리니지 API 또는 UI가 지원하는 경로; API 엔드포인트는 **읽은 페이지에 문서화되어 있지 않으므로** [S1] 구현 전에 1.13.3 기준으로 확인해야 한다).
- **L3, 런타임 이벤트(선택).** Airflow OpenLineage 프로바이더에서 OpenMetadata의 OpenLineage 커넥터로, Airflow 3.3.0 지원이 확인된 뒤에만 [S3, S5]. Flink 런타임 리니지는 SQL을 지원하는 Flink 버전을 기다린다 [S4].
- **L4, 컬럼 단위 리니지:** 여기서는 범위 밖(이슈 #88).
- 메달리온 정렬: 메달리온 6절의 레이어 id와 `_batch_id`/스냅샷 id 증거는 Bronze가 생기면 L1 간선에 붙는다.

### 4.3 스키마 변경 정책

- 정적: 기존 검사기가 Git의 DDL에 대한 게이트로 유지된다.
- 라이브 드리프트(제안): `iceberg.lake.*`의 `information_schema.columns`(Trino 경유; `information_schema`와 `$snapshots` 메타데이터 테이블로 한정된 **새로운** 읽기 전용 Trino 주체가 필요하다. 적합한 기존 롤이 없고 `engineers`를 재사용해서는 안 되며, 별도의 컴파일러 규칙과 소유자 결정이 필요하므로 접근이 암묵적으로 넓어지지 않는다)를 레지스트리와 비교한다. 컬럼 추가: 경고이며 리뷰 내에 레지스트리 갱신 필요.
  컬럼 삭제, 이름 변경, 타입 변경: 실패이며 메달리온 5.1(Silver는 검토된 변경을 통한 추가만, Gold의 파괴적 변경은 새 테이블 또는 버전 필요) 및 데이터 계약의 호환성 분류와 정렬된다.
- 전파 기대치: Flink 소스 테이블과 싱크 DDL은 고정된 컬럼 목록을 선언하므로(`cdc_customers.sql:26-34` 소스, `:42`부터 싱크), 원천 데이터베이스에 컬럼이 추가되어도 Flink DDL, Iceberg 테이블, 레지스트리가 함께
  바뀌기 전까지는 **전파되지 않는다**. 이는 사고가 아니라 기대되는 동작으로 명시해야 한다.

### 4.4 최신성

- 테이블별로 `"lake.<table>$snapshots"` [S6]에서 `now() - max(committed_at)`을 측정해 레지스트리 `freshness`와 비교한다.
- 주의: `optimize`(Airflow, 매시간)도 스냅샷을 만든다(`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:30`); 압축이 오래된 테이블을 가리지 않도록 검사는 `operation`으로 필터링해야 한다. `operation` 값은 구현 전에 Iceberg 문서로 확인해야 한다(이 문서를 위해 읽지 않음).
- 선언된 목표를 넘는 알림 유예는 소유자 결정이다(D3).

### 4.5 오래되었거나 고아가 된 메타데이터, 조정

3자 비교, 보고만 한다(자동 삭제 없음):

| 발견 | 의미 | 조치 |
|---|---|---|
| Lakekeeper/Trino에 있고 레지스트리에 없음 | 미분류 테이블 | 차단으로 보고; Trino에서는 이미 기본 거부 적용(PII 문서 참고) |
| 레지스트리에 있고 Lakekeeper에 없음 | 오래된 레지스트리 항목 | DDL은 현재도 CI가 실패시킴; 라이브 검사가 보고 |
| OpenMetadata에 있고 Lakekeeper에 없음 | 고아 카탈로그 엔티티 | 보고; 제거는 `data-lifecycle-policy.md` 2.6절을 따름(soft 대 hard 삭제는 그 문서의 소유자 결정 D12) |
| Git과 OpenMetadata 간 소유자/분류 불일치 | 드리프트 | Git으로 OpenMetadata를 덮어씀 |

### 4.6 거버넌스 검토용 노출

릴리스 증거에 다른 인벤토리처럼 첨부되는, 읽기 전용으로 생성된 보고서(JSON)로 테이블별 owner, steward, classification, 선언된 리니지, 최신성 상태, 마지막 스키마 검사를 나열한다. OpenMetadata가 활성이면
같은 필드가 거기서도 보인다. 질의 가능한 새 거버넌스 테이블은 제안하지 **않는다**.

## 5. 검증 및 테스트 아이디어

| 테스트 | 유형 | 통과 조건 |
|---|---|---|
| `derived_from` id 존재 / 순환 없음 | 정적, `make validate` | 끊어진 id에서 실패 |
| `steward`/`layer`가 없는 레지스트리 테이블 | 정적 부정 | 실패 |
| 테스트 Iceberg 테이블에 컬럼 추가 | 라이브 | 드리프트 검사가 추가 경고를 보고; 컬럼 삭제는 실패를 보고 |
| 테스트 테이블의 Flink 잡 중지 | 라이브 | 선언된 목표와 유예 이후 최신성 상태가 stale이 됨 |
| Lakekeeper에서 테스트 테이블 삭제 | 라이브 | 오래된 레지스트리 항목으로 보고; OpenMetadata 고아 보고(활성 시) |
| 대표 리니지 `postgres.public.customers -> iceberg.lake.customers` | 정적 및 OpenMetadata(활성 시) | 보고서와 카탈로그에 간선 존재 |

## 소유자 결정 사항

| ID | 결정 | 권고 |
|---|---|---|
| D1 | 선언된(Git) 리니지를 첫 산출물로 수용 | 예; 런타임 리니지는 나중에 |
| D2 | Git과 OpenMetadata가 다를 때 리니지의 권위 | Git |
| D3 | 선언된 `PT5M`을 넘는 최신성 알림 유예 | 공식 권고 없음; 소유자가 정함 |
| D4 | Airflow 3.3.0에서 Airflow OpenLineage 추진 | 프로바이더 지원이 확인된 뒤에만 |
| D5 | 고아 OpenMetadata 엔티티: 보고만 또는 제거 | 보고만 |
| D6 | 이 이슈를 위해 모든 프로파일에서 OpenMetadata가 필요한가 | 아니오; 보고서는 OpenMetadata 없이 동작 |

## 후속 구현 작업 (순서대로)

1. 레지스트리와 검사기에 `steward`, `layer`, `derived_from`, `transport_sources` 추가. 테스트: 부정 픽스처 실패.
2. 레지스트리로부터 거버넌스 보고서 생성(owner, classification, 리니지, 최신성 목표). 테스트: 보고서가 5개 테이블 모두 나열.
3. Trino `information_schema`를 통한 라이브 스키마 드리프트 검사. 테스트: 위의 컬럼 추가/삭제 케이스.
4. `operation` 필터를 둔 `$snapshots` 기반 최신성 검사. 테스트: 잡 중지 케이스.
5. 3자 조정 보고서. 테스트: 테이블 삭제 케이스.
6. OpenMetadata reconcile 잡(라벨, 소유자, steward, 리니지 간선, 활성 시). 테스트: 1.13.3에서 간선이 보임.
7. Airflow 3.3.0의 Airflow OpenLineage 프로바이더 지원 평가. 테스트: 샘플 DAG 이벤트가 OpenMetadata에 도착.

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | OpenMetadata, How lineage is produced: https://docs.open-metadata.org/latest/how-to-guides/data-lineage/workflow |
| S2 | OpenMetadata, Trino connector: https://docs.open-metadata.org/latest/connectors/database/trino |
| S3 | OpenMetadata, OpenLineage connector: https://docs.open-metadata.org/latest/connectors/pipeline/openlineage |
| S4 | OpenLineage, Flink integration: https://openlineage.io/docs/integrations/flink/ |
| S5 | OpenLineage, Airflow integration: https://openlineage.io/docs/integrations/airflow/ |
| S6 | Trino 483, Iceberg connector (`$snapshots`): https://trino.io/docs/483/connector/iceberg.html |
