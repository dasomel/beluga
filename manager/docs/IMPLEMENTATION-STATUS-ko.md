# 구현 상태

Last verified for issues #16/#17/#18/#23/#35/#36: 2026-10-05 against default branch commit `2081fef`, including merged PRs [#120](https://github.com/dasomel/beluga-manager/pull/120), [#121](https://github.com/dasomel/beluga-manager/pull/121), [#124](https://github.com/dasomel/beluga-manager/pull/124) and [#125](https://github.com/dasomel/beluga-manager/pull/125).

이 문서는 default branch에 실제 구현된 동작을 기록하고 design direction과 구분합니다.

## 구현됨

- 향후 Beluga 통합 Data Platform Control Plane/UI를 위한 저장소 및 문서 기반.
- 영문/한글 제품, 아키텍처, 개발, 기여 및 보안 문서.
- ADR-0001/0002/0003 승인됨: React 19 + Vite 8 + Tailwind 4 프론트엔드, TypeScript/Node + Hono
  백엔드 방향, WCAG 2.2 AA 목표의 shadcn/ui + Radix 디자인 시스템.
- 6개 화면이 배포된 프론트엔드 shell(`src/web/`) — Overview, Services, Pipelines, Data Catalog,
  Query Workspace, Policy. Policy 화면은 아래 읽기 전용 Domain API projection을 사용하며,
  나머지 화면은 아직 `mockData.ts`로 동작합니다.
- 정책 컴파일러(`src/compiler/`, `src/schema.ts`) — Zod로 검증된 입력에서 Keycloak realm 설정,
  Trino OPA Rego, PostgreSQL DDL/롤을 생성.
- 이슈 #69를 위한 System-1 decision provider 스캐폴드(`src/decision/`) — provider-neutral,
  Zod 검증 인터페이스와 telemetry 누락/노후 시 fail-closed하는 결정론적 rule 기반 provider.
  로컬 모델이나 외부 provider 연동은 아직 없음.
- 읽기 전용 decision projection API (`GET /api/v1/decisions`, `GET /api/v1/decisions/{id}`)와 Operations 화면 섹션. 고정 telemetry fixture 세 개를 시작 시 isolated rule provider로 평가하고, 결정론적 메타데이터·근거 시각·관련 항목 탐색 ID·현지화된 abstain code를 노출합니다. 확신도는 보정되지 않은 참고값이며 자동 조치는 수행하지 않습니다. 실제 추천이 아닌 fixture입니다.
- 읽기 전용 policy summary projection API (`GET /api/v1/policies`, `GET /api/v1/policies/{id}`)와
  Policy 화면. Fixture 기반 role/group 권한을 읽기 전용과 변경 작업으로 분리해 반환하고,
  Trino Rego·PostgreSQL GRANT·Keycloak mapper 산출물의 SHA-256 및 줄 수 메타데이터를 노출합니다.
  원문 컴파일 산출물, credential, secret은 의도적으로 제외합니다. 테스트가 checked-in fixture를
  실제 policy compiler로 컴파일해 projection drift를 감지합니다. 이는 live Keycloak/OPA 연동이 아닙니다.
