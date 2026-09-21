# 구현 상태

Last verified: 2026-09-21 against `main`

이 문서는 default branch에 실제 구현된 동작을 기록하고 design direction과 구분합니다.

## 구현됨

- 향후 Beluga 통합 Data Platform Control Plane/UI를 위한 저장소 및 문서 기반.
- 영문/한글 제품, 아키텍처, 개발, 기여 및 보안 문서.
- ADR-0001/0002/0003 승인됨: React 19 + Vite 8 + Tailwind 4 프론트엔드, TypeScript/Node + Hono
  백엔드 방향, WCAG 2.2 AA 목표의 shadcn/ui + Radix 디자인 시스템.
- 6개 화면이 배포된 프론트엔드 shell(`src/web/`) — Overview, Services, Pipelines, Data Catalog,
  Query Workspace, Policy. `mockData.ts`로 동작하며 아직 실제 백엔드와 연결되지 않음.
- 정책 컴파일러(`src/compiler/`, `src/schema.ts`) — Zod로 검증된 입력에서 Keycloak realm 설정,
  Trino OPA Rego, PostgreSQL DDL/롤을 생성.
- 이슈 #69를 위한 System-1 decision provider 스캐폴드(`src/decision/`) — provider-neutral,
  Zod 검증 인터페이스와 telemetry 누락/노후 시 fail-closed하는 결정론적 rule 기반 provider.
  로컬 모델이나 외부 provider 연동은 아직 없음.
- Services, Pipelines, Data Assets, Operations 중심 Domain 방향과 Adapter/Capability 및 Read-first 경계. 이는 구현된 Runtime이 아니라 설계 결정입니다.
- 저장소 검증, CI Control 및 OpenForge Portfolio Status 게시 연동.

## 부분적 / evolving

- **Backend/API Route 및 Integration Adapter는 아직 구현되지 않았습니다** — ADR-0002가 결정한
  Domain API는 코드로 존재하지 않고, 프론트엔드는 전적으로 mock 데이터로 동작합니다.
- 프론트엔드에 데이터 그리드, DAG/토폴로지 그래프, SQL 에디터 컴포넌트가 아직 없습니다(이슈
  #16-#18) — 현재 뷰는 ADR-0003이 선정한 전문 컴포넌트가 아니라 Tailwind로만 스타일링된 shell입니다.
- Architecture(토폴로지)와 Operations(리소스/이벤트/로그 drill-down) 내비게이션 섹션(이슈 #18,
  #19)이 아직 없습니다 — `docs/architecture.md`의 내비게이션 섹션 참고.
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
