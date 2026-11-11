# ADR-0007: 거버넌스 SQL 변환 계층으로 dbt Core 도입

[English](0007-dbt-core-transformation-layer.md) | 한국어

- Status: Accepted
- Date: 2026-11-10
- Supersedes: —
- Superseded by: —

결정 ID: D-DBT-1(네임스페이스), D-DBT-2(서비스 인증), D-DBT-3(권한),
D-DBT-4(단계), D-DBT-5(공급망), D-DBT-6(빌드 게이트), D-DBT-7(초기 물질화·지표),
D-DBT-8(Linux 해시 잠금), D-DBT-9(서비스 주체·LDAP 그룹), D-DBT-10(Airflow 파드),
D-DBT-11(Trino OAuth2 검증 유지), D-DBT-12(매퍼 부분집합 비교),
D-DBT-13(스키마 역할 system 메타데이터), D-DBT-14(dbt TLS 검증), D-DBT-15(KPO 이벤트 읽기), D-DBT-16(조회 가능한 실행 감사).
오너 결정 D-DBT-1–6: dasomel, 2026-11-10, 이슈 #95.
관련 브랜치: `feat/95-dbt-core-phase-a`, `feat/95-dbt-phase-b`.

## 배경

[변환 프레임워크](../transformation-and-semantic-layer-ko.md) 4절, OD-TR-1,
Task 4는 배치 Silver/Gold 모델 도입을 제안한다. Airflow가 오케스트레이션하고
Trino가 Iceberg SQL을 실행하며 dbt Core가 SQL 의존성·테스트·문서화를 담당한다.
DuckDB는 합성 CI fixture만 처리한다. 로컬 일회용 fixture 테이블 생성은
[ADR-0004](0004-duckdb-complementary-analytics-engine-ko.md)의 1단계 데이터
플레인 읽기 전용 경계를 확장하거나 운영 쓰기를 허가하지 않는다.

## 결정

### D-DBT-1: 신규 출력 네임스페이스, 기존 소스 보존

