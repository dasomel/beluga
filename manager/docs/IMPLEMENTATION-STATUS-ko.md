# 구현 상태

Last verified: 2026-09-09 against `main`

이 문서는 default branch에 실제 구현된 동작을 기록하고 design direction과 구분합니다.

## 구현됨

- Beluga data platform의 unified control-plane/UI를 위한 Beluga Manager project structure.
- Upstream OSS model을 그대로 노출하지 않고 Services, Pipelines, Data Assets, Operations 중심으로 구성하는 domain 방향.
- Authoritative state는 upstream service에 남기고 correlation/cache state를 분리하는 adapter/capability architecture.
- Tauri/web application foundation, 영/한 localization 구조, repository engineering/CI control, OpenForge portfolio status publication integration.
- Unified discovery/correlation 경험을 우선 검증하기 위해 broad mutation을 피하는 read-first product boundary.

## 부분적 / evolving

- Kafka/Flink/Iceberg/Trino/Airflow integration과 cross-service domain view는 점진적으로 발전 중입니다. Architecture 문서의 target boundary가 모든 adapter/resource action 구현 완료를 의미하지 않습니다.
- Operations correlation/drill-down은 전체 design narrative가 아니라 현재 implementation/API route를 기준으로 판단해야 합니다.

## 주장하지 않음

- 모든 upstream OSS를 대체하는 UI가 아닙니다.
- Broad destructive/mutating platform administration은 현재 read-first baseline에 포함되지 않습니다.
- Architecture diagram이나 MVP scope 자체를 execution evidence로 취급하지 않습니다.

## Evidence

- `README.md`
- `README-ko.md`
- `docs/architecture.md`
- application/API source tree
- repository CI workflows
- OpenForge portfolio publisher integration
