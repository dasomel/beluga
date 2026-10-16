# dasomel/openforge#54: beluga-manager-integration-contract 검증 보고서

검증 일자: 2026-10-16  
리비전: `89b609e` (`main`), 격리된 클린 세션 워크트리.

## 범위

`.agents/skills/beluga-manager-integration-contract/SKILL.md` 스킬을 `openforge-maturity: draft`에서 `verified`로 승격하기 위한 리플레이.
`openforge#54`의 수용 기준과 이전 격차 분석(`issue-54-integration-contract-replay-2026-09-23.md`)에 따라, 현재 구현된 `upstream-adapter -> correlation/domain API -> Manager UI` 수직 경로를 검증합니다.

## 정적 워크플로우 점검

1. **어댑터 경계**: `manager/packages/domain-api/src/adapters/`에 상위 어댑터(Flink 어댑터: `flinkAdapter.ts`, `flinkClient.ts`)가 배치되어 있습니다. 상위 REST 모델은 어댑터 내부에 캡슐화되며, 장애 발생 시 상위 에러 페이로드를 직접 유출하지 않고 `unknown`/`degraded` 상태로 분류합니다.
2. **연관 로직**: `manager/packages/domain-api/src/correlation/rules.ts`가 결정론적 연관 규칙을 강제합니다:
   - 명시적 선언 라벨(`declared-label`)은 신뢰도 `0.95`를 가집니다.
   - 이름 규약 매칭(`name-convention`)은 추정으로 취급되어 신뢰도가 `0.6`(`NAME_CONVENTION_CONFIDENCE`)으로 상한 제한되며, 다중 후보 매칭 시 `0.3`(`AMBIGUOUS_CONFIDENCE`)으로 감소합니다.
3. **UI와 도메인 API 분리**: `manager/packages/web/src/api/client.ts`는 오직 Beluga 도메인 API 경로(`/api/v1/*`)만을 호출합니다. UI 뷰(`PipelinesView.tsx`, `ServicesView.tsx` 등)는 상위 Kafka, Flink, Iceberg 엔드포인트에 직접 결합되지 않고 도메인 엔티티와 `correlationLinks`를 소비합니다.
4. **읽기 우선 MVP**: 현재 도메인 API 노출면은 승인되지 않은 변경 엔드포인트 없이 읽기 우선으로 유지됩니다.

## 정상 경로 (Happy Path)

`manager/` 디렉터리에서 다음 결정론적 명령을 실행했습니다:

```bash
make -C manager verify
```
출력:
- Python compileall: OK
- Python unittests: 9개 테스트 통과 (0.414s, OK)
- Python `scripts/verify.py`: Beluga Manager 리포지토리 검증 PASS (필수 파일, 이중 언어 문서, 언어 전환기, 로컬 링크, 워크플로우 구조)

```bash
npm --prefix manager run typecheck
```
출력:
- `@beluga-manager/domain-api`: `tsc --noEmit` 통과
- `@beluga-manager/policy-compiler`: `tsc --noEmit` 통과
- `@beluga-manager/web`: `tsc --noEmit` 통과

```bash
npm --prefix manager test
```
출력:
- Vitest 실행: 80개 테스트 파일 통과 (80), 849개 테스트 통과 (849), 실패 0개.

```bash
npm --prefix manager run build
```
출력:
- `@beluga-manager/web`의 Vite 프로덕션 빌드가 `dist/`에 성공적으로 생성됨.

## 엣지 케이스 (Edge Case)

`manager/packages/domain-api/src/correlation/rules.ts`에 의도적인 계약 위반 결함을 주입:
`NAME_CONVENTION_CONFIDENCE = 1.0;`으로 설정 (D2 규칙 위반: 추정된 이름 규약 연관을 명시적 선언보다 높은 신뢰도로 표시).

실행:
```bash
npm --prefix manager test packages/domain-api/tests/correlation-rules.test.ts
```
결과:
- 테스트가 종료 코드 1로 실패.
- `AssertionError: expected 1 to be less than 0.95` (`tests/correlation-rules.test.ts:33`).
- 불확실한 연관이 사실처럼 표시되는 결함을 테스트 스위트가 정확히 방어함.

복구:
`git checkout -- manager/packages/domain-api/src/correlation/rules.ts`로 결함 변경을 롤백.
`npm --prefix manager test packages/domain-api/tests/correlation-rules.test.ts` 재실행:
- 11개 테스트 통과, 종료 코드 0.
- `git status -s` 깨끗함.

## 미검증 런타임 범위 (Unverified)

- 실제 다중 서비스 런타임 연결: 이번 오프라인 검증 중에는 실제 Kafka, Flink, Lakekeeper/Iceberg, Trino, Airflow 클러스터에 연결하지 않았습니다. Flink 어댑터는 1.20.0 기록 픽스처로 검증되었습니다.
- 도메인 API 인증/인가 메커니즘은 런타임에서 아직 검증되지 않았습니다 (현재 읽기 전용 무인증).
- 브라우저 접근성 및 실화면 상호작용: TanStack Table과 CodeMirror 컴포넌트는 SSR 및 단위/컴포넌트 테스트로 검증되었으며, 실제 브라우저 DOM, 키보드 포커스 순서, 클립보드 상호작용은 검증되지 않았습니다.

## 결정

상위 어댑터 -> 연관 로직 -> 도메인 API -> Manager UI 수직 슬라이스가 구현되었고, 결정론적 검증 및 엣지 케이스 회귀 테스트가 모두 통과하므로 `.agents/skills/beluga-manager-integration-contract/SKILL.md`를 `openforge-maturity: verified`로 승격합니다.
