# ADR-0002: Backend / API Technology Selection

- **Status**: Proposed — awaiting decision
- **Date**: 2026-09-18
- **Issue**: [#27 \[EVALUATION\]\[ADR\] Backend/API Technology Selection](https://github.com/dasomel/beluga-manager/issues/27)
- **Parent epic**: #1
- **Related**: [ADR-0001](0001-frontend-technology.md), [ADR-0003](0003-ui-design-system.md)
- **Deciders**: dasomel

## Context

The Beluga Domain API does not exist yet. What exists in this repository is the **policy compiler**:
TypeScript (7.0.2, Node ≥22, ESM), Zod 4.5.4 schemas in `src/schema.ts`, compiler targets in
`src/compiler/` emitting Keycloak realm configuration, Trino OPA Rego and PostgreSQL DDL, an adapter
type boundary in `src/adapters/types.ts`, and Vitest 5 tests. That is 100% of the executable code.

The API to be built is defined by the issue record, not by this repository:

- **#34 Unified Domain API** — aggregate Kafka, Flink, Iceberg, Trino and Airflow APIs into Beluga's
  own Pipeline, Data and Service domains. Stated explicitly as **not a simple API proxy**;
  upstream API version differences must be isolated inside the Integration Adapter layer.
- **#42 Unified Service API** — one common service model (identity/type, version, health, endpoint,
  capabilities, dependency summary, availability/degraded state) across Kafka, Flink, Iceberg,
  Trino, Airflow, Kubernetes and the observability backend. Success criterion: the Overview and
  Services screens consume this API rather than calling each OSS API directly.
- **#43 API contract** — an OpenAPI-first contract over `GET /api/v1/services`, `/services/{id}`,
  `/pipelines`, `/pipelines/{id}`, `/data-assets`, `/health`, `/events`, with versioning, consistent
  error/degraded/stale responses, pagination and filtering, and explicit representation of
  correlation state. Completion criterion: the frontend can build the MVP using only the Beluga API.
- **#29 domain model** — Platform, Service, Resource, DataCatalog, Pipeline, Job, Event, Health,
  User/Role; a common status/health model; a per-service metadata extension model. Principle: the
  API expresses Beluga's domain and **must not be UI-driven**.
- **#22 boundary** — the frontend never handles per-service credentials or APIs directly. The
  backend is the authoritative integration point and hands the frontend only the minimum data.
- **#41 MVP** — minimal Kafka/Flink/Iceberg/Trino adapters, service discovery, cross-service
  correlation, a Pipeline Domain API, and a topology UI. **Read-only**; mutations are out of scope.
- **#19/#18** need Kubernetes resource, event and workload data (namespace, workload, pod, service,
  PVC, CPU/memory) and Loki log linking.
- **#20/#21** need role/permission introspection, least privilege, no credential exposure, and — when
  mutations eventually arrive — per-action RBAC, confirmation, dry-run and an audit log.

Environmental constraints, already settled in the sibling `beluga` platform and binding here:

- **Keycloak 26.7.1 is the platform's single identity and role source** (decision D13), reachable at
  `sso.local.beluga.internal`. Trino's OAuth2 issuer is already that host.
- **OPA 1.19.0 is the central policy engine** (D14), and this repository's own compiler already
  emits the Trino Rego and the Keycloak group/role mappers. The authorization model is therefore
  *already chosen*; the API consumes it rather than inventing one.
- **APISIX 3.17.0 is the gateway** (D11); everything is reached over unified HTTPS 443 under
  `*.local.beluga.internal`.
- **ArgoCD 3.5.0 GitOps with `selfHeal: true`** delivers workloads; a new service means a new image,
  built for **arm64 and amd64** (VERSIONS.md treats arm64 availability as a gating fact), mirrored
  into the air-gapped registry.
- **Air-gapped friendly** is a standing architecture principle (`docs/architecture.md`, principle 7).

