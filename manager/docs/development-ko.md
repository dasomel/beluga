# 개발 가이드

Frontend와 Backend 기술 스택에 대한 ADR이 확정될 때까지 저장소는 가볍게 유지합니다.

## 현재 기반

- 사용자 문서를 English와 Korean 파일로 분리
- 아키텍처 문서
- GitHub Issue 중심 개발
- GitHub Actions CI 기반
- MVP부터 English/Korean i18n 지원

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

## 로컬 개발

Application Stack이 확정되기 전까지 저장소 검증은 GitHub Actions를 통해 수행할 수 있습니다. Frontend/Backend Toolchain이 확정되면 로컬 개발 명령도 함께 추가합니다.

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
