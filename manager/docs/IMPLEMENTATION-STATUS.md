# Implementation Status

Last verified: 2026-09-14 against `main`

This file records behavior implemented on the default branch and separates it from design direction.

## Implemented

- Repository and documentation foundation for a future unified Beluga data-platform control plane/UI.
- English/Korean product, architecture, development, contribution and security documentation.
- A domain direction around Services, Pipelines, Data Assets and Operations, with adapter/capability and read-first boundaries recorded as design decisions rather than implemented runtime behavior.
- Repository verification, CI controls and OpenForge portfolio-status publication integration.

## Partial / evolving

- No frontend, backend, Tauri application, API route or integration adapter has been implemented yet.
- Kafka/Flink/Iceberg/Trino/Airflow integration and cross-service domain views remain planned; architecture documents define target boundaries only.

## Not claimed

- Beluga Manager is not a replacement UI for every upstream OSS.
- Broad destructive/mutating platform administration is not part of the current read-first baseline.
- Architecture diagrams and MVP scope are not themselves execution evidence.
- Repository scaffolding and documentation are not claimed as an executable product.

## Evidence

- `README.md`
- `README-ko.md`
- `docs/architecture.md`
- repository CI workflows
- `scripts/verify.py`
- `tests/test_verify.py`
- OpenForge portfolio publisher integration
