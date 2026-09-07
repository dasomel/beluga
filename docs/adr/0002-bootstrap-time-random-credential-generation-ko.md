# ADR-0002: 부트스트랩 시점 랜덤 자격증명 생성

- Status: Accepted
- Date: 2026-08-10
- Supersedes: 초기 구현 중 잠깐 쓰였던 암묵적 "고정 커밋 dev 자격증명" 가정
  (그 자체가 ADR로 기록된 적은 없음)
- Superseded by: —

## 배경

초기 보안 리뷰 라운드에서, 리포에 커밋된 고정 개발 자격증명
(`SET-AT-BOOTSTRAP` 형태였지만 실제로는 `beluga-<client>-secret`, `admin`/`admin`
같은 정적 값)이 "리포 관례"로 오판되어 리뷰 3라운드에 걸쳐 수용됐다. 실제
시리즈 관례(narwhal)는 설치 시점에 `openssl rand`로 자격증명을 생성해 Kubernetes
Secret에만 저장하며, 고정값을 커밋하지 않는다. 이는 리뷰 프로세스가 아니라
사용자의 직접 지적으로 발견됐다(`docs/mistakes-log.md`의 2026-08-10 `gitops`
항목 참고).

## 결정

어떤 서비스 자격증명도 리포에 커밋하지 않는다. 모든 자격증명(PostgreSQL, Keycloak
admin, Superset admin, APISIX admin key, 롤별 사용자 비밀번호)은 부트스트랩
중(`scripts/gitops/*.sh`) `openssl rand`로 생성되어 `platform-system` 네임스페이스의
Kubernetes Secret `beluga-credentials`에만 기록된다. Helm 차트는 적용 시점에
`--set`으로만 이 값을 받는다 — values 파일 기본값은 전부 `SET-AT-BOOTSTRAP`
플레이스홀더이며 그 자체로 사용 가능한 자격증명이 아니다. 부트스트랩 후 값을
조회하는 공인 경로는 `scripts/credentials.sh`다.

## 검토한 대안

- **values 파일에 커밋된 고정 dev 자격증명** — 기각: 이 ADR이 바로잡는 실제
  실수였다. 개인/학습 스케일 프로젝트라 해도 커밋된 자격증명은 상시 노출이며,
  리포가 나중에 더 넓게 공개될 경우 실제로 위험한 패턴을 정상화한다.
- **외부 시크릿 매니저(Vault, SOPS 암호화 values 등)** — 현재는 기각: 단일 호스트
  학습 프로젝트에 비해 과도한 운영 의존성을 추가한다. Beluga가 호스트를 넘나드는
  클러스터 재생성에도 자격증명이 살아남아야 하는 요구가 생기면 재검토한다.
- **git-ignore된 실제 시크릿 `.env` 파일** — 기각: 여전히 사람이나 스크립트가
  버전 관리 밖 어딘가에 값을 정하고 유지해야 하며 로테이션 보장이 없다.
  부트스트랩 시점 생성은 "누군가 비밀번호를 정해야 한다"는 단계 자체를
  없앤다.

## 근거

부트스트랩 시점 생성은 자격증명을 리포의 신뢰 경계에서 완전히 제거한다 — 유출,
스크린샷, 실수로 게시될 고정값 자체가 없다. 시리즈 프로젝트 `narwhal`에서 이미
검증된 패턴과 일치해 플랫폼 3부작의 일관성을 유지한다.

## 결과

### 긍정적

- 리포 히스토리, 포크, 실수 게시로 인한 자격증명 노출 위험이 없다.
- 모든 환경이 자동으로 새롭고 고유한 자격증명을 받는다.
- `scripts/credentials.sh`가 흩어진 수동 `kubectl get secret` 호출 대신 단일
  공인 조회 경로를 제공한다.

### 부정적 / 트레이드오프

- `beluga-credentials` Secret 삭제나 네임스페이스 재생성 시 생성 단계를 다시
  실행하지 않으면 자격증명이 살아남지 않는다 — 자격증명에 대한 백업/복구
  시나리오는 설계상 없다.
- 향후 자동화(라이브 클러스터 대상 CI E2E, 외부 툴링)는 값을 미리 안다고
  가정하지 말고 `scripts/credentials.sh`를 호출해야 한다 — 기존 상태 대비
  작은 통합 비용이다.

## 영향받는 표준·템플릿·프로젝트

- `scripts/gitops/`, `scripts/credentials.sh`, `gitops/charts/*/values.yaml` 기본값
- `SECURITY.md`, `.env.example`

## 마이그레이션 / 도입

이 기록 시점에 이미 완전히 도입돼 있다 — 교정 이후 리포는 실제 자격증명을 커밋한
적이 없다. 이 ADR은 OpenForge 컴플라이언스 베이스라인(2026-08)의 일환으로 그
결정을 소급 공식화한다.

## 근거 자료

- 사건 기록: `docs/mistakes-log.md`, 2026-08-10 `gitops` 항목
- 참조 구현: 시리즈 프로젝트 `narwhal`
- 관련 ADR: ADR-0001
