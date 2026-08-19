# beluga manager — IAM 컨트롤 플레인 설계 노트

> 상태: **미착수 설계 노트.** beluga manager를 개발할 때 읽을 것.
> 작성 2026-08-12. 근거는 그 시점 실측이며, 재확인 명령을 함께 적어 두었다.
>
> **갱신 노트 (2026-08-19)**: beluga-manager 정책 컴파일러 SDD 실행 중 이 노트의 전제
> 하나가 틀린 것으로 확인됐다 — §4 "경로 A"의 "Trino가 JWT `groups` 클레임으로 판단한다"는
> Trino 483 공식 문서와 어긋난다(해당 절에 정정 표시). §2.1이 "없다"고 적은
> `group-ldap-mapper`는 이후 배포됐고(beluga-platform, `keycloak-group-mapper.yaml`),
> §2.3의 `ALTER DEFAULT PRIVILEGES` 결함도 이후 제거됐다(둘 다 클러스터 재기동 후 라이브
> 검증은 아직 없음). 이 노트는 2026-08-12 시점 스냅샷으로 남기고 정정만 표시한다. 현재
> 상태는 설계서 §10과 `.superpowers/sdd/2026-08-12-manager-policy-compiler/progress.md`를
> 볼 것.
>
> 이 문서가 존재하는 이유: ldapium을 검토하다 IAM 통합에 필요한 기능들이
> 나왔는데, 그것들을 ldapium에 넣으면 그 프로젝트가 LDAP 스위트가 아니라 IAM
> 컨트롤 플레인이 된다. ldapium은 beluga와 무관한 독립 프로젝트로 유지하기로 했으므로
> (그 시점 `openldap-suite/SESSION-HANDOFF.md`에 근거가 기록되어 있었다 — 현재 프로젝트명은
> ldapium이며 해당 파일은 더 이상 확인되지 않는다), 여기에 남긴다.

## 1. 한 줄 요약

**디렉터리는 비밀번호 저장소일 뿐 권한의 출처가 아니다.** 설계서 §10은 그룹을 권한 축으로
삼지만, Keycloak도 PostgreSQL도 LDAP 그룹을 읽지 않는다. 그 간극을 메우는 것이 manager의
첫 번째 일이다.

## 2. 실측한 현황 (2026-08-12)

### 2.1 Keycloak 연동 — group mapper 없음

`gitops/charts/beluga-platform/templates/keycloak-ldap-federation.yaml`은
`providerId: ldap` 컴포넌트 하나만 만든다. `group-ldap-mapper` 컴포넌트를 만들지 않으므로
**LDAP 그룹이 Keycloak으로 넘어오지 않는다.** 사용자만 임포트된다
(`editMode: WRITABLE`, `syncRegistrations: true`, `uuidLDAPAttribute: entryUUID`).

설계서 §10.1의 `사용자 → 그룹 → 롤` 사슬에서 **그룹 → 롤 구간이 비어 있다.**

### 2.2 PostgreSQL — LDAP은 인증 전용

`beluga-data/templates/02-cnpg.yaml`의 `pg_hba`:

```
host all "beluga-admin","beluga-engineer","beluga-analyst" 0.0.0.0/0 ldap
  ldapserver=... ldapbasedn="ou=users,dc=beluga,dc=internal" ldapsearchattribute="uid"
```

`pg_hba`의 `ldap` 방식에는 **인가를 위임하는 기능이 없다.** 비밀번호만 검증한다. 허용
대상은 리터럴 롤 세 개로 하드코딩되어 있고, 이는 실질적으로 **공유 계정 세 개**를 뜻한다.
개인이 자기 이름으로 붙지 않으므로 DB 감사 로그에 개인이 남지 않는다.

실측:

```
$ kubectl -n beluga-data exec postgres-main-1 -- \
    psql -U postgres -d shop -tAc \
    "select rolname, rolcanlogin from pg_roles where rolname like 'beluga%' order by 1;"
beluga-admin|t      beluga-analyst|t     beluga-engineer|t     ← LOGIN (공유 계정)
beluga_admin|t      beluga_analyst|f     beluga_engineer|f     ← 그룹 롤
```

