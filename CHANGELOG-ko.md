# 변경 이력 (Changelog)

[English](CHANGELOG.md) | 한국어

이 프로젝트의 주요 변경 사항을 이 파일에 기록한다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 기준으로 하며,
0.1.0부터 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다. pre-1.0
단계에서는 `main`만 지원 대상이다. 버전은 개별 컴포넌트가 아니라 플랫폼 정의(IaC)를
가리킨다 — [RELEASING-ko.md](RELEASING-ko.md) 참고.

## [Unreleased]

## [0.2.0] - 2026-11-14

### Added

- [Colima 단일 노드 실습 안내](docs/colima-single-node-ko.md): macOS API·게이트웨이 접근,
  라이브 테스트 조건, Vagrant와의 차이, 비정상 종료 후 복구.
- `csp/kakao-cloud/` 아래 Kakao Cloud 배포 경로 추가(OpenTofu VPC/VM/NLB/bastion,
  `kakao-up.sh` 부트스트랩, ArgoCD 오버레이). 사설 노드는 bastion squid 프록시로
  egress 하고, 게이트웨이는 NLB -> 워커 NodePort 31080/31443 -> APISIX 로 노출한다.
  기본 Vagrant 경로와 `beluga-platform` 기본 렌더는 바뀌지 않는다. 2026-10-16
  에 라이브 apply 1회로 검증했다(Fixed 참고).
- Kakao Cloud 공인 IP 를 VM/NLB 재생성에도 고정(D-KAKAO-12): bastion 은 독립 network interface 를
  쓰고 두 `kakaocloud_public_ip` 리소스는 `related_resource` 변경을 무시한다. 교체 후 NLB
  재연결은 콘솔 수동 단계다(`csp/kakao-cloud/README.ko.md`). 2026-10-16 라이브 검증 완료.
- Kakao Cloud 는 Vagrant 의 `local.beluga.internal` 과 분리된 자체 플랫폼 도메인
  `kakao.beluga.internal` 을 쓴다(`gitops/values/domain-kakao.yaml`, terraform `base_domain` 과의
  일치를 `tests/19` 가 검증).
