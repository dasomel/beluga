# ADR-0008: Iceberg 유지보수 전용 서비스 신원

[English](0008-iceberg-maintenance-service-identity.md) | 한국어

- Status: Accepted
- Date: 2026-11-10
- Supersedes: —
- Superseded by: —

결정 ID: D-MAINT-1(신원), D-MAINT-2(프로시저 권한), D-MAINT-3(파드/TLS),
D-MAINT-4(미생성 테이블), D-MAINT-5(라이브 프로시저 입력). 오너: dasomel, 2026-11-10, 이슈 #387.

## 배경

매시간 실행하도록 선언된 `iceberg_table_maintenance` DAG는 OAuth2/PASSWORD 인증이
필요한 Trino에 무인증 HTTP CLI로 접속했고 테이블 프로시저 권한도 없었다. 실제 실행
이력은 없다. [ADR-0007](0007-dbt-core-transformation-layer-ko.md) D-DBT-9–15의
서비스 신원 계약을 따르되 dbt의 데이터 권한을 빌리거나 브라우저 인증을 변경하지 않는다.

## 결정

### D-MAINT-1: 전용 주체·그룹·자격증명

Keycloak confidential 클라이언트 `maintenance`는 서비스 계정만 켠다. 로그인 흐름,
리다이렉트, full scope, 공용 스코프 연결은 없다. 전용 매퍼는 access token과 UserInfo에
`preferred_username=svc-maintenance`, audience에 `trino`를 넣는다. 기존 매퍼 부분집합
비교와 스코프 교정은 dbt와 공유하는 작은 서비스 신원 표를 순회하며 dbt 설정은 동일하다.
LDAP은 비밀번호 없는 `svc-maintenance`와 `maintainers` 멤버십을 시딩·재동기화한다.
그룹 원천은 LDAP이며 역할 상속 간선이나 사람 멤버십은 추가하지 않는다.

부트스트랩 `ensure_cred client-secret-maintenance`가 신규·기존 클러스터의
`platform-system/beluga-credentials`에 키를 확보하고 `iam`, `analytics`에만
`keycloak-maintenance-client-secret/maintenance`로 복제한다. 공용
`keycloak-client-secrets`나 로그에 값을 넣지 않는다.
비용: 신원 하나와 Secret 사본 두 개. 탈출구: 신원 폐기 시 함께 제거한다.

### D-MAINT-2: 테이블과 프로시저를 함께 제한

`procedureGrants`는 카탈로그 `iceberg`, 테이블 `lake.orders`, `lake.customers`,
`lake.events_enriched`, `silver_shop.orders`, `gold_shop.daily_revenue`, 프로시저
`optimize`, `expire_snapshots`를 명시한다. 와일드카드는 거부한다. 생성된 OPA
`ExecuteTableProcedure` 규칙은 테이블과 프로시저가 모두 일치해야 허용한다.
`resource.table.{catalogName,schemaName,tableName}`과
`lower(resource.function.functionName)`을 검사한다(D-MAINT-5의 라이브 입력 교정).
부가 허용은 `ExecuteQuery`와 `iceberg`의 `AccessCatalog`, `FilterCatalogs`뿐이다.
PII customers를 포함해 테이블 SELECT·INSERT·DELETE·CREATE·DROP은 허용하지 않는다.
직접 Python 클라이언트는 어댑터 메타데이터 조회가 없어 고정 system 메타데이터 권한도
생략한다. Manager 개요에는 정확한 테이블·프로시저 쌍을 투영한다.
비용: 명시적 목록 관리. 탈출구: 관측된 연산을 근거로 별도 검토하며 데이터 권한을
미리 부여하지 않는다.

### D-MAINT-3: Airflow 파드와 TLS 검증·비공개 토큰 부트스트랩

