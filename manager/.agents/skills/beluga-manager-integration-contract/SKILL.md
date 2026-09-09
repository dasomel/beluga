---
name: beluga-manager-integration-contract
description: Implement Beluga Manager upstream integration and unified-domain changes while preserving authoritative OSS ownership, adapter boundaries, correlation confidence, read-first scope, and UI-to-domain-API separation. Use for Kafka/Flink/Iceberg/Trino/Airflow adapters, service/pipeline/data-asset domains, correlation, or Manager API/UI integration changes.
license: Apache-2.0
compatibility: Requires the Beluga Manager checkout and the current repository development toolchain; upstream integration evidence depends on available service APIs.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/beluga-manager
  openforge-maturity: draft
  openforge-version: "1"
---

# Beluga Manager Integration Contract

## Use When

- Adding/changing an upstream OSS adapter or capability.
- Changing Service, Pipeline, Data Asset, Operations, discovery, or correlation behavior.
- Connecting Manager UI behavior to Beluga unified APIs.

## Do Not Use When

- Changing the underlying Beluga data-platform deployment itself; that belongs in `dasomel/beluga`.
- Adding broad mutating control-plane operations before the read-first architecture explicitly adopts them.

## Inputs

- Relevant issue/spec and `docs/architecture.md`.
- Upstream API/resource contract and authority.
- Beluga domain/API shape that consumes the integration.

## Workflow

1. Read `AGENTS.md`, `README.md`, `docs/architecture.md`, and the relevant issue/spec.
2. Identify the authoritative upstream resource/API. Keep upstream-specific models behind an integration adapter rather than leaking them into the unified API/UI.
3. Map upstream state into a Beluga domain concept only when the relationship is evidenced. Distinguish authoritative state, cache, correlation index, and Beluga-owned metadata.
4. Do not present inferred or uncertain correlations as authoritative facts. Preserve confidence/stale/degraded semantics where the architecture defines them.
5. Frontend code consumes Beluga domain APIs; do not bypass them to call Kafka/Flink/Iceberg/Trino/Airflow APIs directly.
6. Keep the MVP read-first unless an approved design explicitly introduces a mutation and its auth/audit/failure semantics.
7. For a cross-service vertical slice, validate the boundaries in order: upstream adapter -> discovery/correlation -> Beluga domain -> unified API -> Manager UI.
8. Add implementation-native build/type/lint/test checks behind the repository-owned `make verify` target as the application stack solidifies; do not create a parallel verification path.

## Verification

Run the repository-owned deterministic baseline:

```bash
make verify
```

The current foundation baseline validates Python verifier syntax, verifier regression tests, required repository files, bilingual documentation pairs, README language switching, local Markdown links, and GitHub workflow structure. It intentionally does **not** claim to prove real Kafka/Flink/Iceberg/Trino/Airflow behavior, correlation correctness, authentication, or other upstream service paths; those require integration/runtime evidence against the actual services.

This skill remains `draft` even though a deterministic local gate now exists. Promote it only after a fresh-session replay records both a successful happy path and an edge/failure case under the OpenForge skill-verification evidence contract.

## Stop / Escalate When

- A change would duplicate upstream source-of-truth state rather than correlate it.
- The UI needs to bypass the domain API to ship the feature.
- An uncertain relationship would be shown as factual.
- A mutation is required but auth, audit, rollback, idempotency, and failure semantics are not designed.

## References

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/development.md`
