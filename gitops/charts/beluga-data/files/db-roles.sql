-- PostgreSQL D19 Composite Role Hierarchy & D20 LDAP User Roles
-- Spec: docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md §10.1 & §10.2
-- Task 18(D-I): D19 특권 롤 이름을 컴파일러 산출물(policies/roles.yaml, Task 11)과 맞춰
-- analysts/engineers/admins로 바꾼다. beluga_admin은 리네임 대상이 아니다 — CNPG bootstrap
-- owner이자 Airflow/Superset/OpenMetadata/Lakekeeper/shop-seed가 실제로 접속에 쓰는 서비스
-- 로그인 계정이라(다섯 연결 문자열 + 02-cnpg.yaml의 owner 선언이 전부 이 이름을 참조) 바꾸면
-- 배포가 깨진다. 그래서 리네임이 아니라 분리다: 새 특권 롤(analysts/engineers/admins)을 만들고
-- `GRANT admins TO beluga_admin`으로 잇는다. D20 LDAP 로그인 계정("beluga-analyst" 등, 하이픈+
-- quoted)도 이름을 바꾸지 않는다 — 이들은 선언 롤이 아니라 pg_hba ldap 검색모드가 매칭하는
-- 로그인 사용자명(uid)이므로, 이들이 물려받는 특권 롤만 새 이름으로 바꾼다.
-- 이 스크립트는 ArgoCD가 매 sync마다 재실행한다(02c-db-roles.yaml, hook: Sync) — 전부 멱등이며,
-- 6번 섹션은 이전 버전이 만든 구 D19 롤(beluga_analyst/beluga_engineer)이 남아있는 클러스터의
-- 마이그레이션까지 처리한다.
--
-- 최종 리뷰 I-1(2026-08-25): 이 파일은 손수 작성된 것이며 beluga-manager의 `policyctl compile`
-- 산출물이 아니다 — 배포된 Trino OPA 정책(gitops/charts/beluga-platform/files/opa/trino.rego,
-- policies/에서 컴파일됨)과 달리 이 파일에는 대응하는 policies/resources.yaml 컷오버가 없다.
-- 아래는 allow-all(GRANT SELECT ON ALL TABLES ... TO analysts) 후 REVOKE로 개별 테이블을 막고,
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL로 신규 테이블에 engineers/admins를 자동 부여하는
-- 패턴을 쓴다 — 이는 이 프로젝트의 "롤 기반 허용만, deny 규칙 없음" 원칙(설계서 §10.1
-- "기본은 거부": 신규 테이블은 기본으로 접근 없음이어야지, 기본 허용 후 revoke가 아니다)을
-- 어긴다. beluga-manager의 Postgres DDL emitter(src/compiler/pgddl.ts:20-22)는 정확히 이
-- 이유로 ALTER DEFAULT PRIVILEGES를 절대 생성하지 않도록 만들어져 있다 — 이 파일과
-- 컴파일러의 의도된 산출물 사이에 실제 괴리가 있다는 뜻이다.
-- 이 괴리를 고치는 실제 PostgreSQL 컷오버(policies/resources.yaml을 소스로 컴파일러가 DDL을
-- 생성하도록 바꾸는 것)는 이 수정 체인의 범위 밖이다 — 어떤 Task도 그 컷오버를 지시한 적이
-- 없다(Task 7은 emitter만 만들었고, 아무것도 그것을 소비하도록 컷오버되지 않았다). 후속
-- 작업으로 남겨둔다. Task 18의 롤 이름 정렬 작업이 이 파일을 컴파일러 산출물처럼 보이게
-- 만들지 않도록, 이 사실을 여기 명시적으로 남긴다.

-- 1. Base Privilege Roles (NOLOGIN, INHERIT) — Task 18: analysts/engineers/admins로 개명
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analysts') THEN
    CREATE ROLE analysts WITH NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'engineers') THEN
    CREATE ROLE engineers WITH NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admins') THEN
    CREATE ROLE admins WITH NOLOGIN INHERIT;
  END IF;
END $$;

-- 2. D19 Composite Role Inheritance (admins ⊃ engineers ⊃ analysts)
GRANT analysts TO engineers;
GRANT engineers TO admins;

-- 2b. Task 18(D-I): admins를 서비스 로그인 계정 beluga_admin에 연결한다. 이 Job은 beluga_admin으로
-- 접속해 실행되고(02c-db-roles.yaml), beluga_admin은 CNPG bootstrap이 부여한 CREATEROLE을 갖는다
-- (02-cnpg.yaml: "ALTER ROLE beluga_admin WITH REPLICATION CREATEROLE"). PG16+에서는 CREATEROLE
-- 롤이 만든 롤에 자동으로 ADMIN OPTION이 실린다(이 클러스터는 PG 17.6) — 그래서 바로 위에서
-- beluga_admin이 직접 CREATE한 admins 롤에 대해 별도 부여 없이 이 GRANT가 그대로 성공한다.
-- (예전에는 beluga_admin 자체를 D19 특권 롤로 쓰려 했으나 CNPG(superuser)가 먼저 만들어서 이
-- Job에 ADMIN OPTION이 없었다 — 그래서 구버전 스크립트는 대신 로그인 계정 "beluga-admin"에
-- beluga_engineer를 부여하는 우회를 썼다. admins가 beluga_admin과 별개인 새 롤이므로 이 우회는
-- 더 이상 필요 없다.) 이 GRANT가 실패하면 Job이 ON_ERROR_STOP=1로 죽는다 — 라이브 검증에서
-- Job 상태로 직접 확인한다.
GRANT admins TO beluga_admin;

