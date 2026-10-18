-- ADR-0009 rollout 3 (D-MSSO-9, D-MSSO-11): audit store of the Manager's SSO change requests.
-- Applied as role manager_owner on EVERY run of the migration Job (psql -v ON_ERROR_STOP=1), so every statement
-- here is re-runnable (IF NOT EXISTS, guarded DO blocks, idempotent GRANT/REVOKE). The role manager_writer must
-- already exist (declared in the CNPG Cluster spec.managed.roles); the Job retries until it does.
--
-- D-MSSO-11: the Manager connects as manager_writer only. It may SELECT sso_change_event and INSERT its non-generated columns (column-level GRANT); it has no
-- UPDATE/DELETE/TRUNCATE there (append-only by grants: stops the Manager itself from rewriting history, not a
-- database administrator). sso_change_requests is the current state and may be UPDATEd.

CREATE TABLE IF NOT EXISTS sso_change_event (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id        uuid,  -- NULL for denied/previewed rows: no request exists yet
  stage             text NOT NULL CHECK (stage IN (
                      'denied', 'previewed', 'submitted', 'pr_open', 'unknown_recovering',
                      'merged', 'applied', 'rejected', 'failed')),
  actor_sub         text NOT NULL,
  actor_username    text,
  endpoint          text,
  idempotency_key   text,
  base_blob_sha     text,
  payload_sha256    text,
  pr_number         integer,
  pr_url            text,
  merge_commit_sha  text,
  reason            text,
  detail            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_change_event_request_id_idx ON sso_change_event (request_id);

CREATE TABLE IF NOT EXISTS sso_change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage             text NOT NULL CHECK (stage IN (
                      'submitted', 'pr_open', 'unknown_recovering',
                      'merged', 'applied', 'rejected', 'failed')),
  file_path         text NOT NULL,
  endpoint          text NOT NULL,
  idempotency_key   text NOT NULL UNIQUE,
  payload_sha256    text NOT NULL,
  base_blob_sha     text NOT NULL,
  source_commit_sha text NOT NULL,
  patch             jsonb NOT NULL,
  actor_sub         text NOT NULL,
  actor_username    text,
  branch            text NOT NULL,
  pr_number         integer,
  pr_url            text,
  merge_commit_sha  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- D-MSSO-9: one active request per file. The submit transaction also takes pg_advisory_xact_lock, so the
-- loser of a race gets a clean OPEN_REQUEST_EXISTS and this index is the backstop (unique_violation 23505).
CREATE UNIQUE INDEX IF NOT EXISTS sso_change_requests_one_active_per_file
  ON sso_change_requests (file_path)
  WHERE stage IN ('submitted', 'pr_open', 'unknown_recovering');

-- Writer privileges: CONNECT + USAGE on public, nothing else. REVOKE ALL first so a re-run also removes anything
-- that drifted in (for example a manual GRANT); the GRANTs below then restore exactly the intended set.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO manager_writer', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM manager_writer;
GRANT USAGE ON SCHEMA public TO manager_writer;

-- TEMP tables would let the writer stage scratch data in the audit database; PUBLIC has it by default.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM manager_writer', current_database());
END
$$;

-- Column-level INSERT: id and created_at stay server-generated, so the writer cannot forge an identity value
-- (OVERRIDING SYSTEM VALUE) or back-date a row. REVOKE ALL (table + column privileges) first so a re-run on an
-- existing database converges to exactly this set.
REVOKE ALL ON sso_change_event FROM manager_writer;
GRANT SELECT ON sso_change_event TO manager_writer;
GRANT INSERT (request_id, stage, actor_sub, actor_username, endpoint, idempotency_key, base_blob_sha,
              payload_sha256, pr_number, pr_url, merge_commit_sha, reason, detail)
  ON sso_change_event TO manager_writer;

REVOKE ALL ON sso_change_requests FROM manager_writer;
GRANT SELECT, INSERT, UPDATE ON sso_change_requests TO manager_writer;
