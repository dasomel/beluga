# 거버넌스 데이터 품질 프레임워크 (제안)

[English](data-quality-framework.md) | 한국어

이슈 #85("OpenMetadata 통합을 갖춘 거버넌스 데이터 품질 관리 프레임워크 구축")를 참조한다.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 매니페스트, DAG, 스크립트, 정책, `VERSIONS.md` 값을 변경하지 않는다.
> 저장소에 관한 서술은 커밋 `9f74c2b`에서 읽은 `file:line`을 붙였다. "라이브" 서술은 2026-10-07에 읽기 전용
> `kubectl`로 확인한 값이며, 그 밖의 런타임 사실은 **라이브 미검증**으로 표시한다. 외부 사실은 `[S#]`로 인용하며
> ([출처](#출처) 참고, 접근일 2026-10-07), 업스트림이 침묵하는 곳은 **공식 권고 없음** 또는
> **읽은 페이지에 없음**으로 적는다. **제안**으로 표시한 항목은 구현되지 않았다. 임계값은 여기서 만들어 내지 않으며 소유자 결정이다.

관련 문서: [`medallion-architecture-ko.md`](medallion-architecture-ko.md)(5.2절 게이트 규칙, 격리), [`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md),
[`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md), [`data-contract-standard-ko.md`](data-contract-standard-ko.md), [`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md)(결과와 격리 데이터의 보존).
이슈 #20, #56(게이트, 지속적 품질), #81, #82(실행 식별자), #75는 이슈 본문에 명시되어 있으며, 이 문서를 위해 그 내용을 다시 읽지는 않았다.

## 1. 목적과 이슈 매핑

이슈는 OpenMetadata를 카탈로그 통합 지점으로 쓰는 Beluga 품질 통제 평면을 요구한다. 이 문서는 기존 레이어 위에 소유권 경계, 게이트 위치, PII 안전 실행, 증거 모델을 정의한다.

| 이슈 #85 인수 기준 | 절 |
|---|---|
| 대표 데이터셋에 품질 프로파일이 있다 | 2.2, 4.6 |
| 재사용 가능한 규칙이 실행되고 버전이 있는 증거를 만든다 | 4.2, 4.4 |
| 결과가 OpenMetadata 통합 카탈로그에서 보인다 | 4.1, 4.5 |
| 치명적 실패로 Silver/Gold 게시를 차단할 수 있다 | 4.3 |
| 드리프트, 최신성, 볼륨 이상이 감지된다 | 4.2, 4.6 |
| 품질 실패를 리니지로 영향받는 다운스트림 자산까지 추적할 수 있다 | 4.5 |
| 격리, 교정, 재검사, 종결이 감사 가능하다 | 4.7 |
| 프로파일링이 PII/보안과 원천 자원 한도를 존중한다 | 4.8 |
| 품질 지표가 SLA와 운영 보고에 공급된다 | 4.9 |

## 2. 현재 상태 (검증됨)

### 2.1 존재하는 품질 통제

- **데이터 파이프라인에는 없다.** 메달리온 문서는 Silver/Gold 이전 품질 게이트 없음, 격리 없음, `lake.customers`/`lake.orders`가 스트림에서 곧바로 기록됨을 기록한다
  ([`medallion-architecture-ko.md`](medallion-architecture-ko.md) 4절, 격차 목록). Flink SQL은 타입을 변환하지만(예: 문자열에서 `TIMESTAMP(3)`, `DECIMAL(10, 2)`) 파일에는 검증이나 dead-letter 경로가 없다
  (`gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:54-58`, `cdc_orders.sql:55-63`; 두 파일 모두 `WHERE`나 오류 싱크 없음).
- **메타데이터 완전성은 데이터 품질이 아니다.** [`policies/data-standards.yaml:31`](../policies/data-standards.yaml#L31)의 `completeness_threshold_percent: 100`은 레지스트리 필드가 존재하는지를 측정하며
  `make validate`의 `scripts/ci/check-data-standards.py`가 집행한다(`Makefile:68`). 행 값에 대해서는 아무것도 말하지 않는다.
- 최신성은 선언(`PT5M`)만 되고 측정되지 않는다([`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md) 2.1절 참고).

### 2.2 카탈로그 계층과 데이터셋

- OpenMetadata 1.13.3은 선택적이며(`values.yaml:58-59`) OIDC 로그인과 `DefaultAuthorizer`로 배포된다(`11-openmetadata.yaml:179-205`); **라이브:** `governance`에서 실행 중; 수집 러너 파드는 발견되지 않음; 저장소에 정의된 테스트 스위트 없음. 라이브 내용은 **미검증**이다.
- 현재 후보 데이터셋은 정형뿐이다: `lake.customers`, `lake.orders`, `lake.events_enriched`와 그 PostgreSQL 원천(`policies/data-standards.yaml:33-112`). 저장소에는 API 유래, 문서 유래, 멀티미디어 유래 데이터셋이 없으므로
  이슈의 네 가지 데이터셋 종류를 지금 모두 시연할 수는 없다.
- 실행 식별자(#82)는 저장소에 없다; 가장 가까운 안정 식별자는 Iceberg 스냅샷 id와 Airflow/Flink 잡 이름이다.

### 2.3 품질 러너가 쓸 접근 경로

- 사람과 서비스는 Trino를 통해 Iceberg에 도달하며, Trino는 `default allow := false`로 테이블 단위 OPA를 집행한다(`trino.rego:6`). `lake.customers`는 `admins`/`engineers`만
  select할 수 있다(`trino.rego:31-39`). 현재 Trino 컬럼 마스크는 없다([`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md) 2.3절 참고).
- OpenMetadata의 Trino 커넥터는 `Data Profiler`, `Data Quality`, `Sample Data` 기능을 문서화하며 테이블에 대한 `SELECT`(및 `system.metadata.table_comments`)가 필요하고
  프로파일링과 품질에는 추가 `SELECT`가 필요하다고 밝힌다 [S2]. 따라서 품질 러너는 명시적 grant를 가져야 하는 새로운 Trino 주체이며, 현재 `policies/roles.yaml`에는 없다(`analysts`, `engineers`, `admins`뿐).

### 2.4 업스트림이 문서화한 것

| 주제 | 업스트림 진술 | 출처 |
|---|---|---|
| OpenMetadata 품질 | 지원되는 데이터베이스 커넥터에 대한 테이블/컬럼 단위 테스트; YAML 및 UI 설정; 사용자 정의 테스트/스위트; 실패 알림; 상태 대시보드; 해결 워크플로. 이 기능이 오픈소스 기능인지는 **읽은 페이지에 명시되어 있지 않다** | [S1] |
| 테이블 테스트 정의 | `tableRowCountToEqual`, `tableRowCountToBeBetween`, `tableColumnCountToEqual`, `tableColumnCountToBeBetween`, `tableColumnNameToExist`, `tableColumnToMatchSet`, `tableCustomSQLQuery`, `tableRowInsertedCountToBeBetween`, `tableDiff`; YAML(`testDefinitionName`)과 TestSuite로 실행. 컬럼 테스트 이름은 별도 페이지에 있으며 **읽지 않았다** | [S3] |
| 게시 차단 | OpenMetadata 테스트가 파이프라인 단계를 차단할 수 있는지는 **읽은 페이지에 문서화되어 있지 않다**: 공식 권고 없음 | [S1, S3] |
| 품질 차원 | ODCS는 `accuracy`, `completeness`, `conformity`, `consistency`, `coverage`, `timeliness`, `uniqueness`를 나열; 라이브러리 지표 `nullValues`, `missingValues`, `invalidValues`, `duplicateValues`, `rowCount`; 연산자 `mustBe`, `mustNotBe`, `mustBeGreaterThan`, ...; 사용자 정의 규칙은 `engine`을 지정할 수 있음(예: `soda`, `greatExpectations`) | [S4] |
| Great Expectations / Soda / dbt 테스트 | 이 문서를 위해 평가하지 않았다: 공식 문서 검토를 하지 않았고 권고하지 않는다. 채택하려면 `policies/license-policy.yaml:1-7`에 대한 라이선스/SBOM 검사가 필요하다 | 해당 없음 |

## 3. 인수 기준 대비 격차

| ID | 격차 |
|---|---|
| G1 | 규칙 정의, 실행, 결과, 증거가 어디에도 없다 |
| G2 | 파이프라인 게이트 없음; OpenMetadata 테스트가 단계를 차단할 수 있다고 문서화되어 있지 않으므로 차단 게이트는 파이프라인에 있어야 한다 |
| G3 | 격리 네임스페이스/테이블과 교정 워크플로 없음(메달리온이 규칙을 정의했을 뿐 구현은 없음) |
| G4 | 품질 러너 신원 없음; 부주의하게 부여하면 PII 접근이 넓어진다 |
| G5 | 실패를 연관시킬 실행 식별자(#82) 없음; 스냅샷 id와 잡 이름뿐 |
| G6 | 대표 데이터셋 기준에 정형 데이터셋만 존재한다 |

## 4. 제안 (제안)

### 4.1 소유권 경계 (권위 분할)

| 항목 | 권위 | OpenMetadata의 역할 |
|---|---|---|
| 규칙 정의, 템플릿, 심각도, 임계값, 면제 | Git(`policies/quality/*.yaml`, 제안 경로) | 읽기 사본; Git에서 동기화 |
| 게이트 결정(통과/차단/경고) | 파이프라인(Airflow 태스크 또는 Flink 잡) | 없음 |
| 실행 증거(규칙 버전, 실행 id, 스냅샷 id, 타임스탬프, 건수) | Beluga 증거 레코드(4.4) | 테스트 결과와 인시던트를 표시 |
| 데이터셋 소유권, 분류, 리니지 | 레지스트리([`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md) 참고) | 읽기 사본 |
| UI의 인시던트 상태 | OpenMetadata 해결 워크플로 [S1] | UI 상태에 대해서만 권위; 종결은 Git/증거에도 기록(4.7) |

OpenMetadata 편집은 규칙이나 게이트 결과를 바꾸지 않는다. 이로써 정의의 권위가 하나로 유지되고 호환되지 않는 메타데이터 사일로를 피한다.

### 4.2 차원과 규칙 모델

ODCS 차원 이름을 **어휘**로 쓴다(강제 아님). 규칙이 계약([`data-contract-standard-ko.md`](data-contract-standard-ko.md))과 일대일로 대응하도록 하기 위함이며, 이슈의 `validity`, `integrity`, `volume/anomaly`는 하위 종류로 매핑한다:

| 이슈 차원 | 규칙 템플릿(제안) | OpenMetadata 후보 매핑 |
|---|---|---|
| completeness | 컬럼별 not-null / 결측 비율 | 컬럼 테스트(이름 **읽지 않음**) |
| uniqueness | 키의 중복 비율 | 컬럼 테스트(이름 **읽지 않음**) |
| validity / conformity | 허용 집합, 범위, 패턴 | 컬럼 테스트 또는 `tableCustomSQLQuery` |
| integrity | 테이블 간 참조 검사 | `tableCustomSQLQuery`, `tableDiff` |
| volume | 허용 범위 내 행 수; 기간당 삽입 행 수 | `tableRowCountToBeBetween`, `tableRowInsertedCountToBeBetween` |
| schema drift | 기대 컬럼 존재 | `tableColumnToMatchSet`, `tableColumnNameToExist` |
| timeliness | `$snapshots`에서 얻는 최신성(리니지 문서 4.4절 참고) | 읽은 것 없음; Beluga 검사 |
| accuracy, anomaly detection | 참조가 있는 경우에만; 통계적 이상 탐지는 **첫 슬라이스 밖** | 읽은 것 없음 |

수치(범위, 비율)는 데이터셋별로 소유자가 제공하며 제안하는 값은 없다.

### 4.3 게이트 위치 (메달리온 5.2와 정렬)

- Bronze에서 Silver: 변환 안에서 스키마/타입/키 검사; 실패 레코드는 버리지 않고 격리 테이블로 보낸다(메달리온 규칙).
- Silver에서 Gold: Airflow 태스크가 해당 기간의 Silver 입력에 대해 선언된 규칙을 실행하고 통과할 때만 Gold를 게시한다; 심각도 `critical`은 차단하고 `warning`은 기록하고 계속한다
  (차단 대 경고는 규칙별로 Git에서 설정). 차단 시 이전 Gold 스냅샷이 그대로 유지된다.
- OpenMetadata 테스트는 게이트가 아니라 추가적인 가시성과 알림으로 실행된다 [S1, S3].
- 현재 스트리밍 Gold 유사 `lake.events_enriched`에는 Silver 입력이 없다; 이를 게이트하려면 메달리온 Q4 결정이 필요하다.

### 4.4 증거 레코드 (재현성)

규칙 실행마다 저장: 규칙 id, 규칙 버전(규칙 파일의 Git 커밋), 실행 id, 입력 데이터셋 id와 Iceberg `snapshot_id`/`committed_at` [S5], 게이트 결정, 건수(검사 행 수, 실패 행 수), 타임스탬프, 러너 신원.
**행 값은 저장하지 않으며** 건수와 규칙 결과만 저장한다. 저장 위치는 소유자 결정이다(D3): Iceberg `quality_results` 테이블(그 자체가 `internal`로 등록·분류되어야 함) 또는 릴리스 증거에 첨부하는 파일.
보존은 [`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md)(감사 클래스)를 따르며 여기서 기간을 정하지 않는다.

### 4.5 리니지 기반 영향 분석

게이트가 실패하면 보고서는 선언된 `derived_from` 간선([`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md) L1)을 써서 다운스트림 자산을 나열한다. 보고서, API, 데이터 제품은
리니지 노드로 선언된 뒤에만 나열되며, Superset 대시보드는 현재 노드가 **아니다**.

### 4.6 대표 첫 슬라이스

`lake.orders`와 `lake.customers`(정형), 행 수 범위, 최신성, 키 유일성, 키의 not-null, 스키마 일치. API, 문서, 멀티미디어 데이터셋은 생길 때까지 보류(G6). 원천 PostgreSQL 테이블은
**직접 프로파일링하지 않는다**(4.8).

### 4.7 격리, 교정, 종결 (감사 추적)

상태: `open -> quarantined -> remediating -> rechecked -> closed`, 그리고 `waived`. 각 전이는 Git 검토를 거친 레코드이거나 증거 레코드 추가(누가, 언제, 실행 id)다. 면제에는 같은 레코드에
지명된 승인자와 만료일이 필요하다. OpenMetadata의 해결 워크플로 [S1]는 UI를 위해 상태를 미러링하며 감사 원천은 Git 레코드다. 격리된 데이터는 원천의 분류를 상속하고(PII는 PII로 유지) 같은 보존 훅을 따른다.

### 4.8 보안: PII와 원천 부하

- 품질 러너는 PII 접근을 넓혀서는 안 된다. 첫 슬라이스: `pii`가 아닌 테이블과, `pii` 테이블의 `internal` 컬럼에 대해서만 규칙을 실행하며 러너에게 `lake.customers` 접근을 **부여하지 않는다**.
- `pii` 컬럼에 대한 값 수준 검사(완전성, 유일성)는 null과 결정성을 보존하는 Trino 마스크, 예를 들어 컴파일러의 `hash` 종류(`beluga-manager/.../rego.ts:6-10`)로 실행할 수 있어 원문 값 없이도 건수가 유효하다.
  이는 SQL 의미론(NULL의 해시는 NULL)에 대한 추론이며 채택 전에 테스트해야 한다; `null`이나 `partial` 마스크는 이런 검사를 무효로 만든다. 이를 위해서는 마스킹 `select` grant를 가진 러너 롤,
  즉 `policies/roles.yaml`의 새 롤과 Keycloak 그룹이 필요하며 이는 소유자 결정이고(D2), `engineers`여서는 안 된다.
- OpenMetadata 프로파일러 실행에서 `pii` 테이블의 샘플 데이터/미리보기 수집을 비활성화한다([`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md) 4.5절).
- 원천 부하: PostgreSQL이 아니라 Trino를 통해 Iceberg 미러를 프로파일링한다. Trino 동시성 한도와 샘플링 비율은 소유자 결정이다(D4); 벤치마크는 없으며 주장하지 않는다.

### 4.9 SLA/SLO와 API

데이터셋별 최신성과 통과율 SLO는 레지스트리 `freshness` 목표와 계약 SLA([`data-contract-standard-ko.md`](data-contract-standard-ko.md))를 재사용한다. 포털/자동화용 내보내기: 증거 레코드(4.4)를 JSON으로,
OpenMetadata가 활성이면 OpenMetadata API. 새 서비스는 제안하지 않는다.

## 5. 검증 및 테스트 아이디어

| 테스트 | 유형 | 통과 조건 |
|---|---|---|
| 규칙 파일 스키마와 고유 id | 정적, `make validate` | 잘못된 픽스처 실패 |
| 스테이징된 Silver 입력에 대한 `critical` 규칙 실패 | 라이브(Airflow) | Gold 미게시, 이전 스냅샷 변경 없음 |
| `warning` 규칙 실패 | 라이브 | 기록되고 게시 계속 |
| 테스트 테이블에 행 수 범위 이탈, 중복 키 주입 | 라이브 | 감지됨, 증거에 규칙 버전과 `snapshot_id` 포함 |
| 러너 신원이 `lake.customers` 원문을 읽을 수 없음 | 라이브 | `SELECT` 거부(OPA) |
| `customers`의 마스킹된 null/유일성 건수(D2 승인 시에만) | 라이브 | 건수가 마스킹 없는 건수와 같고 증거에 값이 저장되지 않음 |
| 승인자/만료 없는 면제 | 정적 부정 | 실패 |

## 소유자 결정 사항

| ID | 결정 | 권고 |
|---|---|---|
| D1 | OpenMetadata 테스트를 게이트로 쓸지 가시성 전용으로 쓸지 | 가시성 전용; 게이트는 파이프라인에 |
| D2 | 마스킹된 `pii` 검사를 위한 전용 읽기 전용 품질 러너 롤 | 첫 슬라이스에서는 아니오; PII 완전성 검사가 필요할 때만 추가 |
| D3 | 증거 저장: Iceberg 테이블 대 릴리스 증거 파일 | Silver가 생기면 Iceberg 테이블; 그 전에는 파일 |
| D4 | 프로파일링 동시성/샘플링 한도와 규칙 임계값 | 공식 권고 없음; 소유자가 데이터셋별로 정함 |
| D5 | Great Expectations/Soda 평가 또는 OpenMetadata와 SQL 규칙 유지 | 격차가 드러날 때까지 OpenMetadata와 SQL 규칙 유지; 평가 시 라이선스 검토 |
| D6 | 새 규칙의 차단 기본 심각도 | 규칙에 기준선이 생길 때까지 `warning` |

## 후속 구현 작업 (순서대로)

1. 규칙 파일 형식과 정적 검증기 정의(`policies/quality/`). 테스트: 잘못된 픽스처 실패.
2. `lake.orders`에 대한 볼륨, 최신성, 스키마 일치 검사를 증거 레코드를 쓰는 Airflow 태스크로 구현. 테스트: 주입된 실패가 `snapshot_id`가 있는 증거를 생성.
3. critical/warning 심각도를 갖는 Silver에서 Gold 게이트 태스크 패턴 추가. 테스트: 위의 차단/경고 케이스.
4. 격리 테이블 규약과 상태 레코드(메달리온 Bronze/Silver가 생긴 뒤). 테스트: 면제와 종결의 부정 케이스.
5. 활성 시 규칙과 결과를 OpenMetadata에 동기화. 테스트: 데이터셋 페이지에서 결과가 보임.
6. 품질 러너 신원 결정(D2)과 마스킹된 PII 완전성 테스트. 테스트: 건수 일치, 원문 접근 없음.
7. 선언된 리니지로부터 영향 보고서. 테스트: `lake.customers` 실패가 선언된 다운스트림 테이블을 나열.

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | OpenMetadata, Data Quality overview: https://docs.open-metadata.org/latest/how-to-guides/data-quality-observability/quality |
| S2 | OpenMetadata, Trino connector: https://docs.open-metadata.org/latest/connectors/database/trino |
| S3 | OpenMetadata, Table test definitions (YAML): https://docs.open-metadata.org/latest/how-to-guides/data-quality-observability/quality/tests-yaml |
| S4 | Open Data Contract Standard, Data Quality: https://bitol-io.github.io/open-data-contract-standard/latest/data-quality/ |
| S5 | Trino 483, Iceberg connector (`$snapshots`): https://trino.io/docs/483/connector/iceberg.html |
