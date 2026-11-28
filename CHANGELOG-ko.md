# 변경 이력 (Changelog)

[English](CHANGELOG.md) | 한국어

이 프로젝트의 주요 변경 사항을 이 파일에 기록한다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 기준으로 하며,
0.1.0부터 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다. pre-1.0
단계에서는 `main`만 지원 대상이다. 버전은 개별 컴포넌트가 아니라 플랫폼 정의(IaC)를
가리킨다 — [RELEASING-ko.md](RELEASING-ko.md) 참고.

## [Unreleased]

### Added

- Manager 아키텍처 화면에 "현재 구성" 관점을 추가했다. 플랫폼을 계층별로 배치하고, 설계상 데이터·쿼리·인증·제어 흐름(점선, 애니메이션 없음)과 Manager가 실제로 관측한 상태만 표시한다. 각 컴포넌트 상태에는 출처를 붙인다: 등록 서비스, Kubernetes 워크로드, 보고 없음(완전히 읽은 네임스페이스에 없음), 관측 안 됨(#463–#465). Manager 이미지 핀 `sha-628f0e142ba254d16efbc8ba495cc7605b2e45f5`로 배포한다.
- narwhal과 같은 SSO 로그인 이름 `admin`(`beluga-admin`과 같은 비밀번호·`admins` 그룹, PostgreSQL LDAP 로그인과 DB 역할은 `beluga-admin`만 해당)을 추가했다. Superset 로컬 관리자는 `superset-admin`으로 분리해 같은 행을 공유하지 않게 했고, OpenMetadata 관리자 주체에도 `admin`을 넣었다(#455).
- 전용 Keycloak 서비스 신원(`manager-query-history`, aud `trino`, 설계상 자기 쿼리만)으로 Manager 쿼리 이력을 연결했다(ADR-0012, #453). 쿼리 워크스페이스 테이블 목록 수정도 들어 있는 Manager 이미지 핀 `sha-d4ea6bf796b01787eb7bcf01d17a02723745c875`와 함께 켰다(#460).
- 전용 CNPG 계정·Cilium 정책·오프라인 테스트를 갖춘 선택적(기본 비활성) 지속 shop CDC 트래픽 생성기 추가. [설정·라이브 확인](docs/shop-traffic-generator-ko.md). 실제 전파는 미검증.

- 명시 활성화 CDC 수명주기 테스트 33·오프라인 프로토콜 회귀 추가. 04/05는 파드 확인을 유지하며 실제 쿼리·DAG 로드 검사는 라이브 검증 후 후속 반영 예정이다. 라이브 경로는 미실행.
- [VM vCPU 정체 사고와 증거](research/incidents/2026-11-16-vm-vcpu-stall/README-ko.md): 두 차례 실습 환경 정체와 제공 복구 검사는 **실측**, 호스트 메모리 원인은 **추론**, 커널/VZ 원인은 **미상**으로 구분했다. 호스트 메모리·boot ID 주의사항 추가. 메모리 예산·커널 선택은 소유자 결정으로 남긴다.
- 노드 메모리 warning/critical·차트 Job을 제외한 제한된 컨테이너 재시작 경보·운영자 호스트 기준 API Date/heartbeat 시계 검사 32 추가(#45, #408; D-ALERT-22–25). 오프라인 계약·EN/KO 대응/커버리지 문서 갱신, 라이브 확인 대기.
- [VM 시계 점프 사고와 증거](research/incidents/2026-11-16-vm-clock-jump/README-ko.md), VM 로컬 시계 가드·dnsmasq 설치 기록, Colima 복구 주의사항 추가. 2026-11-16 소유자 승인으로 무인 재부팅을 유지하고 VM 로컬 HWE 7.0.0-43을 적용했다. 00:42 루트 fsck 실패→emergency shell 실측과 SSH·다른 부팅 원인 추론을 구분하고 두 디스크 오프라인 복구·커널 전환 후 검증을 기록했다. 브로커당 쓰기 ~3.4 MB/s 중 stdout은 ~0.15 MB/s이며 나머지 대상은 미측정이다. 시각 보정 후 ~9 KB/s로 감소했다(raw/17·28). 7.0 재발 방지·실제 점프 재부팅 경로는 미검증이다.
- Flink JobManager 경보 및 손상된 HA 체크포인트 핸들 복구 런북 추가(#412, `D-ALERT-21`):
  새 RBAC 없이 정적 `Service/flink-cluster-metrics`(`flink-cluster-metrics.streaming.svc.cluster.local:9249`)로
  Flink 내장 Prometheus 리포터(`:9249`)를 노출하고, 양방향 `NetworkPolicy`(`victoria-metrics-egress`,
  `flink-cluster-ingress`), `vmalert` 규칙 `FlinkNoRunningJobs`(`critical`, 5m)와
  `FlinkJobManagerRestarting`(`warning`, 5m), 정적/라이브 계약 검사(`scripts/ci/check-alerting-pipeline.py`,
  `tests/31-alerting-pipeline.sh`), [복구 런북](docs/runbooks/flink-ha-broken-checkpoint-ko.md)([EN](docs/runbooks/flink-ha-broken-checkpoint.md))을 추가했다.

### Changed

- Manager "현재 구성" 다이어그램 가독성 개선: 모든 화살표가 왼쪽에서 바로 다음 열로만 향하도록 컴포넌트를 격자에 직접 배치했다(PostgreSQL에서 SeaweedFS까지 데이터 경로는 한 줄). 연결선은 캔버스의 글자 라벨 대신 종류(데이터·쿼리·인증)별 색과 선 모양, 범례로 구분하고, Manager 어댑터의 설계상 읽기 대상(Trino, Lakekeeper, Flink, Argo CD, 각각 설정된 경우에만 동작)은 연결선 대신 Manager 상세 패널에 표시한다(#469). Manager 이미지 핀 `sha-fed6354a81405666fdbd7efb5b079f92d065d85d`로 배포한다.

### Fixed

- 상점 생성기 주문 수명주기: 주문은 `PENDING`으로 생성되고 `PENDING -> SHIPPED -> COMPLETED`(또는 `PENDING -> CANCELLED`)로만 진행하며 금액은 바뀌지 않는다. 이전에는 업데이트마다 상태와 금액을 무작위로 다시 써서(배송 시 주문 금액이 바뀌고 `COMPLETED`가 `PENDING`으로 되돌아감) 생성기를 켜면 골드 `completed_revenue`가 의미를 잃었다. dbt 문서에 골드 날짜가 최신 갱신 시각의 UTC 달력 날짜임을 명시했다.
- Lakekeeper 카탈로그에서 Manager 쿼리 워크스페이스가 테이블을 하나도 보여 주지 않던 문제를 `kind=table` 요청으로 고쳤다(#452).
- `postgres-main` 연결 예산: `max_connections` 200과 OpenMetadata·OpenFGA 풀 상한으로 OpenMetadata 마이그레이션 훅이 beluga-data 동기화를 멈추지 않게 했다(#456).
- Superset 메타데이터를 파드 교체 때마다 사라지던 파드 내부 SQLite 대신 전용 Postgres `superset` DB에 저장한다(#457). 대시보드 import는 새 파드가 Ready가 된 뒤에만 돈다(#458).
- `db-roles-setup` 훅 역할에 CREATEDB가 없어 `superset`·`openfga` DB를 CNPG `Database` 리소스로 선언했다(#457, #459).
- 선택적 shop-gen을 모든 다른 sync wave 뒤에 배치하고 UPDATE 시 시드 고객·주문을 보존한다. 집계 health와 sync 대기를 구분하고 오프라인 회귀 검사를 추가했다. 라이브 동작은 미검증이다.
- #428 경보 후속: 메모리 입력 15분 부재 warning과 동일 노드 critical 중 warning 억제를 추가한다. 의도된 컨트롤러 한정 재시작 범위를 유지하고 오프라인 회귀 검사로 계약을 강제한다. 라이브 검증 대기.
- Flink HA·checkpoint 공통 접두사에 SeaweedFS fsync를 적용·검증하는 멱등 Sync hook과 정적 경로 불일치 fixture, 실패 폐쇄 라이브 검사를 추가한다(#412). 내구성 취약 창을 줄이며 손상 핸들을 복구하지는 않는다.
- 라이브 검증 후속 수정(#412): Go 타임스탬프 소수부를 Python 3.10에 맞게 정규화하고, Flink CRD가 있으면 리소스 누락을 실패로 처리하며, TLS 3단계 배선을 오프라인으로 검증한다.

### Security

- Trino가 bearer JWT를 로컬 검증(`use-userinfo-endpoint=false`)하고 토큰을 발급하는 모든 realm 클라이언트가 audience를 싣게 해, 다른 서비스용 토큰(예: Lakekeeper, Grafana 로그인 토큰)을 Trino에 재사용할 수 없게 했다(#454).
- Manager 이미지 핀 `sha-8f39078b25fc2ca7e63214e33f751ffa149c05a0` 갱신으로 `hono` 4.13.16(#421)을 배포한다.

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
