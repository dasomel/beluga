-- PostgreSQL D19 Composite Role Hierarchy & D20 LDAP User Roles
-- Spec: docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md §10.1 & §10.2

-- 1. Base Privilege Roles (NOLOGIN, INHERIT)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_analyst') THEN
    CREATE ROLE beluga_analyst WITH NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_engineer') THEN
    CREATE ROLE beluga_engineer WITH NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_admin') THEN
    CREATE ROLE beluga_admin WITH NOLOGIN INHERIT;
  END IF;
END $$;

-- 2. D19 Composite Role Inheritance (admin ⊃ engineer ⊃ analyst)
GRANT beluga_analyst TO beluga_engineer;
GRANT beluga_engineer TO beluga_admin;

-- 3. Schema & Table Privileges on shop DB
GRANT CONNECT ON DATABASE shop TO beluga_analyst, beluga_engineer, beluga_admin;
GRANT USAGE ON SCHEMA public TO beluga_analyst, beluga_engineer, beluga_admin;

-- analyst: Read-only access to all tables except PII ('customers')
GRANT SELECT ON ALL TABLES IN SCHEMA public TO beluga_analyst;
REVOKE SELECT ON TABLE customers FROM beluga_analyst;

-- engineer: analyst privileges + Read/Write on all tables (including explicit customers access) + sequences
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO beluga_engineer;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO beluga_engineer;

-- admin: Full privileges
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO beluga_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO beluga_admin;
GRANT ALL PRIVILEGES ON DATABASE shop TO beluga_admin;

-- Default Privileges for future tables in public schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO beluga_analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO beluga_engineer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO beluga_admin;

-- 4. D20 LDAP Login Accounts (LOGIN, no password stored - authenticated via pg_hba ldap)
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

-- 5. Bind LDAP Login Accounts to Privilege Roles
GRANT beluga_analyst TO "beluga-analyst";
GRANT beluga_engineer TO "beluga-engineer";
GRANT beluga_admin TO "beluga-admin";
