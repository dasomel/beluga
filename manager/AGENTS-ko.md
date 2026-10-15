# AGENTS.md

Beluga Manager는 OpenForge agent engineering 모델을 따릅니다. 변경 분류와 완료 상태는 https://github.com/dasomel/openforge/blob/main/docs/change-management.md 와 https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md 를 따릅니다.

## 경계

- upstream OSS API, integration adapter, correlation/discovery, Beluga domain, unified API, Manager UI 사이의 경계를 유지합니다. 아키텍처가 명시적으로 허용하지 않는 한 UI에서 domain API를 우회해 upstream OSS를 직접 호출하지 않습니다.
- domain model, correlation authority, upstream adapter contract, auth/RBAC, destructive operation, public API 변경은 설계 변경입니다.
- 불확실하게 추론된 관계를 확정 사실처럼 표시하지 않습니다.
- 관련 없는 발견은 자동 수정하지 말고 별도로 보고합니다.

## 검증

- `make verify`가 canonical baseline입니다(`make lint` / `make test`로 문제를 좁힘). 필수 저장소 파일, bilingual 문서 쌍, README language switcher, local Markdown link, workflow 구조, Python syntax, verifier test를 검증하며 실제 upstream OSS/API 동작은 증명하지 않습니다. cross-service correlation과 upstream API 동작에는 integration evidence를 사용합니다.
- shared/production/destructive/release/credential/permission/external 변경은 명시적 승인이 필요합니다.

## Skills

upstream OSS adapter, discovery/correlation, Beluga domain/API, Manager UI integration 작업에는 `.agents/skills/beluga-manager-integration-contract/SKILL.md`를 로드합니다.
