# 구현 상태

Last verified: 2026-09-14 against `main`

이 문서는 default branch에 실제 구현된 동작을 기록하고 design direction과 구분합니다.

## 구현됨

- 향후 Beluga 통합 Data Platform Control Plane/UI를 위한 저장소 및 문서 기반.
- 영문/한글 제품, 아키텍처, 개발, 기여 및 보안 문서.
- Services, Pipelines, Data Assets, Operations 중심 Domain 방향과 Adapter/Capability 및 Read-first 경계. 이는 구현된 Runtime이 아니라 설계 결정입니다.
- 저장소 검증, CI Control 및 OpenForge Portfolio Status 게시 연동.

## 부분적 / evolving

- Frontend, Backend, Tauri Application, API Route 및 Integration Adapter는 아직 구현되지 않았습니다.
- Kafka/Flink/Iceberg/Trino/Airflow 연동과 Cross-service Domain View는 계획 단계이며, Architecture 문서는 Target Boundary만 정의합니다.

## 주장하지 않음

- 모든 upstream OSS를 대체하는 UI가 아닙니다.
- Broad destructive/mutating platform administration은 현재 read-first baseline에 포함되지 않습니다.
- Architecture diagram이나 MVP scope 자체를 execution evidence로 취급하지 않습니다.
- 저장소 Scaffold와 문서만으로 실행 가능한 제품이라고 주장하지 않습니다.

## Evidence

- `README.md`
- `README-ko.md`
- `docs/architecture.md`
- repository CI workflows
- `scripts/verify.py`
- `tests/test_verify.py`
- OpenForge portfolio publisher integration
