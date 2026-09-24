# dasomel/openforge#54: beluga-platform-change 리플레이

리플레이 날짜: 2026-09-24
리비전: `4a992b279f5b3d1afae52352b0bafe958fca14ba` (origin/main), 격리된 신규 클론, 이전 세션
맥락 없음. `beluga-manager`는 별도 격리 클론(`origin/main` `a39ea2e62df065fbddc618ca6fe0d1021ab69c17`,
아래 "차단 요인 해소" 참고)을 sibling 디렉터리로 사용.

## 범위

`.agents/skills/beluga-platform-change/SKILL.md` (`openforge-maturity: draft`,
`openforge-version: 1`). dasomel/openforge#54의 2026-09-17 두 번째 코멘트에서 이 스킬은
"`make validate`가 beluga-manager의 `policyctl`에 의존하는데, 미설치 sibling에서
`ERR_MODULE_NOT_FOUND: tsx`로 실패하고, 이 리포지토리 간 의존성이 스킬/mistakes-log에 문서화되지
않아 에스컬레이션 경로가 없다"는 이유로 `draft`로 유지되었다.

## 0. 차단 요인 재현 및 해소 확인

리플레이 시작 전, 인용된 차단 요인을 문자 그대로 재현했다: `beluga-manager`를 완전히 새로 클론하고
(`npm install`/`npm ci` 실행 전) `beluga`의 `tests/14-policy-compiler-seam.sh`를 그대로 실행하면
다음과 같이 실패한다(`make` 종료 코드 2):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from .../beluga-manager/
```

근본 원인은 `beluga-manager`의 `package.json`/락파일/워크스페이스 설정 자체의 결함이 아니라
(`npm ci`/`npm install`은 정상적으로 `tsx`를 설치하며 해당 리포의 CI도 그린이었다), `policyctl`이
다른 리포지토리(본 리포의 test 14 등)의 도구로도 호출되는데 그 호출자들은 `beluga-manager`
자신의 의존성 설치가 먼저 이루어져야 한다는 사실을 알 방법이 없었다는 시퀀싱 문제였다.
`dasomel/beluga-manager#76`("bootstrap deps when tsx is missing from a fresh clone",
`a39ea2e62df065fbddc618ca6fe0d1021ab69c17`, 이 리플레이 세션에서 병합)이 `policyctl` npm
스크립트에 `tsx` 부재 시 `npm ci`로 자동 부트스트랩하는 로직을 추가했다. 동일한 클린 클론 재현을
그 수정 이후 다시 실행하면 자가 치유되어 `[TEST 14] ... 통과`, 종료 코드 0으로 끝난다. 이 스킬
자체의 결함이 아니라 인접 리포지토리의 의존성 문제였으므로 스킬 텍스트 수정은 필요하지 않았다.

## 1. 정적 워크플로 점검 (단계 1)

`AGENTS.md`, `VERSIONS.md`, `docs/mistakes-log.md`를 사전 지식 없이 읽고 워크플로의 각 단계를
실제 저장소와 대조했다. `AGENTS.md`의 클러스터 검증 규율(격리 kubeconfig, ArgoCD selfHeal,
FQDN, ConfigMap 재시작, 게이트웨이 이중 검증)과 `SKILL.md`의 워크플로 9단계가 서로 모순 없이
일치했다. `configs/cluster.env`, `docs/mistakes-log.md`, `tests/` 등 References 섹션의 경로도
모두 실존한다. 이름/경로 결함(예: egovframe-launcher 리플레이가 찾아낸 존재하지 않는 모듈 참조)은
발견되지 않았다.

## 2. 해피 패스 (단계 3, 4, 7) — 실제 컴포넌트 버전 승급

