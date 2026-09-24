# PostgreSQL 권한 컷오버 — 라이브 클러스터 런북 (이슈 #107)

> **범위**: `gitops/charts/beluga-data/files/db-roles.sql`의 Generated Body(§1–3)를
> policyctl 컴파일러 산출물로 컷오버한 오프라인 작업(커밋 `36a9614`, `1398d67`, `88bec03`,
> 테스트 14 parity gate)은 이미 완료되어 `main`에 병합돼 있다. 이 런북은 **그 컷오버가 이미
> 실행 중인(구버전 Job으로 넓은 권한을 부여받은) 라이브 클러스터에 적용될 때만** 필요한,
> 클러스터 접속이 있어야 수행 가능한 잔여 작업을 다룬다. 이 문서 자체는 아무것도 실행하지
> 않는다 — 클러스터 운영자가 접속 후 체크리스트를 따라간다.

## 1. 왜 필요한가

`02c-db-roles.yaml`의 Job은 ArgoCD sync마다 `db-roles.sql`을 재실행하며 **추가(additive)만
멱등**하다: `CREATE ROLE IF NOT EXISTS`와 새 `GRANT`는 재실행해도 안전하지만, SQL 파일에서
줄을 **삭제**해도 이미 부여된 권한은 자동으로 회수(REVOKE)되지 않는다.

컷오버 전(커밋 `36a9614` 이전) Job이 최소 한 번 이상 실행된 클러스터에는 다음이 이미
적용되어 있고, 새 Generated Body를 배포해도 아래 항목은 **그대로 남는다**:

| 구버전 항목 | 컷오버 후 상태 | 라이브 클러스터에 남아있는 위험 |
|---|---|---|
| `GRANT SELECT ON ALL TABLES IN SCHEMA public TO analysts;` (`customers`만 개별 REVOKE) | 신규 Generated Body는 `orders`에만 명시적 SELECT | analysts가 `policies/resources.yaml`에 없는 미래 테이블도 여전히 SELECT 가능 — §10.1 "기본은 거부" 위반 |
| `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO engineers;` | 신규 Generated Body는 `customers`/`orders`에만 명시적 CRUD | engineers가 미선언 테이블에도 ALL 보유 |
| `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admins;` | admins는 이제 `engineers` 상속으로만 테이블 접근(§2 역할 상속) | admins에 중복 직접 GRANT가 남아 상속 경로와 별개로 권한이 존재 |
| `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO engineers;`/`admins;` | 신규 Generated Body는 engineers에 `USAGE, SELECT`만(§3) | `setval()`에 필요한 시퀀스 `UPDATE` 권한이 과다 부여 상태로 남음 |
| `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO engineers;`/`admins;` | 신규 Generated Body는 `ALTER DEFAULT PRIVILEGES`를 **절대 생성하지 않음**(pgddl.ts 설계 원칙) | **가장 위험** — 이 항목이 남아있으면 향후 아무 신규 테이블이나 자동으로 engineers/admins에 전권 부여되어, 컷오버의 실제 목적(기본 거부)이 무효화됨 |

## 2. 사전 확인 (읽기 전용, 안전)

클러스터에 `beluga_admin`(또는 동등 권한)으로 접속해 아래 쿼리로 현재 상태를 먼저 확인한다.
**아직 아무것도 수정하지 않는다.**

```bash
psql -h postgres-main-rw.database.svc.cluster.local -U beluga_admin -d shop
```

