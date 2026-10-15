# ADR-0007: Observability Integration — Metrics, Logs & Events

- **Status**: Proposed — design proposal; no live metrics/logs adapter or Grafana proxy is implemented by this ADR.
  Note on numbering: ADR-0005 covers Deployment & GitOps Integration (PR #113); ADR-0006 covers Safe Actions (PR #134, issue #21); this Observability proposal is numbered ADR-0007.
- **Date**: 2026-10-07
- **Issue**: [#24 [ROADMAP][ARCH] Observability Integration — Metrics, Logs & Events](https://github.com/dasomel/beluga-manager/issues/24)
- **Parent epic**: #1
- **Related**: [ADR-0002](0002-backend-api-technology.md) (Domain API, Hono), [ADR-0003](0003-ui-design-system.md) (UI design system, Operations view), ADR-0006 (Safe Actions proposal, PR #134), `AGENTS.md` (read-first principle, boundary between upstream OSS and unified domain), `docs/architecture.md` (headings "Design Principles", "Navigation / Information Architecture" — which describes the shipped Operations slice and log links — and "Ownership Boundaries", whose table assigns "Metrics, logs and traces" to "Observability backends"; the headings are un-numbered), `packages/domain-api/src/schema/event.ts` (Event schema: severity `info|warning|error`, source `kubernetes|service|job`), `packages/domain-api/src/schema/resource.ts` (`cpuUsage`, `memoryUsage`, `capacity`, `logsUrl`).
- **Deciders**: dasomel

Conventions: Beluga file:line citations are as of beluga commit `1df61e0` (`origin/main`); live-cluster outputs are as measured on 2026-10-07. **Current state** lists only observed facts (file:line or a command that was run, evidence date 2026-10-07). **Proposal** is design intent. Every number (cache TTL, timeout, line limits, lookback) is labelled *Proposed*. External facts carry an official URL opened on 2026-10-07, or are marked *not verified*.

## Context

Beluga Manager is the unified operational cockpit for the Beluga Data Platform. Operators need (issue #24): a health overview; drill-down from resources/pipelines to metrics, logs and events; root-cause context for failed jobs; time-range filtering; and explicit degraded states when observability backends are missing. The governing principle: **Beluga Manager does not host or store metrics and logs long-term**; it consumes, aggregates and correlates what authoritative systems provide (`docs/architecture.md`, "Ownership Boundaries").

### Current state (observed)

Beluga platform side (read from `refs/remotes/origin/main` of the beluga repo, and the live cluster read-only):

| Fact | Evidence |
|---|---|
| `VERSIONS.md` lists "Prometheus Stack 67.4.0" (`prometheus-community/kube-prometheus-stack`), but nothing installs it. | Beluga `VERSIONS.md:20`; Beluga `docs/portfolio-integration-matrix.md:54` (row 12: "no Prometheus/Loki/Tempo workload"), `:81` (D8: "nothing deployed; VERSIONS.md entry is a drift candidate"); Beluga `docs/adr/0003-beluga-data-platform-plane.md:80` (Beluga ADR-0003 Q5). |
| `gitops/charts/beluga-platform/values.yaml:18-19` sets `prometheusGrafana.enabled: true` (version `67.4.0`, ports 3000/9090). The only template it gates is a `grafana-external` Service shim. The flag does **not** install Prometheus or Grafana. | Beluga `gitops/charts/beluga-platform/values.yaml:18-19`; `gitops/charts/beluga-platform/templates/platform-services.yaml:8-23` (`{{- if .Values.prometheusGrafana.enabled }}` -> `Service grafana-external`, NodePort 3000:30000, selector `app.kubernetes.io/name: grafana`). |
| Live: Service `platform-system/grafana-external` exists (NodePort `3000:30000`) and has **no endpoints**. | `kubectl -n platform-system get svc grafana-external`; `kubectl -n platform-system get endpoints grafana-external` -> `ENDPOINTS <none>`. |
| Live: no Prometheus Operator CRDs, no `monitoring` namespace, and no Prometheus/Grafana/Loki/Alertmanager/Promtail/Fluent Bit pods (76 pods in total at the time of measurement on 2026-10-07; the count drifts, e.g. 77 a day later, and does not affect the zero-match result). | `kubectl get crd -o name \| grep -c -i "coreos\|prometheus"` -> `0`; `kubectl get ns monitoring` -> NotFound; `kubectl get pods -A --no-headers \| grep -i -c "prometheus\|grafana\|loki\|alertmanager\|promtail\|fluent"` -> `0`. |
| No Promtail / Fluent Bit manifest in Beluga gitops or `VERSIONS.md`. | `git grep -n -i "promtail\|fluentbit\|fluent-bit" refs/remotes/origin/main -- gitops VERSIONS.md` -> no hits. |
| The Beluga domain registry (`*.local.beluga.internal`) lists `trino airflow superset catalog s3 argocd sso`; it has no Grafana, Prometheus, Loki or `monitoring` entry. | Beluga `AGENTS.md:16-18`. |

Beluga Manager side:

| Fact | Evidence |
|---|---|
| The Event domain (`GET /api/v1/events`) and the Operations timeline exist on stub fixtures; `Resource.cpuUsage`/`memoryUsage`/`logsUrl` are optional/nullable fields. | `packages/domain-api/src/schema/event.ts:3-20`, `schema/resource.ts:11-19`, `stub-data/events.ts`. |
| Log links open only when an upstream URL is configured on the resource; Manager stores no logs. | `docs/architecture.md`, section "Navigation / Information Architecture" (sentence "Log links open only when an upstream URL is configured on the resource; Manager stores no logs"). |
| The domain API has no authentication middleware. | `docs/IMPLEMENTATION-STATUS.md:30` ("the app has no auth middleware"). |

### External references (opened 2026-10-07)

- Prometheus HTTP API — <https://prometheus.io/docs/prometheus/latest/querying/api/> (opened 2026-10-07): `GET /api/v1/query` (instant) and `GET /api/v1/query_range` exist.
- Loki HTTP API — <https://grafana.com/docs/loki/latest/reference/loki-http-api/> (opened 2026-10-07): `GET /loki/api/v1/query_range`; `start`/`end` are "a nanosecond Unix epoch or another supported format".
- Kubernetes Event v1 API — <https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/event-v1/> (opened 2026-10-07): core `v1` paths `GET /api/v1/namespaces/{namespace}/events` and `GET /api/v1/events`; the `events.k8s.io/v1` group paths were not visible in the part I read (*not verified*).
- Alertmanager API v2 OpenAPI — <https://raw.githubusercontent.com/prometheus/alertmanager/main/api/v2/openapi.yaml> (opened 2026-10-07; the `main` branch, not pinned to a release): `GET /alerts` takes boolean query parameters `active`, `silenced`, `inhibited`, `unprocessed` (all default `true`), an array parameter `filter` (matcher expressions such as `alertname="MyAlert"`), and `receiver`. The earlier draft's `?filter=silenced=false` was wrong: use `?silenced=false` (and `inhibited=false`). The Alertmanager version that Beluga would deploy is undecided, so conformance of that version to this `main` spec is *not verified*. The earlier draft cited the `management_api` docs page, which is not the API reference; it is removed.
- Grafana Explore URL format — <https://grafana.com/docs/grafana/latest/explore/> (opened 2026-10-07) does **not** document a deep-link URL schema (`left=` / `panes=`). The URL template below is therefore *not verified* and must be validated against the deployed Grafana version before implementation (Task 3).
- PromQL metric names used below (`node_namespace_pod_container:...:sum_irate`, `container_memory_working_set_bytes`, `kube_persistentvolumeclaim_resource_requests_storage_bytes`) are conventional kube-prometheus-stack / kube-state-metrics names; I did not open their docs, so they are *not verified* and depend on the stack that is eventually deployed.

## Decision Drivers

1. **Read-only, zero-duplication**: do not store or index time series or logs in the Manager; upstream systems stay authoritative.
2. **Degraded-first**: with backends missing (today's reality), core views (Overview, Services, Pipelines) must keep working and say what is unavailable.
3. **Consistent domain mapping** into `Resource.cpuUsage`, `memoryUsage`, `logsUrl` and `Event`.
4. **Correlation and drill-down** between domain resources and upstream telemetry.
5. **Redaction and access control**: logs and alert text can contain secrets/PII, and the API currently has no authentication (Current state).

## Considered Options

### Option 1: Embedded metric/log store in the Manager
**Rejected**: duplicates the system of record; conflicts with "No unnecessary duplication" (`docs/architecture.md`, Design Principles 3); large footprint.

### Option 2: Browser queries Prometheus/Loki directly via the gateway
**Rejected**: bypasses unified authorization and redaction, and exposes raw backends to browsers.

### Option 3: Observability adapter layer with deep-link primacy and optional ephemeral proxy (Proposed)
1. **Metrics**: adapter reads Prometheus instant queries for point-in-time CPU/memory and alert state.
2. **Logs**: primary path is a deep link to the Grafana Explore (`Resource.logsUrl`); an optional ephemeral tail endpoint reads recent lines from Loki with redaction and rate limiting.
3. **Events**: Kubernetes Events and Alertmanager alerts normalized into the `Event` schema.
4. **Degraded state**: missing backends return structured degraded responses instead of errors.
- **Pros**: no storage in the Manager; instant drill-down; central redaction.
- **Cons**: per-workload query templates to maintain; needs backend endpoints that do not exist yet.
- **Outcome**: **Proposed**.

## Decision Outcome (Proposal)

```mermaid
flowchart TD
    subgraph Browser["Manager Web UI"]
        OV["Overview KPI Cards"]
        Ops["Operations Timeline & Resource View"]
        Pipe["Pipelines & Services View"]
    end

    subgraph ManagerBackend["Beluga Manager Domain API"]
        ObsRouter["GET /api/v1/resources\nGET /api/v1/events\nGET /api/v1/resources/{id}/logs (Proposal)"]
        ObsAdapter["Observability Adapter Registry"]
        Redactor["PII & Secret Sanitizer"]
        DegradeH["Degraded Fallback Handler"]
    end

    subgraph PlatformOSS["Backends (NOT deployed in Beluga today)"]
        Prom["Prometheus API\nInstant Vectors"]
        AM["Alertmanager API v2"]
        Loki["Loki API\nLogQL"]
        K8s["Kubernetes API\nCore v1 Events (exists)"]
        Grafana["Grafana Explore\nlogsUrl target"]
    end

    OV --> ObsRouter
    Ops --> ObsRouter
    Pipe --> ObsRouter
    ObsRouter --> ObsAdapter
    ObsAdapter --> DegradeH
    ObsAdapter -.-> Prom
    ObsAdapter -.-> AM
    ObsAdapter -.-> K8s
    ObsAdapter -.-> Loki
    Loki --> Redactor --> ObsRouter
    Ops -->|logsUrl click| Grafana
```

Only the Kubernetes API in this diagram exists today.

### 1. Backend reality and phasing

- **Phase 1 (degraded foundation)**: define the adapter interface and API contracts. When `PROMETHEUS_URL` / `LOKI_URL` / `ALERTMANAGER_URL` (proposed variable names) are unset or unreachable, adapters report `status: "degraded"`, `cpuUsage: null`, `memoryUsage: null`, and the Operations timeline uses Kubernetes Events only (the one backend that exists).
- **Phase 2 (after Beluga deploys a stack — decision owned by the Beluga repo, Beluga-repo ADR-0003 Q5 (`beluga/docs/adr/0003-beluga-data-platform-plane.md`; not this repository's ADR-0003, which is the UI design ADR))**: adapters activate against whatever in-cluster endpoints that deployment exposes. The service names and namespace are **not decided**; the earlier draft's `prometheus.monitoring.svc.cluster.local:9090` / `loki.monitoring.svc.cluster.local:3100` are *proposed placeholders only* — no `monitoring` namespace exists (Current state) — and must be read from configuration, never hard-coded.

### 2. Metrics integration and domain mapping (Proposal)

| Domain entity | Field | PromQL pattern (illustrative; metric names not verified) | Output |
|---|---|---|---|
| `Resource` (Workload/Pod) | `cpuUsage` | `sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace=~"$ns", pod=~"$pod.*"})` | Quantity string, e.g. `"250m"` |
| `Resource` (Workload/Pod) | `memoryUsage` | `sum(container_memory_working_set_bytes{namespace=~"$ns", pod=~"$pod.*", container!=""})` | e.g. `"512Mi"` |
| `Resource` (PVC) | `capacity` | `kube_persistentvolumeclaim_resource_requests_storage_bytes{...}` | e.g. `"128Gi"` |

Label values interpolated into PromQL must be escaped or validated against an allow-list (injection into queries).

- **Caching and budget (Proposed)**: 15 s TTL for instant results, 1500 ms per-query timeout (fail fast to degraded), single-flight per query key so concurrent page loads share one upstream call, a total request deadline, a concurrency cap and a bounded queue. All values are *Proposed* and to be tuned against a real backend; none has been measured.

### 3. Log integration (Proposal)

1. **Tier 1 — deep link (`logsUrl`)**: populated with a Grafana Explore URL. Host and URL schema are **proposals**: `grafana.local.beluga.internal` is not in the Beluga domain registry (`AGENTS.md:16-18`, Current state), so the host must come from configuration, and the Explore query-parameter format is *not verified* (External references). Illustrative shape only, to be validated: `https://<grafana-host>/explore?<state-parameter>=...` containing datasource, LogQL expression (`{namespace="…",pod=~"…"}`) and a time range.
2. **Tier 2 — ephemeral tail proxy** `GET /api/v1/resources/{id}/logs?lines=100&since=15m`: bounded to a maximum of 200 lines and 1 hour lookback (*Proposed*, defaults 100 lines / 15 min, *Proposed*); paged or streaming archives are not offered. Because the domain API has no authentication today (`docs/IMPLEMENTATION-STATUS.md:30`), **this endpoint must not ship before real OIDC/JWT validation and per-resource authorization exist** (the same hard prerequisite as ADR-0006 section 0). The resource id must map to a server-side allow-listed LogQL template, never to a client-supplied query.

### 4. Redaction policy (Proposal)

Applied server-side before any log line or alert text leaves the API:
1. **Credentials**: mask bearer tokens/JWTs, `password=`-style pairs, cloud access keys and `scheme://user:secret@host` URLs.
2. **PII**: mask e-mail addresses and national-ID/payment-card-like patterns. The patterns need locale review and have false negatives; redaction is defence in depth, not a guarantee.
3. **SQL literals**: truncate `INSERT ... VALUES (...)` parameters in Trino/Airflow logs.

### 5. Event correlation (Proposal)

Mapping into `packages/domain-api/src/schema/event.ts` (`severity: info|warning|error`, `source: kubernetes|service|job`):
1. **Kubernetes Events** (`GET /api/v1/namespaces/{ns}/events`, core v1): `type: Normal` -> `info`, `Warning` -> `warning`; `source: "kubernetes"`; involved object -> `relatedResourceId` where resolvable (otherwise absent; do not guess).
2. **Alertmanager alerts** (`GET /api/v2/alerts?silenced=false&inhibited=false`, per the OpenAPI above): label `severity="critical"` -> `error`, `severity="warning"` -> `warning`; `source: "service"`. The label convention is the stack's, not guaranteed.
3. **Safe Action executions** (ADR-0006): emitted as events with `source: "job"` or `"service"` once such actions exist (none are scheduled for execution before ADR-0006's prerequisites).

### 6. Degraded behaviour (Proposal)

```typescript
export interface ObservabilityHealthStatus {
  backend: "prometheus" | "loki" | "alertmanager" | "kubernetes";
  status: "available" | "unavailable" | "disabled";
  endpoint?: string;   // do not expose internal URLs to unauthenticated callers
  lastChecked: string;
  message?: string;
}
```

- Prometheus unreachable/unconfigured: `GET /api/v1/resources` still returns 200 with `cpuUsage: null`, `memoryUsage: null`, a degraded indicator (header `X-Beluga-Degraded: metrics-unavailable`, Proposed name) and a UI badge instead of 0.
- Loki unreachable: `logsUrl` is `null`; the tail endpoint returns 503 with a stable error code.

## Consequences

### Positive
- No metric or log storage in the Manager.
- Works on clusters with no observability stack, as Beluga is today.
- Server-side redaction and (with the prerequisite) authorization before telemetry reaches the browser.

### Negative
- Tail view is short; deep analysis requires Grafana.
- Deep links depend on a Grafana host and URL format that are not yet decided or verified.
- Metrics stay empty until the Beluga repo deploys a stack.

## Alternatives Considered

1. **OpenTelemetry Collector inside the Manager** — rejected: the Manager is a consumer of telemetry, not a collector. (The earlier draft's claim "Beluga already uses Prometheus Operator, Promtail/Fluent Bit" was false: Current state shows no such CRDs, pods or manifests.)
2. **`metrics-server` (`kubectl top`) as the only source** — not adopted as the sole source (Proposed judgement): it can serve current CPU/memory without any new deployment and is a candidate for Phase 1 (see Current state: `kubectl -n kube-system get deploy` shows `metrics-server 1/1`, and `kubectl get apiservice v1beta1.metrics.k8s.io` is `True`). Its limits (no history, rates, namespace rollups, disk/network metrics) are a general statement I did not source from its docs: *not verified*.

## Risks and Mitigations

| Risk | Impact | Mitigation (Proposed) |
|---|---|---|
| Query amplification on Prometheus | Heavy UI use overloads the backend | Single-flight, 15 s cache, per-query timeout, total deadline, concurrency cap, bounded queue (values *Proposed*) |
| Unmasked secrets in logs/alerts | Credential exposure | Server-side redaction; tail endpoint gated on authentication; no raw log view by default |
| Unauthenticated API exposes telemetry | Anyone reaching the API reads logs | Hard prerequisite (section 3) |
| Broken Grafana deep links | 404 or empty query | Validate URL against the deployed Grafana before shipping; configuration-driven host |
| Time zone skew | Timeline mismatch | UTC ISO-8601 in API; localized rendering in UI |

## Open Owner Questions

1. **Observability stack in Beluga**: will `kube-prometheus-stack` (and a log stack) be deployed, and under which namespace/endpoints?
   - *Recommendation*: raise it in the Beluga repo (Beluga-repo ADR-0003 Q5 (`beluga/docs/adr/0003-beluga-data-platform-plane.md`; not this repository's ADR-0003, which is the UI design ADR) / D8); keep Phase 1 degraded-first until it is answered.
2. **Grafana embedding vs deep link**.
   - *Recommendation*: external deep links only; iframes raise CSP, cookie and SSO issues (reasoning, not verified against Grafana docs).
3. **Tail proxy in Phase 1?**
   - *Recommendation*: defer to Phase 2 and after authentication exists; Phase 1 ships `logsUrl` and Kubernetes Events only.
4. **Metrics source before a stack exists**: metrics-server is live in the current cluster (Current state in Alternatives item 2).
   - *Recommendation*: evaluate a metrics-server-backed adapter for `cpuUsage`/`memoryUsage` in Phase 1 (it needs no new deployment; check its API docs first, not verified); keep the Prometheus adapter for Phase 2.

## Follow-up Implementation Tasks & Acceptance Test Ideas

1. **Adapter interface and health probe**. *Acceptance*: with the probe failing, `Resource` list returns 200 with `cpuUsage: null` and the degraded indicator.
2. **Prometheus instant adapter** (only meaningful once a backend exists). *Acceptance*: mock-server test converts to `"250m"`/`"512Mi"`, times out at the configured limit, and collapses concurrent identical queries to one upstream call.
3. **Grafana Explore URL generator** — first validate the URL format against the deployed Grafana version. *Acceptance*: unit test of URL encoding for the validated format; host comes from configuration.
4. **Redaction utility**. *Acceptance*: samples containing a JWT, a password pair and an e-mail address are masked.
5. **Kubernetes Event adapter**. *Acceptance*: `Warning` -> `warning`; unresolved involved object leaves `relatedResourceId` absent.
6. **Alertmanager adapter** (after a backend exists). *Acceptance*: request uses `silenced=false&inhibited=false`; severity labels map as specified.
