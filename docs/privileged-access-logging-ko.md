# 권한 접근 및 데이터베이스 활동 로깅 (제안)

[English](privileged-access-logging.md) | 한국어

이슈 [#44](https://github.com/dasomel/beluga/issues/44) ("Define privileged access and database activity logging controls") 관련.

> **상태: 제안. 문서만 변경.** 이 문서는 매니페스트, 스크립트, `VERSIONS.md` 항목, 정책을 변경하지 않습니다. 저장소에 대한 모든 서술은
> 커밋 `9f74c2b`에서 읽은 `file:line`을 가집니다. 라이브 클러스터에 대한 서술은 2026-10-07에 실행한 읽기 전용 `kubectl` 명령
> ([2.2절](#22-라이브-상태-2026-10-07-실측))에서 나왔거나 **라이브 미검증**으로 표시했습니다. 외부 사실은 [출처](#출처)(접근일 2026-10-07)를 인용하며, 공식 권고를 찾지 못한 경우 그렇게 적었습니다.
> **제안** 또는 **소유자 결정**으로 표시한 수치는 저장소/업스트림 근거가 없습니다.

이 문서는 [`docs/privileged-access-inventory.md`](privileged-access-inventory.md)를 이어받습니다. 해당 문서는 수락 기준 1(인벤토리)을 이미 충족하며 시스템별 로그 위치를 나열합니다.
이 문서는 기준 2-5를 설계로 다룹니다. 관련 문서: [`docs/audit-retention.md`](audit-retention.md) (저장, 불변성, 이슈 #35),
[`docs/time-synchronization.md`](time-synchronization.md) (타임스탬프, 이슈 #45), [`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (C10 "Logging and audit trail" 행은 `gap`).

## 1. 목적과 이슈 매핑

| 이슈 #44 기준 | 다루는 위치 |
|---|---|
| 권한 접근 경로 인벤토리 | 기존 인벤토리; 반복하지 않음 |
| 보안 관련 권한 작업이 구조화된 레코드를 생성 | 3절, 4.1, 4.2 |
| DB 접근 로깅 정책 문서화 및 적용 | 4.3 |
| 보존/검토 규칙 정의 | 4.5(값은 소유자 결정; 저장은 감사 보존 문서) |
| 주기적 권한 접근 증거 보고서 생성 가능 | 4.6 |

## 2. 현재 상태 (검증됨)

### 2.1 저장소가 정의하는 것

| 시스템 | 사실 | 출처 |
|---|---|---|
| Kubernetes API (k3s) | 감사 옵션이 없는 플래그로 서버 시작 | [`02-k8s-init.sh:27`](../scripts/cluster/02-k8s-init.sh#L27) |
| PostgreSQL | `postgresql.parameters`는 `wal_level`, `max_wal_senders`, `max_replication_slots`만 설정; `pgaudit.*`, `log_connections`, `log_disconnections`, `log_statement` 없음 | [`02-cnpg.yaml:48-51`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L48-L51) |
| PostgreSQL 인증 | `pg_hba` 항목은 세 애플리케이션 로그인 롤에 대한 `host ... ldap`; 클러스터 슈퍼유저 경로는 여기에 선언되지 않음 | [`02-cnpg.yaml:46-47`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L46-L47) |
| APISIX 게이트웨이 | 액세스 로그는 `/dev/stdout`, 형식 `$remote_addr - $remote_user [$time_local] $http_host "$request" $status $body_bytes_sent $request_time`: 요청 ID나 `$remote_user` 이상의 인증 신원 없음. 관리 변경 감사는 확립되지 않음 | [`apisix-gateway.yaml:52-60`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L52-L60) |
| OPA (Trino 인가) | 결정 로그가 콘솔로 활성화됨 | [`opa.yaml:10-11`](../gitops/charts/beluga-platform/templates/opa.yaml#L10-L11) |
| Kafka | values에 따라 인가자는 OPA(`OpaAuthorizer`) 또는 Strimzi `simple` ACL | [`03-strimzi-kafka.yaml:49`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L49), [`:51-55`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L51-L55) |
| 기타 시스템 | `gitops/`와 `scripts/`(CI/릴리스/에이전트/리서치 도구 제외)에서 `audit`(대소문자 무시) 검색: 일치 없음. `gitops/`에서 `accesslog`, `slapo`, `loglevel`, `eventsEnabled`, `adminEventsEnabled`, `jboss-logging` 검색: 일치 없음 | 이 커밋 기준 검색 |
| 다른 곳의 기존 레코드 | 운영 에이전트는 UTC 타임스탬프의 구조화된 레코드를 쓰고 상관 ID를 요구(에이전트 도구이며 플랫폼 감사가 아님) | [`operations_agent.py:96`](../scripts/agent/operations_agent.py#L96), [`:123`](../scripts/agent/operations_agent.py#L123) |
| 검증기 | 증거 맵 C10 "Logging and audit trail" 행은 `gap`: 검증기 없음 | [`security-control-evidence-map.md`](security-control-evidence-map.md) |
| 로그 목적지 | 이 저장소에서 배포되는 로그 수집기나 저장소 없음(라이브 점검은 2.2) | 라이브 |

### 2.2 라이브 상태 (2026-10-07 실측)

| 측정 | 명령 | 결과 |
|---|---|---|
| k3s 서버 인자 | `kubectl get node master-1 -o jsonpath='{.metadata.annotations.k3s\.io/node-args}'` | `audit-log-path`, `audit-policy-file`, `kube-apiserver-arg` 없음. 따라서 이 어노테이션에 나타나지 않는 `config.yaml`로 설정하지 않았다면 API 감사는 꺼져 있음(**미검증**) |
| PostgreSQL 파라미터 (Cluster spec) | `kubectl get cluster.postgresql.cnpg.io -n database postgres-main -o jsonpath='{.spec.postgresql.parameters}'` | `log_destination: csvlog`, `logging_collector: on`, `log_rotation_age: 0`, `log_rotation_size: 0`, `shared_preload_libraries: ""`, `pgaudit.*` 없음, `log_connections` 없음: **pgaudit이 로드되지 않음**. SQL로 유효 값은 조회하지 않음 |
| 로그 파이프라인 | `kubectl get pods -A \| grep -E "prom\|graf\|loki\|alert\|fluent\|vector\|otel\|falco"` | 일치 없음: 실행 중인 수집기나 저장소 없음; 컨테이너 로그는 노드에만 존재 |
| Keycloak, ArgoCD, LDAP, SeaweedFS, Lakekeeper의 관리/감사 이벤트 | 애플리케이션 자격증명/API 필요 | **라이브 미검증** |

클러스터 생성 후 3일이므로 검토할 보존 이력이 없습니다.

### 2.3 사용한 업스트림 사실

- Kubernetes: 감사는 기본 활성화되지 않음; 정책 파일(`--audit-policy-file`) 필요; 수준 `None`, `Metadata`, `Request`, `RequestResponse`; 로그 및 웹훅 백엔드; 플래그 `--audit-log-path`, `--audit-log-maxage`, `--audit-log-maxbackup`, `--audit-log-maxsize`; Secret과 ConfigMap은 `Metadata`만 기록하는 것이 모범 사례 [S1].
- k3s: 감사를 기본 활성화하지 않으며 로그 디렉터리나 정책을 만들지 않음; 감사 플래그의 `kube-apiserver-arg` 항목과 최소 `Metadata` 정책 예시를 제시. 해당 페이지의 샘플 수치(30일, 백업 10개, 100 MB)는 예시이며 권고가 아님 [S2].
- pgAudit: `shared_preload_libraries`로 로드; 클래스 READ, WRITE, FUNCTION, ROLE, DDL, MISC, MISC_SET, ALL; 파라미터 로깅은 **기본 꺼짐**이며 켜면 민감한 값이 노출될 수 있음; `pgaudit.log_catalog`가 카탈로그 잡음을 줄임; `pgaudit.role`을 통한 객체 수준 감사; 항목은 표준 PostgreSQL 로그로 출력; pgAudit v17.X는 PostgreSQL 17 대상 [S3].
- CloudNativePG v1.30.0: `pgaudit.*` 파라미터가 있으면 오퍼레이터가 `shared_preload_libraries`와 확장 생성을 자동 관리; pgaudit 레코드는 JSON 로그에 `logger: pgaudit`와 `audit` 객체로 나타남 [S4]. 읽은 페이지에는 `log_connections`에 대한 언급이 없음.
- PostgreSQL 17: `log_connections` 기본 `off`, `log_disconnections` 기본 `off`, `log_statement` 기본 `none`, `log_line_prefix` 기본 `'%m [%p] '`, `log_timezone` 내장 기본 `GMT` [S5].
- Keycloak: 서버 관리 가이드에 사용자 이벤트 감사와 관리 이벤트 감사, 이벤트 리스너(`jboss-logging` 언급), 이벤트 만료, 데이터베이스 이벤트 저장이 있음; 세부 설정은 읽지 않음 [S6].
- 권한 접근 레코드의 최소 보존 기간과 검토 주기: 읽은 출처에 **공식 권고 없음**; 소유자 결정.

## 3. 수락 기준 대비 간극

| 수락 기준 | 상태 | 이유 |
|---|---|---|
| 권한 접근 경로 인벤토리 | **완료** | [`privileged-access-inventory.md`](privileged-access-inventory.md) |
| 보안 관련 권한 작업이 구조화된 레코드를 생성 | **미충족**(OPA 결정과 APISIX 액세스 로그는 부분) | API 감사 꺼짐, pgaudit 미로드, Keycloak 이벤트/관리 이벤트 설정 없음, LDAP/ArgoCD/APISIX 관리 감사 미확립; OPA 결정 로그와 게이트웨이 액세스 로그는 있으나 컨테이너 stdout으로 감 |
| 보호 대상 데이터 경로에 DB 접근 로깅 정책이 문서화되고 적용됨 | **미충족** | 이 제안 이전에는 문서화되지 않음; 적용된 것 없음; "보호 대상 데이터 경로"가 아직 정의되지 않음(4.3 참조) |
| 보존/검토 규칙 정의 | **미충족** | 규칙 없음; 저장소 없음 |
| 주기적 증거 보고서 생성 가능 | **미충족** | 보고할 레코드 소스가 없음; 인벤토리 자체는 정적 |

## 4. 제안 (모든 항목은 제안)

### 4.1 공통 레코드 내용

각 권한 작업 레코드는 행위자(신원과 인증 방식), 타임스탬프(`Z` 접미사의 UTC RFC 3339, 시간 문서 참조), 출처(주소/호스트), 대상(시스템과 객체), 작업, 결과(성공/거부/오류),
그리고 시스템이 허용하는 범위에서 게이트웨이, 애플리케이션, 데이터베이스에 걸쳐 전파되는 상관 ID를 가집니다. 요청 또는 행 페이로드는 기본적으로 기록하지 않으며(이슈 요구), Secret과 ConfigMap은 메타데이터 수준만 기록합니다 [S1].

### 4.2 시스템별 수집 메커니즘

| 시스템 | 권한 작업(인벤토리 기준) | 후보 메커니즘 | 비고 |
|---|---|---|---|
| Kubernetes | cluster-admin kubeconfig 사용, RBAC 변경, Secret 읽기 | k3s 감사 정책과 로그/웹훅 백엔드 [S1, S2] | 시작 정책 `Metadata`; Secret/ConfigMap은 `Metadata`; 보안 프로파일은 로테이션 설정 필요(**D2**) |
| PostgreSQL | 슈퍼유저/소유자 연결, 롤/DDL 변경, 보호 테이블 접근 | `ROLE`, `DDL` 클래스와 보호 테이블에 대한 객체 감사(`pgaudit.role`)를 쓰는 pgaudit; `log_connections`/`log_disconnections` 켬 [S3, S4, S5] | 파라미터 로깅은 끔 유지 [S3]; `log_timezone`을 명시 설정 [S5] |
| Keycloak | 관리 콘솔/REST 작업, 로그인 이벤트 | 로깅 리스너를 쓰는 관리 이벤트와 로그인 이벤트 [S6] | 정확한 설정은 Keycloak 페이지를 읽어야 함 |
| APISIX | 관리 API 키 사용, 라우트 변경 | 요청 ID 필드와 신원이 있는 액세스 로그; 관리 API 액세스 로그 | `apisix-gateway.yaml:60`의 형식 변경 |
| ArgoCD | sync/삭제, 관리자 로그인 | 이번 조사에서 조사하지 않음 | 소유자 후속 |
| Kafka | ACL/인가 결정 | 인가자 로깅 | 이번 조사에서 조사하지 않음 |
| OPA / Trino 인가 | 허용/거부 결정 | 기존 결정 로그(콘솔) [`opa.yaml:10-11`] | 수집하고 내용을 확인 |
| SeaweedFS, Lakekeeper/OpenFGA, OpenLDAP, Superset, Airflow | 인벤토리의 관리 신원 | 이번 조사에서 조사하지 않음 | 소유자 후속 |

### 4.3 데이터베이스 활동 정책 (보호 대상 데이터 경로)

**제안 정의**: 보호 대상 데이터 경로는 레지스트리 분류가 `pii`인 모든 테이블([`policies/data-standards.yaml:28`](../policies/data-standards.yaml#L28), [`:39`](../policies/data-standards.yaml#L39))과 모든 데이터베이스의 롤 관리 및 DDL 작업입니다.
정책: 관리 및 롤/DDL 활동은 항상 기록; 보호 테이블에 대한 읽기/쓰기 접근은 객체 감사로 기록; 문장 텍스트는 기록하고 바인드 파라미터는 기록하지 않음 [S3]; 슈퍼유저와 `beluga_admin` 세션은 항상 기록.
비보호 테이블에 대한 READ/WRITE 감사 범위는 볼륨 때문에 소유자 결정(**D3**)입니다.

### 4.4 일상 로그와 감사 증거의 분리

감사 레코드는 소스에서 태그(pgaudit `logger`, Kubernetes 감사 파일/웹훅, Keycloak 이벤트 유형)를 붙이고 일반 운영자가 수정할 수 없는 목적지로 보냅니다. 저장 및 불변성 설계는 [`audit-retention.md`](audit-retention.md)에 있습니다. 일상 애플리케이션 로그는 컨테이너 stdout에 남깁니다.

### 4.5 보존과 검토

최소 보존과 검토 주기는 소유자 값(**D1**; 공식 수치 없음)입니다. 검토란 지정된 검토자가 주기적 보고서(4.6)에 서명하는 것이며, 서명 자체도 증거로 보존합니다.

### 4.6 주기적 권한 접근 증거 보고서

읽기 전용 생성기 입력: 인벤토리(시스템, 주체, 출처), 시스템별 감사 상태(2.2와 같은 라이브 읽기로 얻은 활성/비활성), 감사 저장소의 기간별 행위자/시스템별 권한 이벤트 수.
출력: 기간, UTC 타임스탬프, 시스템별 상태, 이벤트 수, 감사 소스가 없는 인벤토리 행 목록("감사되지 않는 경로")을 담은 결정적 보고서. 이 목록은 5.2의 부정 테스트이기도 합니다.

## 5. 검증 및 테스트 아이디어

1. 정적: 인벤토리 표와 새 기계 판독 가능한 감사 소스 맵을 파싱해 인벤토리 행에 감사 소스 항목이 없거나 항목이 렌더에 없는 설정을 가리키면 실패하는 게이트.
2. 부정(보안 프로파일): 렌더에서 pgaudit 파라미터나 k3s 감사 플래그를 제거하고 게이트가 실패함을 단언.
3. 라이브(폐기 가능 클러스터): 각 시스템에서 권한 작업을 수행하고 4.1의 모든 필드를 가진 구조화된 레코드가 감사 저장소에 나타남을 단언.
4. 라이브: pgaudit이 로드되었는지(`SHOW shared_preload_libraries`)와 보호 테이블에 대한 `SELECT`가 바인드 값 없는 `READ` 레코드를 생성하는지 단언.
5. 보고서: 픽스처 이벤트 집합에 대한 보고서 생성기의 골든 파일 테스트.

## 6. 남은 소유자 결정

| ID | 결정 | 권고 |
|---|---|---|
| D1 | 최소 보존 및 검토 주기 | 감사 보존 D1과 함께 결정; 공식 수치 없음 |
| D2 | Kubernetes 감사 정책 수준과 로테이션 파라미터 | `Metadata`로 시작, Secret/ConfigMap은 `Metadata` [S1]; 로테이션 값은 소유자 선택 |
| D3 | `pii` 테이블 외 READ/WRITE 감사 범위 | `pii` 테이블과 모든 DDL/ROLE; 볼륨 측정 후 확대 |
| D4 | 로그 파이프라인/저장소(인증서, 시간, 감사 보존 이슈와 공유) | 하나의 공통 결정; 다섯 문서가 모두 여기에 의존 |
| D5 | 슈퍼유저 접근을 비상용(break-glass)으로만 할지 | 프로덕션은 예; 각 사용을 기록 |
| D6 | 여기서 조사하지 않은 시스템(ArgoCD, Kafka, SeaweedFS, Lakekeeper, LDAP, Superset, Airflow) | 각 공식 페이지를 읽은 후 시스템별 행 추가 |

## 7. 후속 구현 작업 (순서대로)

1. 폐기 가능 클러스터에서 `log_connections`/`log_disconnections`와 pgaudit `ROLE`,`DDL` 활성화; 수락: CNPG JSON `pgaudit` 로거로 레코드가 보이고 바인드 값이 없음.
2. 폐기 가능 클러스터에 k3s 감사 정책과 로그 파일 추가; 수락: `kubectl get secret`이 페이로드 없는 `Metadata` 이벤트를 생성.
3. 기계 판독 가능한 감사 소스 맵과 정적 게이트(5.1) 및 부정 픽스처(5.2) 작성.
4. Keycloak 관리/로그인 이벤트 설정; 수락: 관리 작업이 레코드를 생성.
5. 요청 ID와 관리 API 로깅이 있는 APISIX 로그 형식; 수락: 요청 ID가 끝에서 끝까지 나타남.
6. 골든 파일 테스트를 포함한 보고서 생성기(4.6).
7. 조사하지 않은 시스템을 조사하고 추가(D6).

## 출처

모두 2026-10-07 접근.

| ID | 출처 |
|---|---|
| S1 | Kubernetes, Auditing: https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/ |
| S2 | K3s, Hardening guide (audit logging): https://docs.k3s.io/security/hardening-guide |
| S3 | pgAudit README: https://github.com/pgaudit/pgaudit |
| S4 | CloudNativePG v1.30.0, Logging: https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/logging.md |
| S5 | PostgreSQL 17, Error Reporting and Logging: https://www.postgresql.org/docs/17/runtime-config-logging.html |
| S6 | Keycloak, Server Administration Guide (auditing and events): https://www.keycloak.org/docs/latest/server_admin/#auditing-and-events |
