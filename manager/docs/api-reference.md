# API Reference

The Beluga Manager Domain API provides a unified RESTful interface over the integrated open-source platform components (Kafka, Flink, Iceberg, Trino, Airflow, Superset, and Kubernetes). It exposes platform-level domain abstractions—Services, Pipelines, Data Assets, Resources, Events, Decisions, and Policies—rather than raw OSS management interfaces.

See the [Korean API reference](api-reference-ko.md) for the Korean version.

## Live Runtime API Contract

To avoid documentation drift, this reference does not duplicate request/response schemas by hand. The authoritative, OpenAPI 3.1.0-compliant specification is generated directly from source code Zod schemas (`@hono/zod-openapi`) and served at runtime by the Domain API process:

- **Local base URL**: `http://localhost:8787` (default port, configurable via the `PORT` environment variable; see [`packages/domain-api/src/server.ts`](../packages/domain-api/src/server.ts))
- **Interactive Swagger UI**: `http://localhost:8787/api/v1/docs` (served via `@hono/swagger-ui`)
- **Machine-readable OpenAPI 3.1 JSON**: `http://localhost:8787/api/v1/openapi.json`

To start the API server locally:

```bash
npm run dev:api
```

Developers integrating with or extending the Domain API should inspect `http://localhost:8787/api/v1/docs` for exact payload structures, parameter requirements, field validation constraints, and interactive request testing.

## Core Resource Groups

The Domain API organizes endpoints into eight distinct resource groups under `/api/v1`. Route implementations reside in [`packages/domain-api/src/routes/`](../packages/domain-api/src/routes/):

| Resource Group | Base Path | Description | Endpoints |
|---|---|---|---|
| **Health** | `/api/v1/health` | Process health and version check for the Domain API itself (does not proxy upstream health) | `GET /api/v1/health` |
| **Services** | `/api/v1/services` | Unified view of integrated OSS platform components, health statuses, and capability categories | `GET /api/v1/services`<br>`GET /api/v1/services/{id}` |
| **Pipelines** | `/api/v1/pipelines` | End-to-end data pipeline topologies and stage execution states correlated across streaming, compute, lakehouse, and query engines | `GET /api/v1/pipelines`<br>`GET /api/v1/pipelines/{id}` |
| **Data Assets** | `/api/v1/data-assets` | Cataloged platform data assets (tables, topics, schemas) with query context and storage metadata | `GET /api/v1/data-assets`<br>`GET /api/v1/data-assets/{id}`<br>`GET /api/v1/data-assets/{id}/query-context` |
| **Resources** | `/api/v1/resources` | Underlying Kubernetes infrastructure workloads and operational objects (Pods, Deployments, StatefulSets) | `GET /api/v1/resources`<br>`GET /api/v1/resources/{id}` |
| **Events** | `/api/v1/events` | Platform timeline events, state transitions, and operational alerts, sorted newest first | `GET /api/v1/events` |
| **Decisions** | `/api/v1/decisions` | Read-only System-1 automated operational decision projections | `GET /api/v1/decisions`<br>`GET /api/v1/decisions/{id}` |
| **Policies** | `/api/v1/policies` | Compiled Beluga platform access control policies, role definitions, and binding projections | `GET /api/v1/policies`<br>`GET /api/v1/policies/{id}` |

### Route Details

- **Health (`/api/v1/health`)**: Defined in [`packages/domain-api/src/routes/health.ts`](../packages/domain-api/src/routes/health.ts). Returns `{ status: "healthy", version: string }`. Used for container readiness/liveness probes.
- **Services (`/api/v1/services`)**: Defined in [`packages/domain-api/src/routes/services.ts`](../packages/domain-api/src/routes/services.ts). Supports filtering by `type` (e.g. `streaming`, `lakehouse`, `query`, `processing`, `bi`) and `status` (`healthy`, `degraded`, `unavailable`).
- **Pipelines (`/api/v1/pipelines`)**: Defined in [`packages/domain-api/src/routes/pipelines.ts`](../packages/domain-api/src/routes/pipelines.ts). Supports filtering by aggregate `status`. Single pipeline lookups include connected upstream and downstream stages.
- **Data Assets (`/api/v1/data-assets`)**: Defined in [`packages/domain-api/src/routes/dataAssets.ts`](../packages/domain-api/src/routes/dataAssets.ts). Supports filtering by `status` and `kind` (`table`, `topic`, `schema`). Detailed lookups include column definitions and sample query context.
- **Resources (`/api/v1/resources`)**: Defined in [`packages/domain-api/src/routes/resources.ts`](../packages/domain-api/src/routes/resources.ts). Supports filtering by `namespace` and `kind` (`pod`, `deployment`, `statefulset`, etc.).
- **Events (`/api/v1/events`)**: Defined in [`packages/domain-api/src/routes/events.ts`](../packages/domain-api/src/routes/events.ts). Note: Events do not contain a health `status` field; they are filtered by `severity` (`info`, `warning`, `error`, `critical`).
- **Decisions (`/api/v1/decisions`)**: Defined in [`packages/domain-api/src/routes/decisions.ts`](../packages/domain-api/src/routes/decisions.ts). Supports filtering by `decision` outcome.
- **Policies (`/api/v1/policies`)**: Defined in [`packages/domain-api/src/routes/policies.ts`](../packages/domain-api/src/routes/policies.ts). Supports filtering by `role`.

## Common Conventions

### Pagination

All collection listing endpoints support standard query parameters:

- `page`: 1-based page number (integer, min 1, default `1`).
- `pageSize`: Number of items per page (integer, min 1, max 100, default `20`).

Every collection response wraps results in an envelope containing pagination metadata:

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

> **Important**: `meta.total` represents the total count of matching items across all pages after query filters are applied. Callers calculating total counts or displaying KPI aggregates (e.g. total tables in catalog) must read `meta.total`, not `data.length`, because `data` only contains items on the current page.

### Response Envelope and Partial-Failure Warnings

In accordance with [ADR-0002](adr/0002-backend-api-technology.md) partial-failure semantics, the failure or degradation of an individual upstream service does not fail the entire API request. Instead, available data is returned and degradation is communicated via the `warnings` array:

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

The `warnings` array is omitted from the response envelope when all components are healthy.

### Uniform Error Structure

All endpoints share a consistent error envelope for validation errors (400), missing resources (404), and server errors (500):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Query parameter 'page' must be greater than or equal to 1"
  }
}
```

Recognized error codes are:
- `VALIDATION_ERROR` (HTTP 400): Request parameters or body failed schema validation.
- `NOT_FOUND` (HTTP 404): Requested resource identifier does not exist or route is not matched.
- `INTERNAL_ERROR` (HTTP 500): Internal server error; detailed exception traces are logged on the server and omitted from the response body to prevent leakage.
- `SERVICE_UNAVAILABLE` (HTTP 503): A required upstream service (e.g. Trino for `query-context`) is unavailable, timed out, or has no endpoint. Distinct from `NOT_FOUND`; clients may retry.

### Locale-Neutral Payloads

All Domain API resources, entity names, status tokens, and error payloads are strictly locale-neutral. Localization into Korean (`ko-KR`) or English (`en-US`), along with localized number and date formatting, is handled exclusively by the web frontend. See the Internationalization section in the [Development Guide](development.md#internationalization).
