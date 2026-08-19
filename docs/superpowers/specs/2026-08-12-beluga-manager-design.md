# beluga manager — IAM 컨트롤 플레인 설계서

- 작성일: 2026-08-12
- 상태: 승인됨 (브레인스토밍 완료)
- 선행 노트: `2026-08-12-iam-control-plane-notes.md` — 현황 실측과 문제 정의
- 상위 설계: `2026-08-09-beluga-data-platform-design.md` §10 (D18 매트릭스 · D19 상속 · D20 계정 통합)

## 1. 개요

**beluga manager**는 데이터 플랫폼의 권한을 한 곳에서 선언하고 여러 집행 지점에 컴파일하는
컨트롤 플레인이다. 화면을 모으는 일이기 전에 **끊긴 권한 사슬을 잇는 일**이다.

선행 노트가 실측한 간극:

- Keycloak에 `group-ldap-mapper`가 없어 **LDAP 그룹이 Keycloak으로 넘어오지 않는다** —
  §10.1의 `사용자 → 그룹 → 롤` 사슬에서 그룹→롤 구간이 비어 있다.
- PostgreSQL은 **공유 계정 3개**로 접속되어 개인 감사도 행 수준 통제도 원리적으로 불가능하다.
- `ALTER DEFAULT PRIVILEGES`가 신규 테이블에 analyst SELECT를 자동 부여해 §10.1의
  "기본은 거부" 원칙을 정반대로 뒤집고 있다.

manager의 첫 번째 일은 이 셋을 메우는 것이다.

### 범위

첫 릴리스는 **IAM 컨트롤 플레인**이다. 관측 대시보드·데이터 카탈로그·셀프서비스는 이후 슬라이스로
남긴다. 첫 릴리스가 반드시 하는 것 네 가지:

1. 사용자·그룹 관리 (CRUD)
2. 권한 매트릭스 뷰어 + 편집
3. 드리프트 감지·동기화
4. 접근 감사 타임라인

### 비범위

- 관측/운영 대시보드 (narwhal-portal이 담당하는 영역의 beluga판 — 이후 슬라이스)
- 데이터 카탈로그·쿼리 워크벤치 (OpenMetadata·Superset이 이미 제공)
- 신규 정책 엔진 — **OPA를 재사용한다.** 엔진이 둘이 되면 §10.1이 경계한 "계층마다 상속을
  다르게 구현해 생기는 편차"가 그대로 발생한다.

## 2. 결정 레지스트리 (M-Registry)

| ID | 결정 | 근거 | 탈출구 |
|----|------|------|--------|
| M1 | 첫 슬라이스 = IAM 컨트롤 플레인 | 다른 화면들은 권한 사슬 위에 얹힌다. 사슬이 끊긴 채 대시보드를 먼저 만들면 보여줄 진실이 없다 | 슬라이스 순서는 조정 가능 |
| M2 | 쓰기 경로 = 하이브리드 (Git 원천 + 즉시 적용) | 감사 추적과 UI 반응성을 모두 확보. 순수 GitOps는 긴급 차단이 느리고, 런타임 직접은 재설치 시 정책 유실 | 드리프트가 감당 안 되면 순수 GitOps로 후퇴 |
| M3 | PG 집행 = Trino 기본 + psql 예외 (둘 다) | 일반 사용자는 Trino 경유로 OPA 정책이 그대로 적용되고, 운영자·엔지니어는 개인 PG 롤로 직접 접속. 집행 지점이 둘이므로 **드리프트 감지가 필수 기능**이 된다 | psql 요구가 사라지면 경로 A(Trino 단일)로 수렴 |
| M4 | 별도 리포 `beluga-manager` | narwhal-portal 선례 승계. UI 빌드·배포 주기가 플랫폼과 다르고 의존성이 완전히 분리됨. 정책 원천(Git)은 beluga 리포에 두고 manager가 그곳에 커밋 | 단일 리포 통합 가능(경로만 이동) |
| M5 | 아키텍처 = BFF 단일 앱 + 동기화 워커 | 자격증명이 브라우저에 노출되지 않는 것이 IAM 도구의 필수 조건. 오퍼레이터(CRD) 방식이 더 정석이나 첫 릴리스에 Go 오퍼레이터 개발 비용은 과함 | 정책 종류가 늘면 워커를 오퍼레이터로 승격 |
| M6 | PG 보안 = 마스킹 + 암호화 + 감사 전부 | 분석 가치를 살리면서 PII를 지키려면 전면 차단보다 마스킹이 맞다 | 단계적 적용 가능(§7 단계) |
| M7 | 마스킹 경로 = PostgreSQL 18 승급 후 `anon` 도입 | CNPG 선언적 확장(`spec.postgresql.extensions[]`)은 **PG18 이상 전용**이라 17.6에서는 경로가 없다(2026-08-12 검증). 레지스트리 부재로 자체 빌드도 불가 | Trino 컬럼 마스킹만으로 축소 가능 |
| M8 | 프런트 스택 = Next.js 16.3.0 + React 19.2.8 | 2026-08-12 npm `latest` 실측. narwhal-portal(16.2.6)의 한 마이너 앞 — D17 최신 안정판 핀 | — |

