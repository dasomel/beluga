---
name: beluga-manager-integration-contract
description: Implement Beluga Manager upstream integration and unified-domain changes while preserving authoritative OSS ownership, adapter boundaries, correlation confidence, read-first scope, and UI-to-domain-API separation. Use for Kafka/Flink/Iceberg/Trino/Airflow adapters, service/pipeline/data-asset domains, correlation, or Manager API/UI integration changes.
license: Apache-2.0
compatibility: Requires the manager/ directory of the beluga repo and its development toolchain (Node 22, npm workspaces); upstream integration evidence depends on available service APIs.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/beluga
  openforge-maturity: verified
  openforge-version: "1"
---

# Beluga Manager Integration Contract

D-MONO-1: this skill lives at the monorepo root `.agents/skills/`. All paths below (`AGENTS.md`, `docs/`, `research/`, `make verify`) are relative to `manager/`; run commands from there.

## Use When

- Adding/changing an upstream OSS adapter or capability.
- Changing Service, Pipeline, Data Asset, Operations, discovery, or correlation behavior.
- Connecting Manager UI behavior to Beluga unified APIs.

## Do Not Use When

- Changing the underlying Beluga data-platform deployment itself; that belongs in the beluga platform tree outside `manager/` (see the root `AGENTS.md`).
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

Run the repository-owned deterministic baseline and manager test suites:

```bash
make verify
npm run typecheck
npm test
npm run build
```

This skill is `verified` at the upstream-adapter -> correlation -> domain API -> Manager UI vertical slice: fresh-session replay evidence (happy path on Flink adapter/correlation/domain routes/PipelinesView, correlation confidence boundary edge case, and deterministic checks) is recorded in `.agents/skill-evals/beluga-manager-integration-contract.json` and `manager/research/issue-54-integration-contract-verification-2026-10-16.md`. Live multi-service cluster runtime (Kafka, live Flink cluster, Iceberg, Trino, Airflow), Domain API runtime auth, and live browser DOM interactions remain unverified; do not cite this skill's `verified` status as live-service integration evidence.

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
