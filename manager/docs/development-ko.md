# 개발 가이드

Frontend와 Backend 기술 선택은 아래에 연결한 ADR에 기록되어 있으며, 워크스페이스 구조 절은 현재 구현된 내용을 설명합니다.

## 현재 기반

- 사용자 문서를 English와 Korean 파일로 분리
- 아키텍처 문서
- GitHub Issue 중심 개발
- GitHub Actions CI 기반
- MVP부터 English/Korean i18n 지원
- `make verify`를 통한 저장소 소유 결정론적 검증

## 애플리케이션 구조

저장소는 `packages/` 아래의 npm workspace로 구성되어 있습니다.

```text
beluga-manager/
├── packages/
│   ├── web/              # Frontend (React 19 + Vite SPA)
│   ├── domain-api/       # Backend / Domain API (Hono + @hono/zod-openapi)
│   └── policy-compiler/  # Beluga 정책 컴파일러 및 policyctl CLI
├── docs/
│   └── adr/              # 아키텍처 결정 기록 (ADR)
└── .github/              # CI 워크플로우 및 자동화
```

### 워크스페이스 패키지

- `packages/web` (`@beluga-manager/web`): Vite와 Tailwind CSS 기반의 React 19 싱글 페이지 애플리케이션(SPA)입니다. Overview, Services, Pipelines, Data Assets, Operations, Policy 뷰로 구성된 Beluga Manager 웹 콘솔을 제공합니다. 기술 선택은 [ADR-0001](adr/0001-frontend-technology-ko.md) 및 [ADR-0003](adr/0003-ui-design-system-ko.md)을 따릅니다.
- `packages/domain-api` (`@beluga-manager/domain-api`): Node.js 및 Hono 기반의 백엔드 Domain API 서비스로, `@hono/zod-openapi`를 사용하여 REST 엔드포인트와 스키마 정의를 제공합니다. 로컬 fixture 기반의 도메인 리소스(서비스, 파이프라인, 데이터 자산, 이벤트)를 제공하고, 공유 도메인 스키마 정의(`./schema`)를 내보내며, System-1 의사결정 제공자 경계(`src/decision/`)를 포함합니다. 기술 선택은 [ADR-0002](adr/0002-backend-api-technology-ko.md)를 따릅니다.
- `packages/policy-compiler` (`@beluga-manager/policy-compiler`): 정책 선언 컴파일러 및 `policyctl` CLI입니다. Zod를 통해 Beluga 플랫폼 YAML 정책 선언을 검증하고 Keycloak 설정, Trino OPA Rego 정책, PostgreSQL DDL/role 아티팩트로 컴파일하며, 정책 drift를 검사합니다.

아키텍처 및 기술 결정 사항은 [아키텍처 결정 기록 (ADR)](adr/README-ko.md) ([ADR-0001](adr/0001-frontend-technology-ko.md), [ADR-0002](adr/0002-backend-api-technology-ko.md), [ADR-0003](adr/0003-ui-design-system-ko.md))에 기록되어 있습니다.

## 로컬 개발

Node.js 22 이상을 사용하고 저장소 루트에서 워크스페이스 의존성을 설치합니다.

```bash
npm install
```

별도 터미널 두 개에서 각각 저장소 루트를 기준으로 Frontend와 Domain API를 실행합니다.

```bash
# 터미널 1: Vite Frontend — http://localhost:5180
npm run dev

# 터미널 2: Domain API — http://localhost:8787 (tsx watch)
npm run dev:api
```

`http://localhost:5180`에 접속합니다. Frontend는 `packages/web/public/config.json`의
`apiBaseUrl`을 읽으며 기본값은 `http://localhost:8787`입니다. API의 현재 CORS 설정은
Frontend 출처 `http://localhost:5180`을 허용하므로 이 호스트명을 사용하고 5180 포트를
비워 두어야 합니다. 두 서버 모두 `PORT`로 포트를 변경할 수 있지만, API 포트를 바꾸면
`apiBaseUrl`도 수정해야 하며 Frontend 출처를 바꾸면 API의 CORS 설정도 수정해야 합니다.