## 3. 검증된 전제 (2026-08-12)

설계가 의존하는 사실이라 근거와 함께 남긴다. 재확인 시 아래 출처를 볼 것.

| 전제 | 결과 | 근거 |
|---|---|---|
| Trino OPA 컬럼 마스킹·행 필터 | **지원**. Release 438부터 `getColumnMask`/`getRowFilters`, 483 문서 유지. 행 필터는 `{"expression":"..."}` 배열(AND 결합), 컬럼 마스킹은 컬럼당 단일 객체 | trino.io/docs/current/security/opa-access-control.html |
| CNPG 선언적 확장 | **PG18 이상 전용**. `spec.postgresql.extensions[]` 필드는 존재하나 문서가 "PostgreSQL 18 or later required" 명시 → PG17.6에서는 사용 불가 | cloudnative-pg.io 문서 |
| `anon` 공개 아티팩트 | 공식 CNPG 확장 컨테이너는 **pgaudit만** 게시. dalibo 이미지는 PG17 태그 없음 + 확인된 태그는 amd64 단일 | 레지스트리 API 조회 |
| Keycloak `group-ldap-mapper` | `providerId=group-ldap-mapper`, `providerType=org.keycloak.storage.ldap.mappers.LDAPStorageMapper`. 필수 config: `groups.dn`, `group.name.ldap.attribute`, `group.object.classes`, `membership.ldap.attribute`, `membership.attribute.type`, `membership.user.ldap.attribute`, `mode`. **Keycloak→LDAP 쓰기는 `mode: LDAP_ONLY`만 가능** | keycloak.org server_admin, GroupMapperConfig.java |

## 4. 아키텍처 (M5)

```
브라우저 ──OIDC──▶ [ beluga-manager (Next.js 16.3) ]
                      │  web     : 화면. 자기 API만 호출
                      │  api     : 인증/인가 + 오케스트레이션 (BFF)
                      │  compiler: 선언 → 산출물 (순수 함수, 네트워크 모름)
                      │  adapters: keycloak / ldap / opa / pg / trino
                      ▼
        ┌─────────────┼──────────────┬─────────────┐
     Keycloak      OpenLDAP        OPA           PG / Trino
     (롤·그룹)     (계정 저장)    (정책 번들)    (GRANT·RLS·마스킹)
                      ▲
                      │ Git 커밋 (정책 원천)
              [ beluga 리포 policies/ ]
                      ▲
              [ sync worker (CronJob) ] ── 선언 vs 실제 대조 → 드리프트 리포트
```

### 4.1 경계와 책임

세 단위가 각각 하나의 일만 한다.

- **compiler** — 선언을 받아 산출물을 만든다. **네트워크를 모른다.** 순수 함수라 단위 테스트로
  "이 선언은 이 GRANT가 된다"를 고정할 수 있다. 집행 지점이 둘이어도 산출물이 한 곳에서
  나오므로 갈라지지 않는다.
- **adapters** — 네트워크만 안다. **정책 의미를 모른다.** 각 시스템에 대해 두 가지만 노출한다:
  `readState()` (현재 상태를 정규화해 반환), `apply(artifact)` (산출물을 적용).
- **api (BFF)** — 둘을 잇고 인증·인가·Git 커밋을 담당한다. 자격증명은 여기서 끝난다 —
  브라우저로 내려가지 않는다.

### 4.2 자격증명 취급

manager가 각 시스템에 접근할 자격은 D15 방식으로 부트스트랩이 생성해 Secret에 넣고,
manager 파드가 env로 받는다. 브라우저는 manager 세션 쿠키만 갖는다.

manager 자체 로그인은 Keycloak OIDC(신규 클라이언트 `manager`)이며, `admins` 롤
보유자만 쓰기가 가능하다. `engineers`는 읽기 전용으로 매트릭스·드리프트·감사를 볼 수 있다.
(롤 이름은 이후 `analysts`/`engineers`/`admins`로 개명됐다 — D-F, 2026-08-19.)

## 5. 정책 선언과 컴파일

### 5.1 선언 스키마

정책 원천은 beluga 리포 `policies/` 아래 YAML이며, 설계서 §10 매트릭스와 1:1 대응한다.

