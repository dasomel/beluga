# 환경 프로파일 (development / test / production-style)

[English](environment-profiles.md) | 한국어

[Issue #24](https://github.com/dasomel/beluga/issues/24)(개발·테스트·운영 프로파일 분리)의 설계 및
증거 기준 문서입니다. **문서 전용 변경입니다. 프로파일 스위치, 사전 점검(preflight) 스크립트, values 파일은
추가하지 않습니다.** 저장소에 대한 모든 서술은 이 문서를 작성한 커밋에서 직접 읽은 `파일:줄` 근거를 갖습니다.
**not defined today(현재 미정의)**는 해당 항목을 정의하는 저장소 산출물이 없다는 뜻입니다. 제안은
**Proposed**, 저장소에서 도출할 수 없는 수치/선택은 **Owner decision**으로 표시했습니다.

이미 내려진 오너 결정(issue #24): **production-style 프로파일은 현재의 TLS/인증 활성 구성을 기준선으로 사용**합니다
(TLS/인증 스위치 뒤에 있는 기능은 모두 ON, 작은 호스트에 맞추려고 완화하지 않음).

---

## 1. 현재 존재하는 것

현재 존재하는 프로파일 축은 **호스트 RAM**(32/48/64 GB) 하나뿐이며, 환경 프로파일이 아닙니다.

| 사실 | 근거 |
|---|---|
| RAM 프로파일 32/48/64GB; 48GB+에서 OpenMetadata와 Trino worker 활성 | [`README.md:65`](../README.md#L65), [`README.md:76-80`](../README.md#L76-L80) |
| `BELUGA_PROFILE`이 VM 사이징 결정; 32/48/64 이외 값은 오류로 거부됨(이 PR에서 수정; 이전에는 조용히 32GB 사이징 분기로 빠짐) | [`scripts/common/env.sh:33-53`](../scripts/common/env.sh#L33-L53) (`*)`는 `:47`) |
| `BELUGA_PROFILE`이 없으면 호스트 RAM을 감지해 프로파일 선택 | [`scripts/common/env.sh:54-75`](../scripts/common/env.sh#L54-L75) |
| `ENABLE_OPENMETADATA` / `TRINO_WORKER_ENABLED`는 미설정 시 `BELUGA_PROFILE >= 48`에서 파생 | [`scripts/common/env.sh:80-89`](../scripts/common/env.sh#L80-L89) |
| 체크인된 기본값은 `BELUGA_PROFILE=64`, 프로바이더 `vmware_desktop`, 서브넷 `192.168.77.x` | [`configs/cluster.env:7`](../configs/cluster.env#L7), [`:10-15`](../configs/cluster.env#L10-L15), [`:25`](../configs/cluster.env#L25) |
| 두 기능 플래그는 부트스트랩 스크립트의 `--set`(`helm template ... \| kubectl apply`)으로만 Helm에 전달 | [`scripts/gitops/01-argocd-bootstrap.sh:358-361`](../scripts/gitops/01-argocd-bootstrap.sh#L358-L361), 환경변수 전달 [`scripts/up.sh:64`](../scripts/up.sh#L64) |
| ArgoCD Application은 Helm 파라미터/values를 선언하지 않아 GitOps sync는 차트 기본값(OpenMetadata off, Trino worker off)으로 렌더 | [`gitops/apps/beluga-data.yaml:5-20`](../gitops/apps/beluga-data.yaml#L5-L20); 기본값 [`gitops/charts/beluga-data/values.yaml:58-59`](../gitops/charts/beluga-data/values.yaml#L58-L59), [`:74`](../gitops/charts/beluga-data/values.yaml#L74) |
| 두 조합 모두 CI에서 렌더됨 | [`.github/workflows/sast.yml:80-92`](../.github/workflows/sast.yml#L80-L92), [`scripts/ci/check-networkpolicy-coverage.py:526-529`](../scripts/ci/check-networkpolicy-coverage.py#L526-L529), [`docs/development.md:124-131`](development.md#L124-L131) |
| 권위 있는 설정 원천과 2단계 드리프트 모델 | [`docs/configuration-sources.md:13-20`](configuration-sources.md#L13-L20), [`:63-97`](configuration-sources.md#L63-L97) |

관찰(검증됨, 승격과 관련): 48GB+에서 부트스트랩은 `--set openmetadata.enabled=true trino.workerEnabled=true`를
적용하지만, ArgoCD Application(`selfHeal: true`, `prune: true`,
[`gitops/apps/beluga-data.yaml:19-22`](../gitops/apps/beluga-data.yaml#L19-L22))은 차트 기본값을 추적합니다.
따라서 48/64GB 클러스터의 유효 구성은 버전 관리되지 않는 입력(부트스트랩 셸 환경변수)에 의존합니다. 이것이
"유효 구성을 버전 관리 입력으로 재현할 수 있다"는 수용 기준의 구체적 공백입니다.

---

## 2. 프로파일 매트릭스

열: **Development** = 현재 로컬 기본값(검증됨). **Test**, **Production-style** = **Proposed**이며, 해당 열의
"today" 문구는 그 항목에서 저장소가 현재 하는 일을 적어 공백이 드러나도록 한 것입니다. 숫자를 임의로 만든 셀은 없습니다.

| 항목 | Development (현재, 검증됨) | Test (Proposed) | Production-style (Proposed; 기준선 = 현재 TLS/인증 활성 구성) |
|---|---|---|---|
| **TLS: 엣지** | APISIX 443 HTTPS, 자체서명 내부 CA가 발급하는 cert-manager `Certificate`(`duration: 2160h`, `renewBefore: 720h`) ([`apisix-gateway.yaml:29`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L29), [`:247-260`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L247-L260), [`cert-manager-issuer.yaml:12-18`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L12-L18), `isCA` [`:28`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L28)) | Development와 동일 | 동일하되 발급자는 자체서명 내부 CA이면 안 됨. **Owner decision**: 외부/사내 CA. 현재 미정의 |
| **TLS: 클러스터 내부** | 혼재. Trino 코디네이터 HTTPS 활성([`06-trino.yaml:53-56`](../gitops/charts/beluga-data/templates/06-trino.yaml#L53-L56))이나 HTTP 리스너 유지([`06-trino.yaml:41`](../gitops/charts/beluga-data/templates/06-trino.yaml#L41), 주석 `:51-52`); Keycloak은 프록시 뒤 `--http-enabled=true`([`keycloak.yaml:332`](../gitops/charts/beluga-platform/templates/keycloak.yaml#L332)); Lakekeeper base URI는 `http://`([`04-lakekeeper.yaml:109-110`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L109-L110)); Postgres LDAP 인증은 평문이며 수용으로 문서화([`02-cnpg.yaml:38`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L38), `:46-47`); OpenLDAP은 389와 636을 함께 열며 평문 비활성 불가([`openldap.yaml:22-23`](../gitops/charts/beluga-platform/templates/openldap.yaml#L22-L23)) | 현재 미정의 | 요구사항으로는 현재 미정의. 평문 Kafka 9092(`strimzi.listenerTls: false`, [`values.yaml:35`](../gitops/charts/beluga-data/values.yaml#L35), 렌더 [`03-strimzi-kafka.yaml:64-67`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L64-L67))는 baseline에 동결된 부채([`check-kafka-listener-security.py:15-25`](../scripts/ci/check-kafka-listener-security.py#L15-L25)). 정의상 prod-style은 평문/무인증 Kafka 경로를 허용하지 않으며, Issue #6 후속이 끝나기 전까지 prod-style 선언은 차단됨(현재 기본 렌더는 이 정의 대비 공백) |
| **인증** | Trino: OAuth2(Keycloak)+PASSWORD([`06-trino.yaml:81`](../gitops/charts/beluga-data/templates/06-trino.yaml#L81)); Lakekeeper: OIDC+OpenFGA, 기본 `lakekeeper.openfga.enabled: true`([`values.yaml:53-55`](../gitops/charts/beluga-data/values.yaml#L53-L55), 게이트 [`04-lakekeeper.yaml:49`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L49), [`:111`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L111)); Kafka: 기본 **없음**(`oauthListener: false`, [`values.yaml:46`](../gitops/charts/beluga-data/values.yaml#L46)); Airflow는 로컬 admin의 `airflow standalone`([`07-airflow.yaml:161`](../gitops/charts/beluga-data/templates/07-airflow.yaml#L161), [`docs/privileged-access-inventory.md:26`](privileged-access-inventory.md#L26)) | 현재 미정의 | 모든 TLS/인증 스위치가 ON이어야 **필수**: `lakekeeper.openfga.enabled=true`, Keycloak 기반 인증, Kafka `oauthListener=true`(`aclAuthorizer`, `listenerTls` 포함, 외부 리스너 없음). 현재 기본 렌더는 이를 충족하지 **못함**(`oauthListener` 기본값 `false`; 켜면 plain 9092가 사라져 하드코딩된 소비자가 깨짐) - 이는 프로파일 정의가 아니라 정의 대비 공백임([`values.yaml:39-46`](../gitops/charts/beluga-data/values.yaml#L39-L46), 리스너 [`03-strimzi-kafka.yaml:87-98`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L87-L98)). **Owner decision**: 소비자 마이그레이션 순서 |
| **HA / 레플리카** | 단일 인스턴스: Postgres `instances: 1`([`02-cnpg.yaml:7`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L7)), Keycloak([`keycloak.yaml:285`](../gitops/charts/beluga-platform/templates/keycloak.yaml#L285)), Lakekeeper([`04-lakekeeper.yaml:69`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L69)), Trino 코디네이터([`06-trino.yaml:235`](../gitops/charts/beluga-data/templates/06-trino.yaml#L235)), Trino worker 1([`06-trino.yaml:436`](../gitops/charts/beluga-data/templates/06-trino.yaml#L436)), SeaweedFS([`01-seaweedfs.yaml:49`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L49)), APISIX([`apisix-gateway.yaml:109`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L109)), OpenLDAP([`openldap.yaml:112`](../gitops/charts/beluga-platform/templates/openldap.yaml#L112)), OpenFGA([`openfga.yaml:9`](../gitops/charts/beluga-platform/templates/openfga.yaml#L9)). Kafka `replicas: 3`([`values.yaml:25`](../gitops/charts/beluga-data/values.yaml#L25))이나 replication factor / min.isr = 1([`03-strimzi-kafka.yaml:101-104`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L101-L104)) | 현재 미정의 | 현재 미정의. **Owner decision**: 컴포넌트별 HA 목표(저장소에서 도출 가능한 수치 없음) |
| **리소스 한도** | 워크로드별 선언(템플릿 17개 파일에 `limits:`, `limits:`/`memory:` 줄 65개), 프로파일별 VM 용량을 `make validate`가 점검([`docs/development.md:124-147`](development.md#L124-L147)); Kafka CR 파드는 미선언(같은 절) | 동일한 선언 상태 점검 | 동일 점검; 리포트는 운영 사이징을 제공하지 않음을 명시([`docs/development.md:147`](development.md#L147)). **Owner decision**: 운영 사이징 목표 |
| **외부 노출** | APISIX `LoadBalancer`(MetalLB IP) ([`apisix-gateway.yaml:230-232`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L230-L232), [`values.yaml:11-12`](../gitops/charts/beluga-platform/values.yaml#L11-L12)); Kafka 외부 NodePort 리스너는 기본 **off**이나 활성화하면 `tls: false`+익명([`values.yaml:27-31`](../gitops/charts/beluga-data/values.yaml#L27-L31), [`03-strimzi-kafka.yaml:73-79`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L73-L79)); Vagrant는 게스트 30094를 호스트로 무조건 포워딩([`Vagrantfile:80`](../Vagrantfile#L80)); `prometheusGrafana.enabled`(기본 true) 시 Grafana `NodePort 30000`([`platform-services.yaml:8-19`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L19), [`values.yaml:18-19`](../gitops/charts/beluga-platform/values.yaml#L18-L19)). 6개 네임스페이스(iam, database, orchestration, streaming, analytics, platform-system)는 default-deny 없이 baseline 처리([`networkpolicy-baseline.yaml:22-48`](../scripts/ci/networkpolicy-baseline.yaml#L22-L48)) | 현재 미정의 | 현재 미정의. 요구사항(Proposed): NodePort 없음, Kafka 외부 리스너 없음, 무인증 리스너 없음 |
| **관측성** | 값 플래그로 Prometheus/Grafana([`platform-services.yaml:8`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8), 버전 `67.4.0` [`values.yaml:18-22`](../gitops/charts/beluga-platform/values.yaml#L18-L22)); APISIX 접근 로그는 stdout([`docs/privileged-access-inventory.md:45`](privileged-access-inventory.md#L45)); k8s/PostgreSQL/LDAP 감사 로그 없음([`docs/privileged-access-inventory.md:39-46`](privileged-access-inventory.md#L39-L46)) | 현재 미정의 | 현재 미정의. 감사 로그는 Issue #44 범위(기준 2-5 보류, [`docs/privileged-access-inventory.md:55-58`](privileged-access-inventory.md#L55-L58)) |
| **데이터 취급** | 합성 데이터: shop 시드([`02b-shop-seed.yaml:1-2`](../gitops/charts/beluga-data/templates/02b-shop-seed.yaml#L1-L2))와 클릭스트림 생성기([`13-clickstream-gen.yaml:1`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml#L1)); Postgres 백업 `retentionPolicy: 30d`, 스케줄 `0 0 2 * * *`([`02-cnpg.yaml:71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L71), [`:81`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L81)); object-lock/WORM 미검증([`docs/configuration-sources.md:47`](configuration-sources.md#L47)); 자격증명은 부트스트랩이 `openssl rand`로 생성, 로테이션 미확립([`docs/privileged-access-inventory.md:37`](privileged-access-inventory.md#L37)) | 현재 미정의 (Proposed: 합성 데이터만) | 현재 미정의. 요구사항(Proposed): 시드/생성기 워크로드 없음, 백업 복원 검증. **Owner decision**: 보존기간 및 데이터 분류 |

---

## 3. 개발 전용 설정 (저장소에서 도출)

저장소가 스스로 로컬/경량 또는 수용된 부채로 표시했거나, 로컬 Vagrant/MetalLB 랩에 구조적으로 묶인 설정을
나열했습니다. production-style 프로파일에서는 선택할 수 없어야 합니다.

| # | 설정 | 개발 전용인 이유 | 근거 |
|---|---|---|---|
| 1 | `VAGRANT_PROVIDER`, `SUBNET_PREFIX`, 노드 IP, `METALLB_IP_RANGE`, `APISIX_LB_IP` | 로컬 VM 랩 네트워크 | [`configs/cluster.env:7-18`](../configs/cluster.env#L7-L18) |
| 2 | `BASE_DOMAIN=local.beluga.internal` + 자체서명 내부 CA | 라우팅 불가 도메인, 내부 CA | [`configs/cluster.env:37`](../configs/cluster.env#L37), [`cert-manager-issuer.yaml:1-4`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L1-L4) |
| 3 | `BELUGA_PROFILE`(RAM 사이징) 및 암묵적 OpenMetadata/Trino worker 토글 | RAM 적합성이지 환경이 아님 | [`scripts/common/env.sh:32-89`](../scripts/common/env.sh#L32-L89) |
| 4 | `strimzi.listenerTls: false`(평문 9092) | 클러스터 내부 소비자 파손 방지를 위한 의도적 범위 분리 | [`values.yaml:32-35`](../gitops/charts/beluga-data/values.yaml#L32-L35) |
| 5 | `strimzi.externalListenerEnabled: true`(NodePort, TLS 없음, 익명) | 랩 호스트 접근용; 보안 부채 | [`values.yaml:27-31`](../gitops/charts/beluga-data/values.yaml#L27-L31), [`Vagrantfile:80`](../Vagrantfile#L80) |
| 6 | Kafka replication factor / min.isr = 1 | 단일 복제본 토픽 | [`03-strimzi-kafka.yaml:101-104`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L101-L104) |
| 7 | (프로파일 선택지 아님) `strimzi.opaAuthorizer: true` | 개발을 포함한 모든 프로파일에서 무효: 플러그인 JAR가 든 커스텀 이미지가 필요하나 존재하지 않아 브로커 기동 실패(P4 참조). 차트가 스위치를 노출하므로 기재 | [`03-strimzi-kafka.yaml:44-46`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L44-L46), [`values.yaml:36-37`](../gitops/charts/beluga-data/values.yaml#L36-L37) |
| 8 | `lakekeeper.openfga.enabled: false` | 인가 백엔드 비활성(기본값이 아닌 약화) | [`04-lakekeeper.yaml:49`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L49), on/off 모두 [`tests/15-lakekeeper-authz-render.sh:7-8`](../tests/15-lakekeeper-authz-render.sh#L7-L8)에서 검증 |
| 9 | HTTPS와 함께 유지되는 Trino 평문 HTTP 리스너 | "인증 전환 전까지 유지" | [`06-trino.yaml:41`](../gitops/charts/beluga-data/templates/06-trino.yaml#L41), `:51-52` |
| 10 | 평문 LDAP simple-bind의 Postgres 인증, `0.0.0.0/0` | 클러스터 내부 평문 수용으로 문서화 | [`02-cnpg.yaml:38`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L38), [`:46-47`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L46-L47) |
| 11 | Airflow `standalone` 로컬 admin | 단일 프로세스 로컬 모드 | [`07-airflow.yaml:161`](../gitops/charts/beluga-data/templates/07-airflow.yaml#L161) |
| 12 | `prometheusGrafana` NodePort 30000 | 노드 직접 접근 | [`platform-services.yaml:12-19`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L12-L19) |
| 13 | shop 시드·클릭스트림 생성기 워크로드; 합성 토픽 위 `flink.sqlJobsEnabled` 파이프라인 | 합성 데이터 소스 | [`02b-shop-seed.yaml:1-2`](../gitops/charts/beluga-data/templates/02b-shop-seed.yaml#L1-L2), [`13-clickstream-gen.yaml:1`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml#L1), [`14-flink-jobs.yaml:2`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L2) |
| 14 | `instances: 1` / `replicas: 1` 단일 인스턴스 | HA 없음 | HA 행 참조 |

개발 전용은 아니지만 관련: `oauthListener: true`는 production-style에서 필수(2절 인증 행)인 보안 기능이지만 *현재 plain-9092 소비자와 호환되지 않아*
([`values.yaml:39-46`](../gitops/charts/beluga-data/values.yaml#L39-L46)) 개발 설정이 아니라 마이그레이션 차단 요인입니다.

---

## 4. 사전 점검에서 실패해야 하는 잘못된 조합 (요구사항, 설계 전용)

여기서는 스크립트를 추가하지 않습니다. **Proposed 위치:** 기존 래칫(예:
[`check-kafka-listener-security.py`](../scripts/ci/check-kafka-listener-security.py))과 같은 형태의 단일 검사기
`scripts/ci/check-environment-profile.py`를 `make validate`([`Makefile:50`](../Makefile#L50), 기존 렌더 기반 게이트 옆)에서
실행하고 CI 단계 동등성 검사([`scripts/ci/check-ci-stage-parity.py`](../scripts/ci/check-ci-stage-parity.py))에 등록합니다.
두 번째 진입점은 VM 생성 전 `scripts/up.sh` 최상단에서 같은 함수를 실행합니다(현재 `up.sh`에는 검증 단계가 없고 환경 파생은
`scripts/common/env.sh`가 담당). 검사기는 프로파일 이름과 유효 값(helm `--set` + env)을 받아
[`scripts/generate_sizing_report.py`](../scripts/generate_sizing_report.py)처럼 두 차트를 렌더하고 fail-closed로 동작합니다.

| ID | 잘못된 조합 | 적용 | 검사기가 읽는 위치 |
|---|---|---|---|
| P1 | production-style에서 `tls: false` 또는 무인증인 렌더된 Kafka 리스너(현재 `plain`, `external`) | prod-style | 렌더된 `Kafka` CR; 기존 baseline이 동결한 데이터([`check-kafka-listener-security.py:15-25`](../scripts/ci/check-kafka-listener-security.py#L15-L25)). P1은 prod-style 정의의 일부: P1을 실패하는 렌더는 유효한 prod-style 렌더가 아니며 Issue #6 완료 전까지 prod-style 선언은 차단됨. 현재 기본 렌더는 이를 위반(공백). 열려 있는 것은 순서/시점뿐(**Owner decision**: 검사기가 빌드를 실패시키기 시작하는 시점, Kafka 소비자 마이그레이션 순서) |
| P2 | `strimzi.externalListenerEnabled=true` | test, prod-style | values; 렌더된 리스너 `type: nodeport` |
| P3 | `lakekeeper.openfga.enabled=false` | test, prod-style | values; 렌더된 Lakekeeper env에 `LAKEKEEPER__AUTHZ_BACKEND=openfga` 부재([`04-lakekeeper.yaml:111-113`](../gitops/charts/beluga-data/templates/04-lakekeeper.yaml#L111-L113)) |
| P4 | 커스텀 이미지 없이 `strimzi.opaAuthorizer=true` | 전체 | values; 렌더된 Kafka 이미지 |
| P5 | 소비자가 여전히 `beluga-kafka-kafka-bootstrap:9092`를 가리키는 상태에서 `strimzi.oauthListener=true` | 전체 | 렌더된 Deployment/Job env 스캔(Debezium, clickstream-gen)과 렌더된 리스너 대조([`values.yaml:39-43`](../gitops/charts/beluga-data/values.yaml#L39-L43)) |
| P6 | `certManager.enabled=false`인데 게이트웨이 `Certificate`가 그대로 렌더됨 | 전체 | 발급자 파일은 게이트됨([`cert-manager-issuer.yaml:5`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L5))이나 `apisix-gateway.yaml`의 `Certificate`에는 게이트 없음([`:247-260`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L247-L260)); 렌더된 `Certificate`->`ClusterIssuer` 참조 검사 |
| P7 | `BELUGA_PROFILE`이 {32,48,64}가 아님 | 전체 | env; **수정됨**: `apply_ram_profile`이 거부(exit 1, 허용값 출력), `tests/18-profile-validation.sh`로 검증. 이전에는 128이 32GB 사이징을 타면서 `-ge 48`도 만족(OpenMetadata on) |
| P8 | prod-style에서 `BASE_DOMAIN=local.beluga.internal`, 자체서명 내부 CA, MetalLB/Vagrant 프로바이더 변수 | prod-style | env + 렌더된 `ClusterIssuer`의 `selfSigned`([`cert-manager-issuer.yaml:18`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L18)) |
| P9 | prod-style에서 `prometheusGrafana` NodePort Service 또는 모든 `type: NodePort` | prod-style | 렌더된 Service |
| P10 | ArgoCD Application 소스와 다른 helm `--set`/env 입력(`openmetadata.enabled`, `trino.workerEnabled`의 부트스트랩 vs GitOps 불일치) | test, prod-style | `01-argocd-bootstrap.sh:358-361` 입력과 Application 매니페스트 비교; Application이 프로파일 값을 담을 때까지 실패(6절 참조) |
| P11 | `development`, `test`, `production-style`이 아닌 프로파일 이름 | 전체 | 검사기 인자 자체 |

이슈가 요구한 프로파일별 렌더 매니페스트 정책 검사: P1, P2, P3, P6, P8, P9는 프로파일별 `helm template` 출력에 대한
렌더 시점 단언이고, P7과 P10은 입력 검사입니다.

---

## 5. 유효 구성 출처(provenance)

재사용할 기존 메커니즘은 릴리스 증거 번들입니다. 현재 번들에는 `manifest.json`(`schema`, `version`, `commit`, SBOM/인벤토리 파일명),
CycloneDX SBOM, 라이선스 인벤토리와 선언 상태 플랫폼 자산 인벤토리, NOTICE·LICENSE, `SHA256SUMS`가 있고 검증은 오프라인 fail-closed입니다
([`scripts/release/evidence_bundle.py:1-15`](../scripts/release/evidence_bundle.py#L1-L15),
[`:35`](../scripts/release/evidence_bundle.py#L35), [`:87-89`](../scripts/release/evidence_bundle.py#L87-L89)).
릴리스 게이트가 이를 실행합니다([`.github/workflows/release.yml:1-8`](../.github/workflows/release.yml#L1-L8), `make release-evidence` [`Makefile:133-141`](../Makefile#L133-L141)).

**현재 기록되지 않는 것:** 프로파일, `BELUGA_PROFILE`, 두 기능 플래그, helm `--set` 값, `configs/cluster.env`, 렌더된 매니페스트 해시.
자산 인벤토리는 helm이 고정된 조합 집합(`default`, `48GB+`, `oauth`, `acl`, `external`, `all-enabled`,
[`generate_platform_asset_inventory.py:30-40`](../scripts/generate_platform_asset_inventory.py#L30-L40))으로 렌더한 "선언 상태"이며 각 자산에 프로파일 소속이 표시됩니다.
따라서 48GB+ 부트스트랩 조합은 포함하지만, 릴리스/클러스터가 **실제로 어느 조합을 썼는지**는 기록하지 않고, 목록 밖 조합(예: `lakekeeper.openfga.enabled=false`,
`strimzi.listenerTls=true`, `strimzi.opaAuthorizer`, `flink.sqlJobsEnabled=false`)과 env 파생 입력도 기록하지 않습니다.

**Proposed**(릴리스는 `SHA256SUMS`가 포함하는 추가 번들 파일로 다음을 기록):

1. 프로파일 이름과 전체 유효 values 파일(버전 관리 파일, 6절), 그리고 `--set` 오버라이드 목록(비어 있어야 함);
2. `configs/cluster.env` 내용 해시와 `scripts/common/env.sh` 해시(사이징과 플래그를 결정);
3. 렌더된 각 차트(`helm template`)의 SHA-256과 helm 버전(번들은 이미 CI 버전 `v3.16.4`로 helm을 고정, [`evidence_bundle.py:75`](../scripts/release/evidence_bundle.py#L75));
4. 차트 `version`/`appVersion` 및 이미지 다이제스트(렌더된 이미지 집합은 이미 인벤토리화됨);
5. 프로파일 사전 점검(4절) 결과(통과/실패와 검사기 버전).

재현성 테스트(**Proposed**): 현재 `evidence_bundle.py verify`는 재렌더하지 않습니다. 체크섬, manifest/SBOM 식별, 동봉 파일과 체크아웃의 일치만 확인하며
자산 인벤토리를 재생성하지 않는다고 명시합니다([`evidence_bundle.py:5-12`](../scripts/release/evidence_bundle.py#L5-L12)). 따라서 제안 검사는 신규 작업입니다:
릴리스 커밋에서 기록된 프로파일 values 파일로 두 차트를 재렌더(고정 버전 helm 필요)해 기록된 렌더 해시와 비교하는 별도 단계.

---

## 6. 승격: development -> test -> production-style

**Proposed 메커니즘**(설계 전용): 프로파일마다 버전 관리되는 values 파일 하나(예:
`gitops/profiles/{development,test,production-style}.yaml`)를 두고 ArgoCD Application(`helm.valueFiles`)과 부트스트랩
`helm template -f`가 참조하게 하여 두 개의 임시 `--set` 플래그를 대체합니다. 이로써 1절의 부트스트랩 vs GitOps 불일치가 사라집니다.

| 단계 | 변경 내용 | 각 단계의 테스트 가능성 (기존 + 제안) |
|---|---|---|
| dev -> test | values 파일 전환; 개발에서 ON인 보안 기능은 ON 유지; HA/사이징은 작게 유지 가능 | 기존: `make validate`([`Makefile:50-124`](../Makefile#L50-L124)) — NetworkPolicy 래칫, K8s 보안 baseline, TLS 인증서 인벤토리, 이미지 불변성 포함; CI가 두 RAM 조합을 렌더([`sast.yml:80-92`](../.github/workflows/sast.yml#L80-L92)). 제안: `test`용 사전 점검 P2-P4, P7, P10 |
| test -> prod-style | 내부 CA 교체, 개발 전용 항목(3절) 제거, 오너 목표에 따른 HA 활성, P1/P5에 따라 리스너 폐쇄 | 제안: 사전 점검 P1-P11 전부 통과; 클러스터 대상 `make drift-live`([`Makefile:152`](../Makefile#L152), [`docs/configuration-sources.md:106`](configuration-sources.md#L106))가 비인가 드리프트 없음 보고; 새 provenance 파일을 포함한 증거 번들이 오프라인 검증 통과 |
| 모든 단계 | 승격 기록 | 릴리스 증거 번들(5절); `AGENTS.md`의 독립 리뷰 상태 규칙은 그대로 적용 |

---

## 7. 공백과 오너 결정

Issue #24 수용 기준 대비 공백:

| 기준 | 이 문서 이후 상태 |
|---|---|
| 지원 프로파일이 문서화됨 | 문서화됨(설계); 이를 강제하는 메커니즘 없음 |
| Production-style 프로파일에 명시적 보안 기본값 존재 | 미충족: values/프로파일 파일이 없고, 현재 기본값에는 평문 Kafka 리스너와 Postgres LDAP 평문이 남아 있음 |
| 잘못된 프로파일 조합이 사전 점검에서 실패 | 미충족: 요구사항만 나열(4절), 스크립트 없음 |
| 유효 구성을 버전 관리 입력으로 재현 가능 | 미충족: 부트스트랩 `--set`/env 입력이 버전 관리되지 않음(1절) |
| 승격이 문서화되고 테스트 가능 | 문서화됨(6절); 제안된 테스트는 아직 없음 |

필요한 오너 결정: (1) 순서/시점만: P1 강제 시점과 Issue #6 소비자 마이그레이션 순서(정의는 고정: Kafka `plain`/`external`이 있으면 prod-style 선언 불가); (2) 운영 CA와 도메인(P8); (3) HA, 리소스, 보존기간 목표(저장소에 값 없음); (4) 프로파일 파일 구조와 ArgoCD Application이
값을 담을지 여부(6절); (5) `test`가 prod-style 보안을 완전히 미러링해야 하는지(권장: 예, 크기/HA만 다르게).
