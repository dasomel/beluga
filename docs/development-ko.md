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
   `tests/14-policy-compiler-seam.sh`까지가 실제 클러스터 상태(파드 헬스, Kafka/CDC 흐름,
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

## Trivy HIGH 래칫 (#117)

SAST는 Trivy 0.70.0을 고정한다. HIGH 기준선을 로컬에서 재현하려면
`.github/workflows/sast.yml`과 동일한 Helm 렌더 명령을 실행한 뒤 렌더 디렉터리를
스캔하고 JSON 보고서를 차단 래칫에 전달한다.

```bash
set -euo pipefail
rendered="$(mktemp -d)/rendered"
mkdir -p "$rendered/beluga-platform" "$rendered/beluga-data-lite" "$rendered/beluga-data-full" "$rendered/plain"
helm template beluga-platform gitops/charts/beluga-platform --namespace platform-system --output-dir "$rendered"
helm template beluga-data gitops/charts/beluga-data --namespace storage --set openmetadata.enabled=false --set trino.workerEnabled=false --output-dir "$rendered/beluga-data-lite"
helm template beluga-data gitops/charts/beluga-data --namespace storage --set openmetadata.enabled=true --set trino.workerEnabled=true --output-dir "$rendered/beluga-data-full"
cp gitops/apps/*.yaml "$rendered/plain/"
trivy config --severity HIGH --format json --output /tmp/trivy-high.json "$rendered"
python3 scripts/ci/check-trivy-high-ratchet.py /tmp/trivy-high.json "$rendered"
```

CI에는 기존 HIGH 스캔 결과가 계속 보이며 알려진 부채는 스캔 단계에서 차단하지 않는다.
바로 다음 래칫 단계가 새 키와 stale 기준선 항목을 차단한다. YAML에는 리소스/파일별
사유가 있고 검사기는 기준선 키 digest도 고정해 YAML만 편집한 증액을 거부한다.

## 라이선스 변경 게이트 (#26)

`make validate`는 `scripts/ci/check-license-change.py`의 fixture 자체 검증을 실행한다. 비교할 기준을 명시하려면 `--base-ref <git-ref>`(git show로 읽음) 또는 `--base-file <path>`를 전달한다. base 없는 호출은 비교를 건너뛰고 이를 stdout에 표시한다. 예외는 `policies/license-policy.yaml`의 `license_change_reviews`에 정확한 컴포넌트·새 라이선스·검토자·근거로 기록한다. `make validate LICENSE_BASE_REF=<git-ref>`가 base를 검사기로 전달하며, CI `validate` 잡은 전체 history를 fetch하고 PR에서 `origin/<base 브랜치>`를 설정한다(push 실행은 base가 없어 비교를 건너뛴다). 릴리스 인벤토리는 `python3 scripts/generate_release_license_inventory.py --out <directory>`로 생성하며, `release-license-inventory.md`와 `.json`을 출력한다.

## 인증서 인벤토리 게이트 (#47)

`make validate`는 양성·음성 fixture를 내장한
`scripts/ci/check-certificate-inventory.py`를 실행한다. 인벤토리 저장 명령:

```bash
python3 scripts/ci/check-certificate-inventory.py > /tmp/certificate-inventory.json
```

두 차트를 `KUBECONFIG=/dev/null`로 RAM 프로필(32/48/64) 각각에서 OAuth 리스너를
끄고 켠 두 경우로 렌더한다. 32GB에서는 `listenerTls`, `externalListenerEnabled`,
`aclAuthorizer`를 각각 켠 변형도 렌더한다. `openmetadata.enabled`, `trino.workerEnabled`는
`scripts/gitops/01-argocd-bootstrap.sh`가 전달하는 값과 같아서, 프로필별 엔드포인트와
옵션인 Kafka OAuth 리스너도 검사된다.
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

Kafka 리스너와 cluster/client CA의 선언된 소유권을 별도 목록으로 출력한다.
`brokerCertChainAndKey`를 사용하는 TLS 리스너는 외부 제공 인증서로,
`generateCertificateAuthority: false`인 CA는 외부 제공 CA로 표시한다.
그 외 TLS 리스너 인증서는 Strimzi cluster CA 서명으로 분류한다.
OAuth issuer/JWKS/introspection/user-info URL 중 선언된 필드는 HTTPS여야 하고
URL에 자격증명을 포함하거나 호스트명 검증을 끌 수 없다.
`tlsTrustedCertificates`는 렌더된 Certificate가 관리하는 Secret의 `ca.crt`를
가리켜야 한다. 해당 Certificate와 같은 발급자가 발급한 별도 렌더된 Certificate가
URL 호스트를 덮는지도 검사하고, 두 참조를 JSON 소비 리소스에 기록한다.
이 정적 발급자·호스트 비교만으로 인증서 바이트, 실제 CA 체인, 만료 상태,
Secret 내용이나 Keycloak 연결성을 증명하지 않는다.

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
| `.github/workflows/research-evidence.yml` | `Set up Python` | *(none)* | Non-make: 검증기에 사용할 Python 3.12 선택 |
| `.github/workflows/research-evidence.yml` | `Validate research evidence` | `research-check` | Makefile target |
| `.github/workflows/operations-agent-security.yml` | `Validate policy and fail-closed execution boundary` | `test-agent` | Makefile target |
| `.github/workflows/docs-check.yml` | `Verify bilingual pairs for root user-facing docs` | *(none)* | Non-make: 인라인 셸 스크립트로 이중 언어 마크다운 쌍 검증 |
| `.github/workflows/docs-check.yml` | `Verify ADR pairs and index` | *(none)* | Non-make: 인라인 셸 스크립트로 ADR 인덱스 및 쌍 검증 |
| `.github/workflows/sast.yml` | `Render Helm charts (every deployed values combination)` | *(none)* | Non-make: gitops가 실제로 배포하는 차트+값 조합을 스캔 전 `helm template`으로 렌더 (D21) |
| `.github/workflows/sast.yml` | `Trivy IaC misconfiguration scan — CRITICAL (blocking, rendered manifests)` | *(none)* | Non-make: aquasecurity/trivy-action으로 Trivy IaC 설정 스캔 실행 |
| `.github/workflows/sast.yml` | `Trivy IaC misconfiguration scan — HIGH (non-blocking, visibility only, rendered manifests)` | *(none)* | Non-make: aquasecurity/trivy-action으로 Trivy IaC 설정 스캔 실행 |
| `.github/workflows/sast.yml` | `Trivy HIGH debt ratchet (blocking)` | *(none)* | Non-make: 렌더된 HIGH 결과를 줄어드는 #117 기준선과 비교 |
| `.github/workflows/sast.yml` | `Trivy secret scan (full repo)` | *(none)* | Non-make: aquasecurity/trivy-action으로 Trivy 시크릿 스캔 실행 |
| `.github/workflows/supply-chain.yml` | `Dependency update automation present` | *(none)* | Non-make: .github/dependabot.yml 파일 존재 정적 단언 |
| `.github/workflows/supply-chain.yml` | `Version single source of truth present` | *(none)* | Non-make: VERSIONS.md 파일 존재 정적 단언 |
| `.github/workflows/supply-chain.yml` | `No floating/missing image tags in Helm charts` | *(none)* | Non-make: allowlist 기반 뜬/누락 이미지 태그 인라인 셸 스캔 |
| `.github/workflows/supply-chain.yml` | `GitHub Actions are pinned to a commit SHA` | *(none)* | Non-make: 40자 git commit SHA 고정 인라인 셸 검증 |
| `.github/workflows/release.yml` | `Verify tagged commit is on main` | *(none)* | Non-make: 태그 커밋이 main에서 도달 가능한지 git 조상 검사 |
| `.github/workflows/release.yml` | `Verify vulnerability scan checks passed for tagged commit` | *(none)* | Non-make: 태그 커밋에서 sast.yml Trivy 체크가 성공했는지 요구(fail-closed) |
| `.github/workflows/release.yml` | `Resolve previous release tag for license gate` | *(none)* | Non-make: LICENSE_BASE_REF로 쓸 직전 태그 확인 |
| `.github/workflows/release.yml` | `shellcheck + helm lint` | `lint` | Makefile target |
| `.github/workflows/release.yml` | `helm template render + YAML syntax validation` | `validate` | Makefile target |
| `.github/workflows/release.yml` | `Build release evidence bundle` | `release-evidence` | Makefile target |
| `.github/workflows/release.yml` | `Verify release evidence bundle offline` | `release-evidence-verify` | Makefile target |
| `.github/workflows/release.yml` | `Attest build provenance` | *(none)* | Non-make: actions/attest-build-provenance로 SHA256SUMS 대상을 커밋/워크플로 실행에 증명 |
| `.github/workflows/release.yml` | `Verify provenance attestation` | *(none)* | Non-make: 게시 산출물별 gh attestation verify |
| `.github/workflows/release.yml` | `Publish GitHub release` | *(none)* | Non-make: 검증된 증적 파일로 gh release create |

### 릴리스 증적 (#100)

`vX.Y.Z` 태그를 push하면 [release.yml](../.github/workflows/release.yml)이 실행된다. `gate` 잡은 태그 커밋이
`main`에 있고, 해당 커밋의 `trivy-config`/`trivy-secrets` 체크가 성공했으며, `make lint`/`make validate`(직전 태그 대비
라이선스 게이트 포함)가 통과하지 않으면 실패하고 `release` 잡은 시작되지 않는다. `release` 잡은
`make release-evidence`로 `sbom.cdx.json`(CycloneDX 1.5: `VERSIONS.md` 컴포넌트와 렌더된 차트의 이미지 — 이미지 내부는
스캔하지 않으며 전이 패키지는 라이브 클러스터 대상 `scripts/generate-sbom.sh`가 담당), `release-license-inventory.{json,md}`,
`manifest.json`(버전, 커밋), `SHA256SUMS`를 만든다. 라이선스/SBOM 실패 시 번들이 만들어지기 전에 중단된다. 파일은 GitHub
빌드 provenance(digest -> 워크플로 실행 -> 커밋)로 증명되어 릴리스에 첨부된다. `make validate`는
`tests/test_release_evidence.py`(변조/누락/추가 파일/위조 manifest/게이트 실패 음성 테스트)와 placeholder 식별자 dry-run
빌드+검증을 실행한다.

내려받은 릴리스의 오프라인 검증(저장소 체크아웃·네트워크 불필요): `python3 scripts/release/evidence_bundle.py verify <dir>`
(체크섬, manifest/SBOM 커밋 일치, 목록 외 파일 없음). 네트워크가 있으면 `gh attestation verify <file> --repo dasomel/beluga`로
provenance까지 확인한다. 미포함: 라이브 클러스터 이미지 digest 대조 attestation, 태그 서명.

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
