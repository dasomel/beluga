# 보안 통제-증적 매핑

[English](security-control-evidence-map.md) | 한국어

보안 통제 영역을 이를 검증하는 스크립트/테스트/워크플로, 실행하는 Make 타깃, 남기는 증적에 대응시킨 저장소 기반 정적 매핑입니다. [Issue #50](https://github.com/dasomel/beluga/issues/50)("보안 기준선 및 통제-증적 매핑 정의")의 범위가 제한된 첫 슬라이스이며 전체 기준선이 아닙니다.

> [!IMPORTANT]
> **이 맵이 결정하지 않는 것.** 통제 소유자를 지정하지 않고, 배포 프로파일별 필수 통제를 선언하지 않으며, 목표·예외·만료일을 정하지 않습니다. 이는 #50에서 아직 열려 있는 사람의 결정입니다. 상태는 이 저장소에 자동 검증기가 있는지만 나타내며 컴플라이언스 주장이 **아닙니다**. 대부분의 검증기는 라이브 동작이 아닌 렌더/선언 상태를 검사합니다.

## 상태 의미

- `implemented`: 자동 검증기가 있고 CI에서 정적 수준으로 실행됩니다. 런타임 동작은 여전히 증명되지 않습니다.
- `partial`: 검증기가 영역의 일부만 다루거나, CI에서 실행되지 않는 라이브 클러스터 테스트만 있습니다.
- `gap`: 이 저장소에 자동 검증기가 없습니다.

현재 implemented 5, partial 10, gap 4.

## 통제

<!-- controls:start -->
| ID | 영역 | 검증 스크립트/테스트 | Make | 증적 산출물/생성 위치 | 상태 |
|---|---|---|---|---|---|
| C01 | 신원 부트스트랩 및 평문 엔드포인트 | `scripts/ci/check-identity-bootstrap-ropc.py` `tests/11-identity-plaintext-preflight.sh` | `validate` | `make validate` CI 로그의 게이트 출력 및 정적 테스트 11(테스트 11은 `make test`에서도 실행); tests/10-tls-identity-boundary.sh는 `make test`에서만 실행되며 라이브 클러스터 필요, 저장 산출물 없음, 따라서 verifier로 인용하지 않음 | partial |
| C02 | 접근 통제(기본 거부, 정책 컴파일 Seam) | `tests/06-authz-defaults.sh` `tests/07-trino-authz-live.sh` `tests/09-seaweedfs-authz-live.sh` `tests/14-policy-compiler-seam.sh` `tests/15-lakekeeper-authz-render.sh` | `test` | 테스트 출력만 존재(정적 14/15는 `make validate`에서도 실행되어 해당 CI 로그에 남음, 06/07/09는 라이브 클러스터 전용) | partial |
| C03 | TLS 및 인증서 | `scripts/ci/check-certificate-inventory.py` `scripts/ci/check-kafka-listener-security.py` | `validate` | 인증서 인벤토리 JSON 표준출력(저장 안 됨); 만료·갱신·무효 인증서 동작 검증기 없음 | partial |
| C04 | 네트워크 분리 | `scripts/ci/check-networkpolicy-coverage.py` | `validate` | CI 로그의 커버리지 래칫; tests/08-apisix-admin-restrict.sh(집행 검증)는 `make test`에서만 실행되며 라이브 클러스터 전용, verifier로 인용하지 않음 | partial |
| C05 | 워크로드 런타임 하드닝(Pod 보안 태세) | `scripts/ci/check-k8s-security-baseline.py` | `validate` | 렌더 기준선 인벤토리(Makefile이 출력 폐기); tests/15-k8s-security-baseline-inventory.py는 존재하지만 make/CI에 연결되지 않아 검증 수단으로 인용하지 않음 | partial |
| C06 | 게이트웨이 요청 제한(속도, 본문 크기) | `scripts/ci/check-apisix-route-rate-limit.py` `scripts/ci/check-apisix-request-size-limit.py` | `validate` | CI 로그의 정적 렌더 래칫; 런타임 집행은 검증되지 않음 | implemented |
| C07 | 시크릿 취급 | `scripts/ci/check-identity-bootstrap-ropc.py` `.github/workflows/sast.yml` | `validate` | CI 로그의 인라인 시크릿 래칫; sast.yml Actions 실행의 Trivy 시크릿 스캔 결과. 회전·외부 시크릿 저장소 검증기 없음 | partial |
| C08 | 데이터 보호(스키마 표준) | `scripts/ci/check-data-standards.py` | `validate` | CI 로그의 게이트 출력; 저장 시 암호화·데이터 분류 통제 검증기 없음 | partial |
| C09 | 백업 및 복구 | `scripts/ci/check-postgres-backup-config.py` | `validate` | CI 로그의 정적 백업 설정 검사; 복구 훈련과 Postgres 외 저장소는 검증되지 않음 | partial |
| C10 | 로깅 및 감사 추적 | none | none | 없음 | gap |
| C11 | 취약점 관리 | `scripts/ci/check-trivy-high-ratchet.py` `.github/workflows/sast.yml` | none | sast.yml Actions 실행의 Trivy 보고서; 어떤 Make 타깃에서도 실행되지 않음 | partial |
| C12 | 공급망 고정(이미지, 차트, 의존성, 업스트림 아티팩트) | `scripts/ci/check-pin-enforcement.py` `scripts/ci/check-image-tag-immutability.py` `scripts/ci/check-upstream-artifacts.py` `scripts/ci/check-dependency-integrity.py` `scripts/ci/check-version-consistency.py` `tests/test_pin_base_ref.py` `.github/workflows/supply-chain.yml` | `validate` | CI 로그의 게이트 출력; scripts/ci/*-baseline.yaml 및 configs/upstream-artifacts.sha256 기준선 | implemented |
| C13 | 라이선스 및 고지 준수 | `scripts/ci/check-license-policy.py` `scripts/ci/check-license-change.py` `scripts/ci/check-notice-consistency.py` `tests/test_release_license_inventory.py` | `validate` | CI 로그의 게이트 출력; 릴리스 번들의 release-license-inventory.{json,md} | implemented |
| C14 | 릴리스 증적(SBOM, 출처 증명, 체크섬) | `scripts/release/evidence_bundle.py` `.github/workflows/release.yml` | `release-evidence` `release-evidence-verify` | 회귀 테스트 tests/test_release_evidence.py는 `make validate`에서 실행; 릴리스 워크플로가 출처 증명과 함께 생성하는 번들(sbom.cdx.json, 라이선스 인벤토리, manifest.json, SHA256SUMS); 보안 통제 섹션 및 통제 상태 게이트 없음 | partial |
| C15 | 플랫폼 자산 인벤토리 | `scripts/ci/check-platform-asset-inventory.py` | `validate` | CI 로그의 docs/platform-asset-inventory.md 드리프트 검사; 선언 상태만 해당 | implemented |
| C16 | 운영 에이전트 실행 경계 | `tests/13-operations-agent-security.py` `.github/workflows/operations-agent-security.yml` | `test-agent` | operations-agent-security.yml Actions 실행의 테스트 출력과 생성된 계획 | implemented |
| C17 | 사고 대응 | none | none | 없음 | gap |
| C18 | 기간 제한 예외 등록부 | none | none | 없음 | gap |
| C19 | 통제 증적에 기반한 릴리스 준비 게이트 | none | none | 없음; 릴리스 게이트는 Trivy 실행, lint, validate만 확인 | gap |
<!-- controls:end -->

라이브 테스트가 있는 경우 `make test`(라이브 클러스터 E2E)를 표기하며 CI는 이를 실행하지 않습니다.

## 범위 제외 게이트 스크립트

모든 `scripts/ci/check-*.py`는 위에 매핑되거나 사유와 함께 여기에 나열되어야 합니다.

<!-- out-of-scope:start -->
| 스크립트 | 사유 |
|---|---|
| `scripts/ci/check-ci-stage-parity.py` | CI/Makefile/문서 정합성 점검이며 보안 통제 자체가 아님 |
| `scripts/ci/check-run-all-completeness.py` | tests/run-all.sh 테스트 러너 완전성 위생 점검 |
| `scripts/ci/check-rendered-shell-syntax.py` | 렌더된 Job의 셸 문법 정확성 점검이며 보안 속성이 아님 |
| `scripts/ci/check-control-evidence-map.py` | 이 맵 자체를 검증하는 메타 게이트 |
| `scripts/ci/check-independent-review.py` | 머지 절차 게이트(PR 리뷰 라벨 대 마지막 push)이며 브랜치 보호로 강제되고 플랫폼 보안 통제 자체가 아님 |
<!-- out-of-scope:end -->

## 집행

`python3 scripts/ci/check-control-evidence-map.py`는 `make validate`에서 실행됩니다. 참조 파일이나 Make 타깃이 없거나, `check-*.py` 게이트가 매핑도 사유 있는 범위 제외도 아니거나, 상태가 잘못되었거나, 표에 헤더 행이 없거나 열 수가 틀리거나 ID가 중복되거나, 검증기 경로가 절대 경로이거나 저장소 밖을 가리키거나 심볼릭 링크이거나, `gap` 행이 검증기나 Make 타깃을 인용하거나 다른 행이 검증기를 인용하지 않거나, 스크립트·테스트 검증기를 해당 행이 주장한 모든 Make 타깃 레시피가 실행하지 않거나(행은 모든 스크립트·테스트 검증기를 실행하는 타깃만 주장해야 함; 선행 타깃, `$(MAKE)` 호출, `tests/run-all.sh`를 따라가며 백슬래시 줄 이음을 먼저 합친 뒤 `echo` 문자열과 후행 주석을 포함한 `#` 주석은 인정하지 않음; 워크플로 검증기는 존재 여부만 확인), [영문 문서](security-control-evidence-map.md)와 ID·검증기·Make 타깃·상태·범위 제외 목록이 어긋나면 실패(fail closed)합니다. 회귀 테스트: `tests/test_control_evidence_map.py`.

**한계.** 레시피 검사는 셸이나 Make 평가가 아닌 텍스트 검사입니다. `if false; then …; fi`, heredoc 본문, `tests/run-all.sh`의 `: bash …` 줄도 실행으로 간주되며, 다중 타깃 규칙, `$(VAR)` 선행 요건, `$(MAKE) -f`는 파싱하지 않으므로 이를 쓰는 Makefile 수정은 게이트를 명시적으로 실패(false FAIL)시킬 수 있고 맵에 반영해야 합니다.
