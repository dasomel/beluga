# Implementation Status

Last verified: 2026-09-09 against `main`

This file records capabilities implemented on the default branch. It is not a production-readiness claim or roadmap.

## Implemented

- Vagrant-based four-VM k3s environment with ArgoCD GitOps bootstrap.
- Data-platform composition spanning Kafka/KRaft + Debezium CDC, Flink, Iceberg/Lakekeeper, SeaweedFS S3, Trino, Superset, Airflow, CloudNativePG, Keycloak/OpenLDAP, OPA/OpenFGA, and Prometheus-based observability.
- APISIX-based service gateway and internal TLS/identity boundary.
- End-to-end clickstream and CDC-oriented platform verification assets and real-state test scripts under `tests/`.
- Read-only Operations Agent security PoC with code-owned diagnostic tools, explicit risk classes, isolated kubeconfig requirement, canonical invocation digest, deny-before-executor behavior for mutation/egress/privileged classes, and bounded execution evidence.
- Permanent Operations Agent security CI for the PoC contract.

## Partial / experimental

- Beluga remains a personal/learning-scale data-platform project; the repository explicitly does not claim production readiness.
- The Operations Agent currently implements a constrained read-only diagnostic profile. Role-specific inspectors, Agent Graph orchestration, live incident RCA evaluation, and production-value measurement remain future work.
- Resource-heavy optional components and behavior depend on host memory profile and a real cluster.

## Not claimed

- No autonomous data mutation, privileged remediation, or unrestricted external-egress agent execution is enabled.
- Passing render/static tests alone is not treated as proof that the live data platform works.

## Evidence

- `README.md`
- `VERSIONS.md`
- `scripts/`
- `gitops/`
- `tests/`
- `operations-agent/`
- `.github/workflows/operations-agent-security.yml`
- PR #118 (`eee97cf7d5574735fbbc7824f86eda39e3ed07ff`)
