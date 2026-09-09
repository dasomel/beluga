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

현재는 Frontend/Backend stack이 확정되지 않아 application build 또는 type-check 대상이 없습니다. 따라서 실제 저장소에 존재하는 기반 자산만 검증합니다.

- `make lint` — Python verifier와 regression test의 syntax를 compile-check합니다.
- `make test` — 잘못된 repository fixture가 실제 non-zero로 실패하는 경우를 포함한 verifier regression test를 실행합니다.
- `make verify` — lint + test + 필수 파일, bilingual 문서 쌍, README language switcher, local Markdown link, GitHub workflow 구조를 현재 checkout에서 검증합니다.

Application code가 추가되면 해당 stack의 native build/type/lint/test 명령을 이 repository-owned target 뒤에 연결하고 별도의 두 번째 검증 경로를 만들지 않습니다.

실제 Kafka/Flink/Iceberg/Trino/Airflow 동작, correlation 정확성, authentication 등 upstream integration은 실제 서비스에 대한 integration/runtime evidence가 별도로 필요합니다. `make verify`는 그 영역까지 증명한다고 주장하지 않습니다.

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
