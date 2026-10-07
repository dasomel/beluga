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
| **Query History** | `/api/v1/query-history` | Adapter-visible query snapshot; no persistent history. Default: 503 until the opt-in Trino adapter is configured (see the Trino/Lakekeeper section). The app has no auth middleware, so the history is the Manager service credential's view shared by every caller, which is why enabling the adapter requires an explicit acknowledgement. With the adapter, `sql` is masked by default (string/numeric literals and comments replaced); double-quoted identifiers and non-ASCII digits are NOT masked and may carry PII, and `BELUGA_TRINO_HISTORY_SQL=none` returns SQL verbatim. Injected test stubs return whatever SQL they are given. | `GET /api/v1/query-history?page=1&pageSize=20` |
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

## Upstream Adapters: Flink (opt-in, read-only)

By default the Domain API serves stub fixtures and makes no upstream calls. Setting `BELUGA_FLINK_REST_URL` enables the Flink adapter ([`packages/domain-api/src/adapters/flink/`](../packages/domain-api/src/adapters/flink/), issues #16/#35/#41); invalid values fail at startup.

| Variable | Default | Meaning |
|---|---|---|
| `BELUGA_FLINK_REST_URL` | unset (adapter disabled) | Flink JobManager REST origin, e.g. `http://flink-cluster-rest.streaming:8081`. Must be `http`/`https`, no path, no embedded credentials. |
| `BELUGA_FLINK_TIMEOUT_MS` | `2000` | Per-request deadline, integer 1-30000. It starts when the request is issued, so time spent waiting for a concurrency slot counts against it. |
| `BELUGA_FLINK_CACHE_TTL_MS` | `5000` | How long a complete pipeline snapshot (and the `/overview` result) is reused, integer 1000-60000 (default 5000). Values below 1000, including `0` (no reuse), are rejected at startup unless `BELUGA_FLINK_ALLOW_NO_CACHE=true` is also set. Warning: with no cache and no API authentication, any caller can drive the JobManager at the concurrency cap (measured about 3000 upstream calls/s with a fake upstream); leave the TTL above 0. Concurrent calls are still coalesced. |
| `BELUGA_FLINK_ALLOW_NO_CACHE` | unset | Set to exactly `true` to permit `BELUGA_FLINK_CACHE_TTL_MS` below 1000. Not recommended. |
| `BELUGA_FLINK_SNAPSHOT_BUDGET_MS` | `5000` | Total time budget to build one snapshot, integer 1-60000. When exceeded, pending requests are aborted and the jobs read so far are returned with a `PARTIAL` warning (or `UPSTREAM_UNAVAILABLE` if even `/jobs/overview` did not arrive). |
| `BELUGA_FLINK_MAX_CONCURRENCY` | `8` | Global cap on in-flight JobManager requests across all routes, integer 1-32. |
| `BELUGA_FLINK_MAX_QUEUE` | `64` | Maximum number of requests waiting for a concurrency slot, integer 0-1024. When full, further requests are rejected immediately (service health `unknown`; list/by-id report `UPSTREAM_UNAVAILABLE` / 503). |
| `BELUGA_FLINK_JOB_NAME_PREFIX` | `beluga-` | Removed from a Flink job name before name-convention correlation (`beluga-cdc_orders` is compared as `cdc_orders`). |

Behavior when enabled:

- Only `GET /overview`, `GET /jobs/overview` and `GET /jobs/{jobid}` are called ([Flink 1.20 REST API](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/rest_api/)); no mutating request exists in the client.
- `svc-flink` in `GET /api/v1/services` is served by the adapter (version and key metrics from `/overview`; `endpoint` is not exposed). `GET /api/v1/pipelines` returns **live Flink pipelines only** (one Pipeline per Flink job, id `pl-flink-<jid>`); stub pipelines are not mixed in.
- Load on the JobManager: both `GET /api/v1/pipelines` and `GET /api/v1/pipelines/{id}` are served from one shared snapshot. Concurrent calls share a single build (single flight) and a complete result is reused for `BELUGA_FLINK_CACHE_TTL_MS`. One build is 1 `/jobs/overview` plus at most 100 `/jobs/{jobid}` (more jobs are cut with a `TRUNCATED` warning and are not addressable by id either), bounded by the snapshot budget, the global concurrency cap and the wait queue. So the upstream cost is at most one build per TTL no matter how many requests or distinct ids arrive (there is no per-id cache that could thrash). Transient failures (queue full, timeout, unreachable) are never cached; a snapshot whose only problems are genuine upstream error responses (HTTP error, unexpected body) is reused for at most 1 second (or the TTL if shorter). The Domain API still has no authentication; these limits bound, but do not remove, the load an unauthenticated caller can cause.
- Pipeline id is `pl-flink-<Flink job id>` (32-hex `jid`). It does not depend on other jobs, but Flink assigns a new `jid` when a job is resubmitted, so the id changes then. `GET /api/v1/pipelines/{id}` has no `warnings` field, so it never returns an incomplete object as a clean 200: it returns `503 SERVICE_UNAVAILABLE` when (a) the JobManager cannot be read at all (unreachable, timeout, queue full, error or malformed response), or (b) the job exists but its `/jobs/{jobid}` detail could not be read, so its sink stage and correlation link are missing (the list route returns the same job with a `PARTIAL` warning). It returns 404 only when the snapshot was read successfully and has no such job, and for ids not in this format (without calling upstream).
- Cross-route references: stub events, resources and decisions point at stub pipeline ids (e.g. `pl-lakehouse-ingest`) that do not exist among live pipelines, so while the adapter is enabled their `relatedPipelineId` is returned as `null`. All other fields of those routes remain stub data, and clients following those links get no related pipeline.
- Failures never reach the route as errors: an unreachable or timed-out JobManager gives `unknown` service health and an empty pipeline list with an `UPSTREAM_UNAVAILABLE` warning; HTTP 5xx gives `degraded`; malformed or unexpected JSON gives `unknown`. If only some `/jobs/{jobid}` lookups fail, the jobs are still returned with a `PARTIAL` warning (their sink tables are missing); at most 100 jobs are read (`TRUNCATED` warning); response bodies above 2 MiB are rejected while streaming.
- Flink job state to domain status (unrecognised states map to `unknown`/`unknown`; `RUNNING` with a failed task is `degraded`; `failureReason` carries only the state name, never exception text):

| Flink state | Pipeline/stage status | Job `lastRun.result` |
|---|---|---|
| `RUNNING` | `healthy` | `running` |
| `FINISHED` | `healthy` | `succeeded` |
| `RESTARTING`, `FAILING` | `degraded` | `unknown` |
| `FAILED` | `unavailable` | `failed` |
| `CANCELED`, `SUSPENDED` | `unavailable` | `unknown` |
| `INITIALIZING`, `CREATED`, `RECONCILING`, `CANCELLING`, any other | `unknown` | `unknown` |

- Correlation: Flink REST exposes neither Kafka topics nor labels, so no `topic-feeds-job` link is produced. The sink table named by an `IcebergSink` vertex of the job graph is added as an `iceberg-table` entity and linked through the existing name-convention rule (`method` `name-convention`, confidence 0.6; the Flink job-graph vertex is appended to `evidence`). The Iceberg stage stays `unknown` because it is not verified against Lakekeeper/Trino. Each live Pipeline has `correlation.method` `inferred`.

## Upstream Adapters: Trino Query History and Lakekeeper Catalog (opt-in, read-only)

Independent of the Flink adapter above: each adapter is enabled only by its own variables, and any combination (none, one, or all) works. Issues #17 and #36. Everything below is **off by default**: with no environment variables the Domain API serves fixtures and `GET /api/v1/query-history` returns 503. Code: [`packages/domain-api/src/adapters/upstream/`](../packages/domain-api/src/adapters/upstream/) (wiring in `config.ts`, called from `server.ts`).

**Misconfiguration policy (same as the Flink adapter): fail-fast.** If `BELUGA_TRINO_ENABLED=true` or `BELUGA_LAKEKEEPER_ENABLED=true` and any related value is missing or invalid (bad URL such as `BELUGA_TRINO_BASE_URL="not a url"`, missing token, missing acknowledgement, invalid number), startup fails with a `ConfigError` naming the variable (values are never echoed), exactly as `BELUGA_FLINK_REST_URL=nope` does; an adapter is never silently disabled or given a default in place of an invalid value. Booleans accept exactly `true` or `false` (unset or empty = false; `TRUE`, `1`, `yes` are rejected). Integers accept plain decimal digits within a range: `BELUGA_UPSTREAM_TIMEOUT_MS` 1-30000, `BELUGA_UPSTREAM_MAX_CONCURRENT` 1-32, every `*_CACHE_TTL_MS` 0-600000. Unset variables use the defaults below.

| Variable | Meaning |
|---|---|
| `BELUGA_TRINO_ENABLED=true` | Enable the Trino query-history adapter. |
| `BELUGA_TRINO_BASE_URL` | Coordinator origin, e.g. `https://trino.local.beluga.internal`. |
| `BELUGA_TRINO_TOKEN_FILE` / `BELUGA_TRINO_TOKEN` | Bearer token (a mounted file is preferred and re-read on every call so rotation needs no restart). Required. |
| `BELUGA_TRINO_USER` | Optional `X-Trino-User` header. Not required by Trino 483 ([client protocol](https://trino.io/docs/483/develop/client-protocol.html)); with a bearer token the identity comes from the token. |
| `BELUGA_TRINO_HISTORY_ACK=shared-service-credential` | Required acknowledgement that history is the service credential's view, shared by every caller (no per-caller authz, no auth middleware in the app). Without it startup fails with a `ConfigError`. |
| `BELUGA_TRINO_HISTORY_SQL=literals\|none` | Default `literals`: string/numeric literals become `?` and comments are removed from `sql`. `none` returns SQL verbatim. Redaction is best-effort, not a security boundary. |
| `BELUGA_LAKEKEEPER_ENABLED=true` | Enable the Lakekeeper catalog source. |
| `BELUGA_LAKEKEEPER_BASE_URL` | Origin only; `BELUGA_LAKEKEEPER_BASE_PATH` (default `/catalog`) is appended. |
| `BELUGA_LAKEKEEPER_WAREHOUSES` | Comma-separated `warehouse` or `catalogName=warehouse`; each entry becomes a catalog node (the name should equal the Trino catalog name used in `query-context`). |
| `BELUGA_LAKEKEEPER_TOKEN_FILE` / `BELUGA_LAKEKEEPER_TOKEN` | Bearer token. Required. |
| `BELUGA_LAKEKEEPER_CACHE_TTL_MS` | How long a successful catalog listing/detail is reused (default 5000; `0` = no reuse, single-flight only). |
| `BELUGA_TRINO_HISTORY_CACHE_TTL_MS` | How long a successful Trino history snapshot is reused (default 5000; `0` = single-flight only). Pagination does not change the upstream request, so there is one cache key. |
| `BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS` | How long a genuine upstream failure (unreachable, 401/403, 5xx, malformed) is remembered instead of retried (default 2000; `0` disables). Our own timeouts and overload sheds are never remembered. |
| `BELUGA_UPSTREAM_MAX_CONCURRENT` | Max simultaneous in-flight requests per upstream (default 8; 64 callers may wait, further requests are shed as 503). |
| `BELUGA_UPSTREAM_TIMEOUT_MS` | Per-call timeout (default 2500). |
| `BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER=true` | Allow a bearer token over plain `http` to a non-loopback host (e.g. in-cluster ClusterIP). Refused by default (startup fails with a `ConfigError`). |

**Upstream contracts.** Trino: `GET /v1/query` returns `List<BasicQueryInfo>` (`queryId`, `state`, `query`, ...) and is `@ResourceSecurity(AUTHENTICATED_USER)`, filtered by the authenticated identity ([`QueryResource.java`](https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/QueryResource.java), [`BasicQueryInfo.java`](https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/BasicQueryInfo.java), tag 483). **This endpoint is not in the documented client protocol or in the 483 web-interface page; it is the web UI's backing endpoint and may change between Trino versions.** History is only what the coordinator still retains, in upstream order; at most 1000 entries are mapped, and when the upstream returned more, every page carries a `HISTORY_TRUNCATED` warning (`meta.total` counts the exposed rows, not the upstream total). Iceberg REST: [`rest-catalog-open-api.yaml`](https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml) (`/v1/config`, `/v1/{prefix}/namespaces[?parent=&pageToken=&pageSize=]`, `/namespaces/{ns}`, `/namespaces/{ns}/tables`, `/namespaces/{ns}/tables/{table}`; multi-level namespaces joined by `%1F`); Lakekeeper serves it under `/catalog` ([concepts](https://docs.lakekeeper.io/docs/latest/concepts/)).

**Behavior.**
- GET-only; timeouts; response size cap enforced in **bytes while streaming** (default 5 MiB; the stream is cancelled on overflow, also for chunked bodies; every response whose body is not consumed - non-2xx, declared-oversize, abort - is cancelled so its socket is released, verified against a real HTTP server); redirects refused (a redirect could forward the bearer token); only mapped fields are read, so `config`/`storage-credentials` in `LoadTableResult` (vended storage credentials) never reach the response.
- Failure classes (`unreachable`, `timeout`, `401`, `403`, `404`, `5xx`, malformed JSON/shape) never throw into a route. History and data-asset list/detail/query-context return **503** `SERVICE_UNAVAILABLE` with no partial data; 401/403 messages say the upstream did not accept Manager's service credential. Upstream 404 for an asset maps to 404. Logs carry only the failure class and HTTP status.
- Data assets with the live source: omitting `parentId` returns the configured top-level catalogs only (no flat crawl); `parentId` of a catalog lists its top-level namespaces as `schema` nodes; of a schema lists nested namespaces (`schema`) and `table` nodes; any other/unknown `parentId` (including legacy fixture ids) returns an empty list. Upstream pages are drained (at most 10 upstream pages per listing, then a `LISTING_TRUNCATED` warning) before `page`/`pageSize` slicing. Asset `id`s follow ADR-0004 D4; `name` keeps the flat `namespace.table` form. `status` is `unknown` (the REST catalog reports no per-object health). Table detail maps the current schema (Iceberg type names, `required` -> `nullable`, `doc` -> `comment`, partition source columns -> `isPartition`), `location`, `Iceberg v<format-version>` (+ `write.format.default` when set), snapshot count, last update and partition spec.
- **Path-safety.** Asset-id segments that decode to an empty string, `.` or `..`, or contain control characters (including NUL and the `0x1F` namespace separator) or `/`/`\` are rejected when the id is parsed (such ids are 404 / empty list and never reach the upstream); upstream-provided namespace/table names of that kind are not exposed; the upstream-provided `prefix` must match a conservative name charset; and the HTTP client refuses to send any request whose path the URL parser would normalize (`..` and `%2E%2E` are both dot segments), so a request can never leave `/catalog/v1/<prefix>/...`.
- **Request amplification.** Identical concurrent requests are single-flighted for **both** upstreams (Lakekeeper catalog listings/details and `/v1/config`, and the Trino history snapshot) and successful results are reused for a short TTL; genuine upstream failures are remembered briefly (negative cache), while our own timeouts and overload sheds are never cached. Caches are LRU and bounded: at most 100 entries and 20000 total weight (assets, columns or history rows) per adapter, and one listing is capped at 10 upstream pages (1000 items per listing, then a `LISTING_TRUNCATED` warning). Invalid, unknown-catalog or legacy ids are answered before the cache and never occupy a slot. Cache weight accounting only ever changes for live entries (entries evicted while their load was pending cannot alter totals), and cached values are deep-frozen because callers share them. A per-upstream concurrency cap with a bounded wait queue sheds excess load as 503; each inbound data-asset request has a total deadline (about 8 s, including queue waits and all pages). Remaining limits: the app still has **no authentication or rate limiting**, so distinct `parentId` values from many callers can still cost upstream calls up to the concurrency cap, and one listing can issue up to 2 x 10 page requests within its deadline. Put the Domain API behind an authenticating gateway before enabling it for real users.
- **Query history masking limits.** Redaction replaces string/numeric literals and removes comments only. Double-quoted identifiers (table/column/user-like names) are kept verbatim and may contain PII, and non-ASCII (Unicode) digits are not masked.
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
