# Implementation Status

Last verified: 2026-09-09 against `main`

This file records behavior implemented on the default branch and separates it from design direction.

## Implemented

- Beluga Manager project structure for a unified Beluga data-platform control-plane/UI.
- Stable domain direction around Services, Pipelines, Data Assets, and Operations rather than exposing upstream OSS models directly.
- Adapter/capability architecture that preserves authoritative state in upstream services and treats correlation/cache state separately.
- Tauri/web application foundations, English/Korean localization structure, repository engineering/CI controls, and OpenForge portfolio status publication integration.
- Read-first product boundary: the current design deliberately avoids broad mutating operations while the unified discovery/correlation experience is established.

## Partial / evolving

- Kafka/Flink/Iceberg/Trino/Airflow integrations and cross-service domain views continue to evolve incrementally; architecture documents define the target boundary but do not imply every adapter/resource action is complete.
- Operations correlation and drill-down capabilities should be judged from the current implementation/API routes rather than the full design narrative.

## Not claimed

- Beluga Manager is not a replacement UI for every upstream OSS.
- Broad destructive/mutating platform administration is not part of the current read-first baseline.
- Architecture diagrams and MVP scope are not themselves execution evidence.

## Evidence

- `README.md`
- `README-ko.md`
- `docs/architecture.md`
- application/API source tree
- repository CI workflows
- OpenForge portfolio publisher integration