워크플로 3단계("VERSIONS.md를 단일 원천으로 취급하고 관련된 모든 참조를 함께 갱신")를 문자 그대로
수행했다. `curlimages/curl:8.21.0`(부트스트랩/등록 Job 공용 유틸리티, VERSIONS.md 44행)을
`8.22.0`으로 승급했다 — 사전에 `docker manifest inspect curlimages/curl:8.22.0`으로 태그 실존과
arm64(`linux/arm64/v8`) 지원을 직접 조회 확인했다(2026-08-10 mistakes-log의 "워커의 확인했다는
증거가 아니다" 교훈에 따름). `VERSIONS.md` 1곳과 매니페스트 4곳
(`gitops/charts/beluga-platform/templates/apisix-gateway.yaml` 2곳,
`gitops/charts/beluga-data/templates/{01-seaweedfs,03-strimzi-kafka,12-lakekeeper-bootstrap}.yaml`
각 1곳)을 모두 갱신했다.

```
$ make validate
Rendering beluga-platform chart... OK
Rendering beluga-data chart... OK
Validating YAML syntax (policies/, gitops/apps/)... OK
Checking VERSIONS.md against rendered manifest image tags... OK
...
[TEST 14] Beluga ↔ Beluga-Manager 정책 컴파일러 Seam 검증 통과.
```
종료 코드 0 — 이번에는 beluga-manager 쪽 policyctl 컴파일이 실제로 성공해 seam 검증까지
완주했다(0절에서 고친 결과).

`make lint`(shellcheck + helm lint)와 `make test-agent`(Operations Agent 정적 보안 단위
테스트 8건)도 별도로 실행해 모두 통과를 확인했다.

## 3. 실패/엣지 케이스 (실제, 조작 없음) — VERSIONS.md 전용 드리프트

2026-09-17 리플레이 코멘트가 "VERSIONS.md만 바꾸고 매니페스트 image 문자열을 갱신하지 않는
드리프트는 `make validate`가 잡아내지 못한다"(2026-08-10 mistakes-log와 동일한 결함 클래스)고
보고했던 바로 그 케이스를 재현했다. 위 해피 패스 상태에서 매니페스트 4곳만 `curl:8.21.0`으로
되돌리고 `VERSIONS.md`는 `8.22.0`으로 남겨 실제 드리프트를 만들었다:

```
$ python3 scripts/ci/check-version-consistency.py
[curlimages/curl] MISMATCH: VERSIONS.md=8.22.0  manifest=['8.21.0']
...
One or more images are deployed at a version that disagrees with VERSIONS.md.
$ make validate
...
make: *** [validate] Error 1
```
종료 코드 2(make) — 실제, 강제되지 않은 실패. 이 드리프트 클래스는 이제 잡힌다: 저장소에
`scripts/ci/check-version-consistency.py`가 이미 추가되어 `make validate`에 연결되어 있었다
(2026-09-17 리플레이 이후 별도 작업으로 병합된 게이트, 이 리플레이가 새로 만든 것이 아니다).
2026-09-17 코멘트가 지적한 결함은 이제 해소되어 있음을 확인했다 — 스킬 자체나 검증 스크립트를
수정할 필요가 없었다.

매니페스트 4곳을 원상 복구하고(`git checkout --`), 이어서 `VERSIONS.md`도 원상 복구했다.
`git status --short`가 비어 있고 `make validate`가 다시 종료 코드 0으로 통과함을 재확인했다
(작업 트리에 이 리플레이의 스크래치 변경이 전혀 남지 않음).

## 4. 대상 밖 — 라이브 클러스터/게이트웨이 계층

단계 2(격리 kubeconfig 생성 후 라이브 작업), 4의 라이브 절반(ArgoCD 동기화로 실반영 확인), 6
(ConfigMap 롤아웃 재시작 실측), 8(게이트웨이/인증 직접 접근 + 도메인 레지스트리 진입점 이중
실측), 그리고 `make test`(`tests/run-all.sh`, 스킬 자신의 `make help` 문구가 "라이브 클러스터
필요"라고 명시)는 이번 세션에서 실행하지 않았다. `vagrant status`로 확인한 결과 마스터/워커 VM이
전혀 생성되어 있지 않고(`not created`), `kubectl --context=vagrant-beluga`도 `192.168.77.10:6443`
연결 타임아웃으로 실패한다 — 이 환경에는 라이브 Beluga 클러스터가 없다. 상태를 조작하지 않았다.

## 결정

`openforge-maturity`는 `draft`로 유지한다. 이 스킬을 막고 있던 구체적 차단 요인(beluga-manager
policyctl/tsx 크로스 리포 의존성)은 `dasomel/beluga-manager#76`으로 해소되었고, 정적/매니페스트
계층(`make lint`, `make validate` 해피 패스 + 실제 주입 실패 케이스, `make test-agent`)은 이제
완전히 깨끗하게 재생된다. 그러나 스킬 자신의 Verification 섹션이 요구하는 4개 증거 등급 중
라이브 클러스터·게이트웨이/인증 진입점 등급은 이 세션에서 검증 불가능한 상태로 남아 있다(클러스터
VM 자체가 없음, narwhal-verification 리플레이가 같은 이유로 `draft`를 유지한 것과 동일한 사유).
이 스킬은 컴포넌트/GitOps/게이트웨이 변경을 다루도록 설계되어 있어 라이브 계층 증거 없이
`verified`로 승격하는 것은 정적 증거만으로 상위 등급을 증명하는 셈이 되어 이슈 #54 자체의 규칙을
어긴다. 스킬 텍스트 자체에서는 결함을 찾지 못했다(수정 불필요).

향후 재승격 조건: 라이브 Beluga 클러스터에 접근 가능한 세션에서 단계 2/4/6/8을 재생하고, 게이트웨이
또는 인증 관련 변경을 하나 실제로 적용해 직접 접근과 문서화된 도메인 레지스트리 진입점 둘 다
실측한 뒤 이 리플레이를 잇는 후속 보고를 남긴다.
