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
| **Query History** | `/api/v1/query-history` | Adapter 가시성 범위의 query snapshot; 영구 이력이 아닙니다. `sql`은 원문 그대로 반환되며 민감한 리터럴을 포함할 수 있습니다. 마스킹(redaction)과 호출자별 authz가 없으므로(앱에 인증 미들웨어 없음) 마스킹/authz 정책이 정해지기 전에는 live adapter를 연결하지 마십시오. Live adapter 연결 전 기본 응답은 503입니다. | `GET /api/v1/query-history?page=1&pageSize=20` |
| **Resources** | `/api/v1/resources` | 플랫폼 워크로드를 지원하는 하위 Kubernetes 인프라 리소스 (Pod, Deployment, StatefulSet 등) | `GET /api/v1/resources`<br>`GET /api/v1/resources/{id}` |
| **Events** | `/api/v1/events` | 플랫폼 타임라인 이벤트, 상태 전이 및 운영 알림 (최신순 정렬) | `GET /api/v1/events` |
| **Decisions** | `/api/v1/decisions` | 읽기 전용 System-1 자동화 운영 판단 투영(projection) | `GET /api/v1/decisions`<br>`GET /api/v1/decisions/{id}` |
| **Policies** | `/api/v1/policies` | 컴파일된 Beluga 플랫폼 접근 제어 정책, 역할 정의 및 바인딩 투영 | `GET /api/v1/policies`<br>`GET /api/v1/policies/{id}` |

### 라우트 세부사항

- **Health (`/api/v1/health`)**: [`packages/domain-api/src/routes/health.ts`](../packages/domain-api/src/routes/health.ts)에 정의됨. `{ status: "healthy", version: string }`을 반환합니다. 컨테이너 헬스체크 및 liveness/readiness 프로브에 사용됩니다.
- **Services (`/api/v1/services`)**: [`packages/domain-api/src/routes/services.ts`](../packages/domain-api/src/routes/services.ts)에 정의됨. `type`(예: `streaming`, `lakehouse`, `query`, `processing`, `bi`) 및 `status`(`healthy`, `degraded`, `unavailable`) 필터링을 지원합니다.
- **Pipelines (`/api/v1/pipelines`)**: [`packages/domain-api/src/routes/pipelines.ts`](../packages/domain-api/src/routes/pipelines.ts)에 정의됨. 집계 `status` 필터링을 지원합니다. 단일 파이프라인 조회 시 연결된 상류/하류 스테이지 정보를 포함합니다. 각 파이프라인은 읽기 전용 `correlationLinks` 배열(기본값 `[]`)도 포함하며, 서비스 간 타입 링크를 표현합니다: `source`/`target`(`kind` + `id`), `relation`(`topic-feeds-job` = Kafka 토픽→Flink 작업, `job-writes-table` = Flink 작업→Iceberg 테이블, `table-served-by-catalog` = Iceberg 테이블→Trino 카탈로그, `dag-triggers-job` = Airflow DAG→작업), `confidence`(0~1), `method`(`declared-label` 0.95, `name-convention` 0.6, `ambiguous-name-convention` 0.3), `evidence`. 링크는 [`correlation/rules.ts`](../packages/domain-api/src/correlation/rules.ts)가 결정론적으로 생성하며, 존재하지 않는 대상을 가리키는 선언이나 일치하는 키가 없는 쌍은 추측하지 않고 링크를 만들지 않습니다(unknown). `method`가 `declared-label`이 아닌 모든 링크는 사실이 아니라 추정이며, 모호성은 양쪽에서 계산하고 `prod`, `raw` 같은 일반 접두어는 키로 쓰지 않습니다.
- **Data Assets (`/api/v1/data-assets`)**: [`packages/domain-api/src/routes/dataAssets.ts`](../packages/domain-api/src/routes/dataAssets.ts)에 정의됨. `status`, `kind`(`catalog`, `schema`, `table`, `topic`), `parentId` 필터링을 지원합니다. `parentId`는 해당 자산의 직계 자식(catalog -> schema -> table)만 반환하며, 알 수 없는 `parentId`는 빈 목록이고, 생략하면 기존처럼 전체 flat 목록입니다(최상위 catalog는 `kind=catalog`). 자산은 선택적 구조화 계층 필드 `catalog`, `namespace`(순서 있는 segment), `parentId`, `path`(조상 이름)를 가지며, 호환성을 위해 `name`/`id`는 기존 flat·opaque 형태를 유지합니다. 상세 조회 시 컬럼 정의(`isPartition`은 파티션 컬럼 표시)와 샘플 쿼리 컨텍스트를 제공하며, catalog/schema 상세의 `childCount`는 노드 단위 인가 필터링이 구현되기 전까지 항상 `null`입니다(ADR-0004 D7/D9).
- **Resources (`/api/v1/resources`)**: [`packages/domain-api/src/routes/resources.ts`](../packages/domain-api/src/routes/resources.ts)에 정의됨. `namespace` 및 `kind`(`pod`, `deployment`, `statefulset` 등) 필터링을 지원합니다.
- **Events (`/api/v1/events`)**: [`packages/domain-api/src/routes/events.ts`](../packages/domain-api/src/routes/events.ts)에 정의됨. 주의: Event 모델에는 헬스 `status` 필드가 없으며, `severity`(`info`, `warning`, `error`, `critical`)로 필터링합니다.
- **Decisions (`/api/v1/decisions`)**: [`packages/domain-api/src/routes/decisions.ts`](../packages/domain-api/src/routes/decisions.ts)에 정의됨. `decision` 판단 결과 필터링을 지원합니다.
- **Policies (`/api/v1/policies`)**: [`packages/domain-api/src/routes/policies.ts`](../packages/domain-api/src/routes/policies.ts)에 정의됨. `role` 필터링을 지원합니다.

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
