-- PostgreSQL D19 Composite Role Hierarchy & D20 LDAP User Roles
-- Spec: docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md §10.1 & §10.2
-- This Job is rerun by ArgoCD on every sync; the generated grants are idempotent.

-- Prelude (hand-maintained): fail on the first SQL error even outside the generated body.
\set ON_ERROR_STOP on

-- BEGIN GENERATED BODY: policyctl compile policies --out <dir> / roles.sql
-- 자동 생성 — 직접 수정하지 말 것. 원천: policies/*.yaml

-- 1. 권한 롤 (NOLOGIN, 상속 가능)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admins') THEN
    CREATE ROLE admins WITH NOLOGIN INHERIT;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analysts') THEN
    CREATE ROLE analysts WITH NOLOGIN INHERIT;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'engineers') THEN
    CREATE ROLE engineers WITH NOLOGIN INHERIT;
  END IF;
END $$;

-- 2. 롤 상속 (D19)
GRANT engineers TO admins;
GRANT analysts TO engineers;

-- 3. 스키마 및 테이블 권한 (allow-by-role, 명시적 GRANT만)
GRANT USAGE ON SCHEMA public TO analysts;
GRANT USAGE ON SCHEMA public TO engineers;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customers TO engineers;
GRANT SELECT ON TABLE public.orders TO analysts;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO engineers;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO engineers;
-- END GENERATED BODY

-- Epilogue (hand-maintained): database wiring and D20 LDAP login accounts.
GRANT CONNECT ON DATABASE shop TO analysts, engineers, admins;
GRANT admins TO beluga_admin;
GRANT ALL PRIVILEGES ON DATABASE shop TO admins;

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
