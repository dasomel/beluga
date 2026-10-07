# 빌드, CI, SBOM, 라이선스, 프로버넌스 및 릴리스 표준화 (제안)

[English](build-release-standardization.md) | 한국어

이슈 #100 ("[P1][Engineering][Supply-Chain] Standardize Build / GitHub Actions / SBOM / License / Provenance / Release") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 Makefile 타깃, 워크플로, 스크립트, 스키마, 정책을 변경하지 않는다.
> 저장소에 관한 모든 서술에는 이 문서를 작성한 커밋(`332b92c`)에서 읽은 `file:line` 참조를 붙였다.
> 라이브 사실(GitHub API, 클러스터)은 2026-10-07의 읽기 전용 조회에서 얻었으며 `file:line`이 없다. 외부 사실은
> `[S#]`를 인용한다([출처](#출처) 참고, 접근일 2026-10-07). 공식 설명을 찾지 못한 곳은 본문에 그렇게 적었다. **제안(Proposed)** 또는
> **소유자 결정(Owner decision)** 으로 표시한 항목은 먼저 소유자 승인이 필요하다.

[`security-gates.md`](security-gates-ko.md)를 기반으로 한다(게이트 id G15-G24는 재서술하지 않고 인용만 한다). 관련 제안과의 소유 범위 분담:
가져오는 대상의 획득 및 검증 = #103 (`docs/upstream-artifact-verification.md`); 이미지 다이제스트,
이미지별 SBOM, 서명, 취약점 정책 = #10 (`docs/image-provenance-sbom-policy.md`); 정기 평가 = #37
(`docs/vulnerability-assessment-process.md`). 이 문서는 **용어, 릴리스 체인, 증적 번들 내용,
라이선스 증적, 형식**을 소유한다. 해당 파일들은 관련 풀 리퀘스트에서 제안 중이다.

이슈 #100이 구현하는 포트폴리오 계약(Narwhal #161)은 2026-10-07에 `gh issue view`로 `dasomel/narwhal`의 이슈 본문만 읽었다 [S5].
이 계약은 공통 Make 타깃 집합(`help, fmt, lint, test, security, license, sbom, build, package,
e2e, clean, release`), CI 단계 용어(`validate, test, security, license, sbom, build, package, e2e, release, attest`),
최소 SBOM 메타데이터 집합(`artifact, digest, source, version, license, supplier, build_id, commit_sha, workflow_run,
platform/arch, provenance, timestamp`)을 나열한다. 이는 백로그 항목이지 채택된 명세가 아니다. 이 문서는 이를
비교 기준으로 사용할 뿐 구속력 있는 것으로 취급하지 않는다.

## 1. 현재 상태 (확인됨)

### 1.1 Makefile과 CI 단계

| 사실 | 증거 |
|---|---|
| 현재 Makefile 타깃: `help up down status test test-agent test-qa-report lint validate release-evidence release-evidence-verify release-evidence-dryrun drift-live clean research-check` | [`Makefile:3`](../Makefile#L3), [`:19-161`](../Makefile#L19-L161) |
| 문서화된 CI 단계(워크플로 단계 -> Makefile 타깃 또는 명시된 비-make 사유의 표)는 `make validate`의 `check-ci-stage-parity.py`가 두 방향으로 강제한다: 문서화된 모든 단계는 존재하는 타깃에 대응하고, 모든 워크플로 점검 단계는 문서화되어 있다 | [`development.md:210-242`](development-ko.md#L210-L242), [`check-ci-stage-parity.py:1-18`](../scripts/ci/check-ci-stage-parity.py#L1-L18), [`Makefile:89-90`](../Makefile#L89-L90) |
| Narwhal #161 용어와 비교(3.1절): 존재 `help`, `lint`, `test`, `clean`; 타깃으로는 없음 `fmt`, `security`, `license`, `sbom`, `build`, `package`, `e2e`, `release`. 기능은 다른 이름으로 또는 `validate` 안에 있다: 라이선스 게이트는 `validate`의 행이고([`Makefile:65-70`](../Makefile#L65-L70)), `make test`는 라이브 클러스터 E2E이며([`Makefile:32-33`](../Makefile#L32-L33)), SBOM과 패키징은 `release-evidence`이다 | 인용한 `Makefile` |
| 워크플로: `ci.yml` (lint, validate), `sast.yml`, `supply-chain.yml`, `docs-check.yml`, `operations-agent-security.yml`, `research-evidence.yml`, `release.yml`, 그리고 parity에서 제외된 OpenForge 상태 워크플로. 스케줄(`cron`) 워크플로는 없다 | [`.github/workflows/`](../.github/workflows), [`check-ci-stage-parity.py:37-41`](../scripts/ci/check-ci-stage-parity.py#L37-L41); `schedule:`/`cron` 검색 결과 없음 |
| `make validate`는 정적 게이트(라이선스, 고정, 렌더링된 매니페스트, 증적 번들 테스트)와 릴리스 드라이 런을 실행하며, 클러스터가 필요 없다 | [`Makefile:50-126`](../Makefile#L50-L126) |

### 1.2 릴리스 경로

| 사실 | 증거 |
|---|---|
| 트리거: 태그 `v[0-9]+.[0-9]+.[0-9]+*` 푸시; 먼저 엄격한 SemVer 이름 검사; `gate` 잡(태그가 `main`에 있음, 정확히 같은 커밋에 대해 `sast.yml`의 `trivy-config`/`trivy-secrets` 잡 성공, `make lint`, 이전 태그 대비 라이선스 게이트를 포함한 `make validate`); `release` 잡은 `needs: gate` | [`release.yml:11-16`](../.github/workflows/release.yml#L11-L16), [`:32-120`](../.github/workflows/release.yml#L32-L120), [`:122-123`](../.github/workflows/release.yml#L122-L123); `security-gates.md`의 G24 |
| `release` 잡: `make release-evidence`, `make release-evidence-verify`, `subject-checksums: dist/evidence/SHA256SUMS`를 지정한 `actions/attest-build-provenance`, 파일별로 `--signer-workflow`와 `--source-ref`를 지정한 `gh attestation verify`, 그다음 `gh release create` (재실행 안전: 기존 릴리스는 자산이 바이트 단위로 동일할 때만 유지) | [`release.yml:161-203`](../.github/workflows/release.yml#L161-L203) |
| release 잡의 권한: `contents: write`, `id-token: write`, `attestations: write` | [`release.yml:125-128`](../.github/workflows/release.yml#L125-L128) |
| **이 경로는 실제 태그에서 실행된 적이 없다**: 2026-10-07에 `gh api repos/dasomel/beluga/releases`와 `/tags`가 0건을 반환했고, `RELEASING.md`는 태그된 릴리스가 한 번도 만들어지지 않았다고 밝힌다. 증거: 테스트와 드라이 런뿐(`make release-evidence-dryrun`, `tests/test_release_evidence.py`) | [`RELEASING.md:5-6`](../RELEASING.md#L5-L6), [`Makefile:134-141`](../Makefile#L134-L141), 라이브 조회 |

### 1.3 증적 번들, SBOM, 메타데이터

| 항목 | 상태 | 증거 |
|---|---|---|
| 번들 파일 | `manifest.json`, `sbom.cdx.json`, `release-license-inventory.{json,md}`, `platform-asset-inventory.{json,md}`, `NOTICE`, `LICENSE`, 나머지 여덟 개에 대한 `SHA256SUMS` | [`evidence_bundle.py:26-35`](../scripts/release/evidence_bundle.py#L26-L35), [`:65-91`](../scripts/release/evidence_bundle.py#L65-L91) |
| 매니페스트 내용 | `schema`, `version`, `commit`, 파일 이름. 워크플로 실행 id, 워크플로 ref, 빌더, platform/arch, 타임스탬프, 의존성 집합 참조는 **없음** | [`evidence_bundle.py:87-89`](../scripts/release/evidence_bundle.py#L87-L89) |
| SBOM | CycloneDX 1.5; 메타데이터에 컴포넌트 `beluga` + 버전과 `beluga:source-commit`이 있음; 결정성을 위해 타임스탬프는 의도적으로 생략; 컴포넌트 = `VERSIONS.md` 행 + 렌더링된 이미지 참조(태그, 기본값만); purl/CPE/해시 없음; supplier 없음 | [`generate_sbom.py:1-10`](../scripts/release/generate_sbom.py#L1-L10), [`:103-118`](../scripts/release/generate_sbom.py#L103-L118), [`:112-113`](../scripts/release/generate_sbom.py#L112-L113) |
| 오프라인 `verify` | 네트워크 불필요, 릴리스 커밋의 체크아웃 필요: 체크섬, 목록에 없거나 누락되거나 심볼릭 링크인 파일 없음, 매니페스트 대 SBOM의 커밋 및 버전, NOTICE/LICENSE가 체크아웃과 바이트 동일, 자산 인벤토리 형태와 Markdown이 커밋된 문서와 동일, SBOM의 `VERSIONS.md` 이름이 체크아웃과 동일. 문서화된 한계: 번들 내부 일관성만 증명하며, `SHA256SUMS` 자체는 증명(attest)되지 않고, 진위성은 네트워크로 확인하는 프로버넌스에서 나온다 | [`evidence_bundle.py:114-207`](../scripts/release/evidence_bundle.py#L114-L207), [`development.md:258-268`](development-ko.md#L258-L268) |
| 증명(Attestation) | `SHA256SUMS` 대상에 대한 GitHub 빌드 프로버넌스(따라서 모든 번들 파일의 다이제스트에 대한 것); 배포된 컨테이너 이미지에 대한 것이 아님; "라이브 클러스터 대상 이미지 다이제스트 증명과 태그 서명"은 범위 밖으로 문서화됨 | [`release.yml:167-170`](../.github/workflows/release.yml#L167-L170), [`development.md:267-268`](development-ko.md#L267-L268) |
| 번들에 없는 것 | 보안 스캔 결과(SAST는 아티팩트를 업로드하지 않음), 이미지 다이제스트, 의존성 락, 이미지별 SBOM | `security-gates.md` 2절과 4절 |

### 1.4 라이선스

| 항목 | 상태 | 증거 |
|---|---|---|
| 기계 판독 가능 정책 | `policies/license-policy.yaml`: 승인 라이선스 목록, 자체 프로젝트 표지, `license_change_reviews`(현재 비어 있음; 컴포넌트, 새 라이선스, 승인자, 근거 필요), 분류 | [`license-policy.yaml:1-14`](../policies/license-policy.yaml#L1-L14), [`check-license-change.py:63`](../scripts/ci/check-license-change.py#L63) |
| 게이트 | `check-license-policy.py`(VERSIONS.md 대 승인 목록), `check-license-change.py`(기준 ref 대비 검토된 변경; 릴리스는 이전 태그 사용), `check-notice-consistency.py`; 모두 `make validate`에 있으므로 릴리스 `gate`에도 있다 | [`Makefile:65-70`](../Makefile#L65-L70), [`:81-82`](../Makefile#L81-L82), [`release.yml:79-85`](../.github/workflows/release.yml#L79-L85), [`:116-120`](../.github/workflows/release.yml#L116-L120) |
| 데이터 출처와 범위 | 라이선스는 `VERSIONS.md`의 **선언된** 값이다(산문이며 항상 SPDX id는 아님); SBOM 내용에서 도출한 라이선스는 없으므로 전이 패키지의 라이선스는 다루지 않는다 | [`generate_sbom.py:94-98`](../scripts/release/generate_sbom.py#L94-L98), [`NOTICE`](../NOTICE)는 이 저장소가 컴포넌트를 컴파일, 벤더링, 재배포하지 않는다고 밝힌다 |
| `THIRD-PARTY-LICENSES` | 저장소에 이런 파일은 없다(이슈가 범위 항목으로 나열함) | 저장소 루트 목록 |
| 배포되는 라이선스 증적 | `NOTICE`와 `LICENSE`를 번들에 그대로 복사하고 바이트 동일 여부를 검증한다; 릴리스 라이선스 인벤토리가 컴포넌트별 목록이다 | [`evidence_bundle.py:80-81`](../scripts/release/evidence_bundle.py#L80-L81), [`:189-197`](../scripts/release/evidence_bundle.py#L189-L197) |

### 1.5 선언 대 배포

`check-version-consistency.py`는 `make validate`에서 `VERSIONS.md`를 렌더링된 이미지 태그와 비교한다
([`Makefile:63-64`](../Makefile#L63-L64)). `make drift-live`는 라이브 워크로드 이미지를 차트 렌더와 컨테이너
이름으로 비교하며 upstream-manifest 워크로드는 건너뛰고, `make validate`나 릴리스 게이트에는 포함되지 않는다
([`check-live-drift.py:1-30`](../scripts/ops/check-live-drift.py#L1-L30), [`Makefile:154-155`](../Makefile#L154-L155)).

## 2. #100 수용 기준 대비 격차

| 수용 기준 | 상태 | 이유 |
|---|---|---|
| Makefile 공통 타깃 집합과 문서화된 CI 단계가 일치 | **부분(Partial)** | Makefile <-> 문서화된 단계: **충족(Met)** 이고 게이트됨. Narwhal 용어(1.1절): 12개 중 4개 존재 |
| 모든 릴리스 아티팩트가 소스 커밋과 불변 다이제스트에 연결됨 | **부분(Partial)** | 증적 파일: 매니페스트에 커밋, 증명된 `SHA256SUMS`에 SHA-256. 배포 이미지: 어디에도 다이제스트 없음(#10 제안) |
| SBOM이 아티팩트/빌드/프로버넌스 메타데이터를 담음 | **미충족(Not met)** | 이름, 버전, 소스 커밋뿐; 다이제스트, supplier, 빌드 id, 실행, platform, 타임스탬프 없음 |
| 배포 이미지와 선언된 인벤토리의 차이를 자동 탐지 가능 | **부분(Partial)** | `make drift-live`가 있으나 수동이고, 태그 기반이며, upstream-manifest 워크로드를 건너뜀 |
| 라이선스 정책이 기계 판독 가능하고 릴리스 시 적용됨 | **충족(Met)** (선언된 라이선스만) | 1.4절 |
| 릴리스 아티팩트에 NOTICE / 서드파티 / 라이선스 증적 포함 | **부분(Partial)** | NOTICE, LICENSE, 인벤토리는 배포됨; `THIRD-PARTY-LICENSES` 파일 없음 |
| 취약점, 라이선스, SBOM 실패가 릴리스를 막을 수 있음 | **부분(Partial)** | 라이선스와 SBOM: 예. 취약점: IaC/시크릿만; CVE 스캔 없음(`security-gates.md`) |
| Actions 실행 -> 아티팩트 -> SBOM -> 증적 체인을 재구성 가능 | **부분(Partial)** | 실행 -> 증적 파일은 증명으로; 증적 파일 -> SBOM은 `SHA256SUMS`로; SBOM -> 커밋. 실행 id/빌더는 번들에 없고; 이 체인은 실제 태그에서 실행된 적이 없다 |
| 오프라인 검증이 동일한 증적 점검을 재현 | **부분(Partial)** | `verify`는 일관성에 대해 오프라인; 진위성(증명)은 네트워크 필요; 락과 스캔 결과는 번들에 없음 |

## 3. 제안 (모두 제안(Proposed); 소유자 승인 필요)

### 3.1 Make 용어: 이름 변경이 아니라 별칭

| 용어 | Beluga 현재 | 제안 매핑 |
|---|---|---|
| `help` `lint` `test` `clean` | 존재 | 없음 |
| `fmt` | 없음; 포매터를 실행하지 않음 | **소유자 결정(Owner decision):** 문서화된 표에 "해당 없음"으로 선언(애플리케이션 소스 없음, `sast.yml:1-9`)하거나, 나중에 shellcheck 방식의 포매팅을 추가 |
| `security` | `sast.yml`과 `supply-chain.yml` 워크플로 단계뿐 | 오프라인 실행 가능한 부분집합(G4/G15/G16 등가)을 실행하는 타깃. Trivy 단계는 워크플로 전용으로 문서화 |
| `license` | `validate` 내부의 행 | 세 가지 라이선스 점검을 실행하는 타깃 |
| `sbom` | `release-evidence` (SBOM은 산출물 중 하나) | `sbom`은 SBOM 생성 + 검증만 실행 |
| `build` | 해당 없음: 컴파일하거나 빌드하는 것이 없음 | "해당 없음, 빌드 아티팩트 없음"으로 문서화 |
| `package` | `release-evidence` | 번들 빌드의 별칭 |
| `e2e` | `test` (라이브 클러스터 필요) | 별칭, 동일한 선행 조건을 명시 |
| `release` | `release-evidence` + CI | 로컬 드라이 런의 별칭 |

별칭은 기존 이름이 계속 동작하게 한다. `check-ci-stage-parity.py`는 문서화된 표에 용어 열을 추가해 확장하며, 어긋난 별칭이
`make validate`를 실패시키게 한다. 용어 채택은 **소유자 결정(Owner decision)** 이다(포트폴리오 수준 계약이며
저장소는 독립적으로 유지되어야 한다). 단계 용어는 워크플로에 다음과 같이 대응한다: `validate` = `ci.yml`; `security` = `sast.yml`,
`supply-chain.yml`; `license`/`sbom`/`package`/`attest` = `release.yml` 단계; `release` = `release.yml`; `test`/`e2e` = 수동
(`make test`); `build` 해당 없음. 잡별 단계 레이블은 필요하지 않다.

### 3.2 릴리스 체인: 소스 -> 의존성 집합 -> 빌더 -> 아티팩트 다이제스트

체인에는 이미 세 개의 연결이 있다(매니페스트와 SBOM의 커밋; `SHA256SUMS`에 있는 모든 파일의 다이제스트; 명명된 워크플로와 ref에서
나온 해당 다이제스트에 대한 증명). **제안(Proposed)** 추가 사항은 각각 작다.

1. `manifest.json`에 빌더 신원을 기록한다: 워크플로 ref, 실행 id, 실행 시도 횟수를 GitHub이 제공하는 환경
   값에서 가져오며, 사용 전에 엄격한 정규식으로 검증한다(저장소는 이미 태그 이름을 공격자가 영향을 줄 수 있는 입력으로 취급한다,
   [`release.yml:37-40`](../.github/workflows/release.yml#L37-L40)). 정확한 변수 이름은 구현 시점에 GitHub
   문서에서 확인해야 한다(이 문서를 위해서는 읽지 않았다). `schema`를 새 버전으로 올린다. `verify`는 명시된 기간 동안 두 버전을 모두 받아들이거나
   이전 버전을 거부한다(**소유자 결정(Owner decision)**).
2. **의존성 집합**을 번들에 넣는다: 아티팩트 락(#103), 이미지 다이제스트 락과 이미지 인벤토리(#10), 그리고
   스캔 보고서(`security-gates.md` 6.2). 이들은 `SHA256SUMS` 안에 있으므로 기존 증명이 다룬다. 이렇게 하면
   새 메커니즘 없이 "소스 -> 의존성 집합 -> 빌더 -> 아티팩트 다이제스트"를 점검할 수 있게 된다.
3. 매니페스트에 어떤 게이트가 실행되었고 그 결과가 무엇인지 명시한다(lint, validate, SAST 점검의 이름과 종료 상태). 이렇게 번들이
   무엇이 강제되었는지 말해 주며, 이는 `gate` 잡 결과에서 도출하고 게이트를 건너뛸 수 있는 스크립트의 자기 주장에 의존하지 않는다(`release` 잡은
   `needs: gate`, [`release.yml:122-123`](../.github/workflows/release.yml#L122-L123)).
4. GitHub은 아티팩트 증명만으로 SLSA v1.0 Build Level 2를 얻고 재사용 가능한 워크플로가 Build Level 3를 위한
   격리를 제공할 수 있다고 문서화한다 [S1]; SLSA는 프로버넌스를 위조하기 얼마나 어려운지로 레벨을 정의한다 [S2]. 현재
   릴리스가 어떤 레벨이든 충족하는지는 여기서 **평가하지 않았으며**, 레벨을 주장하는 것은 경로가 실제 태그에서 실행된 뒤 소유자가 결정할 일이다.
5. 리허설: 경로가 실제 태그에서 실행된 적이 없으므로(1.2절), 프리릴리스 태그로 한 번 실행하고(태그 정규식은 `-rc` 형태의 접미사를 허용한다,
   [`release.yml:39`](../.github/workflows/release.yml#L39)) 그 결과 증적을 기준으로 보관한다.
   공개 릴리스 객체를 만드는 것은 **소유자 결정(Owner decision)** 이다.

### 3.3 SBOM 최소 메타데이터 (Narwhal #161과 비교)

| 필드 | Beluga SBOM 현재 | 제안 출처 |
|---|---|---|
| artifact, version, license, source | 이름, 버전, 선언된 라이선스, `beluga:source` 속성 | 변경 없음 |
| commit_sha | `beluga:source-commit` | 변경 없음 |
| digest | 없음 | 이미지별 `beluga:image-digest`(#10); 번들 수준 다이제스트 = 증명된 `SHA256SUMS` |
| supplier | 없음 | **소유자 결정(Owner decision):** 저장소에 출처 없음; `VERSIONS.md`에 supplier 열 없음. 지어내지 말고, 설정하지 않은 채 두거나 열을 추가 |
| build_id, workflow_run | 없음 | 3.2절 1번 항목의 매니페스트 필드(또는 그로부터 복사한 SBOM 속성) |
| platform/arch | 없음 | 번들에는 해당 없음; 이미지별로는 다이제스트 락에서(인덱스 다이제스트, #10) |
| provenance | SBOM에는 없음 | 매니페스트에 문서화된 증명 참조 |
| timestamp | 의도적으로 생략(결정성) | 파일에서는 계속 생략; 증명이 서명 시각을 담음; 이를 바꾸는 것은 소유자 결정 |

### 3.4 SBOM 형식

릴리스 SBOM은 CycloneDX 1.5이다. CycloneDX 사이트는 현재 1.7을 나열하고 표준화를 ECMA-424로 설명한다 [S3]; 수동
콘텐츠 SBOM은 SPDX JSON이며, SPDX는 ISO/IEC 5962:2021이고 3.0이 나열된 최신 버전이다 [S4]. 읽은 출처들은 둘 사이에
권고를 하지 않으며 공식 변환 지침도 읽지 못했다(**공식 권고 없음**). **제안(Proposed):**
두 역할을 현재대로 유지하고(선언 상태 릴리스 SBOM은 CycloneDX, Trivy 콘텐츠 SBOM은 SPDX), 문서에 역할을 명시하며,
변환하지 않는다. CycloneDX `specVersion`을 올리는 것은 `validate_bom`에 스키마 검증 단계가 필요한 **소유자 결정(Owner decision)** 이며,
권고: 소비자가 요구할 때까지 보류.

### 3.5 라이선스

- **제안(Proposed):** 저장소가 아무것도 재배포하지 않는 동안에는 릴리스 라이선스 인벤토리가 서드파티 라이선스 증적임을 `docs/`에 선언한다
  (`NOTICE`가 그렇게 밝힌다). 빈 `THIRD-PARTY-LICENSES` 파일은 추가하지 않는다. 이미지를 빌드하거나 벤더링하게 되면 다시 결정한다
  (**소유자 결정(Owner decision)**; 권고는 위와 같음).
- **제안(Proposed):** 인벤토리에 범위 한계를 명시한다: 라이선스는 `VERSIONS.md` 행별로 선언된 값이며, 콘텐츠에서 도출한 라이선스
  (#10의 이미지별 SBOM에서)는 선언된 값을 대체하지 않고 명확히 표시한 두 번째 열로 추가할 수 있다.
- 라이선스 예외 저장소는 `approved_by`를 유지한다. 만료 추가는 공유 예외 대장 제안을 따른다
  (`security-gates.md` 6.2).

### 3.6 릴리스 게이트: 무엇이 막아야 하는가

`security-gates.md` 6.1/6.2의 임계값과 예외 설계를 재사용한다(재서술하지 않음). 릴리스 `gate`에 다음이 추가된다: (a) 이미지 CVE 스캔 잡(#10),
(b) 아티팩트 락 및 다이제스트 락 점검(#103/#10이 반영되면 이미 `make validate`의 일부), (c) 예외 만료 점검.
라이선스와 SBOM 실패는 번들이 만들어지기 전에 이미 중단시킨다
([`evidence_bundle.py:71-72`](../scripts/release/evidence_bundle.py#L71-L72)). `ci.yml`, `sast.yml`, `supply-chain.yml`을
`main`의 필수 상태 점검으로 만드는 것은 `security-gates.md`에 소유자 조치로 나열된 GitHub 설정이다.

### 3.7 선언 대 배포 탐지

**제안(Proposed):** `make drift-live`는 읽기 전용이자 수동으로 유지한다. #10이 생기면 다이제스트까지 확장한다. 소유자가
`security-gates.md` 6.2("Live security tests")에서 제안한 라이브 테스트 선행 조건을 받아들일 때에 한해 **일회용 클러스터를 대상으로 한 릴리스
선행 조건** 으로 추가한다. 그때까지 이 기준은 부분(Partial)으로 남으며 보고서도 그렇게 밝혀야 한다.

### 3.8 오프라인 검증

**제안(Proposed):** `evidence_bundle.py verify`는 오프라인으로 유지한다. 3.2절 2번 항목의 새 파일을 점검에 추가한다(다이제스트 락이
체크아웃의 것과 같고, 인벤토리가 락과 일치). `development.md`에 두 검증 수준을 따로 문서화한다: (a) 오프라인 일관성
(존재함), (b) 네트워크를 이용한 진위성(`gh attestation verify`, CI에 존재함). 증명 자체의 오프라인 검증은
읽은 공식 페이지에서 다루지 않았다. 소유자가 필요로 하면 별도 조사 사항이다.

## 4. 검증 및 테스트 아이디어

| 테스트 | 기대 결과 | 종류 |
|---|---|---|
| 별칭 타깃이 없거나 문서화되지 않은 용어 행이 있는 parity 점검 | `make validate` 실패 | 오프라인 픽스처(`check-ci-stage-parity.py` 자체 테스트 확장) |
| 워크플로 ref/실행 id가 없거나 값이 잘못된 매니페스트 | `verify` 실패 | 오프라인 픽스처(`tests/test_release_evidence.py` 확장) |
| 락/인벤토리/스캔 파일 중 하나가 없거나 변조된 번들 | `verify` 실패 | 오프라인 픽스처 |
| 게이트 결과 목록이 실제 잡 결과와 모순됨 | 빌드 중단 | 일회용 브랜치에서의 워크플로 수준 테스트 |
| 프리릴리스 태그 리허설 | 릴리스 생성; 모든 파일에 대해 `gh attestation verify` 통과; 태그의 깨끗한 체크아웃에서 `verify` 통과 | 라이브, 한 번 |
| 릴리스 워크플로 재실행 | 기존 릴리스는 바이트 동일할 때만 유지 | 라이브(기존 동작) |
| `THIRD-PARTY-LICENSES` 결정 | 문서가 어느 파일이 증적인지 명시 | 문서 점검 |

## 5. 남은 소유자 결정 사항

| # | 결정 | 권고 |
|---|---|---|
| D1 | 포트폴리오 타깃/단계 용어를 별칭으로 채택 | 예(Yes), 별칭만 |
| D2 | `fmt`와 `build`: 해당 없음으로 선언 | 예(Yes) |
| D3 | 매니페스트 스키마 상향과 이전 스키마 허용 여부 | 한 번의 릴리스 후 이전 스키마 거부 |
| D4 | 프리릴리스 태그로 리허설 | 예(Yes), 첫 실제 태그 전에 한 번 |
| D5 | SLSA 레벨 주장 | 리허설 이후; GitHub은 증명만으로 L2라고 문서화 [S1] |
| D6 | CycloneDX 스펙 버전 업그레이드와 SBOM 형식별 역할 | 역할 유지; 업그레이드 보류 |
| D7 | `THIRD-PARTY-LICENSES` 파일 | 재배포하는 것이 없는 동안은 불필요 |
| D8 | `supplier` 필드 출처 | 설정하지 않은 채 둠 |
| D9 | 릴리스 선행 조건으로서의 라이브 드리프트 점검 | `security-gates.md`의 라이브 테스트 결정과 함께 |

## 6. 후속 구현 작업 (순서대로, 작게)

1. 용어 열과 별칭 타깃을 추가하고 parity 점검을 확장한다. *수용 기준:* 별칭을 제거하면 `make validate`가 실패한다.
2. `manifest.json`에 빌더 신원과 게이트 결과를 추가하고 `verify`와 그 테스트를 확장한다. *수용 기준:* 변조되거나 누락된
   필드는 픽스처를 실패시킨다.
3. #103과 #10이 산출물을 제공하면 락/인벤토리/스캔 파일을 번들에 추가한다. *수용 기준:* `SHA256SUMS`가 이들을 나열하고, 리허설에서 증명
   검증이 이들에 대해 통과한다.
4. 리허설 태그 실행과 결과를 `docs/`에 기록한다(D4). *수용 기준:* 모든 `gh attestation verify` 호출이 통과하고 증적이 보관된다.
5. `development.md`에 검증 수준을 문서화한다(이중 언어). *수용 기준:* `docs-check`가 통과한다.
6. 라이선스 증적 선언과 범위 한계(3.5). *수용 기준:* 문서와 인벤토리 헤더 텍스트가 있고, 기존
   인벤토리 테스트로 확인된다.
7. `drift-live`에 다이제스트 비교를 추가한다(#10 이후). *수용 기준:* 다이제스트가 다른 파드가 `unauthorized`로 보고된다.

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | GitHub, Artifact attestations (SLSA v1.0 Build Level 2; reusable workflows for Level 3; `gh attestation verify`): https://docs.github.com/en/actions/concepts/security/artifact-attestations |
| S2 | SLSA v1.0, Levels: https://slsa.dev/spec/v1.0/levels |
| S3 | CycloneDX specification overview: https://cyclonedx.org/specification/overview/ |
| S4 | SPDX specifications: https://spdx.dev/use/specifications/ |
| S5 | `dasomel/narwhal` issue #161 (issue text, read with `gh issue view`; not an official external standard): https://github.com/dasomel/narwhal/issues/161 |
