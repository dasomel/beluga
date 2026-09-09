# 구현 상태

Last verified: 2026-09-09 against `main`

이 문서는 default branch에 실제 구현된 capability를 기록하며 production-readiness 선언이나 roadmap이 아닙니다.

## 구현됨

- Vagrant 기반 4 VM k3s 환경과 ArgoCD GitOps bootstrap.
- Kafka/KRaft + Debezium CDC, Flink, Iceberg/Lakekeeper, SeaweedFS S3, Trino, Superset, Airflow, CloudNativePG, Keycloak/OpenLDAP, OPA/OpenFGA, Prometheus observability로 구성된 data platform.
- APISIX service gateway 및 internal TLS/identity boundary.
- Clickstream/CDC 중심 end-to-end 검증 자산과 `tests/`의 real-state verification script.
- Code-owned diagnostic tool, risk class, isolated kubeconfig, canonical invocation digest, mutation/egress/privileged 요청의 deny-before-executor, bounded evidence를 갖춘 read-only Operations Agent security PoC.
- Operations Agent contract를 지속 검증하는 permanent CI.

## 부분적 / experimental

- Beluga는 personal/learning-scale project이며 production-ready를 주장하지 않습니다.
- Operations Agent는 현재 제한된 read-only diagnostic profile입니다. Role-specific inspector, Agent Graph, live incident RCA 평가, production-value 측정은 후속 범위입니다.
- 일부 resource-heavy component와 동작은 host memory profile 및 실제 cluster에 의존합니다.

## 주장하지 않음

- Autonomous data mutation, privileged remediation, unrestricted external-egress agent execution은 활성화되어 있지 않습니다.
- Render/static test 성공만으로 live data platform 동작을 증명했다고 취급하지 않습니다.

## Evidence

- `README.md`
- `VERSIONS.md`
- `scripts/`
- `gitops/`
- `tests/`
- `operations-agent/`
- `.github/workflows/operations-agent-security.yml`
- PR #118 (`eee97cf7d5574735fbbc7824f86eda39e3ed07ff`)