dbt는 `iceberg` 카탈로그의 `silver_shop`, `gold_shop`에만 쓴다. 기존
`lake.orders`를 이번 도입의 Bronze 입력으로 사용하고 `lake`는 변경하지 않는다.
명명은 [#70 제안](../medallion-architecture.md)의 `<layer>_<domain>`을 따른다.
#70은 계속 미결이며 기존 테이블 이관이나 불변 원시 Bronze 구현을 뜻하지 않는다.
CI는 로컬 `fixtures` 스키마의 합성 seed로 대체한다. `generate_schema_name`은
target 접두사 없이 custom schema를 그대로 사용한다.
비용: 명시적 네임스페이스 소유권 관리. 탈출구: 별도 검토된 이관이며 `lake` 쓰기는 금지한다.

### D-DBT-2: Keycloak 서비스 인증 (Phase B)

Keycloak client-credentials OAuth2/JWT 서비스 ID로 Trino에 인증한다.
Phase A는 비밀값 없는 환경변수 기반 JWT 프로필만 추가한다. 클라이언트 생성,
토큰 발급, Trino 인증 변경은 없다. 비용: 토큰 전달·갱신·TLS 신뢰 연동.
탈출구: 인증 방식 변경 시 이 결정을 개정하며 사람/admin 자격증명을 공유하지 않는다.

### D-DBT-3: 전용 최소 권한 그룹 (Phase B)

`transformers` 같은 전용 그룹을 사용한다. CREATE/INSERT/DROP은
`silver_shop`/`gold_shop` 내부로, 소스 SELECT는 `lake.orders`로 제한한다.
PII인 `lake.customers`에는 접근 권한을 주거나 모델을 만들지 않는다.
policy-compiler의 스키마 수준 grant 확장이 필요하며 이번 변경은 기존 정책을 넓히지 않는다.
비용: 컴파일러 확장과 어댑터의 실제 연산·자체 출력 모델 읽기 권한 검증.
탈출구: 물질화에 추가 연산이 필요하면 검토된 계약을 조정하되 카탈로그·PII 포괄 권한은 금지한다.

### D-DBT-4: 두 단계로 도입

- **Phase A(이번 변경):** dbt 프로젝트, 고정 런타임 이미지 레시피·게시 워크플로,
  DuckDB CI 정상·실패 게이트, 오프라인 Trino 프로필 파싱.
  chart·Airflow DAG·OPA·Keycloak·정책 선언·라이브 변경은 없다.
- **Phase B(후속):** 서비스 ID·토큰 전달·TLS 신뢰, 스키마 단위 OPA/컴파일러 권한,
  `analytics` 네임스페이스에서 dbt를 실행하는 Airflow `KubernetesPodOperator`,
  colima 라이브 검증, OpenMetadata·계보·실행 메타데이터.

비용: Phase A는 Trino/Iceberg 실행과 라이브 권한을 입증하지 못한다.
탈출구: Phase B 증거 확보 전 배포를 보류한다. `VERSIONS.md` 배포 이미지 행과
라이선스 변경 검토는 Phase B 차트 도입 시 게시·증명된 index digest와 함께 추가한다.
그전 런타임 핀은 `images/dbt/requirements.txt`와 Dockerfile, CI 핀은
`requirements-dbt-ci.txt`에 둔다. 미리 제공된 해시 잠금 파일 둘은 보존한다.

### D-DBT-5: Core 1.12.x 고정, dbt v2 배포 제외

Apache-2.0 dbt Core **1.12.6**(1.12.x), `dbt-trino` **1.11.0**을 고정한다.
CI는 같은 Core와 `dbt-duckdb` **1.11.1**을 사용한다. Python 3.12 베이스는
제공된 amd64/arm64 index digest로 고정하고 pip에 해시를 강제한다. 이미지의
UID는 10001이며 익명 사용 통계를 끄고 OCI 소스·라이선스 라벨을 포함한다.
Flink의 네이티브 runner·digest 병합·provenance/SBOM 검증 구조를 복사한다.
PR은 게시하지 않고 main에서만 게시한다.

dbt v2는 제외한다(2026-11-10 라이선스 조사, 출처는 아래).

- **`dbt` 2.x(구 Fusion 엔진, v2 기본 설치)**는 dbt Labs 독점 dbt Product Licensing
  Agreement로 OSI 라이선스가 아니며, 소스가 공개되지 않은 구성요소를 포함한다.
  약관상 사용자의 dbt 서버 접근 차단과 로그인 경로·고지 제거가 금지되어 Beluga
  egress baseline과 충돌한다. sdist는 설치 시 `public.cdn.getdbt.com`에서 사전 빌드
  바이너리를 받는 shim이라 `pip --require-hashes`로 실제 바이너리를 검증할 수 없다.
- **`dbt-oss` 2.x(구 dbt Core v2)**는 Apache-2.0이지만, v2의 ADBC 어댑터 목록
  (Snowflake·Databricks·Redshift·BigQuery·DuckDB, 베타 Spark·ClickHouse)에 Beluga
  실행 엔진인 Trino가 없다. 설치 시 GitHub release 바이너리를 받고 드라이버도
  필요 시 내려받는다.
- **dbt Core 1.x**는 Apache-2.0으로 계속 지원된다. 1.13이 기능 추가 마지막 마이너이며,
  보안·설치 패치는 확정 종료일 없이 3~5년 이어질 예정이다. 신규 기능은 v2에만 들어간다.

버전이 2로 시작하는 다른 의존성을 금지한다는 뜻은 아니다. 비용: v2 전용 기능 미사용,
Core·어댑터 잠금 유지. 탈출구: `dbt-oss`가 Trino를 GA로 지원하고 바이너리·드라이버를
해시 고정·오프라인 벤더링할 수 있으면 이전한다. 그 전까지는 Core 1.13이 나오면 올린다.
독점 `dbt` 2.x는 어떤 경우에도 Beluga 범위 밖이다.

출처: docs.getdbt.com/docs/dbt-licensing, docs.getdbt.com/blog/comparing-dbt-and-dbt-oss,
getdbt.com/licenses-faq, docs.getdbt.com/docs/local/connect-data-platform/about-dbt-connections
(v2), PyPI 메타데이터(`dbt` 2.0.11, `dbt-oss` 2.0.11, `dbt-core` 1.12.6, `dbt-trino` 1.11.0의
`dbt-core<2.0`).

### D-DBT-6: `dbt build`로 하위 모델 실행 차단

모델 직후 테스트를 실행하는 `dbt build`를 사용한다. 상위 error 테스트 실패 시
하위 Gold 모델을 건너뛴다. 핵심 테스트는 `severity: error`, 향후 참고 테스트는
`warn`을 쓴다. `dbt run` 후 `dbt test`는 Silver 검증 전에 Gold를 실행할 수 있어
게이트가 될 수 없다. CI는 정상 fixture 빌드 성공 후 잘못된 status를 주입해
종료코드 1과 `run_results.json`의 Silver 테스트 실패·Gold `skipped`를 확인한다.
Gold 기대값, 오프라인 Trino 소스·스키마, 라이브 seed 비활성화도 검사한다.

비용·한계: 모델은 자기 테스트보다 먼저 물질화된다. 하위 실행 차단은 트랜잭션이나
원자적 후보 게시·롤백이 아니다. Gold 자체 테스트 실패는 테이블을 되돌리지 않으며
건너뛴 기존 Gold 테이블도 삭제하지 않는다. OD-TR-6 후보 격리·원자적 승격은 미결이다.
탈출구: 독자 격리를 주장하기 전에 별도 게시 메커니즘을 설계·검증한다.
후속 DAG가 `dbt run`으로 게이트를 우회하지 않도록 한다.

### D-DBT-7: 전체 테이블과 명확한 최신 상태 지표

두 모델을 table로 물질화한다. 어댑터 간 incremental merge를 먼저 도입하는 대신
DuckDB/Trino 이식성과 결정적 재빌드를 확보한다. Silver는 타입 변환·status
공백 제거/소문자화 후 `order_id`별 최신 `updated_at` 행을 유지한다. 동률은
customer ID·금액·정규화 status 내림차순(nulls last)으로 결정하며 완전히 같은
행은 동등하다. 비용: 전체 스캔과 동률 충돌의 업무상 순서 부재.
탈출구: Phase B에서 재시도·백필·Iceberg 쓰기·권한을 검증한 후 원천 순번과
incremental MERGE를 도입한다.

구매 시각이 없으므로 Gold는 최신 `updated_at`의 날짜로 묶는다. `order_count`는
모든 최신 상태, `completed_order_count`는 completed 상태 수,
`completed_revenue`는 completed 금액 합계(그 외 0)다. 구매일 매출 이력이 아닌
최신 수정일 기준 지표이며 재빌드 시 날짜·상태가 이동할 수 있다.
비용: 이벤트 시점 매출 이력 부재. 탈출구: 지표 재정의 전 구매/이벤트 시각 원천 계약을 도입한다.

### D-DBT-8: Linux 대상 해시 잠금, 의존성 게이트 변경 없음

두 잠금 파일(`images/dbt/requirements.txt`, `requirements-dbt-ci.txt`)은
`uv pip compile --generate-hashes --python-version 3.12 --python-platform
x86_64-manylinux_2_28`로 생성해 환경 마커가 없고, 기존
`scripts/ci/check-dependency-integrity.py` 문법을 그대로 통과한다. aarch64 해석이
동일함을 확인했고, 고정된 각 버전은 게시된 모든 파일의 해시를 담아 arm64 이미지
빌드도 검증된다. CI 잠금에는 오프라인 Trino 프로필 파싱을 위해 `dbt-trino`도 포함한다.
비용: 재생성 때 aarch64 동일성 재확인. 탈출구: 향후 플랫폼별로 갈리는 의존성이
생기면 게이트를 넓히지 말고 플랫폼별 잠금을 둔다.

### D-DBT-9: 주체 `svc-dbt`와 LDAP 그룹 `transformers` (B단계)

Trino의 OPA 입력 그룹은 토큰 클레임이 아니라 기존 LDAP group provider가 주체로 조회한
값이다. Keycloak 서비스 계정 토큰의 기본 `preferred_username`(`service-account-dbt`)은
LDAP에 없으므로 그룹이 비어 모든 요청이 거부된다. 그래서 confidential client `dbt`
(서비스 계정 전용)는 hardcoded-claim 매퍼로 `preferred_username=svc-dbt`를 access
token과 UserInfo에 넣고, audience 매퍼로 `trino`를 추가한다. ldapium은 비밀번호 없는
`svc-dbt` 사용자를 LDAP 그룹 `transformers`에 시드한다. LDAP이 그룹의 단일 원천으로
남는다. 비용: 서비스 신원마다 LDAP 항목 하나. 탈출구: Trino가 지원되는 OAuth2 그룹
클레임 경로를 제공하면 그룹을 토큰으로 옮긴다.

### D-DBT-10: `analytics`에서 Airflow가 띄우는 파드

DAG `dbt_shop_medallion`은 digest 고정 `beluga-dbt` 이미지로 `analytics`에
KubernetesPodOperator를 실행한다. 파드는 클러스터 내부 Keycloak URL에서 client
credentials 토큰을 받고(Keycloak hostname이 고정되어 issuer는
`https://sso.<baseDomain>/realms/beluga` 유지, 라이브 확인), `analytics/beluga-internal-ca`를
신뢰하며 HTTPS 8443으로 `dbt build --target trino`를 실행한다. 비용: 300초 토큰이 빌드보다
오래 유지돼야 한다. 탈출구: 호출마다 재발급하거나 모델이 커지면 client의 access token
수명을 늘린다.

### D-DBT-11: Trino OAuth2 검증 방식 유지

초안은 모든 호출자에 대해 Trino의 UserInfo 검증을 껐다. 기각: scope 인자 하나를 아끼려고
브라우저 SSO와 모든 토큰 소비자의 동작을 바꾸게 된다. 라이브 확인: `scope=openid` 없는
client credentials 토큰은 UserInfo에서 HTTP 403, `scope=openid`이면 HTTP 200. dbt 파드는
`scope=openid`로 요청하고 Trino 설정은 그대로 둔다. 비용: scope 인자 외 없음.

### D-DBT-12: 매퍼 교정은 config를 부분집합으로 비교

Keycloak 26은 저장한 protocol mapper config에 서버 기본값(예: `introspection.token.claim`)을
덧붙여, 딕셔너리 전체 동등 비교 때문에 colima에서 교정 Job이 반복 실패했다. 드리프트와 검증은
하나의 `mapper_matches`를 쓴다: 최상위 필드는 동일, 선언한 config 키는 모두 같은 값으로 존재,
서버가 추가한 키는 허용. 선언 키가 없거나 다르면 여전히 실패한다. 비용: 서버 추가 키는 고정하지 않음.

### D-DBT-13: 스키마 한정 역할의 system 메타데이터

dbt-trino는 relation 목록 조회에 `system.metadata.materialized_views`를 읽는다. 고정된
`system` 카탈로그 메타데이터 규칙(카탈로그 접근, `jdbc`/`metadata` 스키마만, `runtime` 제외)이
catalogGrants 역할에만 생성되었으므로 schemaGrants 역할에도 같은 규칙을 생성한다. 기존 역할
출력은 그대로다. 비용: 신규 역할마다 고정 메타데이터 가시성. 탈출구: 역할별 명시 메타데이터 grant.

### D-DBT-14: dbt의 Trino TLS 검증

dbt-trino는 `cert`가 없으면 인증서 검증을 끄고 경고만 출력하므로 DAG의 `REQUESTS_CA_BUNDLE`은
효과가 없었다. 프로젝트는 `require_certificate_validation: true`를 켜고, trino 프로필은 `cert`를
`DBT_TRINO_CERT`에서 읽으며(기본 `True`, 시스템 신뢰) DAG는 내부 CA 경로를 넘긴다. 이미지 재빌드와
핀 교체가 필요하다. 비용: CA 번들 마운트 필수, `false`는 금지.

### D-DBT-15: KubernetesPodOperator의 `analytics` 이벤트 읽기

cncf.kubernetes provider는 파드 시작을 기다리며 이벤트를 list/watch하고, 403이면 dbt가
`PASS=15`로 끝나도 task를 실패 처리했다(colima 라이브). 기존 `analytics` pod-operator Role에
읽기 전용 `events`(get/list/watch)만 추가한다. 비용: `analytics` 이벤트 가시성. 탈출구:
provider가 이벤트 조회를 끌 수 있으면 제거한다.

### D-DBT-16: 기존 Gold 스키마에 추가 전용 실행 감사

노드 결과가 있는 모든 `dbt build`는 `on-run-end` SQL 훅 세 개로 Gold 스키마·테이블을
없을 때 생성하고 `gold_shop.dbt_run_audit`에 **다중 행 INSERT 한 번**으로 추가한다.
DuckDB CI·Trino 모두 명시 타입을 사용한다. `timestamp(6)`은 시간대 없는 UTC이며
문자열·실수·bigint는 dbt 교차 DB 타입 매크로를 쓴다. 모델 물질화 밖의 테이블이라
재빌드가 교체하지 않는다. 모델·테스트·CI seed 결과마다 한 행을 추가하며 실패와
`skipped`도 기록한다. 테스트의 relation·materialization은 null, 건너뛴 모델의
relation은 예정된 출력이다. invocation ID로 묶지만 exactly-once나 위변조 방지 원장은
아니다. 훅 재실행은 중복을 추가할 수 있으므로 invocation ID·노드 ID로 진단한다.

행에는 invocation·시작 시각, Core 버전, target 이름·어댑터, 프로젝트 git revision,
오케스트레이터 run ID, 노드 ID·유형·물질화·relation, 상태·소요 시간, 알려진 영향 행 수
(미상·음수는 null), 테스트 실패 수, 512자 제한 상태·실패 요약을 담는다. 임의의 어댑터
메시지·SQL은 비밀값이나 원천 데이터가 섞일 수 있어 저장하지 않고 보호된 dbt 로그에
상세 정보를 남긴다. PR·게시 잡 모두 `github.sha`를 `VCS_REF`로 넘기며 이미지가
`BELUGA_DBT_GIT_SHA`에 굽는다(로컬 기본 `unknown`). Airflow는 템플릿 `{{ run_id }}`를
`BELUGA_ORCHESTRATOR_RUN_ID`로 넘긴다(기본 `manual`). Kubernetes provider는 시작 시
버전 고정 없이 설치된다. 공식 문서의
[`env_vars` 템플릿 필드·중첩 `V1EnvVar.value` 렌더링](https://airflow.apache.org/docs/apache-airflow-providers-cncf-kubernetes/stable/_modules/airflow/providers/cncf/kubernetes/operators/pod.html)이
이를 지원하지만 배포된 provider 버전의 런타임 확인은 남아 있다. Secret 환경변수는 유지한다.

이유: 새 버킷·서비스·권한 없이 모델·테스트 출처를 조회한다. 기존 `transformers`의
Gold create/insert/select 권한으로 충분하다. 일반 노드 실패 뒤에도 훅이 실행되며
빈 결과에는 SQL을 내지 않는다. SQL 훅을 분리해 Core의 오류 처리를 사용하므로 감사
저장소 오류가 나도 원래 노드 실패가 `run_results.json`에 남고 함께 보고된다.
정상 빌드에서 감사 쓰기만 실패하면 증거 유실을 숨기지 않고 빌드도 실패한다.
파싱·시작 실패나 `on-run-end` 이전 프로세스 종료에는 기록할 수 없다.

비용: 실행당 SQL 세 번과 Iceberg 데이터·스냅샷 증가. 현재 이 테이블의 보존 기간·압축·
스냅샷 만료는 설정하지 않는다. 유지보수 DAG의 테이블 목록과 maintainer 프로시저
allowlist에 별도 추가한 **이후에만** 유지보수 대상이며 이번에는 둘 다 변경하지 않는다.
원천 snapshot ID는 의도적으로 없다. `transformers`는 `lake.orders`만 SELECT 가능하며
`lake."orders$snapshots"`나 다른 메타데이터 테이블은 읽을 수 없다. 시각·git SHA는
코드·실행 출처이지 재현 가능한 입력 스냅샷 증거가 아니다.

탈출구: 저장 실패에는 보호된 실행 산출물·로그를 보존하고 유지보수·보존 정책 추가를
별도 검토한다. 입력 스냅샷 추적성을 주장하기 전에 테이블 한정 스냅샷 메타데이터 읽기를
별도 승인하거나 상위 시스템의 스냅샷 계약을 제공한다. 이미지 재빌드·게시 후 배포 핀을
갱신해야 라이브 감사를 검증할 수 있으며 이번 소스 변경에서는 핀을 바꾸지 않는다.

## 검토한 대안

- Airflow 직접 SQL: 모델·테스트·문서 구조의 재사용성이 낮다.
- 즉시 incremental MERGE: 재시도·어댑터/Iceberg 의미의 라이브 증거가 없다.
- DuckDB 운영 변환: ADR-0004 1단계와 이번 오프라인 범위 밖이다.
- dbt v2(독점 `dbt`, Trino 미지원 `dbt-oss`): D-DBT-5로 제외한다.

## 결과 및 후속

OD-TR-1은 dbt Core 모델링·Trino 연산·Airflow 오케스트레이션으로 결정한다.
Phase A는 로컬 fixture 동작만 입증한다. Phase B는 배포 전에 colima에서 인증,
최소 권한(PII·타 스키마 쓰기 거부 포함), 재실행·실패 차단을 실측하고 메타데이터·계보를
연동해야 한다. Docker 빌드·다중 아키텍처 게시/증명과 라이브 동작은 온라인 runner가 필요하다.
