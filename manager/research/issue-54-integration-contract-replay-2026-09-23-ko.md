# dasomel/openforge#54: beluga-manager-integration-contract 리플레이

리플레이 날짜: 2026-09-23
리비전: `e6397c01944bfc346299b16c578ab58497fc6298` (origin/main), 격리된 워크트리, 이전 세션
맥락 없음.

## 범위

`.agents/skills/beluga-manager-integration-contract/SKILL.md` (`openforge-maturity: draft`,
`openforge-version: 1`). 승격 기준은 스킬 자체의 Verification 섹션과 beluga-manager#51의
종료 코멘트 양쪽에서 정의된다: "실제 세션에서 upstream 어댑터 -> correlation/domain API ->
Manager UI 경로 하나를 프레시 세션으로 리플레이하고, stale/불확실한 correlation 또는 upstream
실패 엣지 케이스를 하나 포함하며, 정적 점검과 실제 upstream 통합 증거를 구분한 뒤, 리플레이가
통과할 때만 maturity를 승격하라."

## 정적 워크플로 점검 (단계 1, 2, 3, 5, 7)

`AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/development.md`를 사전 지식 없이 읽은
뒤, 워크플로의 주장을 실제 트리와 대조했다:

- `packages/domain-api/src/routes/*.ts` (dataAssets, events, health, pipelines, services)는
  실제 upstream 클라이언트가 아니라 `packages/domain-api/src/stub-data/*`에서 서빙된다 —
  이는 저장소가 "아키텍처와 계약 기반(foundation)"이라는 아키텍처 문서 자체의 서술과 일치한다.
- `packages/web/src/api/client.ts`는 Domain API에 대한 범용 `apiGet(baseUrl, path)`만 노출한다;
  `grep -rniE "kafka|flink|iceberg|trino|airflow" packages/web/src`는 라벨/목업 표시 문자열
  (`mockData.ts`, `translations.ts`, 뷰 텍스트)만 찾아내며, upstream을 직접 호출하는 클라이언트는
  전혀 없다. 5단계("프론트엔드는 Beluga 도메인 API를 사용하며 이를 우회하지 않는다")는 관례가
  아니라 실제로 성립한다.
- `docs/IMPLEMENTATION-STATUS.md:20,25,31`은 명시적으로 "백엔드/API 라우트나 통합 어댑터는
  아직 구현되지 않았다"와 "Kafka/Flink/Iceberg/Trino/Airflow 통합 및 서비스 간 도메인 뷰는
  계획 단계로 남아 있다"고 서술한다. `packages/domain-api/src` 아래에는 `adapter`, `correlation`,
  `discovery` 모듈이 존재하지 않는다 (있는 것은 `decision`, `lib`, `routes`, `schema`,
  `stub-data`뿐).

스킬 텍스트 자체에서 이름/경로 결함은 발견되지 않았다 (존재하지 않는 모듈을 참조하는 단계를
발견했던 egovframe-launcher 리플레이와 대조적이다) — 워크플로의 주장은 실제 저장소와 일치한다.

## 결정론적 검증 (해피 패스)

```
$ make verify
python3 -m compileall -q scripts tests
python3 -m unittest discover -s tests -p 'test_*.py'
.......
Ran 7 tests in 0.081s
OK
python3 scripts/verify.py
Beluga Manager repository verification: PASS
```
종료 코드 0.

## 엣지/실패 케이스 (실제 상황, 조작되지 않음)

`docs/architecture.md`에 끊어진 로컬 Markdown 링크를 추가했다 — 링크 텍스트는
"broken-link-injected-for-replay", 대상은 존재하지 않는 파일 `does-not-exist-issue54.md` —
그리고 동일한 명령을 다시 실행했다:

```
$ make verify
...
python3 scripts/verify.py
ERROR: Broken local link: docs/architecture.md -> ./does-not-exist-issue54.md
make: *** [verify] Error 1
```
종료 코드 2 (실제, 강제되지 않은 실패). 파일을 원복했고 `make verify`는 다시 PASS로
돌아왔다 (`git status --short`가 이후 깨끗함을 확인, 워크트리의 다른 부분은 손대지 않음).

## 저장소 소유 계약 게이트

```
$ python3 <openforge>/templates/scripts/audit-agent-skills.py . --strict
skills: 1  findings: 0
SKILL .agents/skills/beluga-manager-integration-contract/SKILL.md: name=beluga-manager-integration-contract scope=project maturity=draft lines=68
```

## 왜 승격 기준을 충족하지 못하는가

위의 해피 패스와 엣지 케이스는 실제이며 둘 다 통과했고, 이는 스킬 자체의 "Verification"
섹션이 운영적으로 요구하는 전부다 (`make verify`). 그러나 beluga-manager#51의 종료 코멘트는
*이 스킬*에 대해 더 엄격한, 저장소 고유의 기준을 설정했다: 실제 upstream 어댑터 ->
correlation/domain API -> Manager UI 경로와 stale/불확실한 correlation 또는 upstream 실패
엣지 케이스. 이 시나리오는 오늘 리플레이할 수 없다 — 환경에 라이브 서비스가 없어서가
아니라 (narwhal-verification의 라이브 클러스터 상황과는 다름), 이 코드베이스에는 아직
upstream 어댑터, correlation 인덱스, 또는 라이브 domain-API 경로가 전혀 존재하지 않기
때문이다 (`docs/IMPLEMENTATION-STATUS.md`, 위에서 확인). stale-correlation이나 upstream
실패 결함을 주입할 대상 자체가 없다.

이것은 스킬 지침의 결함이 아니다 — 스킬 자체의 Verification 섹션은 이미 "실제
Kafka/Flink/Iceberg/Trino/Airflow 동작, correlation 정확성, 인증, 또는 기타 upstream
서비스 경로를 증명한다고 주장하지 않는다"고 명시하고 있다. 이는 `openforge-maturity:
verified`가 주장하게 될 내용과 저장소가 현재 실제로 보여줄 수 있는 것 사이의 실질적이고
구조적인 간극이다.

## 결정

`openforge-maturity`는 `draft`로 유지한다. 이 스킬의 결정론적/정적 계층은 이제 공식적으로
리플레이되고 증거화되었다 (본 문서); 도메인 통합 계층은 `packages/domain-api`에 리플레이할
실제 upstream 어댑터가 생기기 전까지는 정당하게 게이트된 상태로 남는다. `docs/architecture.md`의
"First Vertical Slice"를 위한 첫 어댑터(또는 `packages/domain-api` -> 라이브 서비스 경로)가
도입되면, 2-4/6단계로 범위를 좁혀 이 리플레이를 다시 실행하라.
