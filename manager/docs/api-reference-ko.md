# API 레퍼런스

Beluga Manager Domain API는 통합 오픈소스 플랫폼 구성요소(Kafka, Flink, Iceberg, Trino, Airflow, Superset 및 Kubernetes)에 대한 통합 RESTful 인터페이스를 제공합니다. 개별 OSS의 원시 관리 인터페이스 대신 플랫폼 수준의 도메인 추상화(Services, Pipelines, Data Assets, Resources, Events, Decisions, Policies)를 노출합니다.

English version: [api-reference.md](api-reference.md)

## 실시간 런타임 API 규약

문서와 실제 코드의 불일치(drift)를 방지하기 위해, 이 레퍼런스는 요청/응답 스키마를 수동으로 중복 기술하지 않습니다. 권위 있는 최신 OpenAPI 3.1.0 규격은 소스 코드의 Zod 스키마(`@hono/zod-openapi`)로부터 직접 생성되어 Domain API 프로세스 런타임에 제공됩니다:

- **로컬 기본 URL**: `http://localhost:8787` (기본 포트이며 `PORT` 환경 변수로 재정의 가능; [`packages/domain-api/src/server.ts`](../packages/domain-api/src/server.ts) 참조)
- **대화형 Swagger UI**: `http://localhost:8787/api/v1/docs` (`@hono/swagger-ui` 기반 서빙)
- **기계 판독 가능한 OpenAPI 3.1 JSON**: `http://localhost:8787/api/v1/openapi.json`

Domain API 서버를 로컬에서 실행하는 방법:

```bash
npm run dev:api
```

Domain API를 연동하거나 확장하는 개발자는 `http://localhost:8787/api/v1/docs`를 통해 정확한 페이로드 구조, 파라미터 요구사항, 필드 유효성 검증 제약 조건 및 대화형 요청 테스트를 확인해야 합니다.

## 핵심 리소스 그룹

Domain API는 엔드포인트를 `/api/v1` 아래 9개의 리소스 그룹으로 구성합니다. 라우트 구현체는 [`packages/domain-api/src/routes/`](../packages/domain-api/src/routes/)에 위치합니다:

| 리소스 그룹 | 기본 경로 | 설명 | 엔드포인트 |
|---|---|---|---|
| **Health** | `/api/v1/health` | Domain API 프로세스 자체의 헬스 및 버전 검사 (업스트림 상태는 프록시하지 않음) | `GET /api/v1/health` |
| **Services** | `/api/v1/services` | 통합 OSS 플랫폼 서비스의 종합 뷰, 헬스 상태 및 Capability 카테고리 | `GET /api/v1/services`<br>`GET /api/v1/services/{id}` |
| **Pipelines** | `/api/v1/pipelines` | 스트리밍, 연산, 레이크하우스, 쿼리 엔진에 걸쳐 상관관계가 맺어진 종단간 데이터 파이프라인 토폴로지 및 단계 실행 상태 | `GET /api/v1/pipelines`<br>`GET /api/v1/pipelines/{id}` |
| **Data Assets** | `/api/v1/data-assets` | 쿼리 컨텍스트 및 스토리지 메타데이터를 포함한 플랫폼 데이터 자산 (카탈로그, 스키마, 테이블, 토픽) | `GET /api/v1/data-assets`<br>`GET /api/v1/data-assets/{id}`<br>`GET /api/v1/data-assets/{id}/query-context` |
| **Query History** | `/api/v1/query-history` | Adapter 가시성 범위의 query snapshot; 영구 이력이 아닙니다. `sql`은 원문 그대로 반환되며 민감한 리터럴을 포함할 수 있습니다. 마스킹(redaction)과 호출자별 authz가 없으므로(앱에 인증 미들웨어 없음) 마스킹/authz 정책이 정해지기 전에는 live adapter를 연결하지 마십시오. opt-in Trino adapter를 설정하기 전 기본 응답은 503입니다(선택적 Upstream Adapter 참조). | `GET /api/v1/query-history?page=1&pageSize=20` |
| **Resources** | `/api/v1/resources` | 플랫폼 워크로드를 지원하는 하위 Kubernetes 인프라 리소스 (Pod, Deployment, StatefulSet 등) | `GET /api/v1/resources`<br>`GET /api/v1/resources/{id}` |
| **Events** | `/api/v1/events` | 플랫폼 타임라인 이벤트, 상태 전이 및 운영 알림 (최신순 정렬) | `GET /api/v1/events` |
| **Decisions** | `/api/v1/decisions` | 읽기 전용 System-1 자동화 운영 판단 투영(projection) | `GET /api/v1/decisions`<br>`GET /api/v1/decisions/{id}` |
| **Policies** | `/api/v1/policies` | 컴파일된 Beluga 플랫폼 접근 제어 정책, 역할 정의 및 바인딩 투영 | `GET /api/v1/policies`<br>`GET /api/v1/policies/{id}` |