```sql
-- 2-0. 대상 데이터베이스 확인 — 아래 모든 쿼리는 shop 데이터베이스에 연결된 상태에서만
-- 유효하다(02c-db-roles.yaml Job도 `-d shop`으로 접속한다).
SELECT current_database();  -- 반드시 'shop'이어야 한다. 아니면 \c shop 또는 -d shop 재접속.

-- 2-1. 남아있는 ALTER DEFAULT PRIVILEGES 항목 확인 (가장 먼저 확인할 것)
-- defaclrole은 "권한을 받는" 롤이 아니라 ALTER DEFAULT PRIVILEGES를 "실행한" 롤(grantor)이다
-- (PostgreSQL 문서: FOR ROLE 생략 시 현재 롤이 target_role이 된다). 02c-db-roles.yaml Job은
-- `-U beluga_admin`으로 실행되므로 구버전이 남긴 항목의 defaclrole은 beluga_admin이다 —
-- engineers/admins로 필터링하면 항상 빈 결과(거짓 음성)가 나온다. defaclacl 내용으로
-- engineers/admins에 대한 부여 여부를 직접 확인한다.
SELECT defaclrole::regrole AS grantor, defaclnamespace::regnamespace AS schema, defaclacl
FROM pg_default_acl
WHERE defaclnamespace = 'public'::regnamespace;
-- defaclacl에 "engineers=..." 또는 "admins=..." 항목이 보이면(특히 grantor가 beluga_admin인
-- 행) 3단계가 반드시 필요하다.

-- 2-2. 테이블 단위 직접 GRANT 목록 (ALL TABLES 블랭킷 여부 확인용)
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('analysts', 'engineers', 'admins')
ORDER BY grantee, table_name, privilege_type;

-- 2-3. 시퀀스 권한 확인 — information_schema.usage_privileges는 표준 USAGE 권한만 노출하고
-- PostgreSQL 고유 확장 권한인 SELECT/UPDATE(예: setval() 과다 부여로 남은 UPDATE)는 절대
-- 보여주지 않는다(PostgreSQL 문서 "usage_privileges": sequences의 비표준 SELECT/UPDATE는
-- information schema에 노출되지 않음). aclexplode로 실제 ACL을 펼쳐서 확인한다.
SELECT c.relname AS sequence_name, a.rolname AS grantee,
       acl.privilege_type, acl.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
JOIN pg_roles a ON a.oid = acl.grantee
WHERE n.nspname = 'public'
  AND c.relkind = 'S'
  AND a.rolname IN ('engineers', 'admins')
ORDER BY c.relname, a.rolname, acl.privilege_type;
```

2-1의 결과가 비어 있지 않으면(즉 `ALTER DEFAULT PRIVILEGES`가 남아있으면) 3단계를 반드시
수행한다. 2-2/2-3에서 `policies/resources.yaml`에 선언되지 않은 테이블·시퀀스에 대한 GRANT가
보이거나, 2-3에서 engineers/admins에 UPDATE가 남아있으면 마찬가지로 해당 행을 3단계 REVOKE
대상에 포함한다.

## 3. 회수(REVOKE) 체크리스트

**사전 조건 — 유지보수 창(maintenance window)**: 이 단계는 `public` 스키마에 새 테이블이
생성되지 않는 구간에서 실행한다. 3-1(ALTER DEFAULT PRIVILEGES REVOKE)과 3-2(블랭킷 GRANT
REVOKE) 사이, 또는 COMMIT 이전에 다른 세션이 `CREATE TABLE`을 실행하면 그 테이블은 이미
구버전 default privileges를 상속받아 생성되고, `ALTER DEFAULT PRIVILEGES ... REVOKE`는
**이미 생성된 객체에는 소급 적용되지 않는다** — 3-1을 먼저 실행해도 그 사이에 생성된 테이블의
과다 권한은 그대로 남는다. 동시 스키마 변경을 완전히 막을 수 없다면, COMMIT 직후 4-3의
재점검 쿼리를 반드시 실행해 유지보수 창 동안 생성된 테이블이 없는지 확인하고, 있다면 해당
테이블에 한해 3-2/3-3과 동일한 REVOKE를 수동으로 추가 실행한다.

**순서 중요**: `ALTER DEFAULT PRIVILEGES` 회수 → 블랭킷 테이블/시퀀스 GRANT 회수 순으로
진행한다(반대로 하면 그 사이에 신규 테이블이 생성될 경우 구 default privileges가 먼저
적용되어 버릴 수 있다).

