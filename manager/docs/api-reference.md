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

The Domain API organizes endpoints into nine distinct resource groups under `/api/v1`. Route implementations reside in [`packages/domain-api/src/routes/`](../packages/domain-api/src/routes/):

| Resource Group | Base Path | Description | Endpoints |
|---|---|---|---|
| **Health** | `/api/v1/health` | Process health and version check for the Domain API itself (does not proxy upstream health) | `GET /api/v1/health` |
| **Services** | `/api/v1/services` | Unified view of integrated OSS platform components, health statuses, and capability categories | `GET /api/v1/services`<br>`GET /api/v1/services/{id}` |
| **Pipelines** | `/api/v1/pipelines` | End-to-end data pipeline topologies and stage execution states correlated across streaming, compute, lakehouse, and query engines | `GET /api/v1/pipelines`<br>`GET /api/v1/pipelines/{id}` |
| **Data Assets** | `/api/v1/data-assets` | Cataloged platform data assets (catalogs, schemas, tables, topics) with query context and storage metadata | `GET /api/v1/data-assets`<br>`GET /api/v1/data-assets/{id}`<br>`GET /api/v1/data-assets/{id}/query-context` |
| **Query History** | `/api/v1/query-history` | Adapter-visible query snapshot; no persistent history. `sql` is returned verbatim and may contain sensitive literals; no redaction and no per-caller authz (the app has no auth middleware), so do not wire a live adapter until a redaction/authz policy is decided. Default: 503 until the opt-in Trino adapter is configured (see Optional Upstream Adapters). | `GET /api/v1/query-history?page=1&pageSize=20` |
| **Resources** | `/api/v1/resources` | Underlying Kubernetes infrastructure workloads and operational objects (Pods, Deployments, StatefulSets) | `GET /api/v1/resources`<br>`GET /api/v1/resources/{id}` |
| **Events** | `/api/v1/events` | Platform timeline events, state transitions, and operational alerts, sorted newest first | `GET /api/v1/events` |
| **Decisions** | `/api/v1/decisions` | Read-only System-1 automated operational decision projections | `GET /api/v1/decisions`<br>`GET /api/v1/decisions/{id}` |
| **Policies** | `/api/v1/policies` | Compiled Beluga platform access control policies, role definitions, and binding projections | `GET /api/v1/policies`<br>`GET /api/v1/policies/{id}` |

### Route Details

