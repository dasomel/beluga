# Architecture

Beluga Manager is the integration and control-plane layer of the Beluga Data Platform.

The architecture separates the user experience, Beluga Domain API, integration adapters, and authoritative platform services.

```text
Frontend
   │
   ▼
Beluga Domain API
   │
   ├── Pipeline Domain
   ├── Data Asset Domain
   ├── Service Domain
   └── Operations Domain
   │
   ▼
Integration Adapters
   │
   ├── Kubernetes
   ├── Kafka
   ├── Flink
   ├── Iceberg Catalog
   ├── Trino
   ├── Airflow
   └── Observability
```

## Design Principles

1. **API-first integration** — use authoritative APIs exposed by each component.
2. **Unified domain model** — correlate multiple OSS APIs into Beluga concepts.
3. **No unnecessary duplication** — do not turn Manager into another metadata platform.
4. **Locale-neutral API** — localization happens in the Frontend.
5. **Capability-aware integration** — detect supported API features and versions.
6. **Explicit correlation** — uncertain relationships must not be presented as authoritative facts.
7. **Air-gapped friendly** — dependencies and runtime assets must be controllable for self-hosted environments.

## First Vertical Slice

The first end-to-end product validation is:

`Source → Kafka → Flink → Iceberg → Trino`

The goal is to represent this flow as one Beluga Pipeline instead of requiring users to move between multiple specialist UIs.

See the [Korean architecture document](architecture-ko.md) for the Korean version.
