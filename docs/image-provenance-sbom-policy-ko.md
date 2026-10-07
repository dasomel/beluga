# 배포 전 이미지 출처(Provenance), SBOM 및 취약점 정책 (제안)

[English](image-provenance-sbom-policy.md) | 한국어

이슈 #10 ("[P1][Security][SupplyChain] Enforce image provenance, SBOM, and vulnerability policy before deployment") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 워크플로, 스크립트, 차트, 어드미션 정책, `VERSIONS.md` 중 어느 것도 변경하지 않는다.
> 저장소에 관한 모든 서술에는 이 문서를 작성한 커밋(`332b92c`)에서 읽은 `file:line` 참조를 붙였다. 라이브 클러스터 사실은
> 2026-10-07에 읽기 전용 `kubectl get`으로 얻은 것이며 `file:line`이 없으므로 재검증해야 한다. 외부 사실은 `[S#]`를 인용하고
> ([출처](#출처) 참고, 접근일 2026-10-07), 공식 설명을 찾지 못한 곳에는 그렇게 적는다("공식 권고 없음(no official recommendation)").
> **제안(Proposed)** 또는 **소유자 결정(Owner decision)** 으로 표시된 항목은 먼저 소유자 승인이 필요하다.

[`security-gates.md`](security-gates-ko.md)를 기반으로 하며 그 문서의 게이트 id를 인용한다. 그 문서의 **제안(Proposed)** 개선 목표(CRITICAL 7일,
HIGH 30일, MEDIUM 90일), 예외 대장(exception register) 설계, 이미지 CVE 게이트 제안(해당 문서 6.2절)은 변경 없이 재사용하며,
이 문서는 다이제스트, 출처(provenance), 인벤토리, 어드미션, 오프라인 부분을 추가한다. 이미지가 아닌 아티팩트(매니페스트, 차트, jar, pip)의 확보는
#103 제안(`docs/upstream-artifact-verification.md`)이, 형식 및 릴리스 체인 문제는 #100 제안(`docs/build-release-standardization.md`)이,
정기 프로세스는 #37 제안(`docs/vulnerability-assessment-process.md`)이 맡는다. 이 파일들은 별도의 형제 풀 리퀘스트로 제안되어 있다.

## 1. 현재 상태 (검증됨)

### 1.1 이미지: 태그 대 다이제스트

| 사실 | 근거 |
|---|---|
| 두 차트는 **서로 다른 컨테이너 이미지 19개**를 선언하며, 모두 태그로 참조하고 다이제스트로 참조하는 것은 없다 | [`platform-asset-inventory.md:104`](platform-asset-inventory-ko.md#L104), [`image-digest-baseline.yaml`](../scripts/ci/image-digest-baseline.yaml)은 19개 저장소를 "tag-pinned only"로 나열하며 상한은 `BASELINE_CEILING = 19` ([`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40)) |
| 태그는 불변성을 정적으로 검사한다: `latest` 없음, 브랜치 형태 태그 없음, 명시된 예외는 `ghcr.io/dasomel/ldapium:nightly-4e85165` 하나 | [`check-image-tag-immutability.py:106-113`](../scripts/ci/check-image-tag-immutability.py#L106-L113), [`.github/image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt), [`supply-chain.yml:63-98`](../.github/workflows/supply-chain.yml#L63-L98) (G15, G16) |
| 태그는 레지스트리 소유자가 옮길 수 있는 이름이다. Kubernetes는 다이제스트를 불변 콘텐츠 해시로, 태그를 이동 가능한 것으로 문서화하며, 둘 다 주어지면 pull에는 다이제스트만 사용된다 | [S1] |
| 라이브 (2026-10-07, 읽기 전용): 파드 스펙의 서로 다른 이미지 참조 39개 중 3개가 `@sha256`을 가지며(Cilium cilium, cilium-envoy, operator-generic, 업스트림 차트 자체 기본값), 36개는 태그만 있다. 실행 중인 모든 컨테이너는 status에 `imageID` 다이제스트를 보고하므로, 실제로 pull된 다이제스트는 사후에 관찰할 수 있다 | `kubectl get pods -A -o jsonpath` (저장하지 않음) |
| ldapium nightly 태그는 라이브에서 `ghcr.io/dasomel/ldapium@sha256:33482e83...`로 해석되었다 | 동일 관찰 |
| 저장소 차트에서 렌더링된 워크로드는 라이브 대 선언 이미지 드리프트를 감지할 수 있지만(이름별 이미지 비교), 업스트림 매니페스트 및 오퍼레이터 워크로드는 **건너뛰며** 그곳의 드리프트된 이미지는 감지되지 않는다 | [`check-live-drift.py:1-30`](../scripts/ops/check-live-drift.py#L1-L30), `make drift-live` ([`Makefile:154-155`](../Makefile#L154-L155)); `make validate`에는 포함되지 않음 |

### 1.2 SBOM

| 사실 | 근거 |
|---|---|
| 릴리스 SBOM: CycloneDX **1.5**이며, (a) `VERSIONS.md` 행(이름, 버전, 선언된 라이선스)과 (b) 각 차트를 **기본 값으로 한 번** 렌더링한 `helm template` 출력에서 찾은 이미지 참조로 만든다(따라서 48/64 GB 스위치에서만 존재하는 이미지는 (b)에 없다). 이미지 내용은 스캔하지 않으며 purl, CPE, 해시는 출력하지 않는다 | [`generate_sbom.py:1-10`](../scripts/release/generate_sbom.py#L1-L10), [`:39-50`](../scripts/release/generate_sbom.py#L39-L50), [`:68-79`](../scripts/release/generate_sbom.py#L68-L79), [`:103-118`](../scripts/release/generate_sbom.py#L103-L118) |
| 이미지 컴포넌트의 `version`은 **태그**이다(참조에 이미 다이제스트가 있을 때만 다이제스트). 다이제스트 속성은 없다 | [`generate_sbom.py:53-65`](../scripts/release/generate_sbom.py#L53-L65) |
| 콘텐츠 수준 SBOM(이미지 내부의 전이 패키지)은 **실행 중인 클러스터**에서 이미지별로 `trivy image --format spdx-json`을 실행하는 수동 명령으로만 존재한다. CI에도 릴리스 게이트에도 없으며, pull 실패는 `--check`가 아니면 경고만 한다 | [`generate-sbom.sh:41-60`](../scripts/generate-sbom.sh#L41-L60), [`RELEASING.md:35-37`](../RELEASING.md#L35-L37), [`supply-chain.yml:1-7`](../.github/workflows/supply-chain.yml#L1-L7) |
| 증적 번들(evidence bundle)의 필수 파일은 매니페스트, SBOM, 라이선스 인벤토리, 자산 인벤토리, NOTICE, LICENSE이다. 스캔 결과, 이미지 다이제스트, 이미지별 SBOM은 없다 | [`evidence_bundle.py:35`](../scripts/release/evidence_bundle.py#L35), [`:87-89`](../scripts/release/evidence_bundle.py#L87-L89) |
| 사용 중인 형식: CycloneDX 1.5(릴리스)와 SPDX JSON(수동 Trivy). CycloneDX 사이트는 현재 1.7(2025-10-21)을 나열하고 ECMA-424를 설명한다 [S5]. SPDX는 ISO/IEC 5962:2021이다 [S6] | [S5], [S6] |

### 1.3 출처(Provenance), 서명, 어드미션, 취약점, 오프라인

| 주제 | 상태 | 근거 |
|---|---|---|
| 내부 아티팩트의 출처(provenance) | 증명(attest)되는 대상은 `actions/attest-build-provenance`를 통한 `dist/evidence/SHA256SUMS`(증적 파일)뿐이며, 실행 중 `gh attestation verify --signer-workflow --source-ref`로 검증한다. 문서화된 미포함 범위: 라이브 클러스터 대비 이미지 다이제스트 증명, 태그 서명 | [`release.yml:167-181`](../.github/workflows/release.yml#L167-L181), [`development.md:244-268`](development-ko.md#L244-L268) |
| 업스트림 서명 검증 | 저장소에 **없음**: `cosign`, `slsa-verifier`, `helm verify` 등이 없다(같은 발견에 대한 이전의 유일한 기록은 [`cross-oss-integration-contracts.md:100`](cross-oss-integration-contracts-ko.md#L100)). 각 업스트림이 서명을 게시하는지: Argo CD는 이미지와 CLI에 대해 cosign 키리스 서명과 SLSA Level 3 출처(provenance)를 문서화한다 [S7]. 읽은 Strimzi 문서 페이지에는 서명이나 SBOM에 관한 서술이 없다 [S8]. 차트 이미지 19개에 대해서는 이 문서가 조사하지 **않았다**(6절 작업 2) | [S7], [S8] |
| 어드미션 제어 | 어떤 종류의 어드미션 정책도 없다(Kyverno, Gatekeeper, `ValidatingAdmissionPolicy`, policy-controller 없음): 해당 이름을 저장소 전체에서 검색했을 때 문서 밖에서는 발견되지 않았다 | 이 커밋에서의 검색 |
| 이미지 취약점 스캔 | CI나 릴리스 게이트에 **없음**. `sast.yml`은 IaC와 시크릿을 스캔하며 이미지 스캔은 해당 없다고 밝히고, `release.yml`은 이를 "vulnerability scans"라고 부른다([`sast.yml:1-9`](../.github/workflows/sast.yml#L1-L9), [`release.yml:1-3`](../.github/workflows/release.yml#L1-L3)). `security-gates.md` 2절 참고 | G1-G4, G24 |
| 심각도 임계값과 예외 | IaC/시크릿 임계값은 있다(CRITICAL은 차단, HIGH는 고정된 기준선 대비 신규일 때만 차단). 예외에는 만료일이 없고 취약점 예외 메커니즘은 없다 | `security-gates.md` 5절 및 6.1절 |
| 오프라인 / 제한된 레지스트리 사용 | 라이브 레지스트리 없이 승인된 이미지 집합을 사용하는 프로파일이나 스크립트는 없다. Trivy 기반 스캔은 오프라인에서 미리 내려받은 데이터베이스가 필요하다 [S9]. k3s는 이미지 tarball을 사용하는 에어갭 경로를 문서화한다 [S10] | [`external-dependencies.md`](external-dependencies-ko.md) (이미지 레지스트리 단계) |
| 릴리스 소프트웨어 인벤토리 | 선언 상태 자산 인벤토리는 이미지를 **태그**로, 라이선스를 `VERSIONS.md`에서, "lifecycle: declared pin only"로 나열한다. 다이제스트, 출처 필드, 스캔 결과는 없다 | [`platform-asset-inventory.md:104-126`](platform-asset-inventory-ko.md#L104-L126), [`evidence_bundle.py:94-111`](../scripts/release/evidence_bundle.py#L94-L111) |

## 2. #10 인수 기준 대비 격차

| 인수 기준 | 상태 | 이유 |
|---|---|---|
| 모든 프로덕션 이미지에 SBOM과 불변 다이제스트가 기록되어 있다 | **미충족(Not met)** | 릴리스 SBOM에 이미지가 태그로 나열되며, 다이제스트가 없고, 릴리스에 이미지별 콘텐츠 SBOM이 없다 |
| 출처/서명 정책이 배포 전에 평가된다 | **미충족(Not met)** | 업스트림 검증이 없고 정책 문서도 없으며, 자체 아티팩트 증명은 증적 파일만 다룬다 |
| 문서화된 예외와 함께 High/Critical 취약점 정책이 강제된다 | **미충족(Not met)** | 정책은 IaC/시크릿에만 있으며, 이미지 CVE 스캔이 없고, 만료일이 있는 예외가 없다(`security-gates.md` 4절) |
| 릴리스에 대한 인벤토리 보고서를 생성할 수 있다 | **부분(Partial)** | 선언 상태 인벤토리가 번들에 있다(이미지 태그, 버전, 라이선스). 다이제스트, 출처, 스캔 결과가 빠져 있다 |
| 정책 실패가 경고 보고에 그치지 않고 배포를 막는다 | **미충족(Not met)** | 어드미션이나 배포 시점 검사가 없다. CI 검사는 필수로 지정된 경우에만 머지를 막는다(`security-gates.md` 3절). Argo CD는 저장소 `HEAD`를 동기화한다([`gitops/apps/beluga-data.yaml:9-10`](../gitops/apps/beluga-data.yaml#L9-L10)) |
| 오프라인 프로파일이 라이브 레지스트리 접근 없이 승인된 아티팩트 집합을 사용할 수 있다 | **미충족(Not met)** | 오프라인 프로파일이 없고 이미지 내보내기도 없다 |

## 3. 제안 (모두 제안(Proposed) 상태, 소유자 승인 필요)

### 3.1 다이제스트 잠금과 렌더링된 이미지 검사

- **제안(Proposed):** 이미지 참조당 한 줄인 버전 관리 잠금 파일: `repository:tag  sha256:<digest>` (레지스트리가 해당 태그에 대해 제공하는
  매니페스트의 다이제스트이며, 멀티 아키텍처 문제는 아래 참고). 초기 내용은 버전을 올리는 사람이 읽기 전용 레지스트리 조회로 만들고,
  PR에서 리뷰하며, 실행 중인 클러스터만 보고 가져오지 않는다.
- **제안(Proposed) 검사 (오프라인):** 차트 렌더링의 모든 이미지(`check-image-tag-immutability.py`가 이미 순회하는 것과 같은 렌더링:
  기본값, 그리고 48/64 GB 조합, [`check-image-tag-immutability.py:90-98`](../scripts/ci/check-image-tag-immutability.py#L90-L98))는
  같은 태그의 잠금 항목이 있어야 하며, 어떤 렌더링도 사용하지 않는 항목이 잠금에 있으면 안 된다(기존 래칫(ratchet)처럼 오래된 항목은 실패).
  이것이 `image-digest-baseline.yaml`을 폐기하는 메커니즘이다(0까지 줄이고 `BASELINE_CEILING`을 그에 맞게 낮춘다).
- **제안(Proposed) 배포 형태:** 차트의 `repo:tag@sha256:...` (읽기 쉬운 태그, pull에는 다이제스트 사용 [S1]). 차트는 values에서
  다이제스트를 읽는다. 정확한 템플릿 처리는 작업 1의 구현 세부 사항이다.
- 멀티 아키텍처 이미지: `VERSIONS.md`는 이미 최소 한 행(Lakekeeper)에 `amd64+arm64` 매니페스트 확인을 기록하므로, 잠금은 **인덱스(index)** 다이제스트(두 아키텍처에서 모두 유효한 단일 값)를 고정해야 하며 테스트는 두 아키텍처에서 모두 pull해야 한다.
  플랫폼별 다이제스트는 한 종류의 호스트를 깨뜨린다. 관찰된 라이브 `imageID` 값은 노드가 pull한 것이며
  인덱스 다이제스트와 같다는 보장이 없으므로, 구현 작업에서 레지스트리와 대조해 확인해야 한다.
- 업스트림 매니페스트 이미지(Argo CD, cert-manager, CNPG 오퍼레이터, Strimzi, Cilium, MetalLB, Flink 오퍼레이터)는 이 차트들에서
  렌더링되지 않는다. 이들은 #103 잠금이 다룬다(매니페스트 해시는 그 안의 이미지 태그를 고정하지만 다이제스트는 고정하지 않는다).
  **제안(Proposed):** 고정된 해당 매니페스트와 Helm 차트 안에 명시된 이미지까지 다이제스트 잠금을 확장하며, 검증된 매니페스트에서
  `image:` 값을 나열하는 스크립트로 생성한다. 이것이 이들에 대해 `make drift-live`를 의미 있게 만드는 유일한 방법이다.

### 3.2 SBOM

- **제안(Proposed) (릴리스 SBOM):** 기존 `beluga:image-reference` 옆에 `beluga:image-digest`를 속성으로 추가하고
  ([`generate_sbom.py:77`](../scripts/release/generate_sbom.py#L77)), 두 프로파일 조합을 모두 렌더링하며, 이미지에 잠금 항목이 없으면
  빌드를 실패시킨다. 새로운 외부 형식 사실은 필요하지 않다.
- **제안(Proposed) (콘텐츠 SBOM):** 라이브 클러스터 대신 `generate-sbom.sh`와 같은 도구와 플래그를 사용해 잠긴 이미지마다 **다이제스트 기준으로**
  SBOM 하나를 생성하고, 증적 번들과 함께 저장하는 릴리스 선행 잡(`SHA256SUMS` 안에 포함시켜 증명되게 한다). 이 잡에는 레지스트리 egress와
  Trivy 데이터베이스가 필요하다(오프라인은 3.6 참고). 이 파일들의 SPDX 대 CycloneDX 선택은 #100 제안에 속한다
  (거기서의 **소유자 결정(Owner decision)**). 여기서의 권고: #100이 결정할 때까지 변환 없이 Trivy의 SPDX 출력을 유지한다.
- 모든 보고서에 유지할 범위 서술: SBOM은 도구가 볼 수 있는 것을 나열할 뿐이며 완전성의 증명이 아니다.

### 3.3 출처(Provenance) 및 서명 정책

이미지별로 적용하고 다이제스트 잠금(`source` 열 또는 사이드카 파일)에 기록하는 정책 등급:

| 등급 | 의미 | 버전 상향 시 검사 (사람) | CI 검사 |
|---|---|---|---|
| A | 업스트림이 검증 가능한 서명/출처(provenance)를 게시한다 (예: Argo CD [S7]) | 업스트림이 문서화한 대로 인증서 ID와 OIDC 발급자를 지정한 `cosign verify` [S3]. ID를 기록한다 | 이후 제안(Proposed): 다이제스트 기준의 같은 명령. 네트워크와 키/투명성 접근에 대한 소유자 결정이 필요하다 |
| B | 업스트림이 게시하지 않는다 (또는 찾지 못했다) | 릴리스 노트와 다이제스트 출처를 검토한다. "no signature available, checked on <date>"를 기록한다 | 다이제스트 고정만 |
| C | 자체 이미지 (ldapium) | GitHub 아티팩트 증명(attestation)으로 빌드한다. 소비자는 `gh attestation verify`로 검증한다 [S2] | 다이제스트 기준으로 증명 검증 |

- 자체 이미지: GitHub는 아티팩트 증명만으로 SLSA v1.0 Build Level 2가 되고 재사용 가능 워크플로로 Build Level 3에 도달할 수 있다고 문서화한다 [S2].
  SLSA는 L2를 "출처 위조나 검증 회피에 명시적 공격이 필요함", L3를 대부분의 공격자 능력을 넘어서는 취약점이 필요함으로 정의한다 [S4].
  이 저장소는 이미지를 빌드하지 않으므로, Beluga 자체 릴리스의 SLSA 레벨은 증적 파일에 대한 서술일 뿐이다.
- **제안(Proposed):** ldapium 프로젝트에 증명이 있는 태그된(`nightly`가 아닌) 이미지를 게시해 달라고 요청한다. 이것이 유일한
  가변 태그 예외를 없앤다([`check-image-tag-immutability.py:108`](../scripts/ci/check-image-tag-immutability.py#L108)). 다른 저장소에 대한
  의존: **소유자 결정(Owner decision)**.
- 차트 이미지 19개 중 어느 것이 서명을 게시하는지 조사하는 것은 구현 작업이며, 이 문서는 그에 대해 어떤 주장도 하지 않는다.

### 3.4 배포 전 취약점 정책

- **제안(Proposed):** 릴리스 게이트에서 다이제스트로 잠긴 이미지에 대한 이미지 CVE 스캔, 그리고 별도의 비차단 보고서로서 일정에 따른 스캔
  (일정은 #37 제안에 속한다). 임계값은 `security-gates.md` 6.1/6.2를 재사용한다: CRITICAL은 차단. HIGH는
  기록된 기준선 대비 신규이거나 개선 기한을 넘겼을 때 차단. MEDIUM은 보고. 개선 목표 7/30/90일은 그곳에서
  **제안(Proposed), 소유자 결정(Owner decision)** 으로 남는다. 수정본이 있는 취약점만 스캔에서 집계할지는 정책 선택이다. Trivy는
  심각도로 제한하고 미수정 항목을 제외할 수 있으며(`--severity`, `--ignore-unfixed`), 기한이 있는 무시 항목(`expired_at`)과
  VEX 문서를 지원한다 [S11]. 사용 여부는 **소유자 결정(Owner decision)** 이다(권고: 미수정은 보고하고, 수정본이 있는 HIGH/CRITICAL만 차단한다.
  개선할 수 없는 차단은 릴리스를 멈추게 하기 때문이다).
- **우선순위 입력이며 임계값이 아님:** CVSS는 수치 심각도를 나타낸다 [S12]. EPSS는 향후 30일 내 악용 확률을
  추정한다 [S13]. CISA KEV 카탈로그는 CISA가 우선순위 결정에 반영해야 할, 실제 악용이 확인된 취약점의 신뢰할 수 있는 출처로
  설명한다 [S14]. 읽은 어떤 출처도 EPSS의 수치 기준선이나 Beluga 전용 규칙을 제시하지 않는다:
  임계값에 대한 **공식 권고 없음(no official recommendation)**. 그런 규칙은 모두 소유자 결정이다.
- **예외:** `security-gates.md` 6.2에서 이미 제안된 단일 대장(id, 범위, 심각도, 사유, 이슈, 승인자, 승인일, 만료일)을 사용한다.
  CVE용 예외 파일을 별도로 만들지 않는다. 스캐너와 대장이 어긋나지 않도록 Trivy `.trivyignore.yaml` 항목은
  대장에서 *생성*할 수 있다.
- 스캐너와 데이터베이스 버전은 보고서에 기록해야 한다(Trivy 데이터베이스는 실행 시점에 가져오며 현재 이 저장소가 고정하지 않는다,
  [`sast.yml:108-111`](../.github/workflows/sast.yml#L108-L111)). 그렇지 않으면 스캔을 재현할 수 없다.

### 3.5 어드미션 시점 강제 (설계 옵션, 선택된 것 없음)

어드미션에서 강제할 수 있는 것은 제한적이다. 어드미션 컨트롤러는 이미지 참조의 형태, 레지스트리, 서명을 검사할 수 있지만 CVE를 스캔할 수는 없다.
따라서 CVE 정책은 배포 전 CI/릴리스 게이트(3.4)로 남고, 어드미션은 다이제스트 형태, 허용 레지스트리, 서명에 대한 클러스터 측 보루이다.

| 옵션 | 할 수 있는 것 (공식 문서 기준) | 한계 / 비용 |
|---|---|---|
| ValidatingAdmissionPolicy (Kubernetes) | 프로세스 내 CEL 규칙, v1.30부터 안정(stable). 동작은 Deny, Warn, Audit [S15]. 컨테이너 이미지 문자열에 대한 CEL 규칙(예: "`@sha256:`를 포함해야 함" 또는 "레지스트리가 목록에 있음")은 테스트해야 할 설계이며 문서화된 레시피가 아니다 | 읽은 페이지에는 외부 데이터나 서명 검증에 대한 언급이 없다. 클러스터는 k3s `1.36`을 실행하며([`configs/cluster.env:21`](../configs/cluster.env#L21)), 1.30보다 높다 |
| Kyverno `verifyImages` | 서명(Sigstore Cosign 및 Notary)을 검증하고, 증명을 확인하며, 태그를 다이제스트로 변경(mutate)할 수 있고, `required`의 기본값은 true이다 [S16] | RAM 프로파일이 정해진 랩에 컨트롤러와 웹훅을 추가한다(리소스 비용은 측정하지 않음). 어드미션 웹훅은 사용할 수 없을 때 부트스트랩을 막을 수 있으므로 `failurePolicy`와 네임스페이스 범위를 설계해야 한다 |
| 없음 (CI/릴리스 게이트만) | 가장 저렴하다 | 그러면 "정책 실패가 배포를 막는다"는 게이트를 거치는 변경에만 참이다. 수동 `kubectl apply`나 업스트림 매니페스트 변경은 포함되지 않는다 |

**제안(Proposed) 롤아웃:** (1) 감사/경고만 하고 `make drift-live` 방식의 출력으로 위반을 보고한다. (2) 다이제스트 잠금이 생긴 뒤
차트가 소유한 네임스페이스에 대해 거부(deny)한다. (3) 업스트림 매니페스트 네임스페이스는 이미지가 잠길 때까지 제외한다. 옵션 간 선택은
**소유자 결정(Owner decision)** 이다. 권고: 다이제스트 형태와 레지스트리 허용 목록에는 먼저 ValidatingAdmissionPolicy를 쓰고(새 컴포넌트 없음),
소유자가 어드미션 시점의 서명 검증을 요구하는 경우에만 Kyverno를 쓴다.

### 3.6 릴리스 소프트웨어 인벤토리와 오프라인 사용

- **제안(Proposed):** 증적 번들에 `image-inventory.json`(+ 렌더링된 Markdown)을 추가한다. 이미지별 항목: 참조, 다이제스트, 버전,
  출처(차트 / 업스트림 매니페스트 / VERSIONS.md 행), 라이선스(`VERSIONS.md`에서), 등급(3.3), SBOM 파일명과 해시, 스캔
  결과 요약과 보고서 파일명, 스캐너 및 데이터베이스 버전. 오프라인 `verify` 단계는 자산 인벤토리에 이미 하는 것처럼
  릴리스 체크아웃의 다이제스트 잠금과 대조해 검사한다([`evidence_bundle.py:94-111`](../scripts/release/evidence_bundle.py#L94-L111),
  [`:179-188`](../scripts/release/evidence_bundle.py#L179-L188)). 파일 이름과 번들 스키마 상향은 #100의 결정 사항이다.
- **제안(Proposed) 오프라인 이미지 집합:** **다이제스트 기준으로** OCI 레이아웃 또는 동등한 아카이브로 내보낸 이미지를 #103
  아티팩트 번들에 나열하고 다이제스트 잠금을 그 색인으로 쓴다. 사용 경로 = 노드 런타임으로 가져오기(k3s는 노드에 이미지
  tarball을 두는 방식을 문서화한다 [S10]) 또는 로컬 레지스트리로 가져오기. 오프라인 취약점 데이터: 미리 내려받은 Trivy 데이터베이스와
  `--skip-db-update`, Java 조회는 `--offline-scan`으로 비활성화 [S9]. 오프라인 프로파일이 범위에 들어가는지는
  `environment-profiles.md` 및 #36과 공유하는 **소유자 결정(Owner decision)** 이다.

## 4. 검증 및 테스트 아이디어

| 테스트 | 기대 결과 | 종류 |
|---|---|---|
| 다이제스트 잠금을 갱신하지 않고 차트의 태그를 수정한다 | `make validate`가 이미지 이름을 밝히며 실패한다 | 오프라인 |
| 어떤 렌더링도 사용하지 않는 잠금 항목을 추가한다 | 오래된 항목으로 실패한다 | 오프라인 |
| 잠금에 없는 이미지가 있는 픽스처로 릴리스 SBOM을 빌드한다 | 빌드가 중단되고 번들이 없다 | 오프라인 (`tests/test_release_evidence.py` 확장) |
| `image-inventory.json`이 변조되었거나, 없거나, 항목이 더 있는 증적 번들 | `verify`가 실패한다 | 오프라인 |
| 레지스트리가 잠긴 태그에 대해 다른 다이제스트를 반환한다 (픽스처 레지스트리 또는 기록된 응답) | 다이제스트 잠금 갱신 검사가 실패한다 | 픽스처 |
| CRITICAL 발견이 있는 스캔 픽스처: 유효한 예외 항목이 있는 경우와 없는 경우, 그리고 만료된 항목이 있는 경우 | 실패 / 통과 / 실패 | 기록된 스캐너 JSON을 쓰는 오프라인 픽스처 |
| 어드미션 (감사): 태그만 있는 이미지의 파드를 일회용 클러스터에 적용한다 | 경고/감사 이벤트. deny 모드에서는 거부된다 | 일회용 클러스터 (라이브) |
| 오프라인 가져오기: 레지스트리 egress를 차단한 채 내보낸 이미지 집합으로 설치한다 | 파드가 시작되고 외부 pull이 없다 | 일회용 클러스터 (라이브) |

## 5. 남은 소유자 결정 사항

| # | 결정 | 권고 |
|---|---|---|
| D1 | 차트 이미지 19개에 다이제스트 잠금과 `tag@sha256` 형태를 채택 | 예(Yes). `image-digest-baseline.yaml` 폐기 |
| D2 | 업스트림 매니페스트와 차트 안의 이미지도 잠금 | 예(Yes). D1 이후 (드리프트 감지에 필요) |
| D3 | 이미지 CVE 게이트: 차단 대상(수정본이 있는 HIGH/CRITICAL 대 전체), 새로 공개된 CVE에 대한 유예 기간 | 수정본이 있는 HIGH/CRITICAL 차단. 유예 기간은 소유자가 정하는 숫자(공식 권고 없음(no official recommendation)) |
| D4 | 개선 목표 7/30/90일 (`security-gates.md`에서) | 그곳에서 제안된 대로 승인 |
| D5 | 어드미션 제어 옵션(3.5)과 롤아웃 순서 | ValidatingAdmissionPolicy 감사부터 |
| D6 | ldapium에 태그되고 증명된 이미지 게시를 요청 | 예(Yes) |
| D7 | 서명 검사를 매 실행마다 CI에서 할지, 버전 상향 시점에만 할지 | 버전 상향 시점부터 |
| D8 | 오프라인 프로파일을 범위에 포함 | #36/#24 소유자와 함께 결정 |
| D9 | 콘텐츠 SBOM 형식 (SPDX 대 CycloneDX) | #100 문서에서 결정 |

## 6. 후속 구현 작업 (순서대로, 작게)

1. 다이제스트 잠금 파일과 두 차트 렌더링에 대한 오프라인 검사기, `tag@digest`를 내보내는 차트 템플릿 처리. *수용 기준:* 잠금 갱신 없이
   태그를 바꾸면 실패한다. 완료되면 `image-digest-baseline.yaml`과 `BASELINE_CEILING`이 0에 도달한다.
2. 차트 이미지 19개가 게시하는 서명/증명을 공식 문서에서 조사하고, 이미지별로 등급 A/B를 기록한다.
   *수용 기준:* 모든 이미지에 등급과 날짜가 있는 출처 링크가 있다.
3. 릴리스 SBOM 생성기에 `beluga:image-digest`와 두 프로파일 렌더링을 추가한다. *수용 기준:* 잠금 항목이 없는 픽스처는
   번들 빌드를 중단시킨다.
4. 스캐너/데이터베이스 버전을 기록하는, 잠긴 다이제스트에 대한 스캔 잡. 출력은 번들에 저장한다. *수용 기준:* 스캔 파일이 없거나 변조되면
   번들 `verify`가 실패한다.
5. 예외 대장과 검사기(#37과 공유, `security-gates.md` 6.2에 정의). *수용 기준:* 만료된 항목은 `make validate`를 실패시킨다.
6. `image-inventory.json` 생성기와 오프라인 verify 단계. *수용 기준:* 잠긴 이미지가 인벤토리에 없으면 verify가 실패한다.
7. 일회용 클러스터에서 감사 모드로 어드미션 정책 적용(D5). *수용 기준:* 태그만 있는 파드가 감사/경고 이벤트를 낸다.
8. 잠긴 업스트림 이미지에 대해 다이제스트를 비교하도록 드리프트 검사를 확장한다. *수용 기준:* 다이제스트가 다른 파드는 `unauthorized`이다.
9. 오프라인 이미지 내보내기/가져오기 절차와 테스트(D8).

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | Kubernetes, Images (digest vs tag): https://kubernetes.io/docs/concepts/containers/images/ |
| S2 | GitHub, Artifact attestations (SLSA v1.0 Build Level 2; reusable workflows for Level 3; `gh attestation verify`): https://docs.github.com/en/actions/concepts/security/artifact-attestations |
| S3 | Sigstore, Cosign verify (digest validation, `--certificate-identity`, `--certificate-oidc-issuer`): https://docs.sigstore.dev/cosign/verifying/verify/ |
| S4 | SLSA v1.0, Levels: https://slsa.dev/spec/v1.0/levels |
| S5 | CycloneDX specification overview (version 1.7, ECMA-424): https://cyclonedx.org/specification/overview/ |
| S6 | SPDX specifications (ISO/IEC 5962:2021): https://spdx.dev/use/specifications/ |
| S7 | Argo CD, Signed release assets: https://argo-cd.readthedocs.io/en/stable/operator-manual/signed-release-assets/ |
| S8 | Strimzi, Deploying and managing (searched; no signature/SBOM/cosign statement found): https://strimzi.io/docs/operators/latest/deploying.html |
| S9 | Trivy, Air-gapped environment: https://trivy.dev/latest/docs/advanced/air-gap/ |
| S10 | K3s, Air-Gap Install: https://docs.k3s.io/installation/airgap |
| S11 | Trivy, Filtering (`--severity`, `.trivyignore.yaml` `expired_at`, `--ignore-unfixed`, VEX): https://trivy.dev/latest/docs/configuration/filtering/ |
| S12 | FIRST, CVSS: https://www.first.org/cvss/ |
| S13 | FIRST, EPSS: https://www.first.org/epss/ |
| S14 | CISA, Known Exploited Vulnerabilities Catalog: https://www.cisa.gov/known-exploited-vulnerabilities-catalog |
| S15 | Kubernetes, Validating Admission Policy: https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/ |
| S16 | Kyverno, Verify Images: https://kyverno.io/docs/policy-types/cluster-policy/verify-images/ |