- **Health (`/api/v1/health`)**: Defined in [`packages/domain-api/src/routes/health.ts`](../packages/domain-api/src/routes/health.ts). Returns `{ status: "healthy", version: string }`. Used for container readiness/liveness probes.
- **Services (`/api/v1/services`)**: Defined in [`packages/domain-api/src/routes/services.ts`](../packages/domain-api/src/routes/services.ts). Supports filtering by `type` (e.g. `kafka`, `flink`, `trino`) and `status` (`healthy`, `degraded`, `stale`, `unknown`, `unavailable`). The registry selects adapters by registered `type` before calling them; `status` is filtered after fetching health. An unmatched valid type returns an empty list without adapter calls. Selected adapter failures retain HTTP 200 with `unknown` entries and warnings for those entries on the returned page; excluded adapters cannot contribute warnings.
- **Pipelines (`/api/v1/pipelines`)**: Defined in [`packages/domain-api/src/routes/pipelines.ts`](../packages/domain-api/src/routes/pipelines.ts). Supports filtering by aggregate `status`. Single pipeline lookups include connected upstream and downstream stages. Each pipeline also carries a read-only `correlationLinks` array (default `[]`) of typed cross-service links: `source`/`target` (`kind` + `id`), `relation` (`topic-feeds-job` = Kafka topic to Flink job, `job-writes-table` = Flink job to Iceberg table, `table-served-by-catalog` = Iceberg table to Trino catalog, `dag-triggers-job` = Airflow DAG to job), `confidence` (0-1), `method` (`declared-label` 0.95, `name-convention` 0.6, `ambiguous-name-convention` 0.3) and `evidence`. Links are produced deterministically by [`correlation/rules.ts`](../packages/domain-api/src/correlation/rules.ts); a declaration pointing at a non-existent target yields no link, and pairs with no matching key yield none (unknown) rather than a guess. Every link whose `method` is not `declared-label` is inferred, not a fact; ambiguity is counted from both sides, and generic prefixes (`prod`, `raw`, ...) never form a key.
- **Data Assets (`/api/v1/data-assets`)**: Defined in [`packages/domain-api/src/routes/dataAssets.ts`](../packages/domain-api/src/routes/dataAssets.ts). Supports filtering by `status`, `kind` (`catalog`, `schema`, `table`, `topic`) and `parentId` (direct children of that asset: catalog -> schemas -> tables; an unknown `parentId` returns an empty list; omitting it keeps the flat all-assets list, and `kind=catalog` lists top-level catalogs). Assets carry structured, optional hierarchy fields `catalog`, `namespace` (ordered segments), `parentId` and `path` (ancestor names); `name` and `id` stay flat/opaque for compatibility. Detail lookups include column definitions (`isPartition` marks partition columns) and sample query context; `childCount` on catalog/schema details is always `null` until node-level authorization filtering exists (ADR-0004 D7/D9).
- **Resources (`/api/v1/resources`)**: Defined in [`packages/domain-api/src/routes/resources.ts`](../packages/domain-api/src/routes/resources.ts). Supports filtering by `namespace` and `kind` (`Namespace`, `Workload`, `Pod`, `Service`, `Endpoint`, `Job`, `PersistentVolumeClaim`). `PersistentVolumeClaim` resources may carry optional `capacity` and `storageClass`; both are omitted when unknown and are not inferred for other kinds. `logsUrl` stays an external link for any kind, including `Job`; the Manager stores no logs.
- **Events (`/api/v1/events`)**: Defined in [`packages/domain-api/src/routes/events.ts`](../packages/domain-api/src/routes/events.ts). Note: Events do not contain a health `status` field; they are filtered by `severity` (`info`, `warning`, `error`). Each event may carry an optional `source` (`kubernetes`, `service`, `job`) distinguishing a Kubernetes Event from a Service or Job failure; an absent `source` means the origin is unknown, and clients must not treat it as authoritative or guess it.
- **Decisions (`/api/v1/decisions`)**: Defined in [`packages/domain-api/src/routes/decisions.ts`](../packages/domain-api/src/routes/decisions.ts). Supports filtering by `decision` outcome.
- **Policies (`/api/v1/policies`)**: Defined in [`packages/domain-api/src/routes/policies.ts`](../packages/domain-api/src/routes/policies.ts). Supports filtering by `role`.

## Optional Upstream Adapters (opt-in, read-only)

Issues #17 and #36. Everything below is **off by default**: with no environment variables the Domain API serves fixtures and `GET /api/v1/query-history` returns 503. Code: [`packages/domain-api/src/adapters/upstream/`](../packages/domain-api/src/adapters/upstream/) (wiring in `config.ts`, called from `server.ts`).

