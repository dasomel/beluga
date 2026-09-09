# AGENTS.md

Beluga Manager는 OpenForge의 context-efficient agent engineering 모델을 따릅니다.

수정 전에 `README.md`, `docs/architecture.md`, 개발 문서, integration/domain contract, 관련 issue/spec을 읽습니다.

- 요청한 문제를 해결하는 가장 작은 일관된 변경을 만듭니다.
- 관련 없는 발견은 자동 수정하지 말고 별도로 보고합니다.
- upstream OSS API, integration adapter, correlation/discovery, Beluga domain, unified API, Manager UI 사이의 경계를 유지합니다.
- 아키텍처가 명시적으로 허용하지 않는 한 UI에서 domain API를 우회해 upstream OSS를 직접 호출하지 않습니다.
- domain model, correlation authority, upstream adapter contract, auth/RBAC, destructive operation, public API 변경은 설계 변경으로 취급합니다.
- 불확실하게 추론된 관계를 확정 사실처럼 표시하지 않습니다.
- 결정론적 스타일은 formatter/linter가 담당하게 하고, 주석은 이유·불변조건·trust boundary·비명시적 제약을 설명합니다.
- 버그는 가능하면 reproduce -> failing test/evidence -> minimal fix -> same test passes -> relevant regression suite 순서로 처리합니다.
- unit test가 실제 경로를 증명할 수 없는 cross-service correlation과 upstream API 동작에는 integration evidence를 사용합니다.
- 완료를 주장하기 전 canonical repository baseline으로 `make verify`를 실행합니다. 문제를 좁힐 때는 `make lint`, `make test`를 각각 사용할 수 있습니다.
- 현재 foundation verifier는 필수 저장소 파일, bilingual 문서 쌍, README language switcher, local Markdown link, workflow 구조, Python syntax, verifier regression test를 검증합니다. 실제 upstream OSS/API 동작까지 증명하지는 않습니다.
- 실제 실행한 검증과 그 범위를 명시하지 않고 완료를 주장하지 않습니다.
- substantive work는 A) complete/verified, B) 다음 blocker가 격리된 meaningful verified progress, C) 추가 작업이 부당한 scope 확장·fragile patch·unsupported assumption·unacceptable risk를 요구할 때 evidence와 함께 stop 중 하나로 끝냅니다.

참조: https://github.com/dasomel/openforge/blob/main/docs/agent-engineering-ko.md
