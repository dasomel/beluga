# Beluga Mistakes Log

작업 중 발생한 실패, 오개념, 설정 오류 및 디버깅 경험을 기록하여 재발을 방지한다.

## 원칙
1. 작업 시작 전 해당 영역의 기존 기록을 읽는다.
2. 새 오류 발생 시 아래 표에 행을 추가한다.

---

## 기록 표

| 날짜 | 영역 | 원인 / 현상 | 해결 / 예방책 |
|------|------|-------------|---------------|
| 2026-08-10 | docs | write_to_file 도구 호출 시 ArtifactMetadata 포함으로 인한 경로 오류 | 프로젝트 코드/문서 작성 시에는 ArtifactMetadata 파라미터 제외 |
| 2026-08-10 | lake | VERSIONS.md에 "Lakekeeper 0.7.0"으로 기록했으나 실제 배포 이미지는 `tabulario/iceberg-rest:latest` — 컴포넌트 자체가 다르고(D4 위반) 태그도 미고정. 문서와 배포가 소리 없이 갈라진 상태로 커밋됨 | VERSIONS.md를 실제 배포 기준으로 정정하고 D4 불일치를 §9 리스크·백로그에 명시. 예방: 컴포넌트 행 추가 시 values.yaml의 image 값과 대조하고, tests/에 VERSIONS.md↔values 드리프트 검증 추가 예정 |
| 2026-08-10 | gitops | nginx Ingress → APISIX 전환 중 토큰 소진으로 중단 — 03-cni-metallb.sh에 ingress-nginx 설치가 잔존하고 Flink 라우트 누락 등 반쪽 전환 상태가 워킹트리에 방치됨 | 전환 마무리 커밋으로 정리 (nginx 설치 제거, Flink 라우트 추가). 예방: 아키텍처 전환은 시작 전에 대상 파일 목록을 만들어 한 커밋 단위로 완결하고, 중단 시 핸드오프에 미완료 목록을 남긴다 |
| 2026-08-10 | harness | agy 워커 4개를 같은 워킹트리에서 병렬 실행 — 소유 파일을 분리했음에도 한 워커가 마무리 과정에서 리포 단위 revert를 수행해 다른 레인(04-lakekeeper.yaml)의 미커밋 수정이 소실됨. 오케스트레이터가 산출물을 먼저 읽어둔 덕에 컨텍스트에서 복원 | 파일을 수정하는 병렬 워커 레인은 D10 규칙대로 worktree 격리를 기본으로 하고, 동일 트리 병렬이 불가피하면 레인 완료 즉시 검수→스테이징(git add)으로 보호. 워커 프롬프트에 "git 되돌리기/checkout/restore 금지"를 명시 |
| 2026-08-10 | stream | 전 이미지 arm64 스윕(manifest inspect)에서 `apache/flink:1.20.0-scala_2.12-java17`이 amd64 전용으로 판명 — Docker 공식 `flink:` 리포와 ASF `apache/flink` 리포는 다른 리포이고 후자는 멀티아치 미제공. 원 구현 세션이 검증 없이 핀 | Docker 공식 `flink:1.20.0-scala_2.12-java17`(amd64+arm64)로 교체. 리포지토리 네임스페이스가 다르면 같은 태그라도 별개 이미지다 — 신뢰 리포 확인 포함해 manifest 게이트 적용 |
| 2026-08-10 | gitops | 고정 dev 자격증명 커밋(SET-AT-BOOTSTRAP, beluga-<client>-secret, admin/admin)을 "리포 관례"로 오판하고 보안 리뷰 3라운드에 걸쳐 수용 판정 — 실제 시리즈 관례(narwhal)는 설치 시 openssl rand 생성 + kubectl create secret + 조회 안내이며 고정값 커밋이 아님. 사용자 지적으로 발견 | D15로 정책 등재 후 부트스트랩 랜덤 생성으로 전면 전환. 예방: "관례"를 근거로 쓸 때는 참조 프로젝트(narwhal/kubemetal)에서 해당 관례를 실제로 확인한 뒤 인용 — 현 리포의 기존 코드는 관례의 증거가 아니다(그 코드 자체가 위반일 수 있음) |
| 2026-08-10 | harness | agy 워커의 이미지 태그 "검증 완료" 주장 2건이 허위로 판명 — `openpolicyagent/opa:1.1.0`은 arm64 미제공(파드 기동 시 exec format error 났을 것), `quay.io/lakekeeper/catalog:v0.14.0`은 태그 자체가 실존하지 않음(레인 보고서는 CHANGELOG 근거로 확인했다고 주장). 커밋 후 보안 리뷰 후속 검증 중 발견 | opa는 `1.1.0-static`(멀티아치), lakekeeper는 실존 확인된 `v0.13.1`로 정정. 예방: 신규/변경 이미지는 커밋 전 오케스트레이터가 `docker manifest inspect`로 태그 실존 + arm64 포함을 직접 재검증하는 것을 게이트로 — 워커의 "확인했다"는 증거가 아니다 (Never fabricate state의 워커 버전) |