### Minimum MVP backend scope

Issue #27 asks that the minimum backend scope be defined before choosing technology. Derived from
#41/#42/#43, the MVP backend must:

1. Terminate OIDC — validate Keycloak-issued JWTs, extract roles/groups, enforce read access.
2. Hold all upstream credentials server-side; the browser never sees them.
3. Run read-only adapters for Kafka, Flink, Iceberg (Lakekeeper REST), Trino, plus Kubernetes for
   resources and events.
4. Perform service discovery and cross-service correlation, with provenance and confidence retained
   (`docs/architecture.md`, principle 6: uncertain relationships must not be presented as facts).
5. Serve the seven `/api/v1/*` endpoints against an OpenAPI contract, including a consistent
   degraded/stale/partial response shape.
6. Cache upstream responses briefly, and maintain correlation indexes — explicitly **not** a second
   metadata store (README: "no second copy of the data platform metadata store").
7. Emit structured logs and health/readiness endpoints for the cluster.

Everything else — mutations (#21), full data catalog (#15), lineage, audit persistence — is later.

## Decision Drivers

1. **Contract cohesion with existing code** — Zod schemas already encode this repository's
   validated shapes; an API in the same language can share them as one source of truth for runtime
   validation, static types and OpenAPI generation.
2. **I/O concurrency profile** — the workload is fan-out to many slow HTTP upstreams and merging the
   results. It is almost entirely I/O-bound; raw CPU throughput is close to irrelevant.
3. **Kubernetes API client quality** — #18/#19 need real Kubernetes reads.
4. **Auth/authz integration** — OIDC validation against an existing Keycloak realm and alignment
   with the OPA/Rego model this repository already compiles.
5. **OpenAPI-first tooling** — #43 makes the contract a deliverable, not a by-product.
6. **Operational footprint** — image size, memory, startup, arm64+amd64 availability, CVE surface.
7. **Maintainability for a small team** — one language across the stack versus two.
8. **Observability integration** — structured logs, metrics for the existing Prometheus stack, and
   optionally OpenTelemetry traces.

## Considered Options

### Option A — TypeScript / Node.js, extending this repository's runtime (Fastify, Hono or Express)

Add an HTTP layer alongside the existing compiler, in the same language and toolchain.

**Pros**

- **Type and schema reuse is the decisive advantage.** `src/schema.ts` already defines Zod schemas.
  The same Zod definitions can drive request/response validation, emit the OpenAPI document #43
  requires, and export TypeScript types the frontend imports directly. In any other runtime this
  contract must be restated in a second language and kept in sync by discipline and tests.
- The adapter boundary in `src/adapters/types.ts` already anticipates the integration-adapter layer
  #34 describes; the existing shape can be grown rather than reinvented.
- The workload is fan-out I/O aggregation, which Node's event loop handles well; `Promise.allSettled`
  over N upstreams with per-adapter timeouts is a natural fit for the partial/degraded semantics
  #42 and #43 require.
- One language, one lint/format/test toolchain (Vitest 5 already in place), one dependency audit
  surface, one hiring profile — material for a small team.
- Mature OIDC/JWT validation (`jose`), an official Kubernetes client
  (`@kubernetes/client-node`), an official Trino client, and Kafka clients (KafkaJS, `node-rdkafka`)
  are all available and permissively licensed; official Node images exist for arm64 and amd64.
- If ADR-0001 chooses a TypeScript frontend, the whole stack shares one language.

**Framework sub-options** — Fastify (schema-first, excellent JSON-schema/OpenAPI story, plugin
encapsulation, fast, mature, large plugin ecosystem — the safest pick for a contract-first API);
Hono (very small, modern, great TypeScript inference, runtime-portable, smaller ecosystem for
enterprise concerns); Express (ubiquitous and familiar, but the least schema-first, thinnest
TypeScript story, and no first-class OpenAPI path).

**Cons**

- The Kubernetes client is good but not `client-go`; for advanced informer/watch patterns it is less
  battle-tested. For MVP read-only listing it is adequate.
- Node's memory footprint and CVE cadence exceed a compiled binary's.
- Long-lived Kafka/Flink connections and heavy JSON transformation need care to avoid event-loop
  stalls, though this is mitigated by keeping the API an aggregator, not a data-plane component.
- Adding a server to a repository that currently produces a CLI changes its nature; it needs a clear
  internal boundary so the compiler stays independently usable.

### Option B — Go

**Pros**

- **`client-go` is the reference Kubernetes client** — the strongest single technical argument for
  Go, and directly relevant to #18/#19. Informers, watches and typed objects are best-in-class.
- Single static binary: tiny image (distroless/scratch), fast start, low memory, small CVE surface,
  trivial arm64/amd64 cross-compilation — the best operational profile of any option, and the
  friendliest to air-gapped mirroring.
- Goroutines suit fan-out aggregation very naturally, with mature context/cancellation semantics.
- It is the lingua franca of the Kubernetes ecosystem; OPA, ArgoCD, Trino gateways and most
  cluster tooling are Go, so idioms and libraries line up.

**Cons**

- **Breaks contract cohesion.** The domain model would exist twice: Zod in TypeScript for the
  compiler and the frontend, Go structs for the API. OpenAPI can be made the shared source of truth
  with generators on both sides, but that is real ongoing machinery, and it is precisely the
  duplication that #29/#43 aim to avoid.
- Two languages in a small team: two toolchains, two dependency audits, two review skill sets.
- More verbose for the JSON-shaping and correlation logic that dominates this service.
- The Go advantage is concentrated in Kubernetes access — one adapter among several — while the cost
  is paid across the entire codebase.

### Option C — Python (FastAPI)

**Pros**

- Excellent OpenAPI story: FastAPI generates the contract from Pydantic models, which is a very
  close analogue of the Zod-driven approach in Option A.
- Pydantic v2 gives strong runtime validation with good typing ergonomics.
- The official Kubernetes Python client is solid, and Trino/Airflow have first-class Python clients —
  Airflow *is* Python, so its ecosystem alignment is the best of any option.
- Fast to write; a very large talent pool.
- This repository already runs Python for `scripts/verify.py` and the `make` targets, so Python is
  not foreign to the project.

**Cons**

- Same contract-duplication problem as Go: Pydantic models restate what Zod already expresses.
- ASGI concurrency is workable but the runtime is heavier than Node or Go, images are larger, and
  dependency/packaging management in air-gapped environments is the most painful of the three.
- Typing is optional and gradually enforced; large refactors are less safe than in TypeScript or Go.
- Introduces Python as a *product* runtime, not just a build-tooling runtime — a meaningfully
  larger commitment than the current `scripts/` usage.

### Option D — Backend-less SPA calling upstream APIs through APISIX

The frontend calls Kafka, Flink, Trino, Lakekeeper and the Kubernetes API directly, with APISIX
handling routing and OIDC.

**Pros**

- No new service to build, deploy or operate; the fastest conceivable path to a first screen.
- APISIX genuinely can do OIDC termination, routing, rate limiting and CORS.

**Cons — this option is effectively excluded by decisions already made**

- **It violates #22 directly**: the frontend would handle per-service credentials and APIs, which
  that issue forbids. Browser-held tokens for Kafka or the Kubernetes API are also a serious
  security regression against #20's least-privilege and no-credential-exposure principles.
- **It cannot deliver the product.** #34 requires correlating Kafka, Flink, Iceberg and Trino into
  a Pipeline object and explicitly states this is not a proxy. A gateway routes; it does not
  correlate, reconcile version differences, or compute provenance and confidence. Doing that work in
  the browser would push exactly the logic #34 wants isolated in adapters into the least trusted,
  least testable tier.
- **It contradicts README and AGENTS.md**: "the frontend should be able to implement the MVP without
  directly calling Kafka, Flink, Iceberg, Trino, or Airflow APIs," and "do not bypass the domain API
  from the UI to call upstream OSS directly."
- Every upstream API-version difference would leak into the UI, which #34 explicitly prohibits.

Recorded for completeness and to close the question — not a viable candidate.

### Option E — Java / Kotlin (Spring Boot or Quarkus)

**Pros**

- The JVM is the native ecosystem of this data platform: Kafka, Flink, Trino and Iceberg all publish
  first-class Java clients, typically the most complete and current of any language.
- Extremely mature enterprise auth, OpenAPI and observability integrations.
- Quarkus with native compilation can reach a small footprint.

**Cons**

- The heaviest operational footprint on the JVM path (memory, startup, image size); native
  compilation reduces this but adds build complexity.
- Furthest from the existing TypeScript codebase; maximum contract duplication.
- Likely the largest team-skill assumption of any option, with nothing in the repository to support
  it.

Listed because the platform's upstream clients are Java-first; not developed further absent a
signal that JVM expertise exists.

## Decision Outcome

**TBD — pending dasomel review.**

Backend/API technology selection is a design change under `AGENTS.md`, and the resulting public API
contract is itself called out there as a design change. This ADR does not decide it.

---

> ### 🏛 Architect's Recommendation *(advisory only — not the decision)*
>
> **Option A: stay in TypeScript/Node, with Fastify, in this repository as an npm workspace.**
>
> **Single strongest reason:** the domain contract is the product here (#29, #43), and TypeScript is
> the only option where that contract exists exactly once. The Zod schemas already in `src/` can
> simultaneously validate requests at runtime, generate the OpenAPI document #43 requires, and export
> the types the frontend consumes — so the API, the compiler and the UI cannot silently drift. Every
> other option makes the domain model exist in two languages and converts "the contract is correct"
> from a compile-time property into a test-and-discipline problem.
>
> **Supporting reasons**
>
> - The workload is fan-out I/O with partial-failure semantics, not computation. Node is a good fit
>   and the language's weaknesses (CPU-bound work, long-lived stateful connections) are not on the
>   critical path for a read-only aggregator.
> - `src/adapters/types.ts` already sketches the adapter boundary #34 describes.
> - Vitest 5 is already the test runner; the API inherits the existing test idiom.
> - One language across compiler, API and (if ADR-0001 goes TypeScript) frontend is a real advantage
>   for a team this size.
>
> **Fastify over Hono and Express:** Fastify's schema-first design maps directly onto an OpenAPI-first
> contract, its plugin encapsulation gives natural per-adapter isolation, and it is mature enough to
> be uninteresting — which is what this layer should be. Hono is the reasonable alternative if
> minimalism is valued over ecosystem; Express should be declined because it offers the weakest
> schema/OpenAPI story precisely where #43 needs the most support.
>
> **The honest counter-argument:** Go's `client-go` is genuinely better than any Node Kubernetes
> client, and #18/#19 depend on Kubernetes reads. I still recommend TypeScript because that advantage
> is confined to one adapter while the contract-duplication cost is paid everywhere — but if
> Kubernetes-native behaviour (informers, watches, high-fidelity resource modelling) turns out to be
> the product's centre of gravity rather than one view among nine, Go becomes the better answer and
> this ADR should be revisited with that evidence.
>
> **On the BFF question (#34):** treat this as a **domain API, not a BFF.** #29 states the API must
> express Beluga's domain and must not be UI-driven; #34 states it is not a proxy. A true BFF is
> shaped by screens and would drift toward per-view endpoints. Build stable domain resources
> (`/services`, `/pipelines`, `/data-assets`, `/events`), and if a specific screen later needs an
> expensive composite, add an explicit, named aggregate resource with field selection or `?expand=` —
> not a `/api/ui/overview-page` endpoint. This is a real tension worth an explicit decision.
>
> **On auth:** consume the existing Keycloak realm; do not create a second identity system. The API
> validates Keycloak-issued JWTs (JWKS from `sso.local.beluga.internal`, verifying issuer, audience,
> expiry and signature), maps realm/client roles and groups onto Beluga permissions, and holds all
> upstream credentials server-side. Where possible, reuse the role names this repository's compiler
> already emits rather than inventing a parallel vocabulary — the root workspace guide requires role
> names to match LDAP group names as a single source of truth. Given OPA 1.19.0 is already the
> platform's central policy engine and this repository already compiles Rego for Trino, evaluate
> whether the API's own authorization should query OPA rather than hard-code checks; that would keep
> one policy source across Trino and the Manager. Flag as an open question rather than a conclusion.

---

## Consequences

**If Option A is chosen:**

- This repository becomes a multi-package workspace (e.g. `packages/policy-compiler`,
  `packages/domain-api`, `packages/shared-schema`, and possibly `packages/web`), or the API moves to
  a separate repository. **This is unresolved** and blocks the first commit — see Open Questions.
- A container image, Deployment, Service, probes, resource limits and an ArgoCD application entry
  are added to the GitOps repository, built for arm64 and amd64 and mirrored for air-gapped use.
- APISIX gains a route for the API host or path prefix, with CORS and OIDC posture agreed against
  the SPA's token handling.
- A dependency-management policy is needed: Node's dependency surface is the largest of the
  candidates, and `docs/dependency-incident-response.md` already exists — the API should be brought
  under it explicitly.
- Adapter isolation must be enforced structurally (one module per upstream, no upstream types
  crossing into the domain layer), since #34 makes that boundary a requirement, not a preference.
- Degraded/stale/partial semantics must be designed into the response envelope from the first
  endpoint rather than retrofitted; #42 and #43 both call for it and it is very hard to add later.

**In all cases:**

- The OpenAPI document becomes a reviewed artifact under `docs/`, and the repository's bilingual
  documentation rule applies to any prose that accompanies it.
- Correlation results must carry provenance and confidence; the response schema must be able to say
  "this relationship is inferred," per `docs/architecture.md` principle 6 and AGENTS.md.
- The MVP is read-only. Mutating endpoints (#21) must not be added without the per-action RBAC,
  confirmation, dry-run and audit model that issue describes.
- Caching is short-lived and explicitly *not* a second system of record.

## Open Questions for dasomel

1. **Monorepo or separate repositories?** Shared with ADR-0001, and the highest-priority unknown:
   the entire type-sharing argument for TypeScript is strongest in a workspace and weakens if the
   frontend, API and compiler live in three repositories connected by published packages.
2. **What is the policy compiler's runtime relationship to the API?** Today it is a build-time CLI
   emitting GitOps artifacts. Does #20's security/policy view read those artifacts, invoke the
   compiler, or query Keycloak/OPA live? This shapes whether they belong in one process at all.
3. **Should the API delegate authorization to OPA?** OPA is already the platform's central policy
   engine and this repository already compiles Rego for Trino. Reusing it keeps one policy source;
   hard-coding checks in the API is simpler but creates a second authorization vocabulary.
4. **Where is Kubernetes access on the priority list?** If cluster-native fidelity (#18/#19) is
   central rather than one view among nine, that materially strengthens Go.
5. **Does the API need a database?** Correlation indexes and Beluga-owned mappings imply persistent
   state. CNPG PostgreSQL 1.30.0 already runs on the platform and this repository already compiles
   PostgreSQL DDL — but "Manager owns a database" deserves an explicit decision, given the standing
   rule against becoming a second metadata store.
6. **Push or poll for health/events?** #13/#19 imply freshness. Polling is simpler; SSE/WebSockets
   are better UX and constrain the gateway configuration and the framework choice.