**미확인**: `ou=users` 아래 `uid=beluga-engineer` 등의 엔트리가 실제로 존재하는지 확인하지
못했다(LDAP 관리자 비밀번호가 부트스트랩 시점 설정이라 values에 없고 익명 조회는 ACL에
막힘). **없다면 DB의 LDAP 인증은 지금 아예 동작하지 않는다.** manager 작업 시작 전에 이것부터
확인할 것.

### 2.3 기본 권한이 PII 경계를 무력화한다 — 우선 수정 대상

`beluga-data/files/db-roles.sql`:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA public TO beluga_analyst;
REVOKE SELECT ON TABLE customers FROM beluga_analyst;      -- 그 시점 그 테이블 하나만
...
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO beluga_analyst;
```

마지막 줄이 **앞으로 생성되는 모든 테이블에 analyst SELECT를 자동 부여**한다. 실측:

```
$ psql -tAc "select defaclobjtype, array_to_string(defaclacl,' | ') from pg_default_acl;"
r|beluga_admin=arwdDxtm/beluga_admin | beluga_analyst=r/beluga_admin | beluga_engineer=arwdDxtm/beluga_admin
```

`customers_v2`나 새 CDC 미러가 생기면 analyst가 즉시 읽는다. `REVOKE`는 일회성 패치다.
설계서 §10.1은 "기본은 거부, 허용만 롤로 부여"라고 못박았는데 구현은 정반대다.

**이것은 manager와 무관하게 지금 고칠 수 있고, 고쳐야 한다.** 권장: analyst에 대한
`ALTER DEFAULT PRIVILEGES` 줄을 제거하고, 테이블 허용을 명시적 GRANT로만 부여한다.
(engineer/admin의 기본 권한은 PII 접근이 허용된 롤이므로 그대로 두어도 무방하다.)

### 2.4 이미 있는 것 — 중앙 정책 엔진

```
$ kubectl get pods -A | grep -E 'opa|openfga|trino'
beluga-system    opa-...             Running
beluga-system    openfga-...         Running
beluga-data      trino-coordinator-...   Running
beluga-data      trino-worker-...        Running
$ kubectl get cm -A | grep trino
beluga-data   trino-access-control     ← OPA 기반 Trino 인가
beluga-data   trino-catalog-iceberg    ← 카탈로그는 iceberg 뿐
```

**OPA가 이미 중앙 정책 엔진으로 동작 중이다.** manager를 만들 때 정책 엔진을 새로 도입하지
말 것 — 엔진이 둘이 되는 순간 설계서 §10.1이 경계한 "계층마다 상속을 다르게 구현해 생기는
편차"가 그대로 발생한다.

**Trino 카탈로그에 postgres가 없다.** PG는 Trino를 거치지 않고 직접 접속된다.

## 3. Apache Ranger에 대한 판단

**Ranger는 도입 대상이 아니다.** Apache Ranger에 PostgreSQL 플러그인이 없다(공식 플러그인은
HDFS/Hive/HBase/Kafka/Knox/Trino 계열). 따라서 "Ranger처럼"은 Ranger 도입이 아니라 그 기능을
다른 수단으로 재현하는 문제다.

| Ranger가 하는 일 | PG 네이티브 수단 | 이 클러스터 현황 |
|---|---|---|
| 테이블 권한 | `GRANT` | 사용 중 |
| 컬럼 권한 | `GRANT SELECT (col) ON t` | 가능, 미사용 |
| 행 필터 | RLS `CREATE POLICY` | 가능, 미사용 (`relrowsecurity=f`) |
| 컬럼 마스킹 | 네이티브 없음 → `anon` 확장 또는 뷰 | **확장 없음** |
| 태그 기반 정책 | `SECURITY LABEL` | 가능하나 직접 구현 |
| 접근 감사 | `pgaudit` | 설치됨 (활성 여부 미확인) |
| 중앙 정책 저장소 | 없음 — 컴파일러 필요 | OPA 재사용 |

실측 (PostgreSQL 17.6):

```
$ psql -tAc "select name from pg_available_extensions where name in
    ('pgaudit','anon','pgcrypto','pg_stat_statements','set_user','sepgsql');"
