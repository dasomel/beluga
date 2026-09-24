# 개발 가이드 (Development Guide)

[English](development.md) | 한국어

로컬 개발과 기여 절차를 다룬다. 기여 워크플로와 커밋 규약은
[CONTRIBUTING-ko.md](../CONTRIBUTING-ko.md)를 참고하고, 이 문서는 명령어 표면과
검증 레벨에 집중한다.

## 명령어 표면

```text
make up         # 전체 클러스터 기동 + GitOps 부트스트랩 (bash scripts/up.sh)
make status     # VM 및 K8s 파드 상태 확인
make test       # tests/run-all.sh — 실상태 E2E 검증 (라이브 클러스터 필요)
make test-agent # tests/13-operations-agent-security.py — 격리된 에이전트 정책/보안 검증
make lint       # shellcheck (scripts/, tests/, demo/) + helm lint
make validate   # 정적 매니페스트/YAML 검증 — 클러스터 불필요
make down       # vagrant destroy -f
make clean      # .kube/ 캐시 삭제
```

## 검증 레벨

무언가 동작한다고 보고할 때는 세 레벨을 구분한다 —
[AGENTS.md](../AGENTS.md)의 evidence-first 원칙이 이를 뒷받침한다.

1. **정적 검증** (`make lint`, `make validate`, `make test-agent`) — shellcheck, `helm lint`,
   `helm template` 렌더, YAML 문법 및 격리된 에이전트 정책/보안 검사. 매니페스트와 정책이 문법적으로
   올바름을 증명할 뿐 런타임 동작은 증명하지 않는다. CI가 매 PR 및 푸시마다 실행하는 것이 이
   레벨이다([.github/workflows/ci.yml](../.github/workflows/ci.yml),
   [.github/workflows/operations-agent-security.yml](../.github/workflows/operations-agent-security.yml)).
2. **라이브 E2E** (`make test`) — `tests/01-cluster-health.sh`부터
   `tests/10-tls-identity-boundary.sh`까지(그리고 별도 실행하는
   `tests/06-authz-defaults.sh`)가 실제 클러스터 상태(파드 헬스, Kafka/CDC 흐름,
   Iceberg 테이블, Trino 쿼리, Airflow DAG, authz 기본값, TLS/identity 경계)를
   조회한다. 기동된 클러스터가 필요해 GitHub Actions에서는 실행할 수 없다. 유일한
   예외는 `tests/11-identity-plaintext-preflight.sh`다 — `helm template`으로 렌더한
   결과만 정적으로 검사해 평문 identity 엔드포인트 노출 여부를 확인하므로 라이브
   클러스터가 필요 없고 로컬에서 클러스터 없이 통과한다.
3. **수동 게이트웨이/인증 검증** — 인증·게이트웨이 변경은 컴포넌트 직접 접근과
   문서화된 사용자 진입점(APISIX 게이트웨이 도메인 레지스트리) 둘 다로
   검증한다. 이 구분이 왜 중요한지는
   [docs/mistakes-log.md](mistakes-log.md)의 2026-08-25 `orch` 항목을 참고.

"렌더/lint 통과"와 "실제로 동작"은 다른 주장이다. 완료를 보고할 때 둘을 섞지
않는다.

## 인증서 인벤토리 게이트 (#47)

`make validate`는 양성·음성 fixture를 내장한
`scripts/ci/check-certificate-inventory.py`를 실행한다. 인벤토리 저장 명령:

```bash
python3 scripts/ci/check-certificate-inventory.py > /tmp/certificate-inventory.json
```

두 차트를 `make validate`와 같은 기본값 및 `KUBECONFIG=/dev/null`로 렌더한다.
성공 시 stdout은 Certificate의 네임스페이스, Secret, 발급자, DNS/common name,
요청 수명·갱신 시점, 소비 리소스를 담은 결정적 JSON이다. 인증서·키 바이트는
출력하지 않는다. 매번 생성하므로 별도 커밋된 스냅샷의 드리프트가 없다.

ApisixTls, Ingress TLS, Gateway의 TLS 종료 리스너, workload의 TLS Secret 참조
(일반·projected 볼륨, env/envFrom, init 컨테이너 및 내장 Pod spec)를 유일한
cert-manager Certificate에 연결한다. Issuer는 합친 렌더에 존재해야 하며,
Issuer/Secret 네임스페이스도 일치해야 한다. DNS/common name, 명시적 양수
`duration`·`renewBefore`, `renewBefore < duration` 및 명시된 호스트의 인증서
이름 일치를 검사한다. inline TLS Secret과 Opaque Secret에 숨긴 식별 가능한
인증서·키, 누락·중복·잘못된 참조는 실패한다.

내용을 확인할 수 없는 외부 볼륨/envFrom Secret과 외부 env 키도 차단한다.
`scripts/ci/certificate_endpoints.py`의 `BOOTSTRAP_KEYS`는
`scripts/gitops/01-argocd-bootstrap.sh`가 생성하는 비인증서 자격증명 키만
명시적으로 분류한다. 부트스트랩 변경 시 함께 리뷰하며 TLS 단서가 있으면
Certificate 검사를 우선한다. Gateway passthrough는 백엔드 인증서 추적을
구현하기 전까지 거부한다. 다른 컨트롤러의 TLS 참조는 추출기와 음성 fixture를
추가해야 하며, 앱 코드의 동적 인증서 조회는 이 매니페스트 게이트 범위 밖이다.

