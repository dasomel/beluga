# ADR-0004: 계층적 Data Asset API — Catalog → Schema → Table → Column

- **상태**: 승인됨(방향) — API를 계층적으로 확장하기로 dasomel이 결정; 2026-09-29 현재 **부분 구현됨**.
  커밋 `ada545e`가 `GET /api/v1/data-assets/{id}`를 추가하고 `DataCatalogView`를 실제 flat 목록/detail
  API로 전환했다. 여기서 설명하는 `parentId` 계층, catalog/schema 탐색, upstream adapter, 노드별
  authorization은 아직 구현되지 않았다.
  **업데이트(이슈 #36 슬라이스)**: 추가형 Phase 1 반영 -- `kind: "catalog"`, `DataAsset`의 선택적
  `catalog`/`namespace`/`parentId`/`path`, `?parentId=` 자식 필터, `childCount`(항상 `null`, D7/D9),
  `isPartition` 컬럼, D4 id 헬퍼(`lib/assetId.ts`). 호환성을 위한 의도적 차이(D6 escape hatch):
  `parentId` 생략 시 기존처럼 전체 flat 목록(최상위 catalog는 `kind=catalog`), `name`/기존 id는 flat 유지,
  신규 필드는 required가 아닌 optional, `DataAssetDetail`은 D9 discriminated union이 아닌 기존 flat
  optional 형태 유지.
- **날짜**: 2026-09-24
- **이슈**: [#36 \[ROADMAP\]\[DOMAIN\] Data Asset Domain Model — Catalog + Query Integration](https://github.com/dasomel/beluga-manager/issues/36),
  [#15 \[ROADMAP\]\[UX\] Data Catalog — Iceberg Catalog / Schema / Table Explorer](https://github.com/dasomel/beluga-manager/issues/15),
  [#43 \[EXECUTION\]\[MVP\] Beluga Domain API Contract & OpenAPI Specification](https://github.com/dasomel/beluga-manager/issues/43)
- **Parent epic**: #1
- **관련**: [ADR-0001](0001-frontend-technology-ko.md) (Data Catalog 화면을 "hierarchical catalog →
  schema → table → column navigator"로 기록), [ADR-0002](0002-backend-api-technology-ko.md)
  (Hono + `@hono/zod-openapi`, OPA에 위임된 authorization, "second metadata store 없음")
- **결정자**: dasomel

## Context

`GET /api/v1/data-assets`(`packages/domain-api/src/routes/dataAssets.ts`)는 이미 존재하며
`DataAsset` 행(`packages/domain-api/src/schema/dataAsset.ts`)의 **flat**, paginated 목록을 반환한다:
`{ id, name, kind, serviceId, status }`, `kind: "table" | "topic" | "schema"`. 스키마나 stub
데이터(`packages/domain-api/src/stub-data/dataAssets.ts`) 어디에도 부모/자식 관계는 없다.

`DataCatalogView.tsx`는 이제 `GET /api/v1/data-assets`에서 flat table 목록을, 선택한 table 상세는
`GET /api/v1/data-assets/{id}`에서 읽는다(issue #15, 커밋 `ada545e`). 왼쪽 패널은 아직 고정된
`beluga_lake / default` 라벨 아래 flat table 목록을 보여주며 catalog/schema 노드를 탐색하지 않는다.
실제 목록/detail 호출이 추가되면서 기존 mock-data 설명 주석은 제거됐다. `mockData.ts`의
`CatalogTable` 타입은 UI와 query 전달용 모양으로 남아 있지만, 화면은 더 이상 `catalogTablesData`를
읽지 않는다.

현재 `DataAssetDetail`은 선택적 table 필드(`columns`, `location`, `format`, `metadataSummary`)를 가진
flat `DataAsset` 확장이다. D9가 제안하는 kind 판별형 hierarchy detail 모양은 아니다. 기존 route와
schema를 남은 설계의 호환성 기준으로 삼는다.

**여기에 매핑해야 할 upstream 모양**(#34, AGENTS.md "OSS API 모델을 그대로 노출하지 않는다"에 따라
그대로 API에 노출하지 않고):

- **Lakekeeper(Iceberg REST Catalog)**, `catalog.local.beluga.internal`은 Catalog → Namespace →
  Table 메타데이터의 authoritative 원천이다. Iceberg REST spec의 namespace는 **정렬된 문자열
  segment 목록**이며 한 단계로 고정되어 있지 않다 — 이 플랫폼이 오늘 쓰지 않더라도 nesting
  (`["analytics", "raw"]`)은 spec 자체에 포함된다.
- **Trino**는 그 위에 관례적인 두 부분 `catalog.schema.table` addressing을 노출한다. 이 저장소의
  기존 `dataAssetKindSchema`는 이미 `"namespace"`가 아니라 `"schema"`를 kind 이름으로 쓰고 있고
  이는 Trino의 어휘와 일치한다 — 이 ADR은 두 번째 동의어를 새로 만들지 않고 연속성을 위해 그 이름을
  유지한다.
- **`beluga/policies/`**(이 저장소에서는 읽기 전용, `beluga`가 소유)는 이미 정확히 이 두 단계와
  더 세밀한 세 번째 단계에서 grant를 선언하고 있다:
  - `catalog.yaml` → `catalogGrants: [{ catalog: iceberg, roles: [...], operations: [ShowSchemas,
    ShowTables, ...] }]` — **catalog 레벨** 가시성.
  - `resources.yaml` → `resources: [{ resource: "lake.orders", classification, grants: [{ roles,
    privileges }], sensitiveColumns: [...] }]` — **schema.table 레벨** grant와, masking을 위한
    **column 레벨** `sensitiveColumns`.
  - 이는 우연이 아니다: 계층적 API의 노드 레벨은 이 ABAC scoping 구조와 맞아야 한다(D7 참조).
- **Kafka topic**도 #36에 따라 `DataAsset`(`kind: "topic"`)이지만 자연스러운 namespace가 없다 —
  Iceberg 스타일의 catalog/schema 체인이 아니라 소유 서비스(Kafka) 바로 아래에 위치한다.

## Decision Drivers

1. **domain model, OSS proxy가 아님**(#34, #29) — 계층은 Iceberg REST tree나 Trino의
   `SHOW SCHEMAS`/`SHOW TABLES` 응답을 그대로 재노출한 것이 아니라 Beluga 고유의 모양이어야 한다.
2. **second metadata store 없음**(README, AGENTS.md, ADR-0002 Decision Outcome §5) — 계층은
   계산/파생되며 live upstream 대비 짧은 캐시로만 뒷받침되고, 절대 영속화된 tree가 아니다.
3. **Lazy, bounded reads** — 하나의 catalog는 다수의 schema를, 하나의 schema는 다수의 table을 가질
   수 있다. UI의 navigator(왼쪽 패널, click-to-expand) 자체가 한 응답에 전체 tree를 필요로 하지도
   않고 요구해서도 안 된다. #43은 이미 모든 목록 엔드포인트에 pagination을 요구한다.
4. **호환성** — `GET /api/v1/data-assets`와 `GET /api/v1/data-assets/{id}`는 구현되어 있고 route/OpenAPI
   테스트가 있으며 `DataCatalogView`가 사용한다. 목록 기본값을 모든 flat asset에서 최상위 catalog로
   바꾸거나 `name`을 fully-qualified에서 leaf-only로 바꾸면 실제 내부 caller에 영향을 준다. 명시적
   contract 테스트와 프론트/API 동시 이전이 필요하다.
5. **ABAC 정합성**(D7) — 계층 레벨은 `beluga/policies`가 이미 grant를 scoping하는 레벨(catalog,
   schema.table, column)과 같아야 한다. 그래야 미래의 authorization 단계가 새 레벨을 발명하지 않고
   기존 레벨에 붙을 수 있다.
6. **Iceberg namespace 일반성** — authoritative upstream(Iceberg REST)이 N-레벨 namespace nesting을
   지원하는데 두 레벨(`catalog.schema`)로 하드코딩해서는 안 된다.
7. **하나의 pagination idiom**(ADR-0002 driver 1: contract cohesion) — 이 엔드포인트 family만을 위한
   cursor pagination을 새로 만들지 말고 `packages/domain-api/src/schema/query.ts`의 기존
   `paginationQuerySchema`를 재사용한다.

## Considered Options

### Option A — 단일 nested-tree 응답(`GET /api/v1/data-assets?tree=true`)

한 번의 호출로 전체 catalog→schema→table tree를 nested JSON으로 반환한다.

**거부.** 무제한 fan-out은 driver 3과 #43의 pagination 요구를 무력화한다. tree 깊은 곳의 단일
degraded/stale 노드를 다시 flatten하지 않고 드러내기가 어렵다(기존 `warnings[]` envelope은 flat한
`data[]`를 전제한다). live Iceberg REST 호출 대비 명확한 cache key 없이 비용이 크다.

### Option B — 기존 엔드포인트를 재사용하는 lazy children-by-parent(`?parentId=`)

`GET /api/v1/data-assets`가 선택적 `parentId` query param을 얻는다. 생략/`null` → 최상위
catalog들; `parentId=<catalogId>` → 그 catalog의 schema들; `parentId=<schemaId>` → 그 schema의
table들. 하나의 재귀적 모양, 하나의 스키마, 하나의 pagination idiom이며 navigator의 실제
click-to-expand interaction과 1:1로 대응한다.

**아래 D3/D6으로 받아들인 trade-off.** *기본* 응답(`parentId` 없음)의 의미는 "모든 asset, flat"에서
"최상위 catalog들"로 바뀌며 기존 `DataCatalogView` caller와 외부 API 소비자에게 breaking change다.
구현 시 caller를 같은 변경에서 이전하고 API contract/test를 갱신해야 한다. 외부 소비자가 생기면 D6의
버전 관리 escape hatch를 사용한다.

### Option C — 새로운 별도 hierarchy 엔드포인트, 기존 flat 엔드포인트는 그대로 유지

`GET /api/v1/data-assets`를 지금 그대로(flat, 예: 모든 kind에 대한 cross-cutting 검색/목록용)
유지하고, navigator를 위해 별도 리소스, 예를 들어 `GET /api/v1/catalogs`,
`GET /api/v1/catalogs/{id}/schemas`, `GET /api/v1/catalogs/{id}/schemas/{schemaId}/tables`를
추가한다.

**B를 위해 거부.** 순수 path-per-level REST는 그 자체로는 더 REST답지만, 하나의 재귀적 관계를 위해
route/schema 표면을 세 배로 늘린다. ADR-0002의 architect 메모(#34)도 이미 per-screen 엔드포인트
(`/api/ui/...`)보다 명시적 파라미터를 가진 안정적인 domain 리소스를 권장한다. 또한 domain이
성장(예: topic)할 때 서로 정합성을 맞춰야 하는 두 개의 독립적으로 pageable한 "이것이 data asset인가"
표면을 만든다.

### Option D — Column을 `DataAsset` kind로(flat 목록에 `kind: "column"` 행 포함)

column을 table/schema/catalog와 함께 `DataAsset` 행으로 나열한다.

**거부.** column은 독립적인 `status`/health도, 자신만의 `serviceId`도 없다 — 이를
`dataAssetSchema`에 억지로 넣으면 그 스키마의 의미를 왜곡하고 넓은 table의 목록 cardinality를
폭증시킨다. column은 asset 목록의 형제가 아니라 **table detail**로 모델링한다(D1).

## Decision Outcome

**승인: Option B** — 기존 `GET /api/v1/data-assets` 엔드포인트에 `parentId`로 접힌 lazy
parent/child 목록과, table/column detail을 위한 새로운 single-resource detail 엔드포인트. 다음
결정으로 기록한다:

### D1 — `kind`를 확장, 행 cardinality는 아님; column은 detail이지 행이 아니다

`dataAssetKindSchema`는 `["table", "topic", "schema"]`에서 `["catalog", "schema", "table",
"topic"]`으로 확장된다(append-only; 기존 값은 의미를 유지한다). column은 `kind`가 **아니다** —
`TableDetail` payload 안에서만 나타난다(D3).

- **이유**: column은 독립적인 health/service identity가 없다. `DataAsset` 행으로 모델링하면 정확히
  그 목적을 위해 존재하는 `status`/`serviceId` 필드를 오용하게 된다.
- **비용**: column 레벨 사실(name, type, `isPartition`, `sensitive`)은 두 번째 스키마
  (`dataAssetColumnSchema`)에 위치하며 목록 엔드포인트가 아니라 table의 detail을 통해서만 접근
  가능하다.
- **escape hatch**: 이 코드베이스의 다른 곳(`serviceType`, `healthStatus`)처럼 이 enum도 관례상
  append-only다. 독립적으로 health를 추적하는 column에 대한 필요가 미래에 생기면 기존 enum
  consumer를 깨지 않고 나중에 `kind: "column"`을 추가할 수 있다.

### D2 — `DataAsset`에 `parentId`와 `path` 추가, 둘 다 필수(`parentId`는 nullable)

```ts
export const dataAssetKindSchema = z
  .enum(["catalog", "schema", "table", "topic"])
  .openapi("DataAssetKind");

export const dataAssetSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "asset-table-orders" }),
    name: z.string().min(1).openapi({ example: "orders" }),
    kind: dataAssetKindSchema,
    serviceId: z.string().min(1).openapi({ example: "svc-iceberg" }),
    status: healthStatusSchema,
    // 최상위(catalog)는 parentId가 없다. 이 자산이 속한 부모 asset의 id — 자식 목록을
    // 조회할 때 그대로 parentId 질의 파라미터에 넣는다.
    parentId: z.string().min(1).nullable().openapi({ example: "asset-catalog-iceberg" }),
    // catalog부터 이 asset까지의 조상 segment 이름을 순서대로 담는다(자기 자신은
    // 제외). Iceberg의 다중 레벨 namespace를 그대로 표현할 수 있도록 평평한 문자열이
    // 아니라 배열로 둔다 — D8 참조.
    path: z.array(z.string().min(1)).openapi({ example: ["iceberg", "analytics"] }),
  })
  .openapi("DataAsset");
```

- **이유**: additive 필드는 기존 `DataAsset` reference type을 그대로 알아볼 수 있게 유지한다.
  `parentId`는 lazy `?parentId=` query가 정확히 필요로 하는 값이다. `path`는 client가 조상당 한
  번의 추가 round trip 없이 breadcrumb을 그리거나 qualified name을 재구성할 수 있게 한다.
- **비용**: stub 데이터/미래 adapter는 파생 시점에 `parentId`/`path`를 계산해야 한다(Iceberg 자체의
  listing 호출이 이미 namespace path를 반환하므로 새로운 state가 아니라 매핑 단계일 뿐이다).
- **escape hatch**: 두 필드 모두 구조적으로 필수(`.optional()` 아님)라서 모든 consumer가 이를
  처리해야 하지만, `parentId: null`이 잘 정의된 "최상위" 케이스다 — 별도의 "root" sentinel 값은
  필요하지 않다.

### D3 — 기존 엔드포인트에 `?parentId=` lazy children; 기존 detail 엔드포인트 사용

```
GET /api/v1/data-assets                      # parentId 생략 -> 최상위 catalog들
GET /api/v1/data-assets?parentId=<catalogId>  # 그 catalog의 schema들
GET /api/v1/data-assets?parentId=<schemaId>   # 그 schema의 table + topic들
GET /api/v1/data-assets/{id}                  # 단일 asset detail; D9에서 hierarchy 모양 제안
```

`status`와 pagination(`page`/`pageSize`) 필터는 `parentId`와 직교하여 변경 없이 계속 동작한다(예:
`?parentId=<schemaId>&status=degraded&pageSize=50`). 새 query 스키마는 `.extend`로 필드 하나만
추가하기 때문이다 — `packages/domain-api/src/schema/query.ts`에서 `statusFilterableListQuerySchema`
자체가 `paginationQuerySchema`를 확장하는 방식과 동일하다:

```ts
export const dataAssetListQuerySchema = statusFilterableListQuerySchema.extend({
  // 생략/undefined -> 최상위 catalog들. 자식 목록을 조회할 부모 asset의 id를 그대로 넣는다(D4의
  // 파생 id를 그대로 재사용 — 별도 lookup 없음).
  parentId: z.string().min(1).optional(),
});
```

- **이유**: 전체 tree를 위한 하나의 재귀적 모양; navigator의 click-to-expand가 확장마다 하나의
  `parentId` 호출로 직접 대응한다; `statusFilterableListQuerySchema`와
  `buildListEnvelope`/`healthWarning`을 변경 없이 재사용한다.
- **비용**: *기본* 호출의 의미가 바뀐다(D6 참조). `packages/domain-api/tests/routes-data-assets.test.ts`의
  필터 없는 호출에 대한 고정된 기대값 `kinds == {table, topic, schema}`는 새로운 최상위 레벨
  `{catalog}`(또는 새 stub의 최상위가 무엇이든)로 다시 작성해야 한다.
- **escape hatch**: "레벨 상관없이 모든 asset을 달라"는 진짜 use case(예: 전역 검색)가 나중에
  나타나면, 기본값을 덮어쓰지 말고 명시적으로 이름 붙인 `?flat=true`를 추가한다.

### D4 — 파생되고 접두사가 붙은 식별자, segment별 percent-encoding; 새로운 영속 매핑 없음

`id`는 여전히 opaque 문자열이지만 저장된 UUID가 아니라 qualified name으로부터 결정적으로 파생되는,
kind가 접두사로 붙은 관례를 따른다. **기본 encoding**: 모든 가변 식별자 segment(catalog, namespace
segment, table 이름, Kafka cluster, topic 이름)는 join 전에 독립적으로 percent-encode된다 — 먼저 `%`
→ `%25`, 그다음 `.` → `%2E`. 인코딩된 segment는 절대 literal `.`을 포함할 수 없으므로, join된 id
안의 모든 `.`은 명확하게 segment 경계이며, encoding은 되돌릴 수 있다(가변 부분을 `.`으로 split한
뒤 각 부분을 percent-decode). 이 규칙이 없으면 D8과 충돌한다: `path: string[]`는 두 세그먼트짜리
namespace와, 우연히 dot을 포함한 단일 segment를 둘 다 표현할 수 있는데, escaping 없이 dot-join하면
둘이 같은 문자열로 붕괴한다. namespace/table/topic만 encode하면 catalog와 Kafka cluster 이름이 여전히
모호하다.

| Kind | 관례 | 예 |
|---|---|---|
| catalog | `asset-catalog-<encode된 catalog>` | `asset-catalog-iceberg` |
| schema | `asset-schema-<encode된 catalog>.<encode된 namespace segment들, dot-join>` | `asset-schema-iceberg.analytics` |
| table | `asset-table-<encode된 catalog>.<encode된 namespace segment들, dot-join>.<encode된 table 이름>` | `asset-table-iceberg.analytics.orders` |
| topic | `asset-topic-<encode된 Kafka cluster>.<encode된 topic 이름>` | `asset-topic-kafka.events-raw` |

encoding이 필요한 이유를 보여주는 예:

- Nested namespace `["a", "b"]`(두 segment) → `asset-schema-iceberg.a.b`.
- literal하게 `"a.b"`라는 이름의 단일 namespace segment → `asset-schema-iceberg.a%2Eb` — encoding된
  덕분에, naive하게 dot-join하면 둘 다 `"a.b"`가 되는 위의 두-segment 경우와 절대 충돌하지 않는다.
- namespace `["analytics"]` 아래 `"orders.v2"`라는 이름의 table → `asset-table-iceberg.analytics.orders%2Ev2`.
- `"ice.berg"`라는 이름의 catalog → `asset-catalog-ice%2Eberg`; Kafka cluster 이름에도 같은 규칙을 적용한다.

- **이유**: 별도의 lookup table 없이 upstream identity로부터 파생 가능 — "second metadata store
  없음"(driver 2)과 일치한다. 접두사가 kind와 소유 서비스/catalog를 모두 인코딩하므로 서비스 간에
  충돌하지 않는다. segment별 percent-encoding은 D8의 `path: string[]` 모양이 upstream에서 만들어낼
  수 있는, nested namespace와 literal dot을 포함한 단일 segment 사이의 `.`-join 모호성을 제거한다.
- **비용**: namespace 깊이와 `.`/`%`를 포함한 이름의 encoding overhead에 따라 id 길이가 늘어난다.
  adapter boundary에서 무제한으로 두지 않고 합리적인 최대치(예: 256자)로 검증해야 한다.
- **escape hatch**: 파생 id가 충돌하거나 다루기 어려워지면(매우 깊은 nesting, 특이한 문자),
  qualified name의 content hash(`sha1`)로 전환하고 사람이 읽을 수 있는 형태는 `path`/`name`에
  유지한다 — `id`가 이미 opaque로 문서화되어 있으므로 API consumer에게는 보이지 않는 내부 표현
  변경이다.

### D5 — children에는 cursor pagination이 아니라 page/pageSize pagination

Children 목록(`?parentId=`)은 다른 모든 목록 엔드포인트와 동일하게 기존 `paginationQuerySchema`
(`page`, `pageSize` ≤ 100)를 사용한다.

- **이유**: 전체 API에서 하나의 pagination idiom(driver 7); 이것은 public multi-tenant catalog가
  아니라 내부 플랫폼의 catalog다 — 노드당 예상 fan-out은 크지 않다.
- **비용**: Iceberg REST 자체의 namespace/table listing이 cursor 기반(`page-token`)일 수 있다.
  adapter는 매우 큰 namespace에 대해 Beluga의 `page`/`pageSize`로 다시 slice하기 전에 upstream
  페이지를 모두 소진하거나 캐시해야 하며 이는 실질적인 비용이다.
- **escape hatch**: additive — namespace/catalog가 수천 개를 넘는 자식을 가진 것으로 측정되면,
  `page`/`pageSize` caller를 깨지 않고 나중에 opaque `pageToken` 대안을 추가한다(상호 배타적
  파라미터, `page`가 기본값으로 유지).

### D6 — 호환성 태도: 기존 contract와 caller의 동시 이전

`GET /api/v1/data-assets`는 (Option C처럼) `/api/v2/data-assets`나 병렬 hierarchy 리소스를 도입하는
대신 D1–D3에 따라 그 자리에서 확장된다.

- **이유**: 기존 `DataCatalogView`는 이제 flat 목록/detail endpoint를 소비한다(issue #15, 커밋 `ada545e`).
  하나의 리소스를 유지하면 중복 source of truth를 피할 수 있고, 현재 caller를 함께 이전하면 API와 UI가
  계속 일치한다.
- **비용**: 이를 배포하는 같은 PR에서 `routes-data-assets.test.ts`와 OpenAPI snapshot 테스트를 바꿔야
  한다. 실제 caller인 UI와 다른 API 소비자에게 flat 기본값 및 fully-qualified `name`에서의 변경을
  알려야 한다. 이는 의도적인 breaking behavior change이므로 API와 UI 이전을 함께 배포하고 contract에
  기록한다.
- **escape hatch**: 이 기능이 배포되기 전에 실제 외부 consumer가 나타나면, ADR-0002가 이미 부채로
  나열한 API-versioning 원칙에 따라 그 시점에 버전을 올린다(`/api/v2/data-assets`).

### D7 — ABAC/policy scoping은 `beluga/policies`의 기존 세 레벨을 그대로 반영한다

계층의 노드 레벨은 `beluga/policies`가 이미 grant를 선언하는 곳과 1:1로 맞도록 선택되어, 미래의
authorization 단계가 새 레벨을 발명하지 않고 기존 레벨에 붙을 수 있다:

- **catalog** 노드 ↔ `catalog.yaml`의 `catalogGrants`(catalog별 Trino operation, 예: `ShowSchemas`/
  `ShowTables`) — 어떤 catalog에도 grant가 없는 caller는 그 catalog 노드(및 그 아래 전부)를 전혀
  볼 수 없어야 한다.
- **schema**/**table** 노드 ↔ `resources.yaml`의 `resource: "<namespace>.<table>"` grant
  (`classification`, `privileges`) — 가시성에는 최소 `select`가 필요하다.
- **column**(table detail 내부) ↔ `resources.yaml`의 `sensitiveColumns` — column별 `sensitive:
  boolean` flag로 드러난다(D9). masking되지 않은 데이터로는 절대 드러내지 않는다. 실제 query
  실행과 masking은 여전히 Trino/OPA(Query Workspace)의 일이며, Domain API는 표시를 위한
  classification만 반영한다.
- **이유**: Domain API에 두 번째 grant engine을 재구현하는 대신 하나의 authorization
  원천(OPA, ADR-0002 Decision Outcome §3)을 유지한다.
- **비용**: hierarchy 목록은 catalog/schema/table 노드마다 authorization 확인이 필요하다 — 아직
  구축되지 않은 새로운 integration 표면(OPA 조회, 노드당이 아니라 페이지당 batch일 가능성이 높다).
- **escape hatch이자 미루면 안 되는 gate**: 그 OPA 통합이 도착하기 전까지, 중간 build는 (a) 실제
  사용자에게 배포하지 않거나, (b) 기존 envelope의 `warnings[]`를 재사용해 모든 hierarchy 응답을
  unauthorized/unfiltered로 명시적으로 표시해야 한다. AGENTS.md의 "불확실/추론된 관계를 사실처럼
  제시하지 않는다"에 따라, 필터링되지 않은 tree를 조용히 반환하는 것은 강제되지 않은 access
  control을 강제된 것처럼 왜곡하는 일이다. 이는 이 ADR이 단독으로 결정할 수 없는, 아래 Open
  Question 3이다(D7은 *모양*을 기록하고, *go/no-go gate*는 Open Question 3이다). 같은 gate가
  `childCount`(D9)에도 적용된다: count 자체가 caller가 볼 권한이 없는 자식에 대한 existence/
  cardinality 정보이므로, node-level OPA 필터링이 존재하기 전까지 `childCount`는 반드시 `null`이며
  절대 필터링되지 않은 원본 숫자가 될 수 없다.

### D8 — `path`는 dotted 문자열이 아니라 정렬된 segment 배열이다

내부적으로도, wire 상으로도 namespace/catalog 계보는 `path: string[]`이며, UI가 단일 문자열이
필요한 곳(예: 화면이 이미 만드는 sample-SQL 템플릿 `${catalog}.${schema}.${table}`)에서는 별도로
계산된, 표시 전용 `qualifiedName`(dot-joined)을 쓴다.

- **이유**: Iceberg REST의 namespace는 원래 segment 목록이며 N-레벨 nesting을 지원한다. dotted
  문자열은 segment 이름 안의 dot을 금지하거나 escaping을 요구하게 되며, 한 레벨보다 깊은 nesting이
  실제로 쓰이는 날 breaking change가 필요해진다.
- **비용**: 이 플랫폼의 `beluga/policies` resource(`lake.orders`)는 현재 항상 namespace segment
  하나 깊이이므로 오늘은 약간의 모델링 오버헤드다.
- **escape hatch**: 필요 없음 — 길이 1인 배열은 추가 비용이 없고 정확히 오늘의 모양이다. 일반성은
  쓰이기 전까지는 공짜다.

### D9 — kind로 구별되는 single-resource detail 엔드포인트

```ts
export const dataAssetColumnSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    isPartition: z.boolean().optional(),
    comment: z.string().optional(),
    // resources.yaml의 sensitiveColumns로부터 파생 — 실제 마스킹은 Trino/OPA가 수행하고
    // 여기서는 표시용 분류만 반영한다(D7).
    sensitive: z.boolean(),
  })
  .openapi("DataAssetColumn");

export const dataAssetDetailSchema = z.discriminatedUnion("kind", [
  dataAssetSchema.extend({
    kind: z.literal("catalog"),
    // beluga/policies grant로 필터링된 이후의 인가된 자식 수(D7). node-level OPA 필터링이
    // 아직 없는 interim 기간에는 D7의 escape hatch에 따라 항상 null이다 — 필터링되지
    // 않은 원본 카운트를 노출하면 access control이 실제로는 강제되지 않은 것을 강제된
    // 것처럼 왜곡한다.
    childCount: z.number().int().nonnegative().nullable(),
  }),
  dataAssetSchema.extend({
    kind: z.literal("schema"),
    // catalog와 동일한 규칙 — 위 주석 참조.
    childCount: z.number().int().nonnegative().nullable(),
  }),
  dataAssetSchema.extend({
    kind: z.literal("table"),
    format: z.string().min(1).openapi({ example: "ICEBERG_V2" }),
    location: z.string().min(1).openapi({ example: "s3://beluga-lake/analytics/orders" }),
    snapshotCount: z.number().int().nonnegative(),
    columns: z.array(dataAssetColumnSchema),
  }),
  dataAssetSchema.extend({
    kind: z.literal("topic"),
    partitionCount: z.number().int().nonnegative(),
    replicationFactor: z.number().int().positive(),
  }),
]).openapi("DataAssetDetail");
```

`GET /api/v1/data-assets/{id}`는 `dataAssetDetailSchema`를 반환한다(알 수 없는 id는 기존
`errorResponseSchema`를 통해 404). 이것이 `DataCatalogView.tsx`의 오른쪽 detail 패널(column 표,
format badge, location, snapshot count)이 만들어지는 원천이다.

- **이유**: table/topic detail(column, format, location, snapshot)은 목록 envelope에 속하지 않고
  (driver 3: bounded reads) 자연스럽게 single-resource REST다. discriminated union은 all-optional
  grab-bag 대신 각 kind가 자신에게 의미 있는 필드만 가지게 한다.
- **비용**: detail route는 이미 존재한다(issue #15, 커밋 `ada545e`). 다만 현재 schema는 선택적 table
  필드가 있는 flat object다. discriminated union으로 바꾸면 기존 response schema가 변경되므로,
  `@hono/zod-openapi`의 OpenAPI 렌더링을 확인하고 caller/test를 함께 이전해야 한다.
  `catalog`/`schema` 멤버의 `childCount`는 authorization에 민감하다(D7): 이후의 `?parentId=` 호출이
  반환할 것과 같은 인가된 자식 집합으로부터 계산되어야 하며, 절대 필터링되지 않은 upstream count에서
  계산되어서는 안 된다 — 그렇지 않으면 caller가 볼 수 없는 자식의 existence/cardinality를 노출한다.
  OPA node 필터링이 존재하기 전까지(D7의 interim gate) `childCount`는 실제 숫자가 아니라 `null`이다.
- **escape hatch**: union이 다루기 어려워지면, 모든 kind별 필드를 `.optional()`로 둔 하나의 공유
  모양으로 후퇴한다 — 타이핑 면에서 명백히 더 나쁘며, 문서화된 fallback으로만 유지한다.

## 화면 매핑(`DataCatalogView.tsx`)

| UI 요소 | 호출 |
|---|---|
| 왼쪽 navigator, 최초 렌더 | `GET /api/v1/data-assets`(최상위 catalog들) |
| catalog 노드 확장 | `GET /api/v1/data-assets?parentId=<catalogId>`(그 schema들) |
| schema 노드 확장 | `GET /api/v1/data-assets?parentId=<schemaId>`(그 table/topic들) |
| table 선택(오른쪽 detail 패널: format badge, location, snapshot count, column 표) | `GET /api/v1/data-assets/{tableId}` |
| Sample-SQL 템플릿(`${catalog}.${schema}.${table}`) | 선택된 table의 `path` + `name`으로 client에서 구성 — 새 엔드포인트 불필요 |
| 어떤 노드의 stale/degraded status badge | 이미 존재하는 `DataAsset`의 `status` 필드, 변경 없음 |

## 단계별 구현 계획과 test plan

**Phase 1 — API schema와 stub 데이터(부분 구현).**

- **issue #15 / 커밋 `ada545e`에서 완료**: `GET /api/v1/data-assets/{id}` detail route, table column/metadata
  summary 필드, flat 목록/detail UI 호출, route/OpenAPI/UI 테스트.
- **남은 작업**: `dataAssetKindSchema`와 `dataAssetSchema`(D1, D2)를 확장하고, 기존 선택 필드형
  `dataAssetDetailSchema`를 D9에서 검토한 hierarchy shape로 변경한다. Stub tree에 `parentId`/`path`와
  일관된 파생 id(D2/D4)를 추가한다.
- `packages/domain-api/src/stub-data/dataAssets.ts`를 일관된 파생 id(D4)와 `parentId`/`path`(D2)를
  가진 작은 손으로 작성한 catalog→schema→table(+topic) tree로 다시 쓴다. 지금의 4행 stub처럼 작고
  명시적으로 유지한다.
- `registerDataAssetRoutes`(`packages/domain-api/src/routes/dataAssets.ts`)에 `parentId` 필터링을
  추가하고 기존 detail route를 유지·발전시킨다.
- **테스트**: 새로운 최상위 기본값에 맞춰 `routes-data-assets.test.ts`의 "모든 kind 존재" 단언을
  다시 쓴다. 각 레벨(catalog→schema, schema→table)에서의 `?parentId=`, 알 수 없는 id에 대한
  `?parentId=`(빈 목록, 404 아님 — 이 엔드포인트의 계약은 부모의 존재를 보장하지 않는다), 각 kind에
  대한 `GET /api/v1/data-assets/{id}`(맞는 union 멤버로 200)와 알 수 없는 id(404 `ErrorResponse`)
  케이스를 추가한다. 새 route/스키마/discriminated union 렌더링을 다루도록
  `openapi-document.test.ts`를 확장한다. D4의 percent-encoding에 대한 id 파생 단위 테스트를
  추가한다: round-trip(`.`을 포함한 이름과 `%`를 포함한 이름을 각각 encode한 뒤 decode하면 원본이
  복원된다)과 collision 케이스(nested namespace `["a", "b"]`와 literal하게 `"a.b"`인 단일 segment는
  서로 다른 id로 파생되어야 한다). `childCount`가 Phase 1 stub에서 `null`을 반환하는지(D7/D9의
  interim, OPA 필터링 이전 posture) — 필터링되지 않은 숫자가 아님을 — 검증하는 테스트를 추가한다.

**Phase 2 — Frontend 계층 탐색 통합(부분 구현).**

- **issue #15 / 커밋 `ada545e`에서 완료**: `DataCatalogView.tsx`가 flat asset 목록을 읽고 선택한 table
  상세를 Domain API에서 가져온다. 기존 테스트는 목록/detail 화면을 검증한다.
- **남은 작업**: 고정된 `beluga_lake / default` 라벨과 flat table 목록을 `parentId` 기반 catalog/schema
  expand로 교체하고, `path` + `name`으로 qualified name을 만들며, expand/collapse 및 모든 detail union
  멤버를 테스트한다. `CatalogTable`은 `mockData.ts`에서 UI/query 전달 타입으로 남아 있다. 이전 후 더
  이상 참조되지 않는 경우에만 제거한다.

**Phase 3 — Live Iceberg/Trino adapter**(#41/#42의 adapter 작업이 먼저 도착하는 것에 의존; 이
ADR이 adapter가 만족해야 하는 id/path 파생 계약(D2/D4) 이상은 범위 밖).

- Adapter가 Lakekeeper REST catalog/namespace/table listing과 Trino catalog 메타데이터를 Phase 1
  스키마로 매핑한다. Kafka topic은 schema 레벨 없이 소유 서비스 아래로 매핑된다.
- **테스트**: 기록된/fixture Iceberg REST 응답에 대한 adapter 레벨 테스트(live-cluster 테스트가
  아니라 contract 테스트)로 `parentId`/`path`/파생 `id` 계산이 D2/D4/D8과 정확히 일치하는지
  검증한다.

**Phase 4 — Authorization 강제(D7)**, 아래 Open Question 3에 의해 gate됨; 해결되기 전까지는 실제
(개발자가 아닌) 사용자에게의 어떤 hierarchy rollout도 막는다.

## Consequences

- `dataAssetKindSchema`, `dataAssetSchema`, `/api/v1/data-assets`의 OpenAPI 문서가 모두 바뀐다.
  `routes-data-assets.test.ts`와 `openapi-document.test.ts`는 고정된 golden file로 보존되는 것이
  아니라 같은 변경에서 함께 업데이트된다(D6).
- `DataAssetColumn`/`DataAssetDetail` schema와 `GET /api/v1/data-assets/{id}` route는 이미 issue #15에서
  추가됐다. 남은 설계는 현재 detail schema를 hierarchy 계약에 맞춰 발전시킨다.
- `DataCatalogView.tsx`는 이미 실제 flat 목록/detail endpoint를 사용한다(issue #15). 남은 계층 탐색은
  이 live caller를 변경하므로 API contract 이전과 함께 배포해야 한다.
- `dataAssetSchema.name`의 의미가 fully-qualified(오늘의 구현, 예:
  `packages/domain-api/src/schema/dataAsset.ts:9`의 `analytics.orders`)에서 leaf-only(이 ADR의 D2
  예시 `orders`; qualified 형태는 `path` + `name`으로 재구성한다, D8)로 바뀐다. 이는 단순 additive가
  아니라 기존 필드에 대한 behavior change다. 현재 UI caller와 다른 소비자에 미치는 영향을 검토하고 D6의
  동시 이전 및 버전 관리 원칙을 적용한다.
- 새로운 영속 저장소는 없다. hierarchy는 "second metadata store 없음"이라는 기존 원칙과 일치하게
  완전히 파생된 상태로 유지된다.
- hierarchy 노드에 대한 authorization 강제(D7)는 이 ADR이 해결하지 않는다 — 실제 사용자 rollout의
  hard gate이며(Open Question 3), Phase 1–3 동안 조용히 채워 넣을 구현 세부사항이 아니다.

## dasomel을 위한 Open Questions

1. **#41/#42와의 순서**: Phase 1(스키마 + stub 데이터)이 오늘의 flat stub처럼 실제 Iceberg/Trino
   adapter 작업보다 먼저 단독으로 배포되어야 하는가? 이 ADR은 그렇다고 가정한다(기존 패턴을
   그대로 따름)만, 이는 저장소에서 파생할 수 없는 일정 판단이다.
2. **이 tree에 Kafka topic이 있어야 하는가?** #36은 `topic`을 `DataAsset` kind로 나열하지만, #15는
   Data Catalog 화면을 구체적으로 "Iceberg Catalog / Schema / Table Explorer"로 규정한다. topic이
   같은 화면/엔드포인트에서 최상위 가짜(synthetic) Kafka 노드 아래의 leaf로 나타나야 하는가, 아니면
   Data Catalog 화면에서 완전히 배제되고 다른 화면(예: 미래의 Kafka/topic 화면)에 맡겨져야 하는가?
   이 ADR의 스키마는 어느 쪽 답도 지원한다(D1은 어느 경우든 `topic`을 enum에 유지한다). 위 화면
   매핑 표는 topic이 *보인다*고 가정하는데, 확인이 필요하다.
3. **Authorization go/no-go gate(D7)**: `beluga/policies` grant와 무관하게 모든 catalog/schema/
   table이 보이는 **필터링되지 않은** hierarchy 노드를, 응답이 명시적인 unauthorized/unfiltered
   경고로 표시되는 한 실제 사용자에게 Phase 1–3을 배포해도 괜찮은가, 아니면 실제 사용자 rollout
   전에 OPA 기반 노드 필터링이 먼저 도착해야 하는가? `childCount`(D9)가 Phase 4 이전에 실제
   필터링되지 않은 숫자가 될 수 있는지, 아니면 node-level OPA 필터링이 도착하기 전까지 `null`로
   남아야 하는지도 같은 답으로 결정된다. 이는 보안/제품 결정이며 이 ADR이 기본값을 정할 수 없다.
4. **예상 fan-out**: D5는 노드당 fan-out(catalog당 schema, schema당 table)이 이 플랫폼에서 수십/낮은
   수백 수준일 것으로 예상되므로 page/pageSize pagination이 충분하다고 가정한다. 실제로 계획된
   catalog들에 그 가정이 맞는가, 아니면 D5의 escape hatch로 미루지 않고 Phase 1부터 cursor
   pagination을 설계에 넣어야 하는가?
5. **rename에 대한 id 안정성**: D4의 파생 id는 catalog/schema/table이 upstream에서 rename되면
   바뀐다(id가 qualified name의 함수이기 때문). 이는 받아들일 만한가("second metadata store 없음"과
   일치 — 마이그레이션할 것이 없다), 아니면 rename을 넘어 안정적인 id에 의존하는 무언가(예: 저장된
   view, deep link, audit 참조)가 다른 identity scheme을 필요로 하는가?