pg_stat_statements
pgaudit
pgcrypto
```

`anon`(PostgreSQL Anonymizer, 동적 마스킹)이 없다. 마스킹까지 하려면 CNPG 커스텀 이미지가
필요하다.

### 3.1 선행 조건 — 공유 계정을 먼저 없애야 한다

**행 수준 통제는 지금 원리적으로 불가능하다.** RLS는 `current_user`로 판단하는데 로그인 롤이
셋뿐이고 모두 공유된다. 개인별 PG 롤 전환이 모든 세밀 통제의 전제다.

## 4. 두 가지 경로

### 경로 A — Trino를 PG 앞에 세운다 (권장)

`trino-catalog-postgres`를 추가하고 PG 직접 접속을 NetworkPolicy로 차단한다.

- **이미 작성된 OPA 정책이 PG에도 그대로 적용된다.** 새 정책 엔진도, 개인 PG 롤도 필요 없다
  (Trino가 OPA에 groups를 실어 보내므로).

  > **정정 (2026-08-19)**: 이 노트는 Trino가 Keycloak JWT의 `groups` 클레임을 읽는다고
  > 가정했는데, 이는 틀렸다 — Trino 483 공식 문서 확인 결과 `input.context.identity.groups`
  > 는 Trino **group provider**(file 또는 ldap)만 채우며 OAuth2/OIDC 클레임에서는 오지
  > 않는다(OAuth2 속성에 groups 자체가 없다). 실제 경로는 **LDAP group provider**가
  > OpenLDAP을 직접 조회하는 것이다(D-D). 경로 A의 결론("OPA 정책이 PG에도 그대로 적용된다")
  > 은 여전히 유효하다 — Trino가 어느 경로로 groups를 채우든 이후 OPA 평가는 동일하기
  > 때문이다. 자세한 내용은 `2026-08-12-beluga-manager-design.md`와 실행 원장을 볼 것.
- 설계서 §10.2의 "Trino: analyst는 `customers` 차단"이 PG로 자동 확장된다.
- 집행 지점이 하나로 줄어 매트릭스 드리프트가 사라진다.
- **성립 조건**: `psql` 직접 접속 요구가 없어야 한다. 있다면 이 경로는 불가.

### 경로 B — PG 네이티브로 집행한다

개인 롤 + 컬럼 GRANT + RLS + `pgaudit`. 정책 원천은 OPA(또는 manager의 선언)에 두고,
그것을 GRANT/POLICY DDL로 **컴파일해 적용하는 잡**을 만든다.

- 필요: 개인별 PG 롤 전환, `pg_hba`를 `all`로 열고 인가는 GRANT가 담당하도록 변경
- 마스킹까지 원하면 `anon` 포함 CNPG 커스텀 이미지
- 장점: `psql` 직접 접속 유지, DB 감사 로그에 개인이 남음

## 5. manager가 ldapium에 요구할 인터페이스

ldapium은 소비자를 몰라야 한다. manager가 필요한 것은 두 가지뿐이고, 둘 다 일반적인
형태로 표현 가능하다.

1. **`memberOf`를 포함한 사용자·그룹 조회 API** — manager가 이걸 읽어 GRANT/롤 매핑을 만든다.
   (ldapium 쪽 작업으로 진행 중)
2. **그룹 변경 이벤트/훅** — "이 그룹의 멤버가 바뀌었다"만 알린다. 무엇에 쓸지는 manager가
   정한다. (ldapium 미구현 — 필요해지면 그때 요청할 것)

**ldapium이 지는 책임은 세 줄이다: 소속을 정확히 계산해 노출하고, 안전하게
전송하고(TLS), 해시에서 약한 고리가 되지 않는 것.** 그 위의 정책 집행은 전부 beluga 몫이다.

## 6. manager 착수 시 순서

1. `ou=users`에 `beluga-*` uid 엔트리가 실제로 있는지 확인 (2.2)
2. `db-roles.sql`의 `ALTER DEFAULT PRIVILEGES` 결함 수정 (2.3) — manager와 무관하게 선행
3. Keycloak `group-ldap-mapper` 추가 (2.1) — 이게 있어야 "그룹이 권한 축"이 실제가 된다
4. 경로 A / B 결정 — `psql` 직접 접속 요구 여부가 갈림길
5. 결정된 경로에 따라 manager의 정책 컴파일러 설계

## 7. 미확인 사항

- beluga LDAP의 실제 디렉터리 내용 (관리자 비밀번호 부재로 조회 실패)
- `pgaudit`이 실제로 활성화되어 로그를 남기고 있는지
- Superset/Airflow/OpenMetadata의 집행이 설계서 매트릭스와 일치하는지 (이번 조사 범위 밖)