서비스 인증서는 기존 기본값인 90일 수명·30일 전 갱신을, CA는 기존 1년 수명과
수명 1/3 전 갱신을 명시한다([cert-manager 문서](https://cert-manager.io/docs/usage/certificate/)).
이는 #47의 인벤토리·배포 매니페스트 수동 편집 없는 회전에 대한 정적 증거이며,
운영 수용 기준 완료를 뜻하지 않는다. 다른 운영 프로파일, 차트 밖 오퍼레이터
생성 인증서, 실만료·갱신·재로딩, CA 신뢰 재배포, 만료 알림, 잘못되거나 만료된
인증서의 거부 동작은 #47에서 라이브 증거를 확보해야 한다.

### CI 스테이지 및 Makefile 정합성 (CI stages and Makefile parity)

모든 CI 워크플로우 검증 스텝은 문서화된 `Makefile` 타깃에 매핑되거나, 아래 표에 설명과 함께 non-make 스테이지로 명시된다. 이 정합성은 `make validate` 시 `scripts/ci/check-ci-stage-parity.py`에 의해 정적으로 검증된다.

| Workflow | Step / Stage | Makefile target | Type / Reason |
|---|---|---|---|
| `.github/workflows/ci.yml` | `shellcheck + helm lint` | `lint` | Makefile target |
| `.github/workflows/ci.yml` | `helm template render + YAML syntax validation` | `validate` | Makefile target |
| `.github/workflows/operations-agent-security.yml` | `Validate policy and fail-closed execution boundary` | `test-agent` | Makefile target |
| `.github/workflows/docs-check.yml` | `Verify bilingual pairs for root user-facing docs` | *(none)* | Non-make: 인라인 셸 스크립트로 이중 언어 마크다운 쌍 검증 |
| `.github/workflows/docs-check.yml` | `Verify ADR pairs and index` | *(none)* | Non-make: 인라인 셸 스크립트로 ADR 인덱스 및 쌍 검증 |
| `.github/workflows/sast.yml` | `Render Helm charts (every deployed values combination)` | *(none)* | Non-make: gitops가 실제로 배포하는 차트+값 조합을 스캔 전 `helm template`으로 렌더 (D21) |
| `.github/workflows/sast.yml` | `Trivy IaC misconfiguration scan — CRITICAL (blocking, rendered manifests)` | *(none)* | Non-make: aquasecurity/trivy-action으로 Trivy IaC 설정 스캔 실행 |
| `.github/workflows/sast.yml` | `Trivy IaC misconfiguration scan — HIGH (non-blocking, visibility only, rendered manifests)` | *(none)* | Non-make: aquasecurity/trivy-action으로 Trivy IaC 설정 스캔 실행 |
| `.github/workflows/sast.yml` | `Trivy secret scan (full repo)` | *(none)* | Non-make: aquasecurity/trivy-action으로 Trivy 시크릿 스캔 실행 |
| `.github/workflows/supply-chain.yml` | `Dependency update automation present` | *(none)* | Non-make: .github/dependabot.yml 파일 존재 정적 단언 |
| `.github/workflows/supply-chain.yml` | `Version single source of truth present` | *(none)* | Non-make: VERSIONS.md 파일 존재 정적 단언 |
| `.github/workflows/supply-chain.yml` | `No floating/missing image tags in Helm charts` | *(none)* | Non-make: allowlist 기반 뜬/누락 이미지 태그 인라인 셸 스캔 |
| `.github/workflows/supply-chain.yml` | `GitHub Actions are pinned to a commit SHA` | *(none)* | Non-make: 40자 git commit SHA 고정 인라인 셸 검증 |

## OpenForge 상태 발행

[.github/workflows/openforge-status.yml](../.github/workflows/openforge-status.yml)은
`main`에서 CI가 성공하거나 수동 `workflow_dispatch` 실행 시
`.openforge/status.json`(`openforge-project-status/v1` 페이로드)을
`dasomel/openforge` 포트폴리오에 발행한다. 리포지토리 시크릿
`OPENFORGE_STATUS_TOKEN`(`dasomel/openforge`에 PR을 열 수 있는 범위가 좁은
토큰)이 필요하며, 시크릿이 없으면 `.openforge/status.json`만 검증하고 스킵
메시지를 남긴 뒤 실패 없이 종료한다. `.openforge/status.json`의 `revision`과
`evidence.commit`은 CI가 실제로 검증한 SHA여야 하며, 이후 커밋이나 미검증
커밋을 넣지 않는다. 워크플로우가 이를 강제한다 — `revision`은 실행의 SHA에서
도달 가능한(해당 커밋의 조상이거나 동일한) 검증된 커밋이어야 하며, 그렇지
않으면 잡이 실패한다.

## 환경 변수

- `configs/cluster.env` — 커밋된, 비밀이 아닌 클러스터 토폴로지(서브넷, 노드 IP,
  도메인 레지스트리). 토폴로지 변경은 직접 수정한다.
- `.env.example` — `scripts/common/env.sh`가 존중하는 선택적 셸 환경변수
  오버라이드(RAM 프로파일 오버라이드, `KUBECONFIG` 경로)의 정제된 템플릿.
  여기든 리포 어디든 실제 시크릿을 추가하지 않는다.
- 이 머신은 다수의 동시 Kubernetes 세션이 돈다. `beluga` 컨텍스트를 건드리기
  전 항상 격리된 kubeconfig를 만든다 — [CLAUDE.md](../CLAUDE.md) 참고.

## 시작 전에

순서대로 읽는다: [AGENTS.md](../AGENTS.md) -> [CLAUDE.md](../CLAUDE.md) ->
[README-ko.md](../README-ko.md) -> [VERSIONS.md](../VERSIONS.md) ->
[docs/mistakes-log.md](mistakes-log.md) -> `docs/superpowers/` 아래 관련
아키텍처/설계 문서 -> 구현하려는 이슈/스펙.
