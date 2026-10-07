# PII / 데이터 분류 집행 (제안)

[English](pii-classification-enforcement.md) | 한국어

이슈 #8("카탈로그와 쿼리 계층 전반에서 PII/데이터 분류를 집행 가능하게 만들기")를 참조한다.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 매니페스트, 스크립트, 정책, `VERSIONS.md`, 레지스트리 값을 변경하지 않는다.
> 저장소에 관한 서술은 커밋 `9f74c2b`에서 읽은 `file:line`을 붙였다. "라이브" 서술은 2026-10-07에 읽기 전용 `kubectl`로
> 확인한 값이며, 실행 중인 시스템에 관한 그 밖의 서술은 **라이브 미검증**으로 표시한다. 외부 사실은 `[S#]`로 인용하며
> ([출처](#출처) 참고, 접근일 2026-10-07), 업스트림 페이지가 침묵하는 곳은 **공식 권고 없음**으로 적는다.
> **제안**으로 표시한 항목은 구현되지 않았다.

관련 문서: [`medallion-architecture-ko.md`](medallion-architecture-ko.md) 5.3절(분류 전파),
[`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md)(보존 훅, 2.6절 카탈로그 메타데이터), [`data-standards-ko.md`](data-standards-ko.md),
[`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md), [`data-contract-standard-ko.md`](data-contract-standard-ko.md).

## 1. 목적과 이슈 매핑

이슈 #8은 쿼리, 카탈로그, 스토리지 계층 전반에 일관되게 집행되는 선언적 분류 모델을 요구한다. 이 문서는 읽은 코드를 근거로
**현재 어떤 계층이 `pii`를 집행하고 어떤 계층이 집행하지 않는지**를 기록하고, 어떤 접근도 넓히지 않으면서 인수 기준 격차를
닫는 가장 작은 추가 사항을 제안한다.

| 이슈 #8 인수 기준 | 절 |
|---|---|
| PII 분류가 선언적으로 표현된다 | 2.1, 3 (G1, G2) |
| 명시적 정책 없이는 새 테이블로 분석가의 민감 데이터 접근이 되살아날 수 없다 | 2.2, 3 (G3), 4.2 |
| 최소 한 개 민감 컬럼에 대해 마스킹 접근이 시연된다 | 2.3, 3 (G4), 4.3 |
| OpenMetadata 활성 시 분류와 소유권이 카탈로그에서 보인다 | 2.6, 3 (G6), 4.5 |
| 정책 회귀 테스트가 원천과 파생 데이터셋을 다룬다 | 2.7, 5 |

이슈의 증거 줄(`REVOKE SELECT ON TABLE customers FROM beluga_analyst`)은 **최신이 아니다**:
[`db-roles.sql`](../gitops/charts/beluga-data/files/db-roles.sql)의 생성 본문(8-42행)에는 이제 명시적 `GRANT`만 있고 `REVOKE`는 없다.
`beluga_analyst`는 레거시 정리 블록(70-100행)에만 나온다.

## 2. 현재 상태 (검증됨)

### 2.1 분류가 선언된 위치

| 원천 | 내용 | 근거 |
|---|---|---|
| `policies/data-standards.yaml` | 허용 값 `[internal, pii]`; 모든 테이블과 컬럼에 `classification` 필수. `customers`(PG와 Iceberg): 테이블 `pii`; 컬럼 `name`, `email`, `city` = `pii`, `customer_id`, `created_at` = `internal` | `policies/data-standards.yaml:26-28`, `:34-48`, `:66-80` |
| `policies/resources.yaml` | 리소스별 `classification`; `lake.customers`와 `public.customers`는 `pii`이며 `sensitiveColumns: [email]`, `engineers`에게만 `allowUnmasked: true`로 단일 grant | `policies/resources.yaml:16-22`, `:33-40` |
| 정책 컴파일러 스키마 (형제 저장소 `beluga-manager`, 커밋 `f9c4e38`) | `public \| internal \| pii` 허용; `pii` 리소스는 `sensitiveColumns`를 선언해야 하며(`PII_NO_SENSITIVE_COLUMNS`), 마스킹 없는 `select` grant에는 `allowUnmasked: true`가 필요(`PII_UNMASKED`) | `packages/policy-compiler/src/schema.ts:18`, `validate.ts:233`, `validate.ts:285-296` |

발견 사항:

- **F1 (드리프트 위험).** 두 선언이 PII 컬럼 집합에서 불일치한다: 레지스트리는 `name`, `email`, `city`를 표시하고 집행 정책은
  `email`만 나열한다. 컴파일러는 `sensitiveColumns`만 마스킹을 요구하므로, 오늘의 `resources.yaml`에 맞춰 작성한 향후 마스킹 grant는
  `name`과 `city`를 마스킹하지 않은 채로 둔다.
- **F2.** 허용 값이 다르다: 레지스트리 검증기는 `internal`/`pii`만 허용하고(`policies/data-standards.yaml:28`), 컴파일러는
  `public`도 허용한다. 두 파일을 교차 검증하는 곳이 없다: `scripts/ci/check-data-standards.py`는 `resources.yaml`을
  참조하지 않는다(파일 grep, 일치 없음).
- **F3.** 레지스트리는 명시적 DDL 파일 목록에서 5개 테이블을 다룬다(`policies/data-standards.yaml:8-16`). `schema_sources`에 추가되지 않은
  새 DDL 파일은 검사기가 보지 못한다(`docs/data-standards.md`는 범위가 대표 5개 테이블이라고 밝힌다).

### 2.2 쿼리 계층: Trino + OPA (테이블 단위, 기본 거부)

- `default allow := false`([`trino.rego:6`](../gitops/charts/beluga-platform/files/opa/trino.rego#L6)). `iceberg.lake.customers`에 대한
  `SelectFromColumns`는 그룹 `admins`/`engineers`에게만 허용된다(`trino.rego:31-39`). `lake.orders`와
  `lake.events_enriched`는 `analysts`도 허용한다(`:51-59`, `:101-109`). 규칙이 없는 테이블은 누구에게도 데이터 접근 allow가 없다
  (규칙 본문을 읽은 결과; 완전히 새로운 Iceberg 테이블에 대한 라이브 테스트는 `tests/`에서 **찾지 못했다**).
- 카탈로그 탐색은 테이블 단위가 아니라 카탈로그 전체 단위다: `FilterTables`, `FilterColumns`, `ShowColumns`, `ShowCreateTable`은
  `iceberg` 카탈로그의 모든 테이블에 대해 `analysts`에게 허용된다(`trino.rego:174-196`, `:206-220`). 따라서 분석가는 `lake.customers`의
  `email`을 포함한 테이블과 컬럼 **이름**(값 아님)을 볼 수 있다. 이것이 허용 가능한지는 소유자 결정이다(D5).
- 라이브 회귀: `tests/07-trino-authz-live.sh:112-119`는 `iceberg.lake.customers`에 대한 분석가 `SELECT`가 거부됨을 단언한다.

### 2.3 쿼리 계층: 마스킹은 배선되어 있으나 비어 있다

- Trino에는 `opa.policy.column-masking-uri`와 `opa.policy.row-filters-uri`가 설정되어 있다
  ([`06-trino.yaml:165-166`](../gitops/charts/beluga-data/templates/06-trino.yaml#L165)). Trino 문서는 이 URI가 없으면 마스킹이나
  필터링이 적용되지 않는다고 밝히며, OPA 규칙이 undefined일 때의 동작은 **해당 페이지에 문서화되어 있지 않다** [S1].
- `trino.rego`에는 `columnMask`나 `rowFilters` 규칙이 **하나도 없다**(파일 확인; 라이브: 배포된 `opa-policies` ConfigMap의 `trino.rego`에 두 문자열 모두 없음, 2026-10-07 확인).
  설계 스펙도 이미 이를 기록했다([`2026-08-09-beluga-data-platform-design.md:395`](superpowers/specs/2026-08-09-beluga-data-platform-design.md)).
- 컴파일러는 grant의 `columnMask:`로부터 마스크(`hash`, `partial`, `null`)를 생성할 수 있지만
  (`beluga-manager/packages/policy-compiler/src/compiler/rego.ts:6-10`, `:171-186`), `policies/resources.yaml`의 어떤 grant도 이를 선언하지 않는다.
  **결론: 현재 마스킹되는 컬럼은 어디에도 없으며, PII 보호는 "테이블 거부"다.**

### 2.4 스토리지/카탈로그 계층: Lakekeeper + OpenFGA

- Lakekeeper는 `LAKEKEEPER__AUTHZ_BACKEND=openfga`로 동작한다(라이브, `lakehouse/lakekeeper`; 차트 `04-lakekeeper.yaml:49-52`).
- 시드된 할당은 두 **서비스 계정**(`service-account-trino`, `service-account-flink`)에 대한 웨어하우스 단위 `describe/select/create/modify`뿐이다
  ([`12-lakekeeper-bootstrap.yaml:158-170`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L158)). 사람 주체도, 분류 입력도 없다.
- Lakekeeper는 server, project, warehouse, namespace, table, view, role 객체에 대한 인가와 상위에서 하위로의 상속을 문서화하며,
  컬럼/행 단위 통제는 언급하지 않는다 [S2]. 따라서 Lakekeeper는 **테이블이나 네임스페이스**를 격리할 수 있어도 컬럼은 격리할 수 없다.
- 결과: Trino 자신의 신원은 모든 Iceberg 테이블을 읽을 수 있고, 사람 대상 통제는 Trino OPA뿐이다. Iceberg나 오브젝트 스토리지를 직접 읽는
  향후 엔진(예: DuckDB 경로, 이슈 #61-#65)은 Trino OPA를, 따라서 모든 컬럼 마스크를 우회한다.

### 2.5 원천 데이터베이스와 스트림

- PostgreSQL: 테이블 단위 `GRANT`만 있다; `public.customers`는 `engineers`에게만 부여된다(`db-roles.sql:35-41`); 컬럼 권한이나 마스킹은 없다.
  `tests/06-authz-defaults.sh:26-35`는 새 테이블을 `analysts`가 select할 수 없음을 단언한다(기본 거부, PostgreSQL 한정).
- Kafka: Debezium 토픽 `cdc.shop.public.customers`는 PII 컬럼을 마스킹 없이 담는다(`flink-sql/cdc_customers.sql:26-34`, 소스 테이블 정의).
  **라이브 2026-10-07:** Kafka 리스너는 `plain` 9092이고 `spec.kafka.authorization`은 비어 있다; 차트 옵션 `strimzi.opaAuthorizer`와
  `strimzi.aclAuthorizer`의 기본값은 `false`다(`values.yaml:37`, `:48`; `03-strimzi-kafka.yaml:44-54`). `kafka.rego`는 분석가 전용 deny 규칙이 있는
  `default allow = true`다(`kafka.rego:15`, `:26-29`). 따라서 분류는 스트림 계층에 도달하지 않는다.

### 2.6 카탈로그/거버넌스 계층: OpenMetadata

- 선택적이며 게이트되어 있다: 기본 `openmetadata.enabled: false`([`values.yaml:58-59`](../gitops/charts/beluga-data/values.yaml#L58)); 템플릿은 서버, OpenSearch,
  `DefaultAuthorizer`와 관리자 주체 `admin`을 쓰는 OIDC 로그인을 배포한다(`11-openmetadata.yaml:1`, `:179-205`). **라이브:** `governance` 네임스페이스에서
  `openmetadata`와 `opensearch`(1.13.3)가 실행 중이다.
- 분류, 소유자, 태그를 OpenMetadata로 푸시하는 저장소 산출물은 없다(grep: 차트 템플릿, 문서, 버전 고정만 언급하며 스크립트나 잡은 없음). `docs/data-standards.md`는
  OpenMetadata 통합을 범위 밖으로 둔다. 라이브 카탈로그의 내용은 **라이브 미검증**이다(API 토큰 미사용).
- 업스트림: OpenMetadata는 컬럼 이름 스캐너와, 선택적으로 **샘플 데이터**에 대한 엔티티 인식을 통한 자동 분류(`PII.Sensitive`, `PII.NonSensitive`)를 문서화한다 [S3].
  Trino 커넥터 페이지는 `Owners`와 `Tags`를 미지원 기능으로 나열하므로 [S4], 소유자/태그는 Trino에서 읽히지 않고 다른 경로로 들어와야 한다.

### 2.7 기존 테스트

정적: `tests/14-policy-compiler-seam.sh`(Rego와 `db-roles.sql`이 diff 0으로 재생성됨; 변조 자가 검증), `make validate`(data-standards 검사).
라이브: `tests/06`, `tests/07`(위). **다루지 않는 것:** 새 Iceberg 테이블, 마스킹 grant, 파생 테이블, OpenMetadata 라벨.

## 3. 인수 기준 대비 격차

| ID | 격차 | 기준 |
|---|---|---|
| G1 | 분류 원천이 둘(레지스트리와 `resources.yaml`)이며 PII 컬럼 집합과 값 집합이 다르고 교차 검증이 없다(F1, F2) | 선언적 |
| G2 | 테이블 단위 `classification`이 grant를 구동하지 않으며 grant는 리소스별로 수작업 작성된다 | 선언적 |
| G3 | 새 Iceberg 테이블(또는 `schema_sources` 밖의 새 DDL 파일)이 분류 및 grant 전까지 분석가에게 거부됨을 보이는 정적/라이브 테스트가 없다(F3) | 새 테이블 |
| G4 | 마스킹 grant, `columnMask` 규칙, 테스트가 없다(2.3) | 마스킹 접근 |
| G5 | Kafka 스트림과 스토리지 직접 읽기 주체는 OPA 컬럼 통제 밖이다(2.4, 2.5) | 일관성 |
| G6 | 분류/소유자/steward가 OpenMetadata와 동기화되지 않으며 레지스트리에 steward 필드가 없다(`owner: data-platform`뿐) | 카탈로그 가시성 |
| G7 | 파생 테이블에 대해 집행되는 전파 규칙이 없다(메달리온 5.3절 규칙은 산문뿐) | 파생 데이터셋 |

## 4. 제안 (제안)

설계 제약: **접근을 절대 넓히지 않는다**; 기본 거부; 분류는 제한만 추가할 수 있다; 마스킹은 해당 롤이 읽을 수 없는 테이블을 읽게 하지 않는다;
PII는 명시적이고 검토된 grant를 통해서만 롤에 도달한다.

### 4.1 분류 체계와 메타데이터

`internal | pii`를 지원 값으로 유지한다(레지스트리가 집행하는 값). `public`과 비PII `confidential` 값은 **소유자 결정**이다(D1): 추가하려면
레지스트리 검증기와 컴파일러 스키마를 함께 바꿔야 하며 한쪽만 바꿔서는 안 된다. `owner` 옆에 `steward`를 필수 테이블 필드로 추가한다(D2);
이슈는 owner/steward를 요구하나 레지스트리에는 `owner`뿐이다.

### 4.2 단일 원천, CI에서 교차 검증

- `policies/resources.yaml`을 **집행** 원천으로, `policies/data-standards.yaml`을 **메타데이터** 원천으로 유지한다(세 번째 파일 없음).
- 제안하는 정적 검사(기존 검사기 확장, 새 도구 없음): `classification`이 `pii`인 모든 레지스트리 테이블에 대해, `resources.yaml`에 `classification: pii`이고
  `sensitiveColumns`가 레지스트리에서 `pii`로 표시된 컬럼 집합과 같은 리소스가 있어야 한다; 모든 `resources.yaml` 리소스는 레지스트리 항목이 있어야 한다;
  불일치는 `make validate`를 실패시킨다. 이로써 F1이 실패하는 테스트가 된다.
- 제안하는 완전성 검사: `flink-sql/`와 shop 스키마 아래의 모든 `CREATE TABLE` DDL은 `schema_sources`에서 도달 가능해야 한다(F3 해소). 등록되지 않은 테이블은
  보이지 않는 대신 CI에서 실패한다.
- 새 데이터셋 기본 거부: `default allow := false`를 유지하고 와일드카드 grant를 추가하지 않는다. 새 테이블은 레지스트리 항목(CI)과
  리소스 항목(컴파일러 산출물)이 생기기 전까지 읽을 수 없다. 레지스트리 분류 없이 리소스 grant를 추가하는 PR은 리뷰어가 반려해야 한다.

### 4.3 분석가용 마스킹 접근 (시연 하나, 옵트인)

- 기본값이 아니다. 현재 분석가는 `lake.customers`에 대한 접근이 **전혀 없으며**, 마스킹 접근은 소유자가 승인할 때만의 추가 grant다(D3). 승인 시
  `lake.customers`에 `analysts`용 `privileges: [select]` grant를 추가하고 레지스트리 `pii` 컬럼 **전부**(`name`, `email`, `city`)에 컴파일러의 기존 마스크 종류로
  `columnMask`를 건다. 컴파일러는 `sensitiveColumns`만 마스킹을 요구하므로 먼저 `sensitiveColumns`를 `[name, email, city]`로 확장해야 한다(G1).
- 컬럼별 마스크 종류는 소유자 결정이다(D4). 판단이며 업스트림 권고가 아니다(**공식 권고 없음**): `hash`는 조인 가능성을 유지하지만 저엔트로피 값의 결정적 해시라
  사전 대입으로 복원될 수 있다; `null`이 가장 안전한 기본값이다; `partial`(`substr(col,1,2)||'***'`)은 여전히 접두부를 드러낸다.
- `engineers`는 `allowUnmasked: true`를 유지하며 컴파일러는 이미 이들을 분석가 마스크에서 제외한다(`rego.ts:104-138`).
- Trino 전용 한계(2.4)로 인해 마스킹 grant는 **Trino 전용**이다: 분석가 마스킹 grant가 있는 테이블은 마스크를 적용할 수 없는 어떤 엔진을 통해서도 사람에게 노출되어서는 안 된다.

### 4.4 카탈로그와 스토리지 규칙

- `pii` 테이블에 대해 Lakekeeper OpenFGA에 사람 주체를 추가하지 않는다. 네임스페이스/테이블 할당이 도입되면(메달리온 Q2) 같은 `resources.yaml`에서 컴파일하고,
  이미 Trino grant를 가진 롤에게만 테이블을 부여한다.
- 스토리지 직접 읽기 주체(DuckDB 등): 분류가 `internal`인 테이블만 읽을 수 있다; `pii` 테이블은 Trino를 통해서만 접근 가능하다(D6).
- 탐색: `pii` 테이블에 대해 `FilterColumns`/`ShowColumns`를 부여된 테이블로 제한할지 결정한다(D5). 제한하려면 컴파일러에 테이블별 카탈로그 규칙이 필요하며 4.2-4.3보다 큰 변경이다.
- Kafka: 여기서는 범위 밖이며 Kafka 인가 작업에서 추적한다. 인가자가 활성화되기 전까지 스트림 계층에서 분류가 **집행되지 않음**을 매트릭스에 명시한다.

### 4.5 OpenMetadata 가시성

- 라벨의 원천은 레지스트리(Git)이며, 작은 reconcile 잡이 OpenMetadata에 적용한다(제안, `openmetadata.enabled`일 때만 실행): 테이블 태그/분류, 컬럼 태그, 소유자/steward.
  방향은 Git에서 OpenMetadata로만이며, OpenMetadata 편집은 분류를 완화하지 않는다(역기록 없음).
- `pii`를 OpenMetadata `PII.Sensitive`에 매핑하는 것은 소유자 결정이다(D7); `internal`에 대응하는 OpenMetadata 내장 태그는 읽은 페이지에 없다.
- 자동 분류를 쓴다면 **`pii` 테이블의 샘플 데이터 수집을 비활성화**한다: 엔티티 인식은 샘플 값을 처리하므로 [S3] PII가 카탈로그에 복사된다. 샘플 데이터가 카탈로그 열람자에게
  보이는지와 `DefaultAuthorizer` 롤이 이를 어떻게 제한하는지는 **라이브 미검증**이다.
- 파생 데이터셋으로의 전파는 [`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md)의 리니지 설계를 쓴다: 파생 테이블은 문서화된 변환이 하향을 정당화하지 않는 한 가장 민감한 입력 컬럼
  이상으로 민감하다(메달리온 5.3). 선언된 `derived_from`에 대한 레지스트리 검사로 집행한다(해당 문서 참고).

### 4.6 보존 훅

각 `pii` 테이블의 레지스트리 `retention`은 [`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md)가 이미 정의한 훅이다; `pii` 테이블에 대한 삭제/파기 요청(#30)은 같은
`derived_from` 선언으로 찾은 파생 테이블을 포함해야 한다. 여기서는 기간을 정하지 않는다.

## 5. 검증 및 테스트 아이디어

| 테스트 | 유형 | 통과 조건 |
|---|---|---|
| 레지스트리와 `resources.yaml`의 PII 컬럼 집합 동일성 | 정적, `make validate` | `sensitiveColumns`를 고치기 전에는 현재의 불일치로 실패; 고친 뒤 통과 |
| 자가 검증: `sensitiveColumns`에서 PII 컬럼 제거 | 정적 부정 | 검사기 실패 |
| `schema_sources`에 없는 새 DDL 파일 | 정적 부정 | 검사기 실패 |
| 레지스트리/리소스 항목이 없는 새 Iceberg 테이블 | 라이브, 테스트 07 확장 | 분석가와 엔지니어 `SELECT` 모두 거부 |
| 분석가 마스킹 select (D3 승인 시에만) | 라이브 | `email`, `name`, `city`가 마스킹됨; 엔지니어는 원문; 분석가는 마스킹 없는 변형을 select할 수 없음(파생 표현식 `SELECT`도 마스킹됨) |
| `lake.customers`에서 만든 파생 테이블 | 정적 | 레지스트리 `derived_from` 입력이 `pii`이고 파생 테이블이 더 낮게 표시되지 않음 |
| `allowUnmasked`가 아닌 롤에 부여된 모든 `pii` 컬럼에 대해 컴파일된 Rego에 `columnMask`가 있음 | 정적 | 컴파일러 산출물과 diff 0(기존 테스트 14) |

## 소유자 결정 사항

| ID | 결정 | 권고 |
|---|---|---|
| D1 | `public` 또는 비PII `confidential` 값 추가 | 지금은 아니오; `internal\|pii` 유지 |
| D2 | 필수 `steward` 필드 추가 | 예 |
| D3 | 분석가에게 `lake.customers` 마스킹 접근 부여 | 소비자가 필요로 할 때까지 아니오; 거부 유지 |
| D4 | 컬럼별 마스크 종류 | 기본 `null`; 조인 키가 필요한 곳에만 `hash` |
| D5 | `pii` 테이블의 컬럼/테이블 탐색 제한 | 보류; 위험 낮음(이름만) |
| D6 | 스토리지 직접 읽기 주체를 `internal` 테이블로 제한 | 예 |
| D7 | `pii`의 OpenMetadata 태그 매핑과 자동 분류 실행 여부 | `pii`를 `PII.Sensitive`에 매핑; 자동 분류는 `pii` 테이블에 샘플 데이터 없이만 실행 |

## 후속 구현 작업 (순서대로)

1. 두 `customers` 리소스의 `sensitiveColumns`를 `[name, email, city]`로 확장(및 컴파일). 테스트: 작업 2의 교차 검사 통과; 테스트 14 diff 0.
2. `scripts/ci/check-data-standards.py`에 레지스트리-`resources.yaml` 교차 검사와 `schema_sources` 완전성 검사를 픽스처와 함께 추가. 테스트: 부정 픽스처 실패.
3. 새 Iceberg 테이블 거부 케이스를 라이브 스위트에 추가. 테스트: 분석가와 엔지니어 `SELECT` 거부.
4. (D3 승인 시) 분석가 마스킹 grant와 라이브 마스킹 select 테스트 추가. 테스트: 분석가는 마스킹 값, 엔지니어는 원문.
5. 레지스트리와 검증기에 `steward` 추가. 테스트: steward 누락 시 실패.
6. 태그/소유자/steward용 OpenMetadata reconcile 잡(활성 시에만). 테스트: `customers`에 라벨 표시; OpenMetadata에서 지운 태그가 다음 실행에서 복구.
7. `derived_from`을 쓰는 파생 테이블 검사(리니지 문서 참고). 테스트: `pii` 입력의 파생 테이블이 `internal`로 표시되면 실패.

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | Trino 483, OPA access control (컬럼 마스킹과 행 필터): https://trino.io/docs/483/security/opa-access-control.html |
| S2 | Lakekeeper v0.13.1, Authorization with OpenFGA: https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/authorization-openfga.md |
| S3 | OpenMetadata, Auto Classification: https://docs.open-metadata.org/latest/how-to-guides/data-governance/classification/auto-classification |
| S4 | OpenMetadata, Trino connector: https://docs.open-metadata.org/latest/connectors/database/trino |
