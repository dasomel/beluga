# 기계 집행 가능한 데이터 계약 표준 (제안)

[English](data-contract-standard.md) | 한국어

이슈 #91("데이터 제품 전반에 기계 집행 가능한 Open Data Contract Standard 채택")을 참조한다.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 매니페스트, DAG, 스크립트, 정책, 레지스트리, `VERSIONS.md` 값을 변경하지 않으며 계약 파일도 추가하지 않는다.
> 저장소에 관한 서술은 커밋 `9f74c2b`에서 읽은 `file:line`을 붙였다. 외부 사실은 `[S#]`로 인용하며
> ([출처](#출처) 참고, 접근일 2026-10-07), 읽은 페이지가 침묵하는 곳은 **읽은 페이지에 없음** 또는
> **공식 권고 없음**으로 적고, 읽지 않은 필드 이름은 사용하지 않는다. **제안**으로 표시한 항목은 구현되지 않았다.

관련 문서: [`medallion-architecture-ko.md`](medallion-architecture-ko.md)(5.1절 스키마 진화), [`data-standards-ko.md`](data-standards-ko.md),
[`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md), [`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md),
[`data-quality-framework-ko.md`](data-quality-framework-ko.md), [`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md).

## 1. 목적과 이슈 매핑

| 이슈 #91 인수 기준 | 절 |
|---|---|
| 대표 Gold 데이터 제품에 버전이 있는 기계 판독 가능 계약이 있다 | 4.1, 4.6 |
| 파괴적 스키마 변경이 게시 전에 거부된다 | 4.3, 4.4 |
| 품질/SLA 기대치가 계약에 대해 검증된다 | 4.4 |
| 계약 메타데이터가 카탈로그에서 보이고 리니지와 연결된다 | 4.5 |
| API/이벤트/데이터 계약이 호환되지 않는 정의의 중복 없이 연관된다 | 4.7 |
| 계약 이력과 승인이 감사 가능하다 | 4.8 |

이슈 참고 링크 정정: `github.com/datacontract/datacontract-specification` 링크는 **Data Contract Specification**이며, 그 README는 ODCS v3.1.0 출시와 함께 폐기(deprecated)되었다고 밝힌다
(지원은 2026년 말까지 계속된다고 명시) [S1]. Open Data Contract Standard는 `github.com/bitol-io/open-data-contract-standard`에서 관리된다 [S2].

## 2. 현재 상태 (검증됨)

- 저장소에는 **데이터 계약이 없다**: `datacontract`, `odcs`, `data contract`, `asyncapi` 검색에서 계약 파일이 나오지 않으며, `docs/critical-interfaces-inventory.md:78`은 공식 계약 산출물
  (OpenAPI, Avro/Protobuf 레지스트리, 호환성 SLA, 폐기 일정)이 "이 저장소에 수립되지 않았다"고 밝힌다.
- **가장 가까운 산출물: 데이터 표준 레지스트리.** [`policies/data-standards.yaml`](../policies/data-standards.yaml)은 테이블별 `owner`, `classification`, `description`, `retention`, `freshness`와
  컬럼별 `description`, `classification`을 담고(`:25-28`), `make validate`의 `scripts/ci/check-data-standards.py`가 정적으로 검사한다(`Makefile:68`). 버전, 소비자 목록, 품질 규칙, 사용 조건, 호환성 검사가 없으며,
  스스로 헤더에서 Git 레지스트리이지 런타임 상태가 아니라고 밝힌다(`check-data-standards.py:29-31`).
- **스키마의 단일 진실 원천**은 Git의 DDL이다(`gitops/charts/beluga-data/files/flink-sql/*.sql`, `shop-schema.sql`); `lake.events_enriched`는 유일한 Gold 유사 테이블(`medallion-architecture.md` 4절)로 컬럼 5개,
  보존 `P90D`, 최신성 `PT5M`이다(`policies/data-standards.yaml:98-112`).
- 계약이 모순되어서는 안 되는 **집행 원천**: `policies/resources.yaml`의 접근(Trino OPA와 PostgreSQL grant로 컴파일됨), PII 문서의 분류, 품질 문서의 품질 게이트. 현재 파이프라인 게이트는 없다(`medallion-architecture.md` 4절).
- CI 도구는 해시 고정된 PyYAML만 있는 Python이다(`requirements-ci.txt`, `.github/workflows/ci.yml:57`에서 `--require-hashes`로 설치). 검증기 의존성을 추가하려면 저장소의 의존성 고정 및 라이선스 검토가 필요하다(`policies/license-policy.yaml:1-7`).

### 표준이 문서화한 것 (게시된 페이지에서 읽음 [S2-S8])

- 현재 버전: 저장소는 **v3.2.0**이라 밝히고; `apiVersion` 필드의 기본값이 `v3.2.0`이며; `kind`는 `DataContract`여야 한다 [S2, S3]. 읽은 페이지가 설명하는 절: fundamentals, schema, context, references, data quality, support, pricing, team, roles, service-level agreement, infrastructure/servers, custom properties, authoritative definitions, tags, variables [S4]. 라이선스 Apache-2.0 [S2].
- Fundamentals 필드: `apiVersion`, `kind`, `id`, `name`, `version`, `status`(예시 `proposed`, `draft`, `active`, `deprecated`, `retired`), `tenant`, `domain`, `description`(purpose, limitations, usage의 컨테이너), `tags`, `customProperties`, `authoritativeDefinitions`; `dataProduct`는 v3.1.0부터 폐기 [S3].
- 스키마 객체: `name`, `id`, `logicalType`, `physicalType`, `physicalName`, `description`, `businessName`, `deprecated`, `tags`, `authoritativeDefinitions`, `synonyms`, `customProperties`, `dataGranularityDescription`, `quality`. 스키마 속성은 추가로: `classification`, `criticalDataElement`, `primaryKey`, `primaryKeyPosition`, `required`, `unique`, `partitioned`, `semanticType`, `transformSourceObjects`, `transformLogic`, `transformDescription`, `enum`, `examples` 등 [S5].
- 품질: 규칙 `type`은 `text`, `library`, `sql`, `custom`; 차원 `accuracy`, `completeness`, `conformity`, `consistency`, `coverage`, `timeliness`, `uniqueness`; 비교 연산자 `mustBe`, `mustNotBe`, `mustBeGreaterThan`, ...; `severity`, `scheduler`/`schedule`, `engine`(예시 `soda`, `greatExpectations`) [S6].
- SLA: `property`, `value`, `unit`, `element`, `driver`를 가진 `slaProperties` 항목; 속성 이름 `availability`, `throughput`, `errorRate`, `generalAvailability`, `endOfSupport`, `endOfLife`, `retention`, `frequency`, `latency`, `timeToDetect`, `timeToNotify`, `timeToRepair`; `latency`는 "freshness보다 선호됨" [S7].
- Team: `members`(`username`, `role`(예시 owner, data steward), `dateIn`, `dateOut`, `replacedByUsername`)를 가진 `team` [S8]. 별도 **roles** 절의 필드는 **읽은 페이지에 없었다**.
- **읽은 페이지에서 찾지 못한 것:** 호환성 또는 파괴적 변경 규칙, 리니지 절, 유효 시작일 필드, OpenAPI/AsyncAPI와의 매핑, `classification` 값 어휘. 각각에 대해 **공식 권고 없음**을 주장하며,
  아래 제안은 Beluga 규칙을 정의하고 그렇게 표시한다. 저장소의 JSON Schema는 표준을 정의하지 않고 "버그가 있을 수 있는" 동반 자료로 설명된다 [S4].

## 3. 인수 기준 대비 격차

| ID | 격차 |
|---|---|
| G1 | 계약 형식, 파일 위치, 예시가 없다 |
| G2 | 호환성 분류나 검사가 없다; 비교할 기준선이 없다 |
| G3 | 게시 게이트가 없다(그리고 현재 Silver/Gold 게이팅 자체가 없다) |
| G4 | 진실 중복 위험: 분류, 소유자, 보존, 최신성이 이미 레지스트리에 있으며 계약이 이와 모순될 수 있다 |
| G5 | 카탈로그/리니지 연결이 없다(OpenMetadata는 선택적; 기록된 리니지 없음) |
| G6 | Git 이력 외 승인 추적이 없다; 상태 수명주기가 없다 |
| G7 | 데이터 계약과 API/이벤트 정의 간 관계가 없다(둘 다 없음: `critical-interfaces-inventory.md:78`) |

## 4. 제안 (제안)

### 4.1 ODCS v3.2.0을 선호 형식으로 채택

- 계약 파일: `contracts/<domain>.<product>.yaml`(제안 경로), `apiVersion: v3.2.0`, **데이터 제품**당 파일 하나(Gold 우선). `dataProduct`는 사용하지 않는다(폐기됨) [S3].
- 버전 결정은 소유자가 고정한다(D1): `v3.2.0`을 고정하고 업그레이드할 때마다 업스트림을 재확인한다; 표준 자체 버전 간 호환 동작은 **읽지 않았다**.
- 레지스트리는 모든 테이블의 테이블 단위 거버넌스 기준선으로 남고, 계약은 제품 단위의 더 풍부한 인터페이스다. 이 제안은 어떤 도구, SDK, CLI도 채택하지 않는다(평가한 것 없음; 먼저 라이선스/SBOM 검토 필요).

### 4.2 필드 매핑 (사실당 단일 원천)

| 사실 | 권위 있는 원천 | ODCS 필드(검증된 이름) | 규칙 |
|---|---|---|---|
| 테이블 스키마(이름, 타입, 키, required) | Git의 DDL | `schema[].name`, `physicalName`, 스키마 속성(중첩 키 이름은 읽지 않음), `primaryKey`, `required`, `unique` | CI: 계약이 DDL과 같음 |
| 분류 | 레지스트리, `resources.yaml`이 집행 | 속성 `classification`, 객체 `tags` | CI: 레지스트리와 같음; 읽은 페이지에서 ODCS는 값 어휘를 정의하지 않으므로 Beluga 값 `internal`, `pii`를 그대로 사용 |
| 소유자 / steward | 레지스트리(`owner`, 제안 `steward`) | `role`을 가진 `team.members[]` | CI: 같음 |
| 보존 | 레지스트리 | `slaProperties`의 속성 `retention` | CI: 레지스트리 `retention`과 같음 |
| 최신성 목표 | 레지스트리 `freshness` | `slaProperties`의 속성 `latency` | CI: 같음; 분(minute) 단위 표기는 읽은 페이지에서 확인되지 않음 |
| 품질 기대치 | 규칙 파일([`data-quality-framework-ko.md`](data-quality-framework-ko.md)) | `quality[]`(`type`, `dimension`, `severity`, `schedule`) | 규칙 id를 참조하며 복사하지 않음 |
| 수명주기 상태, 유효/만료 | 계약 | `status`; `slaProperties`의 `endOfSupport`, `endOfLife`; 유효 시작일: 읽은 필드 없음, `customProperties` 사용(D3) | 상태 전이는 4.8 |
| 사용 조건 / 제한 | 계약 `description`(purpose, limitations, usage) | `description` | 텍스트 전용 |
| 소비자 접근 | `policies/resources.yaml` | 없음: 계약은 의도된 소비자 롤을 **나열**할 수 있으나 집행은 정책에 남는다 | CI: 나열된 롤은 이미 grant를 가져야 하며; 계약은 grant를 만들 수 없다 |
| 리니지 | 레지스트리 `derived_from`([`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md)) | 속성 `transformSourceObjects`(힌트로), 링크용 `authoritativeDefinitions` | CI: 레지스트리와 일관; 두 번째 리니지 원천 없음 |

보안 설계: 계약은 **서술적이며 제한적일 뿐**이다. 접근을 부여하거나, 분류를 낮추거나, 마스킹을 완화할 수 없다; 기존 grant 없이 소비자 롤을 나열하거나 레지스트리보다 낮게 컬럼을 분류하면 CI가 실패한다.

### 4.3 호환성 분류 (Beluga 규칙; 읽은 페이지에서 ODCS는 정의하지 않음)

| 게시된 계약에 대한 변경 | 분류 | 규칙(메달리온 5.1과 정렬) |
|---|---|---|
| 새 nullable 속성 | additive | 검토된 변경으로 허용; 마이너 버전 |
| 속성을 `deprecated`로 표시 | deprecated | 허용; 소비자에게 통지; 폐기 기간 이전에는 제거 불가(기간 길이는 소유자 결정, D4) |
| 제거, 이름 변경, 타입 변경, nullable에서 `required`로, `unique`/키 강화 | breaking | 이전 것과 나란히 새 메이저 버전/테이블 이름을 게시하지 않는 한 거부 |
| 폐기 기간 이후 제거 | removed | 새 메이저 버전의 일부로서만 허용 |
| 분류 하향, 보존 단축 또는 SLA 약화 | policy-breaking | 기록된 소유자 승인 없이는 거부(자동 아님) |

### 4.4 검증 지점

- **CI(`make validate`), 제안:** 계약 파일의 스키마 유효성(라이선스/고정 검토 후에만 ODCS JSON Schema를 쓰며 [S4]에 따라 동반 자료로 취급; 그렇지 않으면 저장소 내 최소 구조 검사), 계약 대 DDL, 계약 대 레지스트리/`resources.yaml`(4.2),
  이전 릴리스 버전에 대한 호환성(4.3). 픽스처의 의도적 파괴적 변경은 실패해야 한다.
- **게시 게이트(런타임), 제안:** Gold 테이블을 게시하는 파이프라인 태스크가 실제 Iceberg 스키마(Trino `information_schema`)를 계약과 비교하고 계약의 품질 규칙([`data-quality-framework-ko.md`](data-quality-framework-ko.md) 4.3절)을 실행한다;
  불일치나 critical 규칙 실패는 게시를 차단한다. 이는 메달리온 작업의 Silver/Gold 게이팅이 필요하며, 그 전에는 CI 검사만 가능하다.
- **SLA 검사:** 최신성과 보존 목표를 리니지 문서(해당 문서 4.4절)의 측정값과 라이프사이클 정책에 비교한다.

### 4.5 카탈로그와 리니지 연결

OpenMetadata가 활성이면 reconcile 잡(다른 제안 참고)이 계약(`id`, `version`, `status`, 파일 링크)을 테이블에 붙인다. 계약과 리니지의 연결은 레지스트리 간선을 쓰며 계약은 자체 리니지를 갖지 않는다.
OpenMetadata 1.13.3에 네이티브 계약 엔티티가 있는지는 이 문서를 위해 **확인하지 않았다**.

### 4.6 대표 Gold 제품

제안하는 첫 계약: `lake.events_enriched`(컬럼 5개; 분류 `internal`; 보존 `P90D`; 최신성 `PT5M`; 값은 `policies/data-standards.yaml:98-112`). 위에서 검증한 필드 이름만 사용한
예시 골격이며(주석으로 표시한 두 키 제외), `id`는 한 번 생성하고 타입의 값 어휘는 파일을 추가하기 전에 확인해야 한다:

```yaml
apiVersion: v3.2.0
kind: DataContract
id: <generated-uuid>
name: events-enriched
version: 1.0.0
status: draft
description:
  purpose: <owner text>   # key name to be confirmed: page describes purpose/limitations/usage only
team:
  members:
    - username: <owner>
      role: owner
schema:
  - name: events_enriched
    physicalName: lake.events_enriched
    properties:   # nesting key name to be confirmed against the schema page
      - name: user_id
        classification: internal
      # window_start, window_end, event_count, total_duration_ms follow the DDL
slaProperties:
  - property: retention
    value: 90
    unit: d
```

메달리온 제안은 이 테이블의 이름을 바꾸므로(`gold_web.user_activity_1m`), 그때 계약의 `physicalName`은 **새 메이저 버전**으로 바뀌어야 하며, 이것이 유용한 첫 호환성 테스트가 된다.

### 4.7 API, 이벤트, 데이터 계약의 연관

OpenAPI(#78)나 AsyncAPI 정의가 존재하면 데이터 계약은 `authoritativeDefinitions`로 이를 참조하며 스키마를 복사하지 않는다; OpenAPI/AsyncAPI와 ODCS 필드 간 매핑은 **읽은 페이지에 문서화되어 있지 않으므로**(공식 권고 없음)
필드 수준의 대응은 지명된 하나의 진실 원천에 대해 CI가 검사하는 Beluga 규칙이다. 현재 OpenAPI/AsyncAPI 정의는 없다. Kafka 전송 스키마는 레지스트리 범위 밖이다(`docs/data-standards.md`);
이에 계약을 둘지는 소유자 결정이다(D5).

### 4.8 이력과 승인

Git 이력과 풀 리퀘스트 리뷰가 감사 추적이다; `status`는 `draft -> active -> deprecated -> retired`([S3] 예시의 이름)를 따르며 각 전이는 승인자를 명시한 검토된 커밋에 담긴다. `status: active`인 계약은
버전 증가 없이 변경할 수 없다(CI). 생성된 산출물(문서 페이지, 호환성 보고서)은 CI 출력이며 수작업으로 편집하지 않는다.

## 5. 검증 및 테스트 아이디어

| 테스트 | 유형 | 통과 조건 |
|---|---|---|
| `events_enriched` 계약이 DDL과 같음 | 정적 | DDL에만 컬럼이 추가되면 실패 |
| 파괴적 변경 픽스처(삭제/이름 변경/타입 변경) | 정적 부정 | 거부 |
| 추가적 변경 픽스처 | 정적 | 마이너 버전 증가와 함께 통과 |
| 계약의 분류가 레지스트리보다 낮음 | 정적 부정 | 거부 |
| `resources.yaml`에 grant 없이 나열된 소비자 롤 | 정적 부정 | 거부 |
| 버전 증가 없이 `active` 계약 편집 | 정적 부정 | 거부 |
| Gold 게시 전 라이브 스키마 불일치 | 라이브 | 게시 차단 |
| 보존/최신성이 레지스트리와 같음 | 정적 | 통과; 불일치 시 실패 |

## 소유자 결정 사항

| ID | 결정 | 권고 |
|---|---|---|
| D1 | ODCS `v3.2.0` 고정 | 예, 업그레이드 시 재검증 |
| D2 | 계약 파일을 레지스트리에서 생성할지 CI 동일성 검사와 함께 수작업 작성할지 | Gold는 수작업 작성, 공유 필드는 CI 동일성 |
| D3 | 유효 시작일 기록 위치(읽은 필드 없음) | `customProperties`, 만료는 `endOfSupport`/`endOfLife` |
| D4 | 제거 전 폐기 기간 | 공식 권고 없음; 소유자가 정함 |
| D5 | Kafka 전송 스키마에 대한 계약 | 레지스트리 범위가 확장될 때까지 보류 |
| D6 | 외부 ODCS 도구/CLI 채택 | 지금은 아니오; CI 검사가 생긴 뒤 라이선스/SBOM 검토와 함께 평가 |
| D7 | 대표 제품 | `lake.events_enriched` |

## 후속 구현 작업 (순서대로)

1. `events_enriched` 계약이 있는 `contracts/`와 `scripts/ci`의 최소 구조 검증기 추가. 테스트: 잘못된 픽스처 실패.
2. 계약 대 DDL, 계약 대 레지스트리/`resources.yaml` 검사. 테스트: 위의 부정 픽스처 실패.
3. 이전 태그 버전에 대한 호환성 검사기. 테스트: 파괴적/추가적 픽스처.
4. 문서 페이지와 호환성 보고서를 CI 산출물로 생성. 테스트: 산출물 존재, 수작업 편집 없음.
5. Gold 게시 태스크에 게시 게이트 비교 연결(메달리온 Silver/Gold가 생긴 뒤). 테스트: 스키마 불일치가 차단.
6. 계약 메타데이터의 OpenMetadata 연결(활성 시). 테스트: 테이블에 계약 id/버전이 보임.
7. CI의 상태 수명주기 및 승인 검사. 테스트: 버전 증가 없는 `active` 편집이 실패.

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | Data Contract Specification README (폐기 공지): https://github.com/datacontract/datacontract-specification |
| S2 | Open Data Contract Standard 저장소: https://github.com/bitol-io/open-data-contract-standard |
| S3 | ODCS, Fundamentals: https://bitol-io.github.io/open-data-contract-standard/latest/fundamentals/ |
| S4 | ODCS, 문서 인덱스: https://bitol-io.github.io/open-data-contract-standard/latest/ |
| S5 | ODCS, Schema: https://bitol-io.github.io/open-data-contract-standard/latest/schema/ |
| S6 | ODCS, Data Quality: https://bitol-io.github.io/open-data-contract-standard/latest/data-quality/ |
| S7 | ODCS, Service-Level Agreement: https://bitol-io.github.io/open-data-contract-standard/latest/service-level-agreement/ |
| S8 | ODCS, Team: https://bitol-io.github.io/open-data-contract-standard/latest/team/ |
