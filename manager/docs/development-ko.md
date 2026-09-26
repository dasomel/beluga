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
이벤트 fixture를 제공합니다. 이 fixture 기반 UI/API 개발에는 실행 중인 Beluga 플랫폼이나
Docker/Podman 서비스가 필요하지 않습니다. 이 데이터로 실제 upstream discovery나
correlation을 검증할 수는 없습니다. API 문서는 `http://localhost:8787/api/v1/docs`에서
확인할 수 있습니다.

운영 이벤트에서 관련 서비스나 파이프라인 참조를 선택하면 서비스는 ID 검색이 적용된
화면으로, 파이프라인은 해당 항목이 선택된 화면으로 이동합니다. 서비스 검색 조건에 맞는
항목이 없으면 빈 결과를, 파이프라인이 없으면 안내를 표시합니다. 일반 사이드바 탐색은
이 이벤트 맥락을 초기화하며, 새로고침 후에는 유지되지 않습니다. Kubernetes 리소스와 로그는 이번 이벤트
탐색 범위에 포함되지 않습니다.

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
포함합니다. 웹 테스트는 Node 환경에서 API 응답 처리, 런타임 설정, 언어 설정과 fallback, 운영 이벤트 탐색 매핑을
검증하며 DOM 컴포넌트를 렌더링하지 않습니다.
웹 테스트만 실행하려면 `npm test -- --project @beluga-manager/web`을 사용합니다.
`npm run build`는 workspace의 타입을 검사하고 웹 프로덕션 번들을 빌드합니다.

실제 Kafka/Flink/Iceberg/Trino/Airflow 동작, correlation 정확성, authentication 등 upstream integration은 실제 서비스에 대한 integration/runtime evidence가 별도로 필요합니다. `make verify`는 그 영역까지 증명한다고 주장하지 않습니다.

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
날짜·숫자 형식과 나머지 하드코딩 UI 문자열은 이 기반 작업에 포함되지 않습니다.

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
