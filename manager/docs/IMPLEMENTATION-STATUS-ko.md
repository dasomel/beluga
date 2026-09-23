# 구현 상태

Last verified: 2026-09-23 against the local branch stack ending at `c059576` (on top of `main` `e6397c0`; becomes `main` status once merged)

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
- Locale 감지, 유지, fallback(이슈 #44): 초기 locale은 저장된 수동 선택값을 우선하고, 없으면
  `navigator.language`를 사용합니다(`ko*` → `ko-KR`, 그 외 → `en-US`). Storage 접근은 감싸져 있어
  `localStorage`가 차단되어도 앱이 죽지 않습니다. `ko-KR` 키가 없으면 `en-US`, 그다음 dotted key로
  fallback합니다. `<html lang>`은 선택된 locale을 따르며, key set이 어긋나면 parity 테스트가 CI에서
  실패합니다.
- 나머지 hard-coded UI 문자열 번역(이슈 #44): theme toggle, cluster card, Figma modal, overview
  card, catalog/query/policy view가 이제 `en-US`/`ko-KR` key를 사용합니다. Brand명, identifier,
  SQL, LDAP 그룹, API enum/message 값은 설계상 번역하지 않습니다. Intl 기반
  `formatDateTime`/`formatNumber`/`formatPercent`(`i18n/format.ts`)가 Operations 이벤트 시각,
  pipeline 업데이트 시각, query 카운트에 쓰입니다.
- Operations 이벤트에서 Services/Pipelines로의 drill-down(이슈 #19 일부, #32): 이벤트의 관련
  service 또는 pipeline 참조가 버튼이 되어, 클릭하면 해당 ID로 필터링된 Services 카탈로그가 열리거나
  Pipelines에서 항목이 선택됩니다(없으면 not-found 안내). 매핑은 순수 모듈
  `packages/web/src/views/eventNavigation.ts`이며 Vitest로 커버됩니다.
- Root `npm run dev:api` 스크립트(이슈 #32) — Domain API를 `tsx watch`로 8787 포트에 기동합니다.
  `docs/development.md`/`-ko.md`가 stub fixture를 대상으로 web(5180)과 API를 함께 실행하는 방법을
  설명합니다.
- `packages/web`이 `node` 환경의 Vitest project로 등록되어(이슈 #30) API client와 runtime config
  로딩을 커버합니다.
- CI가 typecheck·test에 더해 production web bundle build(`npm run build`, 이슈 #31)를 실행하여
  Vite 번들링 회귀가 CI를 통과하지 못하도록 합니다.

## 부분적 / evolving

- **Backend/API Route 및 Integration Adapter는 아직 구현되지 않았습니다** — ADR-0002가 결정한
  Domain API는 코드로 존재하지 않고, 프론트엔드는 전적으로 mock 데이터로 동작합니다.
- 프론트엔드에 데이터 그리드, DAG/토폴로지 그래프, SQL 에디터 컴포넌트가 아직 없습니다(이슈
  #16-#18) — 현재 뷰는 ADR-0003이 선정한 전문 컴포넌트가 아니라 Tailwind로만 스타일링된 shell입니다.
- Architecture(토폴로지) 내비게이션 섹션(이슈 #18)이 아직 없습니다 — `docs/architecture.md`의
  내비게이션 섹션 참고. Operations drill-down(이슈 #19)은 현재 service/pipeline 참조만 다루며,
  Kubernetes 리소스/로그 drill-down은 아직 열려 있습니다.
- Kafka/Flink/Iceberg/Trino/Airflow 연동과 Cross-service Domain View는 계획 단계이며, Architecture 문서는 Target Boundary만 정의합니다.
- 알려진 Cosmetic Gap(이슈 #44): 한글 `columnsCount` 문자열(`개 컬럼`)이 카운트 뒤에 그대로
  붙어 `N 개 컬럼`처럼 공백이 남습니다 — concatenation 대신 interpolation이 필요합니다.
- `packages/web` 테스트는 Vitest `node` 환경에서 실행되며 DOM/E2E 커버리지는 아직 없습니다(이슈
  #30) — 렌더링/상호작용 회귀는 자동 테스트가 아니라 커밋 메시지에 기록된 수동/headless-Chrome
  점검으로만 확인됩니다.

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
- `npm test` — 24개 파일에서 226개 테스트 통과(`packages/web` 포함), `npm run typecheck`,
  `npm run build`, `make verify` 통과