- Beluga Manager 가 클러스터에서 `manager.<baseDomain>` 뒤로 동작하며 Keycloak PKCE 로그인과
  bearer JWT API 인증을 쓴다. Manager 이미지는 `main` 에서 GHCR 로 빌드·게시하고(arm64 는
  네이티브 러너, #359) 차트에 다이제스트로 고정한다. 미인증 사용자는 곧바로 SSO 로그인으로
  이동하고(#342), 사용자 메뉴는 검증된 액세스 토큰의 그룹을 `GET /api/v1/me` 로 보여 준다(#348).
- Manager 가 픽스처 대신 라이브 플랫폼 상태를 읽는다: Kubernetes API 의 서비스 상태·이벤트(#347),
  개요 화면의 워크로드·리소스·정책·감사 결정(#365, 결정은 admins 전용), Flink 파이프라인(#344),
  Grafana/VictoriaMetrics 상태(#366), describe 전용 서비스 아이덴티티를 통한 Lakekeeper
  데이터 자산 이름(#372,
  [ADR-0010](docs/adr/0010-manager-lakekeeper-read-identity-ko.md)). 로컬 개발은 가짜 upstream 으로
  동작한다(#252).
- GitHub PR 을 통한 SSO 변경 요청(ADR-0009,
  [manager/docs/adr](manager/docs/adr/0009-sso-change-requests-via-git-pr-ko.md) 참고):
  `gitops/values/sso.yaml` 기반 읽기 전용 SSO 보기(라벨 형식, `BASE_DOMAIN` 으로 해석), 감사 DB 와
  미리보기/제출(3단계), 리컨사일러·취소·UI 를 갖춘 GitHub App PR 작성기(4단계). 라이브 인수
  테스트는 `tests/23`, `tests/24`.
- 게이트웨이·애플리케이션 SSO([ADR-0006](docs/adr/0006-gateway-sso-oidc-architecture-ko.md)):
  자체 로그인이 없는 UI 에 게이트웨이 OIDC, ArgoCD SSO(D-SSO-1..4), Flink·filer 라우트별
  `allowedGroups`(D-MSSO-14), OpenMetadata·Airflow·Trino UI·Lakekeeper UI 의 앱 수준 로그인 정상화,
  Beluga 브랜드 Keycloak 로그인 테마(#343).
- dbt Core 변환 계층([ADR-0007](docs/adr/0007-dbt-core-transformation-layer-ko.md), #95):
  DuckDB CI 와 다이제스트 고정 런타임 이미지(#381), `silver_shop`/`gold_shop` 으로 권한이 제한된
  `svc-dbt` 서비스 아이덴티티로 클러스터 안에서 도는 Airflow DAG `dbt_shop_medallion`(#382,
  `tests/27`), `gold_shop.dbt_run_audit` 의 노드별 실행 감사(#395).
- Iceberg 테이블 유지보수가 프로시저 전용 아이덴티티로 동작한다
  ([ADR-0008](docs/adr/0008-iceberg-maintenance-service-identity-ko.md), #387): Keycloak 클라이언트
  `maintenance` 와 `maintainers` 그룹은 정책 컴파일러의 와일드카드 없는 `procedureGrants` 로 테이블
  5개의 `optimize`, `expire_snapshots` 만 실행할 수 있다(`tests/28`). 이 DAG 는 그전까지 한 번도
  실행되지 못했다.
- 데이터 계약 도구: `lake.events_enriched` 의 ODCS 계약과 DDL 드리프트 검증기(#91), OpenAPI
  소스 계약 드리프트 검증기(#78), 커넥터 사전 점검이 있는 shop CDC 소스 매니페스트(#71), Flink SQL 에서
  뽑는 정적 컬럼 단위 리니지(#88). dbt 리니지 가시화와 Silver 게시 게이트는 문서로 제안했다(#396).
- 관측성: `grafana.<baseDomain>` 의 VictoriaMetrics 와 Grafana(SSO 전용, 그룹별 롤 매핑, #366;
  Grafana AGPL-3.0 예외는 라이선스 리뷰로 기록), 노드 파일시스템·PVC 사용량·CDC 복제 슬롯 WAL 규칙을
  갖춘 vmalert + Alertmanager([ADR-0011](docs/adr/0011-alerting-vmalert-alertmanager-ko.md), #408,
  `tests/31`).
- 48/64GB 프로파일 컴포넌트(OpenMetadata, Trino 워커)를 `gitops/values/profile-full.yaml` 과
  `gitops/profiles/full` 오버레이로 ArgoCD 가 관리한다(#333). 프로파일을 전환할 때 부트스트랩은
  루트 Application 만 적용한다.
- Flink 가 커넥터 JAR 이 들어 있는 Beluga 이미지로 동작해, 파드 시작 시 Maven Central 에서 더 이상
  내려받지 않는다(#361, #362, #364).
- CI: 매주 GitHub Actions 연구 증거 백필(#375), manager compose 런타임 스모크 테스트, Dependabot 이
  semver-major Docker 베이스 업데이트를 무시.

### Fixed

- 라이브 테스트 수정(#413): `tests/01`은 `EXPECTED_NODES`(기본 4)를 받아 Colima에서
  1로 설정할 수 있고, `tests/03`은 Flink가 선언되어 있으나 내려가 있으면 건너뛰지 않고
  실패한다. `tests/10`의 부정 TLS 검사는 공개 루트 번들을 사용하는 OpenSSL로
  macOS 로그인 키체인 신뢰와 독립적으로 수행한다.
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
- CDC 복제 슬롯 WAL 증가(#399, #401): 2026-11-12 에 `shop` DB 가 한가한 사이 Debezium 슬롯이 WAL
  22.85 GB 를 붙잡았고, 디스크가 가득 차 모든 네임스페이스의 파드가 축출됐다. 이제 Debezium 이 10초
  하트비트를 쓰고, CNPG 에 `max_slot_wal_keep_size=1GB` 를 두며(뒤처진 슬롯은 무효화되어 재스냅샷이
  필요), debezium-connect 는 콘솔 로그와 ephemeral storage 상한을 가지며, `tests/29` 가 슬롯 상태와
  노드 여유 공간을 확인한다. 사고 기록은 `research/incidents/2026-11-12-cdc-slot-wal-disk-pressure`.
- Flink 가 JobManager 재시작을 견딘다: Kubernetes HA 와 SeaweedFS 의 내구 체크포인트, 커밋된
  오프셋에서 재개하는 Kafka 소스로, 재제출해도 토픽을 처음부터 다시 읽어 Iceberg 에 중복 적재하지 않는다(#350).
- ArgoCD 가 Sync 훅만 바뀐 변경도 감지한다: 각 차트가 훅별 해시를 담은 `*-hook-revision` ConfigMap 을
  렌더링해, 그런 커밋도 Application 을 OutOfSync 로 만들고 훅을 다시 실행한다(#404).
- 라이브 dbt 실행에서 나온 문제 수정: Keycloak 26 매퍼 기본값으로 인한 keycloak-clients 크래시 루프
  (D-DBT-12), Trino 시스템 메타데이터 규칙(D-DBT-13), dbt-trino TLS 검증 활성화(D-DBT-14),
  Airflow 파드 오퍼레이터의 analytics 파드 이벤트 읽기 권한(#383, #384, #385).
- Iceberg 유지보수 정책을 Trino 라이브 입력 형태에 맞춤: 대문자 프로시저 이름, `optimize` 가 계획하는
  0개 컬럼 스캔(#391, #393).
- OpenMetadata 는 마이그레이션 훅이 끝난 뒤에만 롤아웃된다(#329). 신규 설치에서 `beluga-manager` 의
  누락된 기본 scope 를 부여한다(#331). Trino 는 설정 변경 시 롤링되고 OpenMetadata 인증 설정은 다시
  시드된다. 클라이언트 origin 은 교체 방식으로 reconcile 하고 도메인별 호스트를 갖는다. Airflow 는
  LocalExecutor 를 유지한다.
- Manager compose 웹 컨테이너가 실제 nginx 설정(CSP, SPA 폴백)을 서빙하고, Vite 개발 서버는
  루프백에만 바인딩한다(#252).
- 데모 `clickstream-gen` 이미지가 차트의 producer 스크립트로 빌드된다.

### Changed

- 버전 인벤토리에서 Flink operator 1.15.0 릴리스 태그와 공식 Helm 차트 기본 이미지(repository `ghcr.io/apache/flink-kubernetes-operator`, tag `79d730b`)를 구분했다. 차트 아카이브와 실배포를 대조했다.
- `csp/kakao-cloud` 에 라이브 검증 결과(공인 IP 고정, import, NLB 소스 IP, 테스트, 부트스트랩
  시간)와 운영 주의를 문서화했고, `tests/19` 가 새 계약을 검증한다.
- `csp/kakao-cloud` 에 배포 시간 실측(apply 약 8분, `kakao-up.sh` 21분, 전체 약 38분)을
  기록하고 기존 부트스트랩 약 13분 추정치를 대체했다.
- 두 차트 전반에 ephemeral storage 상한을 적용했다(#403, #408; 산정 근거는
  [docs/ephemeral-storage-bounds.md](docs/ephemeral-storage-bounds.md)): 디스크 기반 `emptyDir` 마다
  `sizeLimit`, 모든 컨테이너에 ephemeral-storage request/limit, KubernetesPodOperator·CNPG·Flink 잡
  파드에도 상한, 차트 소유 네임스페이스에는 ephemeral-storage LimitRange 기본값. 단일 인스턴스 CNPG
  클러스터 둘 다 이 변경이 sync 될 때 재시작된다.
- Dockerfile 베이스 이미지를 다이제스트로 고정(#103)하고, Trivy HIGH 발견 사항을 차단 조건으로 바꿨다(#117).
- 일상적인 의존성 업데이트(Manager npm 패키지, GitHub Actions)는 Dependabot 으로 머지했으며 항목별로 적지 않았다.

### 보안

- VictoriaMetrics 관리 엔드포인트(`delete_series`, `snapshot`, `flags`, `pprof` 등)는 부트스트랩이 생성한
  Secret 의 랜덤 키를 요구한다(#369).
- keycloak-clients 가 클라이언트 시크릿 접두사를 더 이상 로그에 남기지 않는다(#386). 아이덴티티 부트스트랩
  검사기는 시크릿에서 파생된 출력을 거부하고 taint 를 전파한다(#394).
- Airflow, Superset, flink-sql-submit, OpenMetadata init 컨테이너의 루트 파일시스템을 읽기 전용으로
  전환(#117, KSV-0014).
- Manager 감사 결정은 `admins` 그룹으로 제한(#365). dbt, Iceberg 유지보수, Manager 카탈로그 리더의
  서비스 아이덴티티는 각자의 시크릿과 권한 범위로 한정된다.

### 알려진 제한

- 비정상 스토리지 유실 뒤 읽을 수 없는 체크포인트 핸들이 남으면 Flink HA는
  자동 복구하지 못한다. 아직 Flink 알림도 없다(#412).
- 0.1.0 이후의 변경은 단일 노드 colima k3s 클러스터에서 라이브로 검증했다. Vagrant 멀티 노드 기준
  환경에서의 재검증은 미뤄 두었다.
- Alertmanager 는 null receiver 로 배포된다: 알림은 발화되고 Grafana·Alertmanager 에서 보이지만, 알림
  채널을 설정하기 전에는 어디로도 전달되지 않는다(#408).
- 네임스페이스 LimitRange 기본값은 파드가 생성될 때 적용된다. 업그레이드 전에 이미 있던 오퍼레이터 생성
  파드는 재시작하기 전까지 상한이 없다.
- 위험을 수용한 이슈 #6(Kafka TLS 전용·인증)과 #103(빌드 의존성 fail-closed)은 계속 열려 있다.

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

[Unreleased]: https://github.com/dasomel/beluga/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dasomel/beluga/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dasomel/beluga/releases/tag/v0.1.0