Domain API는 `packages/domain-api/src/stub-data/`의 서비스, 파이프라인, 데이터 자산,
이벤트 및 Kubernetes 리소스 fixture를 제공합니다. 이 fixture 기반 UI/API 개발에는 실행 중인 Beluga 플랫폼이나
Docker/Podman 서비스가 필요하지 않습니다. 이 데이터로 실제 upstream discovery나
correlation을 검증할 수는 없습니다. API 문서는 `http://localhost:8787/api/v1/docs`에서
확인할 수 있습니다.

Operations에서 이벤트 타임라인, Kubernetes 리소스 목록, Decisions (System-1) 권고를 전환할 수 있습니다. Decisions는 `/api/v1/decisions`의 고정 telemetry fixture projection을 사용합니다. 확신도는 advisory/uncalibrated로 표시되며 자동 조치는 실행하지 않습니다. ABSTAIN 항목에는 locale-neutral abstain code의 현지화된 설명이 표시됩니다. 리소스 행은
관련 이벤트, 서비스, 파이프라인으로 이동합니다. 리소스를 참조하는 이벤트에는 해당 리소스가
강조 표시된 목록으로 이동하는 pill이 표시됩니다. 리소스의 `logsUrl`이 있을 때만 새 탭에서
로그를 열며, 관측성 endpoint가 설정되지 않아 fixture에서는 null입니다. Manager는 로그를
저장하지 않습니다. fixture는 실제 Kubernetes discovery를 수행하지 않습니다.

## 로컬 검증

로컬과 CI에서 동일한 baseline을 실행합니다.

```bash
make verify
```

기반 검증은 저장소 구조와 문서를 다룹니다.

- `make lint` — Python verifier와 regression test의 syntax를 compile-check합니다.
- `make test` — 잘못된 repository fixture가 실제 non-zero로 실패하는 경우를 포함한 verifier regression test를 실행합니다.
- `make verify` — lint + test + 필수 파일, bilingual 문서 쌍, README language switcher, local Markdown link, GitHub workflow 구조를 현재 checkout에서 검증합니다.

CI는 application workspace에 대해 `npm run typecheck`, `npm test`, `npm run build`도 실행합니다.
루트 Vitest 프로젝트는 `packages/policy-compiler`, `packages/domain-api`, `packages/web`을
포함합니다.
`npm run build`는 workspace의 타입을 검사하고 웹 프로덕션 번들을 빌드합니다.

실제 Kafka/Flink/Iceberg/Trino/Airflow 동작, correlation 정확성, authentication 등 upstream integration은 실제 서비스에 대한 integration/runtime evidence가 별도로 필요합니다. `make verify`는 그 영역까지 증명한다고 주장하지 않습니다.

### 웹 테스트 전략 (issue #30)

`packages/web` 테스트는 Vitest의 **Node** 환경(`packages/web/vitest.config.ts`)에서 실행됩니다 —
jsdom이나 `@testing-library/react` 의존성이 없어서, 클릭 등 DOM 이벤트를 시뮬레이션하는 대신
`react-dom/server#renderToStaticMarkup`으로 렌더링한 HTML 문자열을 검증합니다. 웹 테스트만
실행하려면 `npm test -- --project @beluga-manager/web`을 사용합니다.

커버리지 계층:

- **순수 함수/단위 테스트** — 테스트 대상 모듈과 같은 위치에 `*.test.ts` 하나씩
  (`catalogSql.test.ts`, `decisionLabels.test.ts`, `eventNavigation.test.ts`,
  `safeExternalUrl.test.ts`, `i18n/` 헬퍼 등). 가장 빠르고 촘촘한 계층이며, 정적 렌더링으로는
  닿지 않는 분기(예: 클릭이 `OperationsView`를 어느 섹션으로 전환시키는지)를 여기서 검증합니다.