- 읽기 전용 Data Asset API 및 테이블 상세 패널(이슈 #15/#36): `DataCatalogView`가 Domain API에서 자산 목록과 선택된 테이블 상세를 조회해 컬럼, 타입, Null 허용 여부, 위치, 포맷, 메타데이터 요약을 표시합니다. 로컬 fixture 기반입니다. 병합된 PR #120은 `catalog` kind, 선택적 `catalog`/`namespace`/`parentId`/`path`, `?parentId=` 필터, 파생 ID helper, 파티션 컬럼 표시를 추가하면서 flat 목록 기본값과 기존 ID를 유지합니다.
- Query context는 별도의 Domain API endpoint (`GET /api/v1/data-assets/{id}/query-context`)입니다. DataCatalogView는 선택한 asset ID만 Query Workspace로 전달하고, Query Workspace가 query context와 starter SQL을 가져옵니다. 이 endpoint도 fixture 자산과 stub service registry를 사용하며 live Trino를 조회하지 않습니다.
- Query history (#17): `GET /api/v1/query-history`는 adapter가 볼 수 있는 query snapshot(id, SQL, upstream 상태)을 페이지 단위로 제공합니다. 영구 이력·추정 시간순 정렬·사용자·자산 연관은 없습니다. live history adapter가 연결되지 않아 기본 앱은 503을 반환합니다. 주입한 stub은 테스트에서만 사용하며 `sql`은 원문 그대로 노출되어 민감한 리터럴을 포함할 수 있고, 마스킹(redaction)과 호출자별 authz가 없으며(앱에 인증 미들웨어 없음) 마스킹/authz 정책이 정해지기 전에는 live adapter를 연결하면 안 됩니다. UI 연결과 live 가시성/auth 검증은 미완료입니다.
- 서비스 목록 type 필터링(#23): `GET /api/v1/services`는 등록된 adapter를 `type`으로 먼저 선택한 뒤 호출합니다(`registry.listServices(type)`, 머지된 PR [#125](https://github.com/dasomel/beluga-manager/pull/125)). 전체 adapter에 fanout한 뒤 필터링하지 않으며, `status`는 여전히 health 조회 후 필터링하고 부분 실패 동작은 변하지 않습니다.
- Pipeline correlation contract (이슈 #35): 병합된 PR #121은 Pipeline 응답의 타입이 있는 `correlationLinks`, confidence/evidence가 포함된 결정론적 declared-label/name-convention 규칙, 읽기 전용 PipelinesView 표시를 추가합니다. 현재 링크는 checked-in stub inventory로 계산하며 live Kafka, Flink, Iceberg/Lakekeeper, Trino, Airflow API에서 discovery하지 않습니다.
- Flink adapter (이슈 #16/#35/#41, 첫 라이브 upstream adapter): `BELUGA_FLINK_REST_URL`로 opt-in(기본 off, 따라서 CI와 로컬 개발은 stub을 유지). Flink JobManager의 `GET /overview`, `/jobs/overview`, `/jobs/{jobid}`만 읽고, `svc-flink`와 라이브 Pipeline/Job(Flink job당 하나)을 문서화된 상태 매핑으로 제공하며, 연결 불가/timeout/malformed/5xx 실패를 오류가 아니라 `unknown`/`degraded`와 목록 경고로 분류하고, job을 sink Iceberg 테이블에 이름 규약 규칙(confidence 0.6, `declared-label` 아님)으로 연결합니다. Flink 1.20.0에서 녹화한 fixture 대비 단위 테스트(restarting/failed fixture는 합성 편집본)와, 2026-10-07 라이브 Beluga Flink 1.20.0에 대한 1회성 읽기 전용 실행(실행 중인 세 job `beluga-cdc_orders`, `beluga-cdc_customers`, `beluga-events_sessionization` 확인)으로 검증했습니다. 요청 부하는 제한되지만(단일 비행 snapshot 캐시, 구성 전체 예산, 제한된 대기열을 가진 전역 동시성 상한, 단건 조회는 같은 snapshot에서 제공하며 객체가 불완전하면 503; 설정값은 API 레퍼런스 참조. API에 인증이 없으므로 캐시 TTL 1000ms 미만은 명시적 opt-in이 필요합니다) Domain API에는 여전히 인증이 없습니다. 어댑터가 켜져 있는 동안에는 stub pipeline id가 더 이상 존재하지 않으므로 stub event/resource/decision의 `relatedPipelineId`가 `null`로 반환됩니다. 이 변경 이후 읽기 전용 라이브 재실행(2026-10-07)에서도 실행 중인 세 job과 `GET /api/v1/pipelines/{id}`의 200을 다시 확인했습니다. 자동화된 라이브 테스트는 없으며 웹 UI는 확인하지 않았습니다.
- Overview Dashboard 및 Services Catalog (이슈 #13/#14): KPI 카드에는 Iceberg 테이블 자산, 활성 워크로드(healthy 또는 degraded 상태의 `Workload` 리소스이며 Job 자체의 수가 아닌 대리 지표), CPU 또는 메모리 사용량을 보고하는 리소스 수가 포함됩니다. 리소스 KPI는 `GET /api/v1/resources`를 사용하고 Operations로 이동합니다. 사용량은 문자열 필드가 있는 리소스 수이며 CPU/스토리지 총량을 계산하지 않습니다. Superset 버전 6.1.0은 `beluga/VERSIONS.md`에 기록되어 있습니다.
- `DecisionProvider`를 위한 장애격리 실행 경계(`src/decision/isolatedProvider.ts`, 이슈 #69) —
  provider가 throw/reject하거나 스키마를 어기는 값을 반환하거나 budget(기본 500ms, 재정의 가능)을
  넘기면 항상 machine-readable abstain code와 개발자용 이유(`ISOLATION_TIMEOUT` / `ISOLATION_PROVIDER_ERROR` /
  `ISOLATION_INVALID_SHAPE`)와 함께 `ABSTAIN`으로 강등하며 caller에게 절대 전파하지 않음.
  timeout은 `Promise.race`로 caller를 해방하고 타이머를 해제하며, timeout 이후 늦게 도착하는
  provider 응답은 unhandled rejection 없이 폐기됨.
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

- Flink adapter만 존재하며 Kafka, Debezium/CDC, Airflow, Iceberg/Lakekeeper, Trino adapter와 live
  telemetry discovery는 구현되지 않았습니다. `BELUGA_FLINK_REST_URL`을 설정하지 않으면 Domain API는
  decision/policy projection, Data Asset, Pipeline correlation을 포함한 local fixture를 제공하며,
  stub 기반 API 테스트는 실제 upstream 동작을 증명하지 않습니다. Flink adapter를 켜면
  `GET /api/v1/pipelines`는 라이브 Flink pipeline만 반환합니다(stub과 섞지 않음).
- 이슈 #35/#41은 아직 완료되지 않았습니다. slice 중 Flink 부분(job 상태, Flink job -> Iceberg sink
  테이블 링크)은 2026-10-07에 라이브로 1회 검증했지만, Flink REST가 Kafka topic도 label도 노출하지
  않으므로 Kafka topic -> Flink job 링크에는 Kafka(또는 declared-label) 출처가 필요합니다.
  Airflow/Debezium adapter, Kafka -> Flink -> Iceberg -> Trino 중 Lakekeeper/Iceberg·Trino 쪽 끝,
  Resource(`relatedResourceIds`) discovery, UI 확인은 하지 않았습니다. Airflow/CDC Job 뷰(#16)도 열려 있습니다.
- 이슈 #36 / ADR-0004 hierarchy는 API/schema/stub-fixture 단계입니다. `DataCatalogView`는 이제
  `GET /api/v1/data-assets?parentId=`로 catalog/namespace 노드를 lazy하게 펼칩니다(fixture 기반, 로딩/빈 상태/오류
  상태 포함. API가 catalog 노드를 반환하지 않으면 flat table 목록으로 대체하며 이 대체 라벨은 여전히 고정 텍스트입니다.
  단위/렌더 테스트로만 검증했고 브라우저에서는 확인하지 않았습니다). 남은 작업은 authoritative
  Lakekeeper/Iceberg 및 Trino metadata를 읽는 adapter, source-to-Domain-API 경로 증거입니다.
  Query Workspace의 별도 query-context route도 아직 fixture 자산과 stub service registry를 씁니다.
  `childCount`는 node-level OPA filtering 전까지 `null`이며 ADR-0004는 실제 사용자 rollout 전에
  해당 filtering을 요구합니다. Superset dataset context는 이슈 #36에서 선택 사항입니다.
- 접근성을 갖춘 전문 노드-엣지 토폴로지 그래프 컴포넌트(`TopologyGraph`, Pipelines 상관관계 그래프(이슈 #16)와 Architecture 뷰(이슈 #18)에서 사용): ADR-0003에 따라 `@xyflow/react`로 구현했습니다. 구현됨: 그래프 전체가 Tab 정지점 하나(roving tabindex, xyflow 노드/엣지 래퍼는 포커스 불가로 만들어 중복 정지점 제거); 눌린 방향에서 가장 가까운 노드로 이동하는 공간 기반 화살표 키 이동(Home/End, Enter/스페이스바로 선택)을 해당 그래프 컨테이너 범위로 한정; 노드/엣지에 원시 id가 아닌 설명형 접근 가능 이름; 텍스트 라벨과 아이콘이 병기된 상태 뱃지, Job 실행 데이터가 없거나 stage와 정확히 일치하지 않는 노드는 `healthy`로 가정하지 않고 명시적 `unknown` 표시; 세 그래프(Pipelines, Architecture 파이프라인, Architecture 인프라) 모두에 라이트/다크 테마 전달, 엣지·선택·포커스 색상은 비텍스트 대비 3:1 이상(hex 값을 테스트로 검증); `prefers-reduced-motion`이면 엣지 애니메이션 중지; 순환을 끊고 self-link를 무시하는 결정적 계층 레이아웃; 중복 id(첫 항목 우선)와 존재하지 않는 노드를 가리키는 엣지는 제외하고 화면에 안내 표시; 그래프와 같은 데이터에서 만든 표 대체 뷰 및 현재 선택을 포함하는 aria-live 요약. 검증 범위: 단위 테스트(레이아웃, 데이터 정제, 순수 함수로 분리한 공간 내비게이션, 대비 비율, 상태 매핑)와 서버 렌더 테스트(`renderToStaticMarkup`, node 테스트 환경)뿐입니다. 검증하지 않은 것: 실제 브라우저에서의 동작, 즉 DOM 키 핸들러(포커스 이동, `preventDefault`), 스크린 리더 출력, 실제 렌더된 엣지 색상/애니메이션, 200% 확대·터치 동작. xyflow 속성은 설치된 `@xyflow/react` 12.11.6 소스로 확인했을 뿐 런타임으로 확인하지 않았습니다. 데이터 그리드 컴포넌트는 쿼리 워크스페이스(#17) 소관이며 SQL 에디터(#17)와 함께 아직 구현되지 않았습니다.
- 프론트엔드에 데이터 그리드나 SQL 에디터 컴포넌트가 아직 없습니다(이슈 #17) — 해당 뷰는 ADR-0003이 선정한 전문 컴포넌트가 아니라 Tailwind로만 스타일링된 shell입니다.
- `docs/architecture.md`의 내비게이션 섹션에 기술된 Architecture 내비게이션 섹션은 아직 없습니다(Architecture 뷰 자체는 있음, 이슈 #18). Operations drill-down(이슈 #19)은 service/pipeline 참조, Kubernetes 리소스
  목록(Namespace/Workload/Pod/Service/Endpoint/Job/PersistentVolumeClaim 종류와 종류 필터, PVC 선택
  필드 `capacity`/`storageClass`), 선택 이벤트 `source`(kubernetes/service/job, 없으면 미상이며 보충하지
  않음)를 다룹니다. 모두 스텁 데이터입니다. Job 전용 로그 진입점이나 로그 화면에서 돌아오는 연결은 없으며,
  `logsUrl`이 유일한 (범용, 외부) 로그 링크이고 스텁 Job에는 값이 없습니다.
- Live Kafka/Flink/Iceberg/Trino/Airflow 연동은 계획 단계입니다. 병합된 #35 Pipeline correlation
  contract는 fixture-backed이며, Superset dataset context는 #36의 선택 항목입니다.
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
- 병합된 PR #120/#121 GitHub CI — Typecheck and Tests, dependency freshness/vulnerability,
  deterministic repository verification 모두 통과.
- `make verify` — 2026-10-03에 `f5e34a9` 기반 문서 변경에서 통과 (Python 테스트 9개, repository verification PASS).