> **갱신 (2026-08-19)**: 아래 예시의 롤 이름은 OpenLDAP 그룹 `cn`에 맞춰
> `analysts`/`engineers`/`admins`로 개명됐다(D-F). 구현 과정에서 스키마 자체도 진화했다 —
> 예를 들어 카탈로그/쿼리 수준 오퍼레이션을 위한 `policies/catalog.yaml`
> (`catalogGrants`)이 추가됐고, PII 컬럼 표현이 `sensitiveColumns`/`allowUnmasked` 쪽으로
> 바뀌는 등 컬럼 마스킹·행 필터 필드는 실제 구현과 차이가 있을 수 있다. 정확한 현재
> 스키마는 이 예시가 아니라 beluga 리포 `policies/*.yaml`과 beluga-manager 리포의
> 컴파일러 소스를 따를 것.

```yaml
# policies/roles.yaml — D19 롤 계층 (컴포지트 상속)
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
  - name: admins
    includes: [engineers]

# policies/groups.yaml — 그룹 → 롤 (D19 주체 모델)
groups:
  - name: analyst
    roles: [analysts]
  - name: engineer
    roles: [engineers]
  - name: admin
    roles: [admins]

# policies/resources.yaml — D18 매트릭스
resources:
  - resource: lake.events_enriched
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
      - roles: [engineers]
        privileges: [select, insert, update, delete]

  - resource: lake.customers
    classification: pii
    grants:
      - roles: [engineers]
        privileges: [select, insert, update, delete]
      - roles: [analysts]
        privileges: [select]
        columnMask:
          email: hash          # 읽되 값은 가림
        rowFilter: "region = 'KR'"
```

**설계 변경 하나**: 현재 매트릭스는 analyst에게 `customers`를 전면 차단하지만, 마스킹 도입 후에는
**읽되 이메일을 가리는** 형태로 바꾼다. 분석 가치를 살리면서 PII를 지키는 쪽이 실무에 맞다.
전면 차단이 필요한 자원은 `grants`에서 해당 롤을 빼는 것으로 표현한다(allow-by-role).

### 5.2 컴파일 대상

| 대상 | 산출물 | 적용 방법 |
|---|---|---|
| Trino | Rego (`allow` + `getColumnMask` + `getRowFilters`) | OPA 정책 ConfigMap 갱신 → OPA 롤(정책 체크섬 어노테이션) |
| PostgreSQL | DDL (`GRANT`/`REVOKE`, `CREATE POLICY`, `SECURITY LABEL`) | 마이그레이션 Job이 `psql`로 적용 |
| Keycloak | 롤·그룹 명세 (컴포지트 롤, 그룹→롤, `group-ldap-mapper`) | Admin REST API |

### 5.3 컴파일러 불변식

1. **순수 함수** — 입력은 선언, 출력은 산출물. 네트워크·시계·난수 없음.
2. **결정론적** — 같은 입력에 항상 같은 출력. 드리프트 비교가 이것에 의존한다.
3. **allow-by-role만** — deny 규칙 금지. deny를 롤에 걸면 상속받은 상위 롤까지 막혀
   D19 상속 모델이 깨진다(§10.1의 규칙).

### 5.4 선언 검증 (컴파일 전 거부)

- 정의되지 않은 롤 참조
- 순환 상속 (`a includes b`, `b includes a`)
- `classification: pii`인데 마스킹 없이 하위 롤에 `select` 부여
  → PII 정책을 코드로 강제하는 장치
- `rowFilter`에 허용되지 않은 SQL 구문(서브쿼리·함수 호출 화이트리스트 밖)

## 6. 화면

| 화면 | 하는 일 |
|---|---|
| 개요 | 드리프트 건수, 집행 지점 연결 상태, 최근 거부된 접근 |
| 사용자·그룹 | 계정 CRUD, 그룹 배정, 비밀번호 재설정 → Keycloak·LDAP 반영 |
| 권한 매트릭스 | 그룹×리소스 격자. 셀 편집 → 권한·마스킹·행 필터 |
| 드리프트 | 선언 vs 실제 diff, 양방향 해소(재적용 / 현실 채택) |
| 감사 타임라인 | OPA 결정 로그 + pgaudit + Trino 쿼리 이력 통합 |

### 6.1 편집 흐름 — diff 게이트

권한 변경은 되돌리기 어려우므로 **적용 전에 반드시 diff를 보여준다.**

```
셀 편집 → 컴파일 → diff 미리보기(Rego / DDL / Keycloak 변경분) → 승인
        → Git 커밋(의도 확정) → 각 어댑터 독립 적용 → 결과 표시
```