### 라우트 세부사항

- **Health (`/api/v1/health`)**: [`packages/domain-api/src/routes/health.ts`](../packages/domain-api/src/routes/health.ts)에 정의됨. `{ status: "healthy", version: string }`을 반환합니다. 컨테이너 헬스체크 및 liveness/readiness 프로브에 사용됩니다.
- **Services (`/api/v1/services`)**: [`packages/domain-api/src/routes/services.ts`](../packages/domain-api/src/routes/services.ts)에 정의됨. `type`(예: `kafka`, `flink`, `trino`) 및 `status`(`healthy`, `degraded`, `stale`, `unknown`, `unavailable`) 필터링을 지원합니다. 레지스트리는 등록된 `type`으로 호출 대상을 먼저 선택하고, `status`는 헬스 조회 후 필터링합니다. 유효하지만 등록된 어댑터가 없는 type은 호출 없이 빈 목록을 반환합니다. 선택된 어댑터가 실패해도 HTTP 200을 유지하며 `unknown` 항목과 현재 페이지의 해당 항목에 대한 경고를 반환합니다. 제외된 어댑터는 경고를 만들지 않습니다.
- **Pipelines (`/api/v1/pipelines`)**: [`packages/domain-api/src/routes/pipelines.ts`](../packages/domain-api/src/routes/pipelines.ts)에 정의됨. 집계 `status` 필터링을 지원합니다. 단일 파이프라인 조회 시 연결된 상류/하류 스테이지 정보를 포함합니다. 각 파이프라인은 읽기 전용 `correlationLinks` 배열(기본값 `[]`)도 포함하며, 서비스 간 타입 링크를 표현합니다: `source`/`target`(`kind` + `id`), `relation`(`topic-feeds-job` = Kafka 토픽→Flink 작업, `job-writes-table` = Flink 작업→Iceberg 테이블, `table-served-by-catalog` = Iceberg 테이블→Trino 카탈로그, `dag-triggers-job` = Airflow DAG→작업), `confidence`(0~1), `method`(`declared-label` 0.95, `name-convention` 0.6, `ambiguous-name-convention` 0.3), `evidence`. 링크는 [`correlation/rules.ts`](../packages/domain-api/src/correlation/rules.ts)가 결정론적으로 생성하며, 존재하지 않는 대상을 가리키는 선언이나 일치하는 키가 없는 쌍은 추측하지 않고 링크를 만들지 않습니다(unknown). `method`가 `declared-label`이 아닌 모든 링크는 사실이 아니라 추정이며, 모호성은 양쪽에서 계산하고 `prod`, `raw` 같은 일반 접두어는 키로 쓰지 않습니다.
- **Data Assets (`/api/v1/data-assets`)**: [`packages/domain-api/src/routes/dataAssets.ts`](../packages/domain-api/src/routes/dataAssets.ts)에 정의됨. `status`, `kind`(`catalog`, `schema`, `table`, `topic`), `parentId` 필터링을 지원합니다. `parentId`는 해당 자산의 직계 자식(catalog -> schema -> table)만 반환하며, 알 수 없는 `parentId`는 빈 목록이고, 생략하면 기존처럼 전체 flat 목록입니다(최상위 catalog는 `kind=catalog`). 자산은 선택적 구조화 계층 필드 `catalog`, `namespace`(순서 있는 segment), `parentId`, `path`(조상 이름)를 가지며, 호환성을 위해 `name`/`id`는 기존 flat·opaque 형태를 유지합니다. 상세 조회 시 컬럼 정의(`isPartition`은 파티션 컬럼 표시)와 샘플 쿼리 컨텍스트를 제공하며, catalog/schema 상세의 `childCount`는 노드 단위 인가 필터링이 구현되기 전까지 항상 `null`입니다(ADR-0004 D7/D9).
- **Resources (`/api/v1/resources`)**: [`packages/domain-api/src/routes/resources.ts`](../packages/domain-api/src/routes/resources.ts)에 정의됨. `namespace` 및 `kind`(`Namespace`, `Workload`, `Pod`, `Service`, `Endpoint`, `Job`, `PersistentVolumeClaim`) 필터링을 지원합니다. `PersistentVolumeClaim` 리소스는 선택 필드 `capacity`, `storageClass`를 가질 수 있으며, 알 수 없으면 생략하고 다른 kind에는 추정해 채우지 않습니다. `logsUrl`은 `Job`을 포함한 모든 kind에서 외부 링크일 뿐이며 Manager는 로그를 저장하지 않습니다.
- **Events (`/api/v1/events`)**: [`packages/domain-api/src/routes/events.ts`](../packages/domain-api/src/routes/events.ts)에 정의됨. 주의: Event 모델에는 헬스 `status` 필드가 없으며, `severity`(`info`, `warning`, `error`)로 필터링합니다. 이벤트는 Kubernetes Event와 Service/Job 장애를 구분하는 선택 필드 `source`(`kubernetes`, `service`, `job`)를 가질 수 있으며, `source`가 없으면 출처 미상이므로 클라이언트는 이를 권위 있는 값으로 취급하거나 추측해서는 안 됩니다.
- **Decisions (`/api/v1/decisions`)**: [`packages/domain-api/src/routes/decisions.ts`](../packages/domain-api/src/routes/decisions.ts)에 정의됨. `decision` 판단 결과 필터링을 지원합니다.
- **Policies (`/api/v1/policies`)**: [`packages/domain-api/src/routes/policies.ts`](../packages/domain-api/src/routes/policies.ts)에 정의됨. `role` 필터링을 지원합니다.