매시간 스케줄과 DAG ID, `catchup=False`, 생성 시 일시정지, `max_active_runs=1`을
유지한다. `analytics`의 KubernetesPodOperator는 dbt와 동일한 태그+다이제스트 고정
`beluga-dbt` 이미지를 사용한다. Python은 Secret을 환경에서 pop하고 내부 Keycloak
토큰 URL에 `scope=openid`를 포함한 client credentials를 요청한다. JWT와
`svc-maintenance`로 `https://trino.analytics.svc.cluster.local:8443`에 접속하며 읽기
전용 `beluga-internal-ca`의 `/etc/internal-ca/ca.crt`로 인증서를 검증한다.
Trino OAuth2/UserInfo 설정은 유지한다. 각 테이블에 optimize 후
`retention_threshold => '7d'`의 expire_snapshots를 실행하고 결과를 소비한다.
실패 시 파드 스펙을 출력하지 않고 종료 시 파드를 삭제한다. 토큰·Secret은 출력하지 않는다.
비용: 토큰 하나가 실행 시간보다 오래 유효해야 한다(realm 기본 300초).
탈출구: 긴 실행에는 검토된 갱신을 도입하며 TLS 검증은 끄지 않는다.

### D-MAINT-4: 미생성 테이블만 건너뛰기

신규 클러스터에는 dbt 출력 테이블이 없을 수 있다. 테이블별 Trino `TABLE_NOT_FOUND`만
잡아 해당 테이블의 남은 프로시저를 건너뛰며 다른 오류는 태스크를 실패시킨다.
비용: 없는 테이블은 다음 실행까지 대기한다. 탈출구: 생산자 가동 후 출력 존재를 필수화한다.

### D-MAINT-5: 캡처한 라이브 프로시저 입력과 일치

2026-11-10 colima의 Trino 483 + OPA 첫 실행에서 `svc-maintenance`와 그룹
`[maintainers]`의 인증·TLS·`ExecuteQuery`는 성공했지만
`PERMISSION_DENIED: Cannot execute table procedure OPTIMIZE on iceberg.lake.orders`로
거부됐다. 결정 로그에서 캡처한 `input.action`은 다음과 같다.

```json
{"operation":"ExecuteTableProcedure","resource":{"function":{"functionName":"OPTIMIZE"},"table":{"catalogName":"iceberg","schemaName":"lake","tableName":"orders"}}}
```

이유: 문서에서 추측한 `function.name` 픽스처가 실제 직렬화 필드와 대문자 프로시저명을
가렸다. `lower(input.action.resource.function.functionName)`을 선언의 소문자 이름과
비교하며 정확한 테이블·그룹 검사는 유지한다. 구형 `.name` 형태를 포함해
`functionName`이 없으면 대체 경로 없이 거부한다.
비용: 라이브 결정 로그에서 캡처한 픽스처를 관리하고 대·소문자 허용과 거부 경계를
OPA로 재현한다. 탈출구: Trino 계약 변경 시 새 캡처 입력을 검토해 컴파일러와 픽스처를
원자적으로 갱신하며 입력 형태 불일치를 우회하려고 권한을 확대하지 않는다.

## 결과와 검증

오프라인 컴파일·OPA 허용/거부·세 프로필 신원 렌더·합성 DAG 실행은 선언 계약만
검증한다. `ALTER TABLE ... EXECUTE optimize`의 추가 연산(예: InsertIntoTable,
SelectFromColumns) 필요 여부: **to be confirmed from live OPA decision log**.
해당 데이터 권한은 미리 부여하지 않았다. 제공된 colima 증거로 프로시저 거부 전의
토큰 수용·maintainers 그룹·TLS·ExecuteQuery 성공을 확인했다. 이번 변경의 교정된
프로시저 규칙·게이트웨이 진입점·압축과 스냅샷 효과는 라이브 미검증이다.

승인된 롤아웃에서는 전용 Secret을 먼저 채우고 클라이언트 Job/DAG를 동기화한 후
Keycloak·LDAP 교정 Job을 확인한다. DAG ConfigMap 변경 후 Airflow를 명시 재시작한다.
`iceberg_table_maintenance`의 일시정지를 풀고 수동 실행한 뒤 격리 kubeconfig로
`MAINT_RUN_ID=<run-id> bash tests/28-iceberg-maintenance.sh`를 실행한다.
지정 실행의 성공과 게이트웨이의 `iceberg.lake.orders` SELECT 거부를 확인한다.
MAINT_RUN_ID가 없으면 클러스터 접근 전에 SKIP한다. 권한 변경 전 라이브 OPA 결정을
확인한다. 롤백은 원천 revert와 DAG 일시정지이며 자격증명 사본·신원 제거는 승인된
롤아웃에서만 수행한다.