```sql
BEGIN;

-- 3-1. 구버전 ALTER DEFAULT PRIVILEGES 제거 — 미래 테이블 자동 권한 부여 중단.
-- FOR ROLE beluga_admin 명시 필수: 원본 Job이 `-U beluga_admin`으로 실행되어 구 항목의
-- defaclrole이 beluga_admin이다(2-1 주석 참고). FOR ROLE 없이 실행하면 "현재 접속 롤"의
-- default privileges만 대상이 되어, beluga_admin이 아닌 계정(superuser 등)으로 접속해
-- 실행할 경우 대상이 하나도 없어 에러 없이 조용히 no-op한다.
ALTER DEFAULT PRIVILEGES FOR ROLE beluga_admin IN SCHEMA public REVOKE ALL ON TABLES FROM engineers;
ALTER DEFAULT PRIVILEGES FOR ROLE beluga_admin IN SCHEMA public REVOKE ALL ON TABLES FROM admins;

-- 3-2. 블랭킷 "ALL TABLES" 회수. 주의: 이 REVOKE는 스키마의 "모든" 테이블에 적용되므로
-- customers/orders처럼 Generated Body(db-roles.sql §3, 38–41행)가 명시적으로 재부여한 권한도
-- 함께 사라진다 — "선언되지 않은 나머지 테이블만" 제거되는 것이 아니다. 그대로 두면 3-2b
-- 이전까지 LDAP 사용자(beluga-engineer/beluga-analyst)의 read/write가 실패한다. 그래서 같은
-- 트랜잭션 안에서 3-2b로 즉시 재부여한다.
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM analysts;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM engineers;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM admins;

-- 3-2b. db-roles.sql §3(38–41행)과 동일한 명시적 GRANT를 같은 트랜잭션에서 즉시 재부여한다
-- (admins는 직접 GRANT 없이 engineers 상속(§2, 32행)으로만 접근하므로 재부여 대상이 아니다).
-- **db-roles.sql §3이 바뀌면 아래 GRANT도 함께 갱신할 것** — 실행 전
-- `git show 36a9614:gitops/charts/beluga-data/files/db-roles.sql`(또는 현재 main)과 대조해
-- 아래 블록이 §3과 정확히 일치하는지 확인한다.
GRANT SELECT ON TABLE public.orders TO analysts;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customers TO engineers;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO engineers;

-- 3-3. 시퀀스 과다 권한 축소 (engineers/admins → USAGE, SELECT만 남기고 회수) 후 재부여
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM engineers;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM admins;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO engineers;

COMMIT;
```

`admins`에 직접 부여된 `ALL PRIVILEGES ON DATABASE shop`은 Epilogue(수기 유지 구간, §10.2)가
의도적으로 존속시키는 항목이므로 **건드리지 않는다** — db-roles.sql 44–47행 주석 참고.

`beluga_admin`(CNPG bootstrap owner, 서비스 로그인 계정) 자체에 대한 직접 GRANT도 위 REVOKE
대상에서 **제외**한다 — db-roles.sql 74–78행 주석(Task 18 마이그레이션 설계)이 이미 이유를
기록했다: Airflow/Superset/OpenMetadata/Lakekeeper 연결이 그 자리에서 끊길 위험이 있다.

## 4. 재적용 및 검증

```bash
# 4-1. ArgoCD 전체(애플리케이션) sync를 트리거해 Generated Body를 재적용(멱등 — 안전).
# 주의: Job/ConfigMap 리소스는 `db-roles-setup`이다(02c는 templates/ 파일명 접두어일 뿐,
# k8s 리소스명이 아니다). 또한 `argocd app sync beluga-data --resource ...`처럼 대상을
# 좁히는 selective sync는 Sync 훅을 실행하지 않는다(Argo CD 공식 문서 "Selective Sync":
# 선택적 동기화는 훅을 트리거하지 않고 동기화 이력에도 기록되지 않음). db-roles-setup Job은
# `argocd.argoproj.io/hook: Sync` 훅이므로 --resource 필터를 쓰면 아무 것도 재실행되지 않고
# 명령만 "성공"으로 조용히 끝난다. 필터 없이 전체 sync를 실행해야 훅이 트리거되며,
# hook-delete-policy: BeforeHookCreation 덕분에 기존 Job이 삭제되고 새로 생성되어 재실행된다.
argocd app sync beluga-data
# 대안: ArgoCD 동기화를 기다리지 않고 즉시 확인하고 싶다면 SQL을 직접 실행한다.
#   kubectl -n database exec -it deploy/postgres-main -- \
#     psql -U beluga_admin -d shop -v ON_ERROR_STOP=1 -f /path/to/db-roles.sql
# (또는 ConfigMap db-roles-schema의 db-roles.sql 내용을 그대로 psql -f로 실행)

# 4-2. Job 로그로 ON_ERROR_STOP 트리거 없이 완료됐는지 확인 (실제 리소스명: db-roles-setup)
kubectl -n database logs job/db-roles-setup
```

