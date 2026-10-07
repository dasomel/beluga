# 보안 검증 게이트 (현황 인벤토리, 공백, 임계값)

[English](security-gates.md) | 한국어

[Issue #31](https://github.com/dasomel/beluga/issues/31)(보안 개발 및 검증 게이트)의 기준선과 공백 분석입니다.
**문서 전용입니다. 이 문서는 게이트, 워크플로, 임계값, 정책 파일을 변경하지 않습니다.** 저장소에 대한 모든 서술은
이 문서를 작성한 커밋에서 직접 읽은 `파일:줄` 근거를 갖습니다. **Proposed** 또는 **Owner decision**으로 표시한 항목은
저장소에 근거가 없으며 정책이 되기 전에 오너 승인이 필요합니다.

이미 내려진 오너 결정(issue #31): **기존 CI 게이트의 HIGH/CRITICAL 차단을 기준선으로 사용**합니다. 따라서 이 문서는 해당 게이트가
오늘 실제로 무엇을 차단하는지를 기록하며, 그 범위는 이슈 문구보다 두 군데에서 좁습니다(4절).

관련 문서: [`docs/security-control-evidence-map.md`](security-control-evidence-map-ko.md)(통제 -> 검증기 매핑, Issue #50)는 통제 단위 뷰이고,
이 문서는 게이트 단위 뷰이자 issue #31 수용 기준 분석입니다. 프로파일별 보안 구성 검사는 환경 프로파일 문서(PR #219, Issue #24)에서 설계합니다.

---

## 1. 현재 존재하는 게이트

"차단"은 실패 시 CI 잡 또는 릴리스 게이트가 실패함을 뜻합니다. "머지 필수"는 별개입니다(3절). 차단형 CI 잡도 GitHub이
required로 지정해야 머지를 막습니다.

| # | 게이트 | 검사 내용 | 도구 | 차단 | 정의 위치 |
|---|---|---|---|---|---|
| G1 | IaC 오설정, CRITICAL | 배포되는 모든 values 조합의 렌더된 Helm 매니페스트와 `gitops/apps/*.yaml` | Trivy `v0.70.0`(`trivy-action` 0.36.0, SHA 고정), `scan-type: config`, `exit-code: 1` | **예** | [`sast.yml:69-118`](../.github/workflows/sast.yml#L69-L118) |
| G2 | IaC 오설정, HIGH(리포트) | HIGH 수준 동일 스캔, JSON 출력 | Trivy, `exit-code: 0` | 아니오(가시성) | [`sast.yml:120-129`](../.github/workflows/sast.yml#L120-L129) |
| G3 | HIGH 부채 래칫 | baseline에 없는 HIGH는 실패, 더 이상 없는 baseline 항목도 실패(stale), baseline은 코드 내 digest로 동결. 현재 baseline: 9건, 모두 `KSV-0014` | `scripts/ci/check-trivy-high-ratchet.py` | **예**(신규 또는 stale) | [`sast.yml:131-134`](../.github/workflows/sast.yml#L131-L134), [`check-trivy-high-ratchet.py:23`](../scripts/ci/check-trivy-high-ratchet.py#L23), [`trivy-high-baseline.yaml`](../scripts/ci/trivy-high-baseline.yaml) |
| G4 | 시크릿 스캔, HIGH 및 CRITICAL | 저장소 전체 파일시스템 | Trivy `scanners: secret`, `severity: HIGH,CRITICAL`, `exit-code: 1` | **예** | [`sast.yml:136-154`](../.github/workflows/sast.yml#L136-L154) |
| G5 | 셸·차트 린트 | `scripts/ tests/ demo/`의 shellcheck; 두 차트의 `helm lint` | shellcheck, helm | 예 | [`Makefile:41-48`](../Makefile#L41-L48), [`ci.yml:18-35`](../.github/workflows/ci.yml#L18-L35) |
| G6 | 렌더된 Kubernetes 보안 baseline | runAsNonRoot, 권한 상승, readOnlyRootFilesystem, seccomp, capability drop, privileged/host* 및 hostPath, 노출 인벤토리 | `check-k8s-security-baseline.py`(래칫) | 예 | [`Makefile:85-86`](../Makefile#L85-L86), [`check-k8s-security-baseline.py:2-22`](../scripts/ci/check-k8s-security-baseline.py#L2-L22) |
| G7 | NetworkPolicy 커버리지 | baseline에 없는 모든 워크로드 네임스페이스는 진짜 default-deny ingress 정책 필요(6개 네임스페이스 baseline); 커버된 네임스페이스는 네임스페이스 전체 default-deny egress도 반드시 보유(baseline 불가 하드 요건); ingress 규칙이 있는 가짜 "default-deny"와 allow-all-egress 보조 정책은 항상 실패 | `check-networkpolicy-coverage.py` | 예(래칫) | [`Makefile:83-84`](../Makefile#L83-L84), [`check-networkpolicy-coverage.py:2-47`](../scripts/ci/check-networkpolicy-coverage.py#L2-L47), [`networkpolicy-baseline.yaml`](../scripts/ci/networkpolicy-baseline.yaml) |
| G8 | TLS 인증서 인벤토리 | 렌더된 `Certificate`의 유효기간, 갱신 창, DNS 이름 | `check-certificate-inventory.py` | 예 | [`Makefile:81-82`](../Makefile#L81-L82), [`check-certificate-inventory.py:2-6`](../scripts/ci/check-certificate-inventory.py#L2-L6) |
| G9 | Kafka 리스너 TLS/인증 | 렌더된 Strimzi 리스너; 알려진 평문/익명 리스너 2개 동결(issue #6) | `check-kafka-listener-security.py`(래칫) | 예(신규 부채) | [`Makefile:104`](../Makefile#L104), [`check-kafka-listener-security.py:15-25`](../scripts/ci/check-kafka-listener-security.py#L15-L25) |
| G10 | 게이트웨이 속도 제한·요청 크기 | 외부 접근 가능한 모든 APISIX 라우트에 속도 제한 플러그인(알려진 위반은 baseline); 각 APISIX ConfigMap은 유한한 전역 요청 본문 한도 설정(baseline 없음) | `check-apisix-route-rate-limit.py`, `check-apisix-request-size-limit.py` | 예(래칫) | [`Makefile:105-106`](../Makefile#L105-L106) |
| G11 | Identity 부트스트랩 위생 | baseline에 없으면 렌더된 워크로드에 ROPC(`grant_type=password`)나 인라인 시크릿 보간 없음 | `check-identity-bootstrap-ropc.py` | 예(래칫) | [`Makefile:107`](../Makefile#L107), [`check-identity-bootstrap-ropc.py:2-53`](../scripts/ci/check-identity-bootstrap-ropc.py#L2-L53) |
| G12 | 평문 identity 엔드포인트 | 렌더된 템플릿에 비-TLS Keycloak/LDAP URL 없음 | `tests/11-identity-plaintext-preflight.sh` | 예 | [`Makefile:69-70`](../Makefile#L69-L70) |
| G13 | 인가 렌더 계약 | Lakekeeper/OpenFGA on/off 렌더 계약; Flink signer token exchange 렌더 계약 | `tests/15-lakekeeper-authz-render.sh`, `tests/17-flink-signer-token-exchange-render.sh` | 예 | [`Makefile:51-54`](../Makefile#L51-L54) |
| G14 | 정책 컴파일러 seam | beluga-manager가 `policies/`를 재컴파일한 결과가 커밋된 Rego/SQL/Keycloak 산출물과 동일 | `tests/14-policy-compiler-seam.sh` | 예 | [`Makefile:91-92`](../Makefile#L91-L92), [`ci.yml:59-82`](../.github/workflows/ci.yml#L59-L82) |
| G15 | 고정(pin) 및 아티팩트 무결성 | 불변 이미지 태그; 차트/이미지 pin 래칫(태그만 고정된 이미지 19개 baseline); 업스트림 아티팩트 SHA-256 pin; 해시 고정 CI 의존성 | `check-image-tag-immutability.py`, `check-pin-enforcement.py`, `check-upstream-artifacts.py`, `check-dependency-integrity.py` | 예 | [`Makefile:71-78`](../Makefile#L71-L78), [`:102`](../Makefile#L102), [`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40) |
| G16 | 공급망 워크플로 | `.github/dependabot.yml` 존재; `VERSIONS.md` 존재; 차트에 `:latest`/`nightly-*`/태그 없음 이미지 없음(fail-closed allowlist); 모든 워크플로 `uses:`가 40자 hex SHA로 고정 | 워크플로 내 셸 | 예 | [`supply-chain.yml:34-112`](../.github/workflows/supply-chain.yml#L34-L112), [`image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt) |
| G17 | 의존성 업데이트 자동화 | `github-actions` 생태계만, 주간, 14일 쿨다운(보안 패치는 수동 처리) | Dependabot | 해당 없음(PR 생성기) | [`dependabot.yml:7-17`](../.github/dependabot.yml#L7-L17) |
| G18 | 라이선스·NOTICE 준수 | `VERSIONS.md` 라이선스를 승인 목록과 대조; 라이선스 변경은 기록된 리뷰 필요; NOTICE 일관성 | `check-license-policy.py`, `check-license-change.py`, `check-notice-consistency.py` | 예 | [`Makefile:63-68`](../Makefile#L63-L68), [`:79-80`](../Makefile#L79-L80), [`policies/license-policy.yaml:12`](../policies/license-policy.yaml#L12) |
| G19 | 외부 엔드포인트 래칫 | 설치/배포/런타임 코드가 접근하는 신규 외부 호스트 | `check-external-endpoints.py` | 예(래칫; 인벤토리이지 승인 아님) | [`Makefile:114-116`](../Makefile#L114-L116), [`check-external-endpoints.py:2-35`](../scripts/ci/check-external-endpoints.py#L2-L35) |
| G20 | 백업·데이터 표준 | CNPG 백업 설정(secretKeyRef, WAL 아카이빙, 보존); 스키마 표준 | `check-postgres-backup-config.py`, `check-data-standards.py` | 예 | [`Makefile:65-66`](../Makefile#L65-L66), [`:110-111`](../Makefile#L110-L111) |
| G21 | Operations agent 경계 | 정책 JSON, fail-closed 실행 경계, plan 스모크 테스트 | `make test-agent`(경로 필터 워크플로) | 예(나열된 경로 변경 시에만) | [`operations-agent-security.yml:1-56`](../.github/workflows/operations-agent-security.yml#L1-L56) |
| G22 | 통제-증거 맵 일관성 | Issue #50 맵이 실제 존재하는 검증기/타깃을 가리킴 | `check-control-evidence-map.py` | 예 | [`Makefile:117-119`](../Makefile#L117-L119) |
| G23 | 머지 전 독립 리뷰 | 비작성자 리뷰어가 정확한 head SHA에 게시한 `independent-review` 커밋 상태 | `scripts/ci/mark-review-pass.py` | 절차적(쓰기 권한자는 누구나 게시 가능; 신원 증명 아님) | [`AGENTS.md:32-36`](../AGENTS.md#L32-L36), [`mark-review-pass.py:2-13`](../scripts/ci/mark-review-pass.py#L2-L13) |
| G24 | 릴리스 게이트 | 태그 커밋이 `main` 위에 있음; 해당 정확한 커밋의 최신 `sast.yml` push 실행이 성공하고 `trivy-config`, `trivy-secrets` 잡이 모두 `success`; `make lint`; `make validate`(이전 태그 대비 라이선스 게이트); 이후 증거 번들 빌드, 오프라인 검증, provenance attestation | `release.yml`, `verify_required_checks.py` | **예**(release 잡이 `needs: gate`) | [`release.yml:54-59`](../.github/workflows/release.yml#L54-L59), [`:61-77`](../.github/workflows/release.yml#L61-L77), [`:113-120`](../.github/workflows/release.yml#L113-L120), [`:122-181`](../.github/workflows/release.yml#L122-L181), [`verify_required_checks.py:17-18`](../scripts/release/verify_required_checks.py#L17-L18) |

GitHub 라이브 설정(2026-10-07에 `gh api`로 조회, 저장소에 저장되지 않으므로 `파일:줄` 근거 없음, 재검증 필요): `main` 브랜치 보호는
status check를 정확히 하나, `independent-review`만 요구; `enforce_admins`는 false; 필수 PR 리뷰 없음; 시크릿 스캐닝과 푸시 보호 활성;
Dependabot 보안 업데이트는 **비활성**; 저장소 ruleset 없음.

---

## 2. 이슈 요구사항 매핑

| Issue #31 요구사항 | 충족 수단 | 상태 |
|---|---|---|
| 정적 분석 | G5(셸/차트 린트), G6, G1-G3(Trivy IaC). `sast.yml`은 IaC와 시크릿 범위이며 저장소에 애플리케이션 소스가 없다고 설명([`sast.yml:1-9`](../.github/workflows/sast.yml#L1-L9))하지만 실행 가능한 Python이 있음: [`scripts/agent/operations_agent.py`](../scripts/agent/operations_agent.py)(operations agent)와 배포되는 Airflow DAG [`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py). 현재 커버리지: 에이전트에 한해 `py_compile`과 정책/경계 테스트([`operations-agent-security.yml:42-44`](../.github/workflows/operations-agent-security.yml#L42-L44)); DAG는 이미지 태그 불변성 검사([`check-image-tag-immutability.py:217-219`](../scripts/ci/check-image-tag-immutability.py#L217-L219))와 Trivy 시크릿 스캔뿐. 둘 다 Python 정적 분석기(bandit, ruff, semgrep 등)는 실행되지 않음 | IaC/셸은 충족; Python 코드에 대한 코드 수준 SAST는 **공백** |
| 의존성 검사 | G15, G16, G17, G18. 고정, 해시, 라이선스를 검사함. **어떤 의존성에 대해서도 알려진 취약점(CVE) 스캔 없음** | **공백**(고정은 있음, 취약점은 없음) |
| 컨테이너/이미지 검사 | 불변 태그와 digest 래칫(G15). **CI에 이미지 CVE 스캔 없음**: `sast.yml`이 이미지 스캔은 해당 없음이라고 명시([`sast.yml:1-9`](../.github/workflows/sast.yml#L1-L9)); `scripts/generate-sbom.sh`는 라이브 클러스터를 수동 스캔([`generate-sbom.sh:1-13`](../scripts/generate-sbom.sh#L1-L13), [`RELEASING.md:35-37`](../RELEASING.md#L35-L37)) | **공백** |
| 매니페스트/구성 검사 | G1-G3, G6, G7, G8, G9, G10, G11, G12 | 충족(래칫이 알려진 부채를 동결) |
| 인증/인가 회귀 테스트 | 정적: G11, G12, G13, G14. 라이브 클러스터 테스트 `tests/06`, `07`, `09`, `10`은 있으나 클러스터가 필요한 `make test`에서만 실행([`Makefile:32-33`](../Makefile#L32-L33), [`tests/run-all.sh:19-23`](../tests/run-all.sh#L19-L23)); CI나 릴리스 게이트에서는 실행 안 됨([`docs/security-control-evidence-map.md:26`](security-control-evidence-map-ko.md#L26) C04 행: tests 08, 16은 `make test`에서만, 라이브 전용) | 정적은 충족; **라이브는 릴리스 검증에 없음** |
| TLS 회귀 테스트 | G8, G9, G12(정적); `tests/10-tls-identity-boundary.sh`는 라이브 전용 | 부분 |
| 네트워크 회귀 테스트 | G7, G10(정적); `tests/08`, `tests/16`은 라이브 전용 | 부분 |
| 시크릿 취급 회귀 테스트 | G4, G11, G16(SHA 고정 액션); 로테이션/외부 시크릿 저장소 검증기 없음([`security-control-evidence-map.md:29`](security-control-evidence-map-ko.md#L29)) | 부분 |
| 데이터 접근 회귀 테스트 | G13, G14(정적); `tests/07`, `tests/09`는 라이브 전용 | 부분 |
| 심각도 임계값 | CRITICAL 차단(G1, G4); HIGH는 동결 baseline 대비 신규/stale(G3) 또는 시크릿 스캔(G4)에서만 차단; MEDIUM/LOW 미스캔 | 워크플로 설정에 암묵적으로 존재, 이 문서 전까지 **정책으로 문서화되지 않음** |
| 조치 목표 | 저장소에 없음. 외부 제보자에 대한 "5영업일 내 접수 확인"만 존재([`SECURITY.md:31-35`](../SECURITY.md#L31-L35)) | **공백** |
| 예외/만료 처리 | 예외는 baseline과 ignore 파일로 존재(5절); 만료를 가진 것은 없고, 승인자(`approved_by`)는 `license_change_reviews`만 요구([`check-license-change.py:63`](../scripts/ci/check-license-change.py#L63)); 나머지는 사유(및 대개 issue)만 기록하고 승인자 없음 | 만료는 전 저장소 **공백**; 승인자는 라이선스 변경을 제외한 모든 저장소가 공백 |
| 릴리스 단위 보안 검증 증거 | 증거 번들에는 SBOM, 라이선스 인벤토리, 자산 인벤토리, NOTICE/LICENSE, manifest, 체크섬, 빌드 provenance가 있음([`evidence_bundle.py:35`](../scripts/release/evidence_bundle.py#L35), [`:87-89`](../scripts/release/evidence_bundle.py#L87-L89), [`release.yml:161-181`](../.github/workflows/release.yml#L161-L181)). **보안 스캔 결과는 없고** `sast.yml`은 아티팩트를 업로드하지 않음(`.github` 아래 `upload-artifact` 없음) | **공백** |
| 필수 게이트 실패 시 승인된 예외 없이는 릴리스 차단 | G24가 `sast.yml` 성공 + lint + validate로 차단. 승인된 예외 경로는 PR에서 리뷰되는 baseline/ignore 수정뿐(릴리스 시점 예외 검사 없음) | 부분 |
| 개발 및 production-style 프로파일의 보안 구성 검사 | G6-G12는 기본 렌더와 일부 게이트에서 48/64GB 조합에 실행([`networkpolicy coverage COMBOS`](../scripts/ci/check-networkpolicy-coverage.py#L526-L529), [`sast.yml:78-93`](../.github/workflows/sast.yml#L78-L93)). 프로파일 개념이 없음; PR #219 참조 | 프로파일별로는 **공백** |

용어 주의: `release.yml`은 SAST 실행을 "vulnerability scans"라고 부릅니다([`release.yml:1-3`](../.github/workflows/release.yml#L1-L3)).
실제로는 IaC 오설정 및 시크릿 스캔이며 CVE 스캔이 아닙니다. "릴리스가 취약점 스캔으로 차단된다"를 이미지/의존성 CVE가
포함된다는 뜻으로 읽어서는 안 됩니다.

---

## 3. 현재 필수인 것

| 수준 | 집합 | 의무의 근거 |
|---|---|---|
| 릴리스 차단(강제) | G24 자체: `main` 계보, 정확한 커밋에 대한 `sast.yml` 잡 `trivy-config` + `trivy-secrets` 성공, `make lint`, `make validate` | [`release.yml:54-120`](../.github/workflows/release.yml#L54-L120) |
| 머지 차단(강제, GitHub 설정) | `independent-review`만(라이브 설정; 절차적, 쓰기 권한자는 누구나 게시 가능) | 위 라이브 `gh api` 결과; [`AGENTS.md:35`](../AGENTS.md#L35)는 check를 required로 지정하는 것이 오너 몫이라고 명시 |
| CI에서 차단하나 머지 필수 아님 | `ci.yml` 잡, `sast.yml`, `supply-chain.yml`, `docs-check.yml`, `operations-agent-security.yml`은 PR 체크를 실패시키지만 required 목록에는 없음 | 라이브 설정 |
| 릴리스에서 강제되지 않음 | `supply-chain.yml`(SHA 고정 액션, Dependabot/`VERSIONS.md` 존재, 워크플로 수준 부동 태그 grep), `docs-check.yml`, `operations-agent-security.yml`, `ci.yml` 실행 자체. 릴리스 게이트가 확인하는 것은 `main` 상의 커밋, 정확한 커밋의 `sast.yml` 잡 `trivy-config`/`trivy-secrets`, 그리고 `make lint`/`make validate` 재실행뿐 | [`release.yml:54-120`](../.github/workflows/release.yml#L54-L120), [`verify_required_checks.py:17-18`](../scripts/release/verify_required_checks.py#L17-L18). `make validate`를 재실행하므로 Makefile에 연결된 게이트(G5-G15, G18-G20, G22)는 릴리스에서 강제되지만, G16의 액션 SHA 고정, G17, G21, G23은 아님 |

관찰: `ci.yml`과 `release.yml`은 정책 컴파일러 seam용 beluga-manager를 서로 다른 고정 SHA로 체크아웃합니다
([`ci.yml:71`](../.github/workflows/ci.yml#L71)의 `a63db0b...` 대 [`release.yml:100`](../.github/workflows/release.yml#L100)의
`406663a...`). PR이 통과한 seam 게이트와 릴리스가 재실행하는 게이트가 다릅니다.

---

## 4. 수용 기준 대비 공백

| 수용 기준 | 상태 | 이유 |
|---|---|---|
| 필수 보안 검사가 정의되고 자동화됨 | **부분** | 자동화: 예(1절). 필수로서의 정의: G24와 단일 required status를 통해 암묵적으로만; 이 문서가 첫 서면 인벤토리. CI 잡의 머지 시점 강제는 저장소에 없는 GitHub 설정에 의존 |
| Critical/high 발견에 명시적 릴리스 차단 정책 또는 승인된 예외가 있음 | **부분** | CRITICAL(IaC, 시크릿)과 HIGH(시크릿; IaC는 래칫)가 차단. 예외는 기록됨(CRITICAL 경로 한정 ignore 1건, HIGH baseline 9건)이나 만료와 승인자 필드 없음(라이선스 변경 저장소만 예외로 `approved_by` 요구). **CVE 스캔이 없어 차단할 CVE 발견 자체가 존재하지 않음** |
| 보안 회귀 테스트가 릴리스 검증에서 실행됨 | **부분** | 정적 렌더 기반 회귀 게이트는 릴리스 게이트의 `make validate`로 실행. 라이브 클러스터 보안 테스트(06-10, 16)는 아님 |
| 보안 결과가 릴리스 증거로 보존됨 | **미충족** | 번들에 스캔 결과 없음; CI는 아무것도 업로드하지 않음; Trivy HIGH JSON은 러너의 임시 파일([`sast.yml:120-129`](../.github/workflows/sast.yml#L120-L129)) |
| 예외 상태와 만료가 감사 가능함 | **미충족** | 어떤 예외 파일에도 만료 필드 없음; 중앙 등록부 없음; 증거 맵 C18 "Time-bounded exceptions register"는 `gap`([`security-control-evidence-map.md:40`](security-control-evidence-map-ko.md#L40)) |

추가 발견: Dependabot 보안 업데이트가 비활성이고 Dependabot은 `github-actions`만 감시([`dependabot.yml:7`](../.github/dependabot.yml#L7))하므로
`VERSIONS.md`의 차트/이미지 버전에 대한 자동 의존성 취약점 신호가 없습니다. SAST는 cancel-in-progress
([`sast.yml:17-19`](../.github/workflows/sast.yml#L17-L19))라 재실행 전까지 릴리스 게이트가 실패할 수 있습니다
([`RELEASING.md:31-34`](../RELEASING.md#L31-L34)).

---

## 5. 현존하는 예외 및 만료 메커니즘

| 예외 저장소 | 범위 | 기록 필드 | 만료/승인자 | 증가 방지 |
|---|---|---|---|---|
| [`.trivyignore.yaml:6-20`](../.trivyignore.yaml#L6-L20) | `KSV-0041`, `beluga-platform/templates/apisix-gateway.yaml`만 | id, path, statement | 없음 | 경로 한정; 그 외는 수동 리뷰 |
| [`scripts/ci/trivy-high-baseline.yaml`](../scripts/ci/trivy-high-baseline.yaml) | `KSV-0014` HIGH 9건 | rule, chart, kind, namespace, name, container, reason | 없음 | 코드 내 동결 digest; 신규/stale 항목은 실패([`check-trivy-high-ratchet.py:23`](../scripts/ci/check-trivy-high-ratchet.py#L23)) |
| [`networkpolicy-baseline.yaml`](../scripts/ci/networkpolicy-baseline.yaml) | default-deny 없는 6개 네임스페이스 | namespace, reason, issue | 없음 | stale 항목 실패; 신규 미커버 네임스페이스 실패 |
| [`check-kafka-listener-security.py:16-25`](../scripts/ci/check-kafka-listener-security.py#L16-L25) | 리스너 2개, issue #6 | attributes, reason, issue | 없음 | 정확한 속성 동결 |
| [`identity-bootstrap-baseline.yaml`](../scripts/ci/identity-bootstrap-baseline.yaml) | ROPC/인라인 시크릿 발견 | id, reason, issue | 없음 | 스키마 오류 실패 |
| [`image-digest-baseline.yaml`](../scripts/ci/image-digest-baseline.yaml) | 태그만 고정된 이미지 | repository, reason(#103) | 없음 | 목록은 줄어들기만 가능; `BASELINE_CEILING = 19`([`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40)) |
| [`.github/image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt) | 부동 태그 예외 | 전체 이미지 참조 | 없음 | 항목을 `registry/path:tag`로 검증; fail-closed([`supply-chain.yml:63-97`](../.github/workflows/supply-chain.yml#L63-L97)) |
| [`check-upstream-artifacts.py:28`](../scripts/ci/check-upstream-artifacts.py#L28) | 미검증 설치 스크립트 allowlist | 항목, reason | 없음 | 리뷰에서 증가가 보임 |
| [`policies/license-policy.yaml:12`](../policies/license-policy.yaml#L12) | `license_change_reviews`(현재 비어 있음) | 컴포넌트, 신규 라이선스, 지명된 승인, 근거 | 승인자 필수(`approved_by`, [`check-license-change.py:63`](../scripts/ci/check-license-change.py#L63)); 만료 없음 | 정확 일치 필요 |
| [`external-endpoints-baseline.yaml`](../scripts/ci/external-endpoints-baseline.yaml) | 외부 호스트 인벤토리 | host, phase | 없음; 인벤토리는 승인이 아님 | 래칫 |

`policies/`에는 취약점 예외 메커니즘이 없고(접근 및 라이선스 정책만 있음) 어디에도 만료 강제가 없습니다. 오늘 "승인된 예외"란
위 파일 중 하나를 수정하는, head SHA에 `independent-review` 상태가 달린 리뷰된 PR을 뜻합니다.

---

## 6. 임계값과 조치 목표

### 6.1 기준선 (오너 채택: 기존 high/critical 차단)

| 심각도 | 현재 릴리스/CI 동작 | 기준선 서술 |
|---|---|---|
| CRITICAL | 차단(IaC 설정 G1; 시크릿 G4) | 예외 없는 CRITICAL 발견이 있으면 릴리스 불가 |
| HIGH | 시크릿은 차단(G4); IaC는 동결 baseline에 없는 모든 발견을 차단(G3) | 신규 HIGH 발견이 있으면 릴리스 불가; 기존 HIGH 부채는 baseline 항목으로만 |
| MEDIUM / LOW | 스캔 안 함(Trivy는 CRITICAL과 HIGH만 실행) | 정책 없음 |

코드에서 따라오는 범위 한계: 이 임계값은 IaC 오설정과 시크릿에 적용됩니다. 스캔하지 않는 이미지/의존성 취약점에는 적용되지 않습니다.

### 6.2 Proposed (오너 승인 필요; 이 수치들은 저장소에 근거 없음)

| 항목 | 제안 | 근거 |
|---|---|---|
| 조치 목표, CRITICAL | 탐지 후 7일 이내 수정 또는 승인된 예외 | 일반 관행을 따름; 저장소에는 목표가 없음. **Owner decision** |
| 조치 목표, HIGH | 30일 이내 수정 또는 승인된 예외 | **Owner decision** |
| 조치 목표, MEDIUM | 90일, 비차단 | **Owner decision** |
| 예외 만료 | 만료 필수, CRITICAL 최대 30일, HIGH 최대 90일, 갱신은 새 지명 승인 필요 | "만료 감사 가능" 공백 해소 |
| 예외 등록부 | 버전 관리되는 단일 파일(예: `policies/security-exceptions.yaml`)에 id, scope, severity, reason, issue, approver, approved-on, expires-on; 검사기가 만료/불완전 항목을 실패시키고 `make validate`와 릴리스 게이트에서 실행; 기존 baseline은 이 등록부에 연결하거나 참조 | 설계 전용; 여기서는 스크립트를 추가하지 않음 |
| 이미지/의존성 CVE 게이트 | 렌더된 차트 이미지에 대한 HIGH/CRITICAL CVE 스캔(SBOM 단계가 이미 도출하는 렌더 이미지 목록에 Trivy 이미지 스캔)을 릴리스 게이트 잡으로 추가하고 결과를 증거 번들에 기록 | 가장 큰 기능적 공백 해소; CI 네트워크 접근과 신규 취약점 유예기간에 대한 오너 결정 필요 |
| 증거 | Trivy JSON 리포트(G2/G3 입력, G4, 신규 CVE 스캔)와 예외 등록부를 `SHA256SUMS`가 포함하는 번들 파일에 추가 | 결과 보존과 attestation 확보 |
| 라이브 보안 테스트 | `tests/06`-`10`, `16`을 일회용 클러스터에서 수동 또는 예약 릴리스 선행 조건으로 실행하고 출력을 번들에 첨부 | 상태 없는 러너에서는 실행 불가([`supply-chain.yml:1-7`](../.github/workflows/supply-chain.yml#L1-L7)가 SBOM에 대해 같은 점을 지적) |
| Required check | `ci.yml` validate, `sast.yml` 잡, `supply-chain.yml`을 `main`의 required status check로 지정 | GitHub 설정, 오너 작업 |

---

## 7. 필요한 오너 결정

1. 6.2절의 조치 목표와 예외 만료 최대값을 승인하거나 변경.
2. 릴리스 게이트에 이미지/의존성 CVE 스캔 추가 승인(네트워크/러너 영향 포함).
3. CI 잡을 `main`의 required status check로 지정할지, `enforce_admins`를 false로 둘지 결정.
4. Dependabot이 더 많은 생태계를 다루게 할지, 보안 업데이트를 활성화할지 결정.
5. 라이브 클러스터 보안 테스트를 릴리스 선행 조건으로 할지, 누가 실행할지 결정.
6. `ci.yml`과 `release.yml`이 사용하는 beluga-manager pin 정렬(3절 관찰).
