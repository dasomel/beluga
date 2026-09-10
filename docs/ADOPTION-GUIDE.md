# Beluga Adoption Guide

> First success is a documented **end-to-end data path**, not only healthy Kubernetes pods.

## 1. Start with capacity and prerequisites

Beluga combines multiple data-platform components, so resource requirements are part of the product contract. Confirm the documented host/VM capacity before troubleshooting individual services.

## 2. First-success strategy

Use the repository's existing quick start, then select one documented E2E scenario and carry a small record through the complete path. A useful acceptance sequence is:

1. Kubernetes/GitOps reconciliation becomes healthy.
2. Identity and platform endpoints required by the scenario are reachable.
3. Produce or ingest a small deterministic dataset.
4. Observe the record through the streaming/storage/query stages used by the scenario.
5. Query or visualize the final result through the documented consumer surface.
6. Re-run the same path after a clean restart when testing reproducibility.

## 3. Evidence discipline

Keep component health, integration health, and business/data-path success as separate evidence classes. A green Kafka/Flink/Trino/Airflow pod set does not prove the intended CDC-to-query flow.

## 4. Documentation path

The README remains the primary Korean entry point. Architecture, verification, and mistakes/lessons documentation should be read after the smallest E2E path is understood. English documentation should prioritize semantic parity for prerequisites, quick start, E2E verification, limitations, and architecture before translating every internal note.

## 5. Maintenance rule

When the supported data path, identity boundary, storage/catalog choice, GitOps ownership, or resource profile changes, update the E2E acceptance path together with the implementation documentation.