```sql
-- 4-3. 2단계 쿼리(2-0~2-3, 수정된 버전)를 재실행해:
--      * pg_default_acl에 engineers/admins로의 항목이 grantor(defaclrole)와 무관하게
--        더 이상 없고,
--      * role_table_grants가 db-roles.sql Generated Body(§3)와 정확히 일치하며,
--      * aclexplode 기반 시퀀스 쿼리에 engineers/admins UPDATE 잔재가 없는지 확인한다.
-- 3단계 유지보수 창 동안 생성된 테이블이 있었다면(§3 사전 조건 참고) 아래로 찾아 수동 조치한다.
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name NOT IN ('customers', 'orders');  -- policies/resources.yaml 선언 목록과 대조
```

## 5. 롤백

3단계는 트랜잭션(`BEGIN`/`COMMIT`) 단위로 실행하므로 실행 도중 문제가 발견되면 `ROLLBACK`으로
즉시 되돌릴 수 있다. COMMIT 이후 되돌려야 하는 경우, 컷오버 이전 커밋(`36a9614`의 부모,
`8dedb46`)의 `db-roles.sql`을 임시로 재적용해 구버전 블랭킷 GRANT/`ALTER DEFAULT PRIVILEGES`를
복원한다. 이때도 **반드시 `beluga_admin`으로 실행**한다 — `ALTER DEFAULT PRIVILEGES ...
GRANT`는 `FOR ROLE`을 생략하면 실행 계정 자신을 defaclrole로 기록하므로(3-1 주석 참고), 다른
계정으로 재적용하면 defaclrole이 어긋나 이후 3-1의 `FOR ROLE beluga_admin` REVOKE가 그 항목을
다시 찾지 못한다. 재적용 방법도 §4와 같은 이유로 ArgoCD `--resource` selective sync가 아니라
전체 sync 또는 SQL 직접 실행을 사용한다. 서비스 연결(Airflow/Superset/OpenMetadata/Lakekeeper,
모두 `beluga_admin` 사용)은 이 절차 전체에서 영향받지 않는다 — 대상이
`analysts`/`engineers`/`admins` 상속 트리와 `beluga-*` LOGIN 계정뿐이기 때문이다.

## 6. 이 런북이 다루지 않는 것 — Epilogue 추가 흡수는 별도 차단 사유로 보류

이슈 코멘트(2026-09-18)가 언급한 "Epilogue 6개 항목의 컴파일러 흡수"는 **부분적으로만**
가능해졌다: beluga-manager PR #66(커밋 `3da9a12`)이 `pgddl.ts`에 D20 LOGIN 계정 생성·역할
바인딩·CONNECT 그랜트 자동 산출(§4–6, `Declaration.logins` 필드, `pgLoginSchema`)을 이미
추가했다. 그러나 **CLI가 아직 이를 소비하지 못한다** — `beluga-manager/packages/policy-compiler/bin/policyctl.ts`의
`loadPolicies()`는 `roles.yaml`/`groups.yaml`/`resources.yaml`/`catalog.yaml`만 읽고
`logins.yaml` 같은 파일을 로드하지 않으며, `resourcesFileSchema`가 `strictObject`라 최상위에
`logins` 키를 추가해도 컴파일러 CLI가 거부한다(직접 확인: `npm run policyctl -- compile
policies --out <dir>` 결과에 §4–6이 전혀 나타나지 않음, PR #66 테스트는 `compileAll()`을
프로그램적으로만 호출).

즉 남은 흡수 작업(CONNECT/LOGIN 롤 바인딩을 db-roles.sql Generated Body로 이관, Epilogue를
`beluga_admin` 바인딩 + 레거시 정리 DO 블록만으로 축소)은 **beluga-manager 쪽에
`policies/logins.yaml`을 읽는 CLI 로더 추가가 선행돼야** 시작할 수 있다. beluga-manager는 이
작업 범위 밖(read-only)이므로 이슈 #107은 이 항목에 대해서는 계속 열어 둔다.
