English | [한국어](README-ko.md) · [Architecture](docs/architecture.md)

# Beluga Manager

> **Unified Control Plane for the Beluga Data Platform**

Beluga Manager is the unified entry point and management console for the Beluga Data Platform.
It integrates APIs from individual open-source components and turns them into a unified domain model, control plane, and user experience.

Beluga Manager is **not an OSS collection portal**. Kafka, Flink, Iceberg, Trino, Airflow, and other components remain authoritative for their own resources. Beluga Manager adds value by correlating those APIs into platform-level concepts such as **Pipelines, Data Assets, Services, and Operations**.

## Why Beluga Manager?

Individual data-platform projects solve individual problems well. The operational cost appears at the boundaries between them.

Beluga Manager is designed to answer questions that cross service boundaries without forcing users to visit each OSS UI independently:

- Which Kafka Topic, Flink Job, Iceberg Table, and Trino context belong to the same Pipeline?
- Where does a Data Asset live, what schema does it have, and how can it be queried?
- Which platform services are healthy, degraded, or unavailable, and what capabilities do they provide?
- Which downstream resources are affected when a job or service fails?

The product therefore focuses on **integration and context**, not reimplementing every upstream UI.

## Architecture

```text
                        Beluga Manager
                              │
                    Unified Domain API
                              │
       ┌──────────────┬───────┼────────┬──────────────┐
       ↓              ↓       ↓        ↓              ↓
    Kafka           Flink   Iceberg   Trino         Airflow
      API             API      API      API            API
       └──────────────┴───────┴────────┴──────────────┘
                              │
                    Beluga Data Platform
```

The architecture follows four rules:

1. **Use authoritative upstream APIs.** Each OSS remains the source of truth for its resources.
2. **Expose Beluga domains, not upstream models.** Frontends consume Beluga APIs such as `/services`, `/pipelines`, and `/data-assets` rather than calling OSS APIs directly.
3. **Correlate instead of duplicate.** Beluga discovers relationships across services and stores only the minimum cache/index state needed for performance and navigation.
4. **Preserve upstream context.** Specialized operations can still open the original OSS UI/API without losing the Beluga context.

## Core Domains

### Pipeline

A Pipeline represents a cross-service data flow and execution context.

```text
Source / CDC
    ↓
Kafka Topic
    ↓
Flink Job
    ↓
Iceberg Table
    ↓
Trino / Query
```

The Pipeline domain correlates resources across Kafka, Flink, Iceberg, Trino, and orchestration systems into one operational view.

### Data Asset

A Data Asset provides a unified view of catalog and query metadata such as catalog, schema, table, columns, partitions, location, and query context.

Iceberg remains authoritative for lakehouse metadata while Trino contributes query/catalog context.

### Service

Services are represented as platform capabilities rather than just an installation list.

Examples include:

- Streaming
- Processing
- Lakehouse
- Query
- Orchestration
- BI
- Storage
- Observability

The Service domain exposes identity, version, health, dependencies, and capabilities.

### Operations

Operations brings together resources, events, health, logs, and dependencies so a failure can be investigated from one platform context.

## Integration Model

Each integration is isolated behind an adapter/capability boundary so that OSS API versions and implementation differences do not leak into the Beluga Domain API.

```text
OSS API
   ↓
Integration Adapter
   ↓
Discovery / Correlation
   ↓
Beluga Domain
   ↓
Unified API
   ↓
Manager UI
```

Beluga distinguishes between:

- **authoritative state** from the upstream OSS
- **short-lived cache** for performance
- **correlation indexes** for cross-service discovery
- **Beluga-owned metadata** such as explicit mappings

Uncertain relationships are not presented as authoritative facts.

## Internationalization

Beluga Manager supports internationalization from the beginning.

- `en-US` — English
- `ko-KR` — Korean
- Browser locale detection
- Manual language selection
- Persistent locale preference
- Locale-neutral APIs
- Localized date, time, and number formatting

Actual platform resource names such as Kafka Topics, tables, jobs, namespaces, and identifiers are never translated.

## Initial MVP

The first vertical slice is intentionally small:

```text
Kafka → Flink → Iceberg → Trino
```

### MVP scope

- Unified Service API
- Service discovery
- Cross-service correlation
- Pipeline Domain API
- Pipeline topology view
- Service health/status
- degraded/stale state handling
- resource/event/log drill-down
- English/Korean UI foundation

### Initially out of scope

- Reimplementing specialized OSS UIs
- Broad mutating operations
- A second copy of the data platform metadata store
- Advanced lineage beyond the first Pipeline slice
- A full observability platform

The MVP is **read-first**: prove the unified experience before adding potentially destructive management actions.

## API Direction

The first Beluga API surface is designed around stable domain concepts rather than OSS-specific models:

```text
GET /api/v1/services
GET /api/v1/services/{id}
GET /api/v1/pipelines
GET /api/v1/pipelines/{id}
GET /api/v1/data-assets
GET /api/v1/health
GET /api/v1/events
```

The frontend should be able to implement the MVP without directly calling Kafka, Flink, Iceberg, Trino, or Airflow APIs.

## Current Status

🚧 **Early development**

The repository is establishing the foundation and architecture before implementation. The planned order is:

```text
API Contract
   ↓
Unified Service API
   ↓
Discovery / Correlation
   ↓
Kafka → Flink → Iceberg → Trino Vertical Slice
   ↓
Data Asset / Query / Operations
```

## Documentation

- [Architecture](docs/architecture.md)
- [Development Guide](docs/development.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Korean documentation](README-ko.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