-- 3. Schema & Table Privileges on shop DB — Task 18: 대상 롤을 analysts/engineers/admins로 교체
GRANT CONNECT ON DATABASE shop TO analysts, engineers, admins;
GRANT USAGE ON SCHEMA public TO analysts, engineers, admins;

-- analyst: Read-only access to all tables except PII ('customers')
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analysts;
REVOKE SELECT ON TABLE customers FROM analysts;

-- engineer: analyst privileges + Read/Write on all tables (including explicit customers access) + sequences
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO engineers;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO engineers;

-- admin: Full privileges. beluga_admin은 2b의 admins 멤버십(INHERIT)으로 이 전부를 물려받는다.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admins;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admins;
GRANT ALL PRIVILEGES ON DATABASE shop TO admins;

-- Default Privileges for future tables in public schema
-- analyst에 대한 ALTER DEFAULT PRIVILEGES는 두지 않는다.
-- 신규 테이블에 SELECT를 자동 부여하면 §10.1 "기본은 거부, 허용만 롤로 부여"를 위반한다
-- (신규 CDC 미러·customers_v2가 생기는 즉시 analyst가 읽게 됨). 테이블 허용은 명시적 GRANT로만.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO engineers;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO admins;

-- 4. D20 LDAP Login Accounts (LOGIN, no password stored - authenticated via pg_hba ldap)
-- Task 18(D-I): 이름 유지 — 선언 롤이 아니라 pg_hba ldap 검색모드가 매칭하는 로그인 사용자명
-- (uid)이다. 바꾸면 02-cnpg.yaml pg_hba 라인의 사용자 목록과 어긋난다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga-analyst') THEN
    CREATE ROLE "beluga-analyst" WITH LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga-engineer') THEN
    CREATE ROLE "beluga-engineer" WITH LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga-admin') THEN
    CREATE ROLE "beluga-admin" WITH LOGIN INHERIT;
  END IF;
END $$;

-- 5. Bind LDAP Login Accounts to the NEW privilege roles (Task 18)
GRANT analysts TO "beluga-analyst";
GRANT engineers TO "beluga-engineer";
GRANT admins TO "beluga-admin";

-- 6. Task 18 마이그레이션: 구버전이 만든 D19 특권 롤(beluga_analyst/beluga_engineer)을 정리한다.
-- 멱등 — 이미 정리된 클러스터에서는 IF EXISTS가 전부 거짓이라 아무 것도 하지 않는다.
-- beluga_admin은 정리 대상이 아니다: D19 특권 롤로 실제로 존재해 본 적이 없다(구스크립트의
-- `CREATE ROLE beluga_admin` 시도는 CNPG owner 선점으로 IF NOT EXISTS에 걸려 항상 스킵됐다).
-- beluga_admin에 남아있는 기존 직접 GRANT(3번 구버전이 TO beluga_admin으로 준 것들)는 일부러
-- 건드리지 않는다 — REVOKE ALL ON DATABASE/REVOKE CONNECT를 서비스 계정에 잘못 실행하면 실행
-- 중인 Airflow/Superset/OpenMetadata/Lakekeeper 연결을 그 자리에서 끊을 위험이 있고, 2b의
-- admins 멤버십과 중복돼도 해가 없다(같은 권한을 두 경로로 받을 뿐) — 안전보다 정리를
-- 앞세우지 않는다.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_engineer') THEN
    -- 구 default privileges 항목을 먼저 지운다 — 남아있으면 DROP ROLE이 dependency 에러로 실패한다.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM beluga_engineer;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM beluga_engineer;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM beluga_engineer;
    REVOKE CONNECT ON DATABASE shop FROM beluga_engineer;
    REVOKE USAGE ON SCHEMA public FROM beluga_engineer;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_analyst') THEN
      REVOKE beluga_analyst FROM beluga_engineer;
    END IF;
    REVOKE beluga_engineer FROM "beluga-engineer";
    REVOKE beluga_engineer FROM "beluga-admin";
    DROP ROLE beluga_engineer;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_analyst') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM beluga_analyst;
    REVOKE CONNECT ON DATABASE shop FROM beluga_analyst;
    REVOKE USAGE ON SCHEMA public FROM beluga_analyst;
    REVOKE beluga_analyst FROM "beluga-analyst";
    DROP ROLE beluga_analyst;
  END IF;
END $$;