## 선택적 Upstream Adapter (opt-in, 읽기 전용)

이슈 #17, #36. 아래 모든 항목은 **기본값이 꺼짐**입니다: 환경 변수가 없으면 Domain API는 fixture를 제공하고 `GET /api/v1/query-history`는 503을 반환합니다. 코드: [`packages/domain-api/src/adapters/upstream/`](../packages/domain-api/src/adapters/upstream/)(연결은 `config.ts`, `server.ts`에서 호출).

| 변수 | 의미 |
|---|---|
| `BELUGA_TRINO_ENABLED=true` | Trino query-history adapter 활성화. |
| `BELUGA_TRINO_BASE_URL` | Coordinator origin. 예: `https://trino.local.beluga.internal`. |
| `BELUGA_TRINO_TOKEN_FILE` / `BELUGA_TRINO_TOKEN` | Bearer 토큰(마운트된 파일을 권장하며 호출마다 다시 읽으므로 재시작 없이 교체 가능). 필수. |
| `BELUGA_TRINO_USER` | 선택적 `X-Trino-User` 헤더. Trino 483에서 필수가 아니며([client protocol](https://trino.io/docs/483/develop/client-protocol.html)), bearer 토큰 사용 시 identity는 토큰에서 결정됩니다. |
| `BELUGA_TRINO_HISTORY_ACK=shared-service-credential` | 이력이 서비스 자격 증명의 가시 범위이며 모든 호출자가 공유한다는(호출자별 authz 없음, 앱에 인증 미들웨어 없음) 필수 확인. 없으면 adapter는 비활성으로 유지됩니다. |
| `BELUGA_TRINO_HISTORY_SQL=literals\|none` | 기본 `literals`: `sql`의 문자열/숫자 리터럴을 `?`로 바꾸고 주석을 제거합니다. `none`은 SQL을 원문 그대로 반환합니다. 마스킹은 최선 노력 방식이며 보안 경계가 아닙니다. |
| `BELUGA_LAKEKEEPER_ENABLED=true` | Lakekeeper catalog source 활성화. |
| `BELUGA_LAKEKEEPER_BASE_URL` | origin만 지정하며 `BELUGA_LAKEKEEPER_BASE_PATH`(기본 `/catalog`)가 뒤에 붙습니다. |
| `BELUGA_LAKEKEEPER_WAREHOUSES` | 쉼표로 구분한 `warehouse` 또는 `catalogName=warehouse`. 각 항목이 catalog 노드가 됩니다(이름은 `query-context`에서 쓰는 Trino catalog 이름과 같아야 합니다). |
| `BELUGA_LAKEKEEPER_TOKEN_FILE` / `BELUGA_LAKEKEEPER_TOKEN` | Bearer 토큰. 필수. |
| `BELUGA_LAKEKEEPER_CACHE_TTL_MS` | 성공한 카탈로그 목록/상세를 재사용하는 시간(기본 5000, `0` = 재사용 없이 single-flight만). |
| `BELUGA_TRINO_HISTORY_CACHE_TTL_MS` | 성공한 Trino 이력 snapshot을 재사용하는 시간(기본 5000, `0` = single-flight만). 페이지네이션은 upstream 요청을 바꾸지 않으므로 캐시 키는 하나입니다. |
| `BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS` | 실제 upstream 실패(unreachable, 401/403, 5xx, malformed)를 재시도하지 않고 기억하는 시간(기본 2000, `0`이면 비활성). 자체 timeout과 과부하 차단은 기억하지 않습니다. |
| `BELUGA_UPSTREAM_MAX_CONCURRENT` | upstream별 동시 in-flight 요청 최대치(기본 8, 대기 가능 64건, 초과 요청은 503으로 차단). |
| `BELUGA_UPSTREAM_TIMEOUT_MS` | 호출별 timeout(기본 2500). |
| `BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER=true` | loopback이 아닌 호스트(예: 클러스터 내부 ClusterIP)로 평문 `http` 위에서 bearer 토큰 전송을 허용. 기본은 거부. |

**Upstream 계약.** Trino: `GET /v1/query`는 `List<BasicQueryInfo>`(`queryId`, `state`, `query` 등)를 반환하며 `@ResourceSecurity(AUTHENTICATED_USER)`로 인증된 identity 기준으로 필터링됩니다([`QueryResource.java`](https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/QueryResource.java), [`BasicQueryInfo.java`](https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/BasicQueryInfo.java), 태그 483). **이 endpoint는 문서화된 client protocol이나 483 web-interface 페이지에 없으며 Web UI의 backing endpoint이므로 Trino 버전 간에 바뀔 수 있습니다.** 이력은 coordinator가 아직 보관 중인 항목이며 upstream 순서 그대로이고 최대 1000건만 매핑하며, upstream이 더 많이 반환하면 모든 페이지에 `HISTORY_TRUNCATED` 경고가 붙습니다(`meta.total`은 upstream 전체가 아니라 노출된 행 수). Iceberg REST: [`rest-catalog-open-api.yaml`](https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml)(`/v1/config`, `/v1/{prefix}/namespaces[?parent=&pageToken=&pageSize=]`, `/namespaces/{ns}`, `/namespaces/{ns}/tables`, `/namespaces/{ns}/tables/{table}`; 다단계 namespace는 `%1F`로 연결). Lakekeeper는 이를 `/catalog` 아래에서 제공합니다([concepts](https://docs.lakekeeper.io/docs/latest/concepts/)).

**동작.**
- GET 전용, timeout, 응답 크기 제한(스트리밍 중 **바이트 단위**로 적용, 기본 5 MiB, 초과 시 chunked 본문도 스트림 취소, 본문을 소비하지 않는 모든 응답(2xx 아님, 선언 크기 초과, abort)도 취소해 소켓을 반환하며 실제 HTTP 서버로 검증), redirect 거부(redirect가 bearer 토큰을 다른 곳으로 전달할 수 있음). 매핑한 필드만 읽으므로 `LoadTableResult`의 `config`/`storage-credentials`(발급된 스토리지 자격 증명)는 응답에 나가지 않습니다.
- 실패 유형(`unreachable`, `timeout`, `401`, `403`, `404`, `5xx`, 잘못된 JSON/형태)은 route로 throw되지 않습니다. 이력과 data-asset 목록/상세/query-context는 부분 데이터 없이 **503** `SERVICE_UNAVAILABLE`을 반환하며, 401/403 메시지는 upstream이 Manager의 서비스 자격 증명을 받아들이지 않았음을 알립니다. 자산에 대한 upstream 404는 404로 매핑됩니다. 로그에는 실패 유형과 HTTP 상태만 남습니다.
- live source의 Data Assets: `parentId`를 생략하면 설정된 최상위 catalog만 반환합니다(flat 전체 탐색 없음). catalog의 `parentId`는 최상위 namespace를 `schema` 노드로, schema의 `parentId`는 중첩 namespace(`schema`)와 `table` 노드를 반환하며, 그 외/알 수 없는 `parentId`(레거시 fixture id 포함)는 빈 목록입니다. upstream 페이지는 `page`/`pageSize` 분할 전에 모두 가져오며(목록당 upstream 페이지 최대 10개, 초과 시 `LISTING_TRUNCATED` 경고) 자산 `id`는 ADR-0004 D4를 따르고 `name`은 flat `namespace.table` 형태를 유지합니다. `status`는 `unknown`입니다(REST catalog는 객체별 헬스를 보고하지 않음). 테이블 상세는 현재 schema(Iceberg 타입 이름, `required` -> `nullable`, `doc` -> `comment`, 파티션 소스 컬럼 -> `isPartition`), `location`, `Iceberg v<format-version>`(`write.format.default`가 있으면 병기), snapshot 수, 마지막 갱신, partition spec을 매핑합니다.
- **경로 안전성.** 디코딩 후 빈 문자열, `.`, `..`이거나 제어 문자(NUL, namespace 구분자 `0x1F` 포함) 또는 `/`, `\`를 포함하는 asset id segment는 id 파싱 단계에서 거부되어(404/빈 목록) upstream에 도달하지 않습니다. 같은 종류의 upstream 제공 namespace/table 이름은 노출하지 않으며, upstream이 준 `prefix`는 보수적인 이름 문자 집합만 허용하고, HTTP client는 URL 파서가 정규화할 경로(`..`, `%2E%2E` 모두 dot segment)를 가진 요청을 보내지 않으므로 요청은 `/catalog/v1/<prefix>/...` 밖으로 나갈 수 없습니다.
- **요청 증폭.** 동일한 동시 요청은 **두 upstream 모두**(Lakekeeper 카탈로그 목록/상세와 `/v1/config`, Trino 이력 snapshot) single-flight로 합쳐지고 성공 결과는 짧은 TTL 동안 재사용됩니다. 실제 upstream 실패는 잠시 기억하며(negative cache), 자체 timeout과 과부하 차단은 캐시하지 않습니다. 캐시는 LRU이며 상한이 있습니다: adapter당 최대 100개 항목, 총 weight 20000(자산, 컬럼 또는 이력 행), 한 목록은 upstream 페이지 10개(목록당 1000건, 초과 시 `LISTING_TRUNCATED` 경고)로 제한됩니다. 잘못된/알 수 없는 catalog/레거시 id는 캐시 앞에서 응답하므로 슬롯을 차지하지 않습니다. 캐시 weight 계산은 살아 있는 항목에 대해서만 바뀌며(로드 대기 중 퇴출된 항목은 합계를 바꿀 수 없음), 호출자들이 값을 공유하므로 캐시된 값은 deep-freeze됩니다. upstream별 동시성 상한과 제한된 대기 큐가 초과 부하를 503으로 차단하며, 각 data-asset 인바운드 요청에는 전체 deadline(약 8초, 큐 대기와 모든 페이지 포함)이 있습니다. 남은 한계: 앱에는 여전히 **인증과 rate limit이 없어** 여러 호출자의 서로 다른 `parentId`가 동시성 상한까지 upstream 호출을 만들 수 있고, 한 목록이 deadline 안에서 최대 2 x 10 페이지 요청을 낼 수 있습니다. 실제 사용자에게 켜기 전에 Domain API를 인증 게이트웨이 뒤에 두십시오.
- **Query history 마스킹 한계.** 마스킹은 문자열/숫자 리터럴 치환과 주석 제거만 합니다. 큰따옴표 식별자(테이블/컬럼/사용자 이름 등)는 그대로 남아 PII를 포함할 수 있고, 비ASCII(유니코드) 숫자는 마스킹되지 않습니다.
- **인가 공백(ADR-0004 D7).** Lakekeeper는 호출 주체, 즉 최종 사용자가 아닌 Manager의 서비스 자격 증명을 인가하며, Manager는 사용자별로 노드를 필터링하지 않습니다. 따라서 live hierarchy 목록은 모두 `NODE_AUTHZ_NOT_ENFORCED` 경고를 포함하고 `childCount`는 `null`로 유지됩니다. 단일 asset 상세 응답에는 warnings 필드가 없어 이 표식이 없습니다(미해결 owner 질문).

**자격 증명(운영).** Manager는 Kubernetes Secret을 읽거나 코드에서 토큰을 발급하지 않으며, 토큰은 위 변수로 주입합니다. upstream마다 least-privilege 읽기 전용 권한의 전용 Keycloak client를 사용하십시오(Trino: 정책이 허용하는 범위의 query 목록만, Lakekeeper: OpenFGA에서 지정 warehouse에 대한 읽기 전용). Manager는 admin 토큰을 사용해서는 **안 됩니다**. 토큰은 로그에 남기거나 응답에 되돌리지 않습니다. 최종 사용자 identity 전파(token exchange/위임 토큰)는 구현되지 않았으며 미해결 owner 질문입니다.

**미해결 owner 질문.** (1) 토큰 모델: Manager가 upstream마다 어떤 Keycloak client/service account를 쓰는지, 실제 사용자 rollout 전에 최종 사용자 identity 전파(token exchange)가 필요한지. (2) `NODE_AUTHZ_NOT_ENFORCED` 경고와 함께 서비스 자격 증명의 가시 범위를 노출해도 되는지(ADR-0004 Open Question 3), 단일 asset 상세에도 같은 표식이 필요한지. (3) 신뢰된 운영자 그룹 밖에서 활성화하기 전에 query history를 호출자별로 제한하거나 정책으로 마스킹해야 하는지. (4) Trino `/v1/query`는 문서화되지 않은 Web UI endpoint입니다: 이 결합을 수용할지, Trino client로 `system.runtime.queries` 테이블을 쓰는 방식으로 옮길지. (5) upstream 401/403을 503에 합치는 대신 전용 `FORBIDDEN`/`UPSTREAM_FORBIDDEN` 에러 코드를 둘지. (6) Lakekeeper warehouse 이름과 Trino catalog 이름의 매핑은 탐색이 아니라 설정입니다.

**증거 상태.** spec에서 유도한 계약 테스트만 있습니다(`packages/domain-api/tests/upstream-*.test.ts`). live에서 기록한 payload가 아닙니다. 인증된 흐름은 **live에서 검증하지 않았습니다**.

## 공통 규약

### 페이지네이션

모든 목록(collection) 엔드포인트는 표준 쿼리 파라미터를 지원합니다:

- `page`: 1부터 시작하는 페이지 번호 (정수, 최소값 1, 기본값 `1`).
- `pageSize`: 페이지당 항목 수 (정수, 최소값 1, 최대값 100, 기본값 `20`).

모든 목록 응답은 페이지네이션 메타데이터를 포함하는 Envelope 구조로 감싸집니다:

```json
{
  "data": [ ... ],
  "meta": {
    "total": 42,
    "page": 1,
    "pageSize": 20
  }
}
```

> **중요**: `meta.total`은 쿼리 필터가 적용된 전체 페이지에 걸친 총 항목 수를 나타냅니다. 카탈로그 전체 테이블 수 등 KPI 집계나 전체 개수가 필요한 호출자는 현재 페이지의 항목 수만 담고 있는 `data.length`가 아니라 반드시 `meta.total`을 읽어야 합니다.

### 응답 Envelope 및 부분 실패(Partial-Failure) 경고

[ADR-0002](adr/0002-backend-api-technology.md)의 부분 실패 원칙에 따라, 특정 개별 업스트림 서비스가 저하(degraded)되거나 도달 불가능하더라도 전체 API 요청을 실패시키지 않습니다. 정상 응답 가능한 데이터를 반환하면서 저하 상태는 `warnings` 배열을 통해 전달합니다:

```json
{
  "data": [ ... ],
  "meta": {
    "total": 5,
    "page": 1,
    "pageSize": 20
  },
  "warnings": [
    {
      "code": "DEGRADED",
      "message": "Service 'Kafka' status is degraded",
      "serviceId": "svc-kafka"
    }
  ]
}
```

모든 구성요소가 정상(`healthy`)인 경우 `warnings` 배열 키는 응답에서 생략됩니다.

### 일관된 에러 구조

모든 엔드포인트는 유효성 검증 실패(400), 리소스 없음(404), 서버 오류(500)에 대해 일관된 에러 Envelope을 공유합니다:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Query parameter 'page' must be greater than or equal to 1"
  }
}
```

정의된 에러 코드는 다음과 같습니다:
- `VALIDATION_ERROR` (HTTP 400): 요청 파라미터나 바디가 스키마 유효성 검증에 실패함.
- `NOT_FOUND` (HTTP 404): 요청한 식별자의 리소스가 없거나 매칭되는 라우트가 없음.
- `INTERNAL_ERROR` (HTTP 500): 서버 내부 오류. 상세 예외 추적 정보는 보안 누출 방지를 위해 응답 바디에서 제외되고 서버 로그에만 기록됩니다.
- `SERVICE_UNAVAILABLE` (HTTP 503): 필요한 업스트림 서비스(예: `query-context`의 Trino)가 사용 불가, 타임아웃이거나 endpoint가 없습니다. `NOT_FOUND`와 구분되며 클라이언트는 재시도할 수 있습니다.

### Locale-Neutral 페이로드

모든 Domain API 응답, 도메인 모델, 엔티티 식별자 및 상태 토큰은 엄격하게 언어 중립적(locale-neutral)입니다. 한국어(`ko-KR`) 또는 영어(`en-US`) 번역과 날짜/숫자 서식 변환은 전적으로 웹 프론트엔드에서 담당합니다. [개발 가이드 — 다국어](development-ko.md#다국어) 섹션을 참조하십시오.