- **뷰/컴포넌트 테스트** — `src/views/` 아래 뷰마다 `*.test.tsx` 하나씩(`OverviewView`,
  `ServicesView`, `PipelinesView`, `ArchitectureView`, `OperationsView`, `DataCatalogView`,
  `QueryWorkspaceView`, `PolicyView`). 각 테스트는 `vi.mock`과 `vi.hoisted` fixture 객체로
  `../api/hooks`를 모킹해 케이스별로 쿼리 결과를 제어한 뒤 `renderToStaticMarkup`으로 렌더링합니다.
  커버리지는 뷰마다 다릅니다: 서버 쿼리를 쓰는 대부분의 뷰는 `en-US`에서 로딩/에러/빈 상태/정상
  상태를, 뷰당 최소 1개의 한국어 로케일 케이스와 함께 검증합니다(모든 상태를 한국어로 반복하지는
  않습니다). `QueryWorkspaceView`는 서버 쿼리도 로딩/에러/빈 상태도 없어서, 대신 렌더링 변형(기본
  preset, 호출자가 제공한 `initialSql`, 카탈로그 출처 breadcrumb)과 한국어 케이스 1개를 검증합니다.
  Fixture는 `domain-api` stub data(`packages/domain-api/src/stub-data/`, 해당 패키지가 `./schema`만
  공개 export로 노출하므로 stub-data 모듈을 그대로 import할 수 없어 벗어나 있는 영역)를 그대로 복사한
  것이 아니라 같은 스키마 모양으로 직접 작성한 리터럴이며, 특정 분기를 검증하려고 stub 값과 의도적으로
  다르게 만든 경우도 있습니다 — 예를 들어 `OperationsView.test.tsx`는 "로그 보기" 링크를 렌더링하려고
  리소스에 `https://` `logsUrl`을 부여합니다(stub의 동일 리소스는 `logsUrl: null`입니다). 아래 여정
  테스트의 fixture도 컬럼 개수가 이 여정과 무관하므로 stub의 7개 대신 3개로 줄였습니다.
- **핵심 여정(critical journey) 테스트** — `catalogToQueryJourney.test.tsx`는 "카탈로그 → 테이블 →
  쿼리" 여정을 재구현이 아니라 실제 production 함수 체인으로 end-to-end 검증합니다: `DataCatalogView`의
  "쿼리에서 열기" 버튼이 실제로 호출하는 함수인 `handleOpenInQuerySelection`을 실제 `onSelectQuery`
  spy와 함께 호출해 전달된 SQL/table 값을 검증한 뒤, 그 결과를 App.tsx가 `query` 탭을 연결할 때 쓰는
  실제 함수인 `mapCatalogQueryTargetToWorkspaceProps`에 그대로 넣고 `QueryWorkspaceView`를 렌더링해
  SQL과 카탈로그 출처 breadcrumb를 검증합니다. 두 함수 모두 이 체인을 클릭 시뮬레이션(jsdom 부재로
  불가능) 없이도 테스트할 수 있도록 production 코드에서 export되었습니다.
- **알려진 공백**: seed 가능한 prop 없이 `onClick`만으로 상태가 바뀌는 상호작용(예: `OperationsView`의
  이벤트/리소스/결정 탭 전환 중 `initialResourceId`/`initialEventId`로 seed되지 않는 부분)은 이
  테스트 계층에서 구동할 수 없습니다 — 탭 버튼 자체의 존재만 검증하고, 내부 선택 로직은 별도로
  단위 테스트합니다. 이 공백을 메우려면 jsdom/testing-library 도입이 필요하며, 이번 작업 범위에는
  포함하지 않았습니다.

모든 웹 fixture는 직접 작성한 결정론적(deterministic) 데이터이며 네트워크 접근이 필요 없어, issue
#30의 air-gapped 요건을 만족합니다.

## OpenForge 상태 발행

`.github/workflows/openforge-status.yml`은 `main`에서 CI가 성공하거나 수동
`workflow_dispatch` 실행 시 `.openforge/status.json`(`openforge-project-status/v1`
페이로드)을 `dasomel/openforge` 포트폴리오에 발행한다. 리포지토리 시크릿
`OPENFORGE_STATUS_TOKEN`(`dasomel/openforge`에 PR을 열 수 있는 범위가 좁은
토큰)이 필요하며, 시크릿이 없으면 `.openforge/status.json`만 검증하고 스킵
메시지를 남긴 뒤 실패 없이 종료한다. `.openforge/status.json`의 `revision`과
`evidence.commit`은 CI가 실제로 검증한 SHA여야 한다. 워크플로우가 이를
강제한다 — `revision`은 실행의 SHA에서 도달 가능한(해당 커밋의 조상이거나
동일한) 검증된 커밋이어야 하며, 그렇지 않으면 잡이 실패한다.

