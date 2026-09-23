# 개발 가이드

Frontend와 Backend 기술 스택에 대한 ADR이 확정될 때까지 저장소는 가볍게 유지합니다.

## 현재 기반

- 사용자 문서를 English와 Korean 파일로 분리
- 아키텍처 문서
- GitHub Issue 중심 개발
- GitHub Actions CI 기반
- MVP부터 English/Korean i18n 지원
- `make verify`를 통한 저장소 소유 결정론적 검증

## 예정 애플리케이션 구조

```text
beluga-manager/
├── apps/
│   ├── web/          # Frontend
│   └── api/          # Backend / Domain API
├── packages/
│   ├── domain/       # Shared domain contracts
│   └── adapters/     # OSS integration adapters
├── docs/
└── .github/
```

구체적인 언어와 Framework 선택은 구현 전에 ADR로 확정합니다.

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
포함합니다. 웹 테스트는 Node 환경에서 API 응답 처리, 런타임 설정, 언어 설정과 fallback을
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