| Variable | Meaning |
|---|---|
| `BELUGA_TRINO_ENABLED=true` | Enable the Trino query-history adapter. |
| `BELUGA_TRINO_BASE_URL` | Coordinator origin, e.g. `https://trino.local.beluga.internal`. |
| `BELUGA_TRINO_TOKEN_FILE` / `BELUGA_TRINO_TOKEN` | Bearer token (a mounted file is preferred and re-read on every call so rotation needs no restart). Required. |
| `BELUGA_TRINO_USER` | Optional `X-Trino-User` header. Not required by Trino 483 ([client protocol](https://trino.io/docs/483/develop/client-protocol.html)); with a bearer token the identity comes from the token. |
| `BELUGA_TRINO_HISTORY_ACK=shared-service-credential` | Required acknowledgement that history is the service credential's view, shared by every caller (no per-caller authz, no auth middleware in the app). Without it the adapter stays disabled. |
| `BELUGA_TRINO_HISTORY_SQL=literals\|none` | Default `literals`: string/numeric literals become `?` and comments are removed from `sql`. `none` returns SQL verbatim. Redaction is best-effort, not a security boundary. |
| `BELUGA_LAKEKEEPER_ENABLED=true` | Enable the Lakekeeper catalog source. |
| `BELUGA_LAKEKEEPER_BASE_URL` | Origin only; `BELUGA_LAKEKEEPER_BASE_PATH` (default `/catalog`) is appended. |
| `BELUGA_LAKEKEEPER_WAREHOUSES` | Comma-separated `warehouse` or `catalogName=warehouse`; each entry becomes a catalog node (the name should equal the Trino catalog name used in `query-context`). |
| `BELUGA_LAKEKEEPER_TOKEN_FILE` / `BELUGA_LAKEKEEPER_TOKEN` | Bearer token. Required. |
| `BELUGA_UPSTREAM_TIMEOUT_MS` | Per-call timeout (default 2500). |
| `BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER=true` | Allow a bearer token over plain `http` to a non-loopback host (e.g. in-cluster ClusterIP). Refused by default. |

**Upstream contracts.** Trino: `GET /v1/query` returns `List<BasicQueryInfo>` (`queryId`, `state`, `query`, ...) and is `@ResourceSecurity(AUTHENTICATED_USER)`, filtered by the authenticated identity ([`QueryResource.java`](https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/QueryResource.java), [`BasicQueryInfo.java`](https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/BasicQueryInfo.java), tag 483). **This endpoint is not in the documented client protocol or in the 483 web-interface page; it is the web UI's backing endpoint and may change between Trino versions.** History is only what the coordinator still retains, in upstream order; at most 1000 entries are mapped. Iceberg REST: [`rest-catalog-open-api.yaml`](https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml) (`/v1/config`, `/v1/{prefix}/namespaces[?parent=&pageToken=&pageSize=]`, `/namespaces/{ns}`, `/namespaces/{ns}/tables`, `/namespaces/{ns}/tables/{table}`; multi-level namespaces joined by `%1F`); Lakekeeper serves it under `/catalog` ([concepts](https://docs.lakekeeper.io/docs/latest/concepts/)).

**Behavior.**
- GET-only; timeouts; response size cap; redirects refused (a redirect could forward the bearer token); only mapped fields are read, so `config`/`storage-credentials` in `LoadTableResult` (vended storage credentials) never reach the response.
- Failure classes (`unreachable`, `timeout`, `401`, `403`, `404`, `5xx`, malformed JSON/shape) never throw into a route. History and data-asset list/detail/query-context return **503** `SERVICE_UNAVAILABLE` with no partial data; 401/403 messages say the upstream did not accept Manager's service credential. Upstream 404 for an asset maps to 404. Logs carry only the failure class and HTTP status.
- Data assets with the live source: omitting `parentId` returns the configured top-level catalogs only (no flat crawl); `parentId` of a catalog lists its top-level namespaces as `schema` nodes; of a schema lists nested namespaces (`schema`) and `table` nodes; any other/unknown `parentId` (including legacy fixture ids) returns an empty list. Upstream pages are drained (at most 50 upstream pages per listing, then a `LISTING_TRUNCATED` warning) before `page`/`pageSize` slicing. Asset `id`s follow ADR-0004 D4; `name` keeps the flat `namespace.table` form. `status` is `unknown` (the REST catalog reports no per-object health). Table detail maps the current schema (Iceberg type names, `required` -> `nullable`, `doc` -> `comment`, partition source columns -> `isPartition`), `location`, `Iceberg v<format-version>` (+ `write.format.default` when set), snapshot count, last update and partition spec.
- **Authorization gap (ADR-0004 D7).** Lakekeeper authorizes the calling principal, which is Manager's service credential, not the end user; Manager does not filter nodes per user. Every live hierarchy list therefore carries a `NODE_AUTHZ_NOT_ENFORCED` warning and `childCount` stays `null`. The single-asset detail response has no warnings field, so it carries no such marker (open owner question).

**Credentials (production).** Manager never reads Kubernetes Secrets or mints tokens in code; tokens are injected through the variables above. Use a dedicated Keycloak client with least-privilege, read-only grants for each upstream (Trino: ability to list queries only as the policy allows; Lakekeeper: read-only on the listed warehouses in OpenFGA). Manager must **not** use an admin token. Tokens are never logged or echoed. Propagating the end-user identity (token exchange / delegated tokens) is not implemented and is an open owner question.

**Open owner questions.** (1) Token model: which Keycloak client/service account does Manager use per upstream, and is end-user identity propagation (token exchange) required before real-user rollout? (2) Is it acceptable to expose the service credential's view with the `NODE_AUTHZ_NOT_ENFORCED` warning (ADR-0004 Open Question 3), and should the single-asset detail carry the same marker? (3) Should query history be restricted per caller or redacted by policy before it is enabled outside a trusted operator group? (4) Trino `/v1/query` is an undocumented web-UI endpoint: accept that coupling, or move to the `system.runtime.queries` table through a Trino client? (5) Should a dedicated `FORBIDDEN`/`UPSTREAM_FORBIDDEN` error code exist instead of folding upstream 401/403 into 503? (6) Mapping of Lakekeeper warehouse name to Trino catalog name is configuration, not discovered.

**Evidence status.** Spec-derived contract tests only (`packages/domain-api/tests/upstream-*.test.ts`); not live-recorded payloads. Authenticated flows are **not verified live**.

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