## 다국어

사용자에게 보이는 모든 문자열은 translation key를 사용해야 합니다. 새로운 UI 문자열을 추가할 때 English와 Korean 번역을 함께 추가합니다. API/Domain 객체는 특정 언어에 종속되지 않도록 합니다.

웹 앱은 localStorage의 `beluga_locale`에 저장된 지원 언어를 먼저 복원한 뒤
`navigator.language`를 확인합니다. 한국어 태그는 `ko-KR`, 영어와 미지원 언어는 `en-US`를
사용합니다. 수동 선택만 저장합니다. 저장소를 사용할 수 없거나 접근이 차단되면 다음 로드에서
브라우저 언어를 사용하며, 현재 세션의 언어 변경은 계속 가능합니다.
누락된 번역은 영어, 그다음 점으로 구분된 번역 키로 대체합니다. 웹 Vitest 테스트는 영어와
한국어의 중첩 키 집합이 동일한지 검사합니다. 리소스 이름과 식별자는 그대로 유지합니다.
날짜·숫자·백분율 서식은 `packages/web/src/i18n/format.ts`에서 처리하며, 복수형을 고려한 카운트 문자열은 `packages/web/src/i18n/interpolate.ts`의 `interpolateCount`로 지원합니다(영어 카운트 키는 `{count} row(s)`처럼 `(s)` 접미사를 명시적으로 사용합니다). 사용자 대상 UI 문자열 하드코딩 방지는 `packages/web/src/i18n/hardcodedStringGuard.ts` AST 가드를 통해 검증됩니다.

### 새 언어(Locale) 추가

Beluga Manager에 새로운 언어를 추가하는 절차:

1. **Locale 타입 추가**: `packages/web/src/i18n/translations.ts`의 `Locale` 유니언 타입에 새 locale 식별자(예: `'ja-JP'`)를 추가합니다.
2. **번역 카탈로그 등록**: `packages/web/src/i18n/translations.ts`의 `translations` 객체에 새 언어의 번역 카탈로그를 정의합니다. TypeScript가 컴파일 타임에 모든 locale 간 키 일치 여부를 강제하므로 `Translations` 인터페이스 구조와 완전히 일치해야 합니다.
3. **언어 감지 및 유지 로직**: 브라우저 언어 감지, localStorage 키(`beluga_locale`), fallback 및 영속화 로직은 `packages/web/src/i18n/locale.ts`(`getInitialLocale`, `persistLocale`)에 위치합니다. 브라우저 언어 태그를 새 locale로 자동 매핑하려면 `getInitialLocale`을 함께 갱신합니다.
4. **검증**:
   - `npm test`를 실행하여 번역 키 일치 검사(`packages/web/src/i18n/getTranslations.test.ts`), locale 감지/유지 테스트(`packages/web/src/i18n/locale.test.ts`), 보간 테스트(`packages/web/src/i18n/interpolate.test.ts`), 서식 테스트(`packages/web/src/i18n/format.test.ts`), 하드코딩 검사(`packages/web/src/i18n/hardcodedStringGuard.test.ts`)를 확인합니다.
   - `npm run typecheck`를 실행하여 컴파일 타임에 누락된 번역 키가 없는지 타입 검사를 수행합니다.

## 문서 파일 규칙

사용자에게 제공하는 Markdown 문서는 언어별로 별도 파일을 사용합니다.

- English: `<name>.md`
- Korean: `<name>-ko.md`

예:

- `README.md` / `README-ko.md`
- `docs/architecture.md` / `docs/architecture-ko.md`
- `docs/development.md` / `docs/development-ko.md`

English 파일명을 기본 이름으로 사용하고 Korean 파일에는 `-ko.md` suffix를 사용합니다. 두 문서는 의미와 구조를 동일하게 유지합니다.

English version: [development.md](development.md)