## 7. 드리프트와 오류 처리

### 7.1 분산 트랜잭션을 흉내내지 않는다

집행 지점이 다섯이라 전부 성공/전부 실패를 보장할 수 없다. 대신:

1. **Git 커밋을 먼저** 해서 의도를 확정한다.
2. 각 시스템 적용은 **독립적으로** 시도한다.
3. 실패한 지점은 **드리프트로 남고** UI에 "선언됨, 미적용"으로 표시되며 재시도할 수 있다.

실패를 숨기지 않고 이미 있는 개념으로 흡수하므로 새로운 오류 상태를 만들지 않는다.

### 7.2 드리프트 분류

| 종류 | 의미 | 해소 |
|---|---|---|
| 미적용 | 선언에 있는데 실제에 없음 | 재적용 |
| 수동 변경 | 실제에 있는데 선언에 없음 | 되돌리기 또는 선언에 채택(Git 커밋) |
| 값 불일치 | 양쪽에 있으나 내용이 다름 | 선언 우선 재적용 또는 채택 |

**수동 변경 감지가 특히 중요하다** — 누군가 Keycloak 콘솔에서 직접 바꾼 것을 잡아내는 장치다.

sync worker는 CronJob으로 주기 스캔하고 결과를 CNPG의 `manager` DB에 남긴다.

## 8. 테스트 전략

| 층 | 대상 | 방법 |
|---|---|---|
| 단위 | compiler | **골든 테스트** — 선언 → 기대 산출물(Rego/DDL/Keycloak) 고정 |
| 통합 | adapters | 테스트 realm·테스트 스키마 상대로 `readState`/`apply` 검증 |
| E2E | 전체 | §5 거버넌스 데모: analyst 로그인 → `customers` 조회 시 이메일 마스킹 관측 |

컴파일러가 순수 함수인 이유가 여기서 드러난다 — 정책 의미의 회귀는 골든 테스트가 전부 잡고,
네트워크가 필요한 검증은 어댑터 층으로 좁혀진다.

## 9. 선행 작업 (manager 밖)

manager 구현 전 또는 병행해야 하는 것들. **1·2는 manager와 무관하게 지금 고쳐야 한다.**

1. ~~**`db-roles.sql`의 기본 권한 결함 수정**~~ — 해소됨(2026-08-19 확인). analyst에 대한
   `ALTER DEFAULT PRIVILEGES`가 제거됐다(`db-roles.sql:40` 주석에 근거 기록).
2. **LDAP 엔트리 실재 확인** — `ou=users`에 `beluga-*` uid가 실제로 있는지. 클러스터 미가동으로
   여전히 라이브 미검증이다(beluga-manager Task 9 known limitation).
3. ~~**Keycloak `group-ldap-mapper` 추가**~~ — 배포됨(beluga-platform
   `keycloak-group-mapper.yaml`, 2026-08-19). 라이브 동작(클러스터 재기동 후 그룹 동기화
   실응답)은 아직 미검증.
4. **PostgreSQL 17.6 → 18 승급** (M7 전제) — CNPG 메이저 업그레이드 + 소비자 6종
   (Debezium·Keycloak·Superset·Airflow·OpenMetadata·Lakekeeper) 호환 재검증 + 데이터 마이그레이션.
   **마스킹 기능은 이 작업 완료에 의존한다.**
5. **개인별 PG 롤 전환** — 공유 계정 3개를 폐기해야 RLS·개인 감사가 성립한다(M3의 psql 경로).

## 10. 리스크

| 리스크 | 대응 |
|---|---|
| PG18 승급이 소비자 호환성 문제로 막히면 마스킹 경로 상실 | Trino 컬럼 마스킹만으로 축소(M7 탈출구). PG 쪽은 뷰 기반 마스킹 + pgcrypto로 대체 |
| 집행 지점 둘(M3)로 인한 매트릭스 드리프트 | 드리프트를 1급 개념으로 설계(§7). sync worker 주기 스캔 + UI 상시 노출 |
| manager 자체가 최고 권한 표적 | 쓰기는 `admins` 롤만(D-F 개명 후 이름). 모든 변경은 Git 커밋으로 추적. 자격증명은 서버 밖으로 나가지 않음 |
| 정책 YAML과 설계서 §10 표의 이중 관리 | 표를 선언 파일에서 생성하거나, 표를 폐기하고 파일을 단일 원천으로 삼는다(구현 시 확정) |
| Keycloak `mode: LDAP_ONLY` 요구가 기존 WRITABLE 페더레이션과 충돌 | 사용자는 WRITABLE, 그룹 매퍼는 LDAP_ONLY로 분리 운용 가능한지 구현 초기에 실측 |
