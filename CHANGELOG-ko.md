# 변경 이력 (Changelog)

[English](CHANGELOG.md) | 한국어

이 프로젝트의 주요 변경 사항을 이 파일에 기록한다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 기준으로 하며,
0.1.0부터 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다. pre-1.0
단계에서는 `main`만 지원 대상이다. 버전은 개별 컴포넌트가 아니라 플랫폼 정의(IaC)를
가리킨다 — [RELEASING-ko.md](RELEASING-ko.md) 참고.

## [Unreleased]

### Added

- `csp/kakao-cloud/` 아래 Kakao Cloud 배포 경로 추가(OpenTofu VPC/VM/NLB/bastion,
  `kakao-up.sh` 부트스트랩, ArgoCD 오버레이). 사설 노드는 bastion squid 프록시로
  egress 하고, 게이트웨이는 NLB -> 워커 NodePort 31080/31443 -> APISIX 로 노출한다.
  기본 Vagrant 경로와 `beluga-platform` 기본 렌더는 바뀌지 않는다. 2026-10-16
  에 라이브 apply 1회로 검증했다(Fixed 참고).
- Kakao Cloud 공인 IP 를 VM/NLB 재생성에도 고정(D-KAKAO-12): bastion 은 독립 network interface 를
  쓰고 두 `kakaocloud_public_ip` 리소스는 `related_resource` 변경을 무시한다. 교체 후 NLB
  재연결은 콘솔 수동 단계다(`csp/kakao-cloud/README.ko.md`). 2026-10-16 라이브 검증 완료.

### Fixed

- Kakao Cloud 첫 라이브 apply(2026-10-16) 수정: VPC 에 인터넷 게이트웨이 연결(D-KAKAO-13, 공인 IP
  연결이 409 로 실패), 서브넷을 `0.0.0.0/0 -> igw` 라우트 테이블로 연결(D-KAKAO-14, bastion SSH
  타임아웃), squid 용 bastion 로컬 dnsmasq 에서 AAAA 필터(D-KAKAO-15, IPv6 로 `CONNECT` 503),
  `bastion_ip_offset` 기본값 11 + validation(`.5` 는 Kakao 예약). LB 모듈은 네트워크와 bastion
  NIC 뒤에 만들어진다.
- `tests/01-cluster-health.sh` 가 게이트웨이 노출 모드(`BELUGA_LB_MODE` 또는 라이브
  `apisix-gateway` Service 타입)를 따른다: NodePort 모드는 MetalLB 가 필요 없고 80:31080/443:31443 을 기대한다.
- Kakao Cloud bastion: VPC DHCP DNS(169.254.169.253)가 모든 VM 에서 타임아웃 나(두 번째 배포,
  2026-10-16) cloud-init `packages` 가 실패하고 squid 가 뜨지 않았다. 이제 `bootcmd` 가
  `bastion_upstream_dns`(기본 1.1.1.1, 8.8.8.8; `[]` 이면 비활성)를 systemd-resolved 에 추가한다(D-KAKAO-16).
  `user_data` 변경만으로는 기존 bastion 이 교체되지 않으므로 `-replace` 한다.

### Changed

- `csp/kakao-cloud` 에 라이브 검증 결과(공인 IP 고정, import, NLB 소스 IP, 테스트, 부트스트랩
  시간)와 운영 주의를 문서화했고, `tests/19` 가 새 계약을 검증한다.
- `csp/kakao-cloud` 에 배포 시간 실측(apply 약 8분, `kakao-up.sh` 21분, 전체 약 38분)을
  기록하고 기존 부트스트랩 약 13분 추정치를 대체했다.

## [0.1.0] - 2026-10-15

첫 태그 릴리스.

### 추가

- 핵심 데이터 플랫폼: Kafka(+CDC) -> Flink -> Iceberg 레이크하우스 ->
  Trino/Superset -> Airflow, Vagrant + k3s + ArgoCD GitOps로 배포. 클린 인스톨
  E2E까지 검증 완료.
- 엔드투엔드 데모 2종: 합성 클릭스트림 이벤트 파이프라인, Postgres CDC 파이프라인.
- 게이트웨이와 인증: APISIX가 HTTP UI를 `*.local.beluga.internal`로 통합, Keycloak +
  OpenLDAP이 SSO와 계정 제공, OpenFGA 기반 Lakekeeper 인가(#159).
- `manager/` 컨트롤 플레인(TypeScript npm workspaces: `domain-api`, `policy-compiler`,
  `web`) — `beluga-manager`에서 이 리포로 통합(#261,
  [ADR-0005](docs/adr/0005-consolidate-beluga-manager-into-monorepo-ko.md)).
- 정책 컴파일러: `policies/`의 선언 YAML을 OPA Rego(`trino.rego`), `db-roles.sql`의
  생성 구간, Keycloak 산출물로 컴파일. seam 테스트
  `tests/14-policy-compiler-seam.sh`가 리포 안에서 재컴파일해 생성물 diff를 검증.
- 태그 트리거 릴리스 파이프라인(#100, #181): main 포함 여부, 취약점 스캔,
  `make lint`·`make validate`(라이선스 변경 게이트 포함)를 게이트로 통과한 뒤
  CycloneDX SBOM, 라이선스 인벤토리, 플랫폼 자산 인벤토리, 체크섬 증거 번들과
  GitHub 빌드 프로비넌스를 생성. `docs/development.md`의 "Release evidence" 참고.
- 독립 리뷰 머지 게이트: SHA에 묶인 `independent-review` 커밋 상태(#201,
  `scripts/ci/mark-review-pass.py`).
- 부트스트랩 시점 랜덤 자격증명 생성 후 Kubernetes Secret 저장(리포에 자격증명
  커밋 없음 — [SECURITY-ko.md](SECURITY-ko.md) 참고).
- 라이브 클러스터 이미지 대상 SBOM 생성(`scripts/generate-sbom.sh`).
- OpenForge 컴플라이언스 베이스라인: 이중 언어 문서 세트, `docs/adr/`, GitHub
  템플릿, CI 워크플로(lint, 정적 검증, 문서/ADR 페어링 검사, 공급망 정책 검사,
  IaC 정적 분석).

### 보안

- APISIX 요청 크기 제한(#165), PostgreSQL 백업 보존 기간(#166).

### 알려진 제한

- 정책 컴파일러 산출물을 클러스터에 실제 배포·검증하는 단계(Trino LDAP 그룹
  프로바이더, 정책 컷오버, Superset 롤 매핑, 카탈로그 브라우징 갭)는 아직 남아
  있다. 이번 릴리스에서 라이브 스위트(`tests/01`-`18`)는 2026-10-15 로컬 클러스터에서
  통과했지만, 위 경로는 정적으로만(그룹명 seam, `tests/14`) 다루고 종단 간 검증은 하지
  않는다.
- Kafka 리스너의 TLS 전용·인증 적용은 아직이다(#6). 플랫폼은 단일 호스트 로컬 랩
  네트워크를 전제로 한다.
- 빌드 의존성·업스트림 아티팩트 fail-closed 검증은 미완료(#103). 라이브 클러스터
  대비 이미지 다이제스트 증명과 태그 서명은 릴리스 증거에 포함되지 않는다.

개발 중 발견·수정한 결함의 상세하고 날짜별인 기록은
[docs/mistakes-log.md](docs/mistakes-log.md)를 참고한다.

[Unreleased]: https://github.com/dasomel/beluga/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dasomel/beluga/releases/tag/v0.1.0
