-- The organization's Postgres. One installation serves one organization, so
-- there is no tenant column and no tenant check: these policies decide who
-- inside the organization may do what (approved member, writer, manager,
-- admin, auditor), the way firestore.rules once did. The browser role has no
-- bypass. The worker role does, and only the server's own jobs may assume it.
--
-- Two bugs that have each shipped three times, and both exist in SQL
-- (docs/SECURITY.md, AGENTS.md):
--
--   Permissive union. Postgres ORs permissive policies. A narrow permissive
--   policy does not take away what a broad one grants. The strict case is
--   RESTRICTIVE, which is ANDed. policy_union is the regression table: a broad
--   DELETE plus a restrictive auditor denial. Dropping the restrictive one
--   lets the auditor through. That is the test.
--
--   Post-state check. WITH CHECK sees the row after the write. Authorising a
--   role change from NEW.data.role lets the writer supply the role that
--   authorises them. users_keep_privilege reads the actor's existing profile
--   and OLD.data, and refuses the change when those do not allow it.

-- Created here when the connecting user may (an embedded or self-run
-- Postgres). A managed Postgres does not hand out SUPERUSER, and creating a
-- BYPASSRLS role needs BYPASSRLS, so an administrator creates both roles once
-- (docs/SELF-HOSTING.md). Checked by name first: Postgres refuses
-- CREATE ROLE ... BYPASSRLS on privilege before it notices the role exists,
-- so catching duplicate_object alone failed every start after that setup.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohsms_browser') THEN
    CREATE ROLE ohsms_browser NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohsms_worker') THEN
    CREATE ROLE ohsms_worker NOLOGIN BYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS documents (
  path text NOT NULL,
  id text NOT NULL,
  rev integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (path, id)
);

CREATE INDEX IF NOT EXISTS documents_path_idx ON documents (path);

-- File rows. The presign endpoint is what deletes bytes; this table is the
-- same decision in SQL so a direct delete cannot outflank it.
CREATE TABLE IF NOT EXISTS files (
  path text PRIMARY KEY,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Exists only so the permissive-union regression has a pair of policies that
-- are not also doing a second job. Not a product table.
CREATE TABLE IF NOT EXISTS policy_union (
  id text PRIMARY KEY
);

-- Passwords and invites are server-only. No grant to the browser role, RLS
-- forced, and no policy: a table the browser role can see with RLS off would
-- be world-readable to anyone who reached it.
CREATE TABLE IF NOT EXISTS auth_secrets (
  uid text PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  email text PRIMARY KEY,
  role text NOT NULL,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY
);

DROP FUNCTION IF EXISTS stamp_org() CASCADE;
DROP FUNCTION IF EXISTS approved_of(text) CASCADE;
DROP FUNCTION IF EXISTS writer_of(text) CASCADE;
DROP FUNCTION IF EXISTS manager_of(text) CASCADE;
DROP FUNCTION IF EXISTS path_org(text) CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO ohsms_browser;
GRANT SELECT, INSERT, UPDATE, DELETE ON files TO ohsms_browser;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_union TO ohsms_browser;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, files, policy_union, auth_secrets, invites TO ohsms_worker;

-- ── One-time move from the per-tenant layout ────────────────────────────────
-- A database created by the earlier, multi-organization build addressed every
-- record as organizations/<orgId>/<collection>. A dedicated server only ever
-- held one organization, so the move is a rename: drop the prefix, make the
-- organization document organization/profile, and drop the tenant columns.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'single-org-v1') THEN
    DROP TRIGGER IF EXISTS documents_stamp_org ON documents;
    -- documents FORCEs row level security, which holds the table owner too
    -- unless it is a superuser. The rows move as the bypass role; the columns
    -- are dropped as the owner afterwards.
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE 'SET LOCAL ROLE ohsms_worker';
    END IF;
    IF (SELECT count(*) FROM documents WHERE path = 'organizations') > 1 THEN
      RAISE EXCEPTION 'this database holds more than one organization; move one organization per server';
    END IF;
    UPDATE documents SET path = 'organization', id = 'profile' WHERE path = 'organizations';
    UPDATE documents SET path = regexp_replace(path, '^organizations/[^/]+/', '')
      WHERE path ~ '^organizations/[^/]+/';
    UPDATE documents SET id = 'organization' WHERE path = 'moduleEntitlements'
      AND id <> 'organization'
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.path = 'moduleEntitlements' AND d.id = 'organization');
    UPDATE documents SET id = 'current' WHERE path = 'scimTokens'
      AND id <> 'current'
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.path = 'scimTokens' AND d.id = 'current');
    DELETE FROM documents WHERE path = 'orgIndex';
    EXECUTE 'RESET ROLE';
    ALTER TABLE documents DROP COLUMN IF EXISTS org_id CASCADE;
    ALTER TABLE files DROP COLUMN IF EXISTS org_id CASCADE;
    ALTER TABLE policy_union DROP COLUMN IF EXISTS org_id CASCADE;
    ALTER TABLE invites DROP COLUMN IF EXISTS org_id CASCADE;
    INSERT INTO schema_migrations (id) VALUES ('single-org-v1');
  END IF;
END $$;


ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_union ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_union FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;

-- ── Session helpers ──────────────────────────────────────────────────────────
-- SECURITY DEFINER so a policy can read the caller's profile without the
-- policy query re-entering itself. The function returns one row: the uid the
-- gateway put in app.uid. The gateway sets that from the verified session,
-- never from a field the browser sent.

CREATE OR REPLACE FUNCTION app_uid() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.uid', true), '');
$$;

CREATE OR REPLACE FUNCTION app_profile() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT data FROM documents WHERE path = 'users' AND id = app_uid();
$$;

-- The collection a path names: its last segment ('permits/P1/events' -> events).
CREATE OR REPLACE FUNCTION collection_of(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT split_part(p, '/', array_length(string_to_array(p, '/'), 1));
$$;

-- The top-level collection a path sits under ('permits/P1/events' -> permits).
CREATE OR REPLACE FUNCTION root_of(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT split_part(p, '/', 1);
$$;

CREATE OR REPLACE FUNCTION is_medical(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p ~ '^(injuries|illnesses)(/|$)';
$$;

-- Written and read only by the server (stack/directory.mjs). No browser
-- policy may match them, whatever the caller's role.
CREATE OR REPLACE FUNCTION server_only_path(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT root_of(p) IN ('scimTokens', 'scimUsers', 'scimGroups');
$$;

-- Documents with their own, narrower write policies below.
CREATE OR REPLACE FUNCTION special_path(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p IN ('users', 'organization', 'moduleEntitlements');
$$;

CREATE OR REPLACE FUNCTION password_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_profile() IS NULL
      OR COALESCE(app_profile()->>'mustChangePassword', 'false') <> 'true';
$$;

CREATE OR REPLACE FUNCTION is_approved() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_profile() IS NOT NULL
     AND app_profile()->>'status' = 'approved'
     AND COALESCE(app_profile()->>'mustChangePassword', 'false') <> 'true';
$$;

CREATE OR REPLACE FUNCTION is_writer() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_approved() AND COALESCE(app_profile()->>'role', '') <> 'auditor';
$$;

CREATE OR REPLACE FUNCTION is_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_approved() AND app_profile()->>'role' IN ('admin', 'manager');
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_approved() AND app_profile()->>'role' = 'admin';
$$;

-- Privilege fields are decided from the actor's existing profile and the row
-- as it was, not from the role in the write. mustChangePassword is cleared
-- only by the worker (completePasswordChange), after the password itself is
-- replaced. An admin can impose the flag. Nobody clears it through this role.
-- Invoker, not definer: current_user has to be the worker when the gateway
-- clears mustChangePassword. A definer function would see the function owner
-- and the worker check would never match. The actor's profile is read through
-- app_profile(), which is the definer, and that read is the row as it stands
-- (OLD), not NEW.data.role.
CREATE OR REPLACE FUNCTION users_keep_privilege() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  actor jsonb;
  privileged boolean;
BEGIN
  IF NEW.path <> 'users' THEN
    RETURN NEW;
  END IF;
  IF current_user = 'ohsms_worker' THEN
    RETURN NEW;
  END IF;
  IF OLD.data->>'mustChangePassword' = 'true'
     AND COALESCE(NEW.data->>'mustChangePassword', 'false') <> 'true' THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  privileged :=
    NEW.data->>'role' IS DISTINCT FROM OLD.data->>'role'
    OR NEW.data->>'status' IS DISTINCT FROM OLD.data->>'status'
    OR COALESCE(NEW.data->>'siteId', '') IS DISTINCT FROM COALESCE(OLD.data->>'siteId', '')
    OR NEW.data->'access' IS DISTINCT FROM OLD.data->'access'
    OR COALESCE(NEW.data->>'department', '') IS DISTINCT FROM COALESCE(OLD.data->>'department', '')
    OR COALESCE(NEW.data->>'dept', '') IS DISTINCT FROM COALESCE(OLD.data->>'dept', '');
  IF NOT privileged THEN
    RETURN NEW;
  END IF;
  actor := app_profile();
  IF actor IS NOT NULL
     AND actor->>'role' = 'admin'
     AND actor->>'status' = 'approved'
     AND COALESCE(actor->>'mustChangePassword', 'false') <> 'true' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS documents_users_privilege ON documents;
CREATE TRIGGER documents_users_privilege
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION users_keep_privilege();

-- Reference numbers only move forward. A merge that writes nextSeq: 0 rewinds
-- the counter and the next incident is handed a number already printed.
CREATE OR REPLACE FUNCTION meta_counters_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF collection_of(NEW.path) <> 'meta' OR NEW.id = 'cryptoKeys' THEN
    RETURN NEW;
  END IF;
  IF COALESCE((OLD.data->>'nextSeq')::numeric, 0) > COALESCE((NEW.data->>'nextSeq')::numeric, 0)
     OR COALESCE((OLD.data->>'permitSeq')::numeric, 0) > COALESCE((NEW.data->>'permitSeq')::numeric, 0)
     OR COALESCE((OLD.data->>'n')::numeric, 0) > COALESCE((NEW.data->>'n')::numeric, 0) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_meta_forward ON documents;
CREATE TRIGGER documents_meta_forward
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION meta_counters_forward();

-- Verified / closed clinical decisions are a manager act. The check reads the
-- actor's profile, not the role on the injury being saved.
CREATE OR REPLACE FUNCTION manager_decisions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  old_status text := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.data->>'status', '') ELSE '' END;
  new_status text := COALESCE(NEW.data->>'status', '');
BEGIN
  IF collection_of(NEW.path) = 'injuries'
     AND new_status = 'verified'
     AND old_status IS DISTINCT FROM 'verified'
     AND NOT is_manager() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  IF collection_of(NEW.path) = 'illnesses'
     AND new_status IN ('closed', 'verified')
     AND old_status IS DISTINCT FROM new_status
     AND NOT is_manager() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_manager_decisions ON documents;
CREATE TRIGGER documents_manager_decisions
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION manager_decisions();

-- ── documents: permissive grants ─────────────────────────────────────────────
-- Earlier per-tenant policies, dropped so an upgraded database does not keep
-- a grant this file no longer makes.
DROP POLICY IF EXISTS read_org_users ON documents;
DROP POLICY IF EXISTS read_org ON documents;
DROP POLICY IF EXISTS read_org_root ON documents;
DROP POLICY IF EXISTS update_org_root ON documents;
DROP POLICY IF EXISTS gate_org_field ON documents;

DROP POLICY IF EXISTS read_own_user ON documents;
CREATE POLICY read_own_user ON documents FOR SELECT TO ohsms_browser
  USING (path = 'users' AND id = app_uid());

-- An approved member reads the organization's records, users included.
DROP POLICY IF EXISTS read_app ON documents;
CREATE POLICY read_app ON documents FOR SELECT TO ohsms_browser
  USING (is_approved() AND NOT server_only_path(path));

-- The public mirrors behind printed QR codes: read by whoever scans them.
DROP POLICY IF EXISTS read_public ON documents;
CREATE POLICY read_public ON documents FOR SELECT TO ohsms_browser
  USING (path IN ('qr', 'permitQr', 'procedureQr'));

DROP POLICY IF EXISTS insert_writer ON documents;
CREATE POLICY insert_writer ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (
    is_writer()
    AND NOT special_path(path)
    AND NOT server_only_path(path)
    AND collection_of(path) <> 'cryptoKeys'
    AND NOT (collection_of(path) = 'meta' AND id = 'cryptoKeys')
  );

DROP POLICY IF EXISTS update_writer ON documents;
CREATE POLICY update_writer ON documents FOR UPDATE TO ohsms_browser
  USING (
    is_writer()
    AND NOT special_path(path)
    AND NOT server_only_path(path)
    AND NOT (collection_of(path) = 'meta' AND id = 'cryptoKeys')
  )
  WITH CHECK (
    is_writer()
    AND NOT special_path(path)
    AND NOT server_only_path(path)
    AND NOT (collection_of(path) = 'meta' AND id = 'cryptoKeys')
  );

-- Broad on purpose. The restrictive auditor policy below is what removes the
-- auditor. A second permissive "auditors may not delete" would not.
DROP POLICY IF EXISTS delete_member ON documents;
CREATE POLICY delete_member ON documents FOR DELETE TO ohsms_browser
  USING (is_approved() AND NOT special_path(path) AND NOT server_only_path(path));

-- The organization document: created by /setup (the worker), edited by an
-- administrator.
DROP POLICY IF EXISTS update_organization ON documents;
CREATE POLICY update_organization ON documents FOR UPDATE TO ohsms_browser
  USING (path = 'organization' AND id = 'profile' AND is_admin())
  WITH CHECK (path = 'organization' AND id = 'profile' AND is_admin());

-- Which modules the organization uses. Absent document means the full
-- product, so this only matters once an admin writes the row.
DROP POLICY IF EXISTS read_entitlement ON documents;
DROP POLICY IF EXISTS insert_entitlement ON documents;
CREATE POLICY insert_entitlement ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (path = 'moduleEntitlements' AND id = 'organization' AND is_admin());

DROP POLICY IF EXISTS update_entitlement ON documents;
CREATE POLICY update_entitlement ON documents FOR UPDATE TO ohsms_browser
  USING (path = 'moduleEntitlements' AND id = 'organization' AND is_admin())
  WITH CHECK (path = 'moduleEntitlements' AND id = 'organization' AND is_admin());

-- Anonymous, token-bound. The token has to name a live mirror, and the asset
-- id on the write has to be the one the mirror names. A token for one
-- extinguisher does not open reports against the others.
DROP POLICY IF EXISTS insert_anon_report ON documents;
CREATE POLICY insert_anon_report ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (
    app_uid() IS NULL
    AND path = 'reports'
    AND data->>'source' = 'qr'
    AND data->>'approvalStatus' = 'pending'
    AND data->>'reportedBy' = 'public'
    AND EXISTS (
      SELECT 1 FROM documents q
      WHERE q.path = 'qr' AND q.id = documents.data->>'token'
        AND COALESCE(q.data->>'deletedAt', '') = ''
        AND (
          (documents.data->>'kind' = 'defect' AND q.data->>'extId' = documents.data->>'extId' AND documents.data->>'extId' <> '')
          OR (
            documents.data->>'kind' = 'asset_defect'
            AND q.data->>'assetKind' = documents.data->>'assetKind'
            AND q.data->>'assetRefId' = documents.data->>'assetRefId'
            AND documents.data->>'assetRefId' <> ''
          )
        )
    )
  );

DROP POLICY IF EXISTS insert_anon_lock ON documents;
CREATE POLICY insert_anon_lock ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (
    app_uid() IS NULL
    AND path = 'defectLocks'
    AND id = (data->>'extId') || '__' || (data->>'defectType')
    AND COALESCE(data->>'extId', '') <> ''
    AND COALESCE(data->>'defectType', '') <> ''
    AND EXISTS (
      SELECT 1 FROM documents q
      WHERE q.path = 'qr' AND q.id = documents.data->>'token'
        AND COALESCE(q.data->>'deletedAt', '') = ''
        AND q.data->>'extId' = documents.data->>'extId'
    )
  );

DROP POLICY IF EXISTS insert_anon_observation ON documents;
CREATE POLICY insert_anon_observation ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (
    app_uid() IS NULL
    AND path = 'observations'
    AND data->>'source' = 'qr'
    AND data->>'approvalStatus' = 'pending'
    AND data->>'observedBy' = 'public'
    AND data->>'type' IN ('safe', 'unsafe')
    AND EXISTS (
      SELECT 1 FROM documents q
      WHERE q.path = 'permitQr' AND q.id = documents.data->>'token'
        AND q.data->>'permitId' = documents.data->>'permitId'
    )
  );

-- An administrator may add a member directly. Never another admin, and the
-- new account must change the password it was given.
DROP POLICY IF EXISTS insert_member ON documents;
CREATE POLICY insert_member ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (
    path = 'users'
    AND is_admin()
    AND data->>'role' <> 'admin'
    AND data->>'mustChangePassword' = 'true'
  );

DROP POLICY IF EXISTS insert_audit ON documents;
CREATE POLICY insert_audit ON documents FOR INSERT TO ohsms_browser
  WITH CHECK (
    collection_of(path) = 'auditLogs'
    AND is_approved()
    AND data->>'actorUid' = app_uid()
  );

DROP POLICY IF EXISTS update_member ON documents;
CREATE POLICY update_member ON documents FOR UPDATE TO ohsms_browser
  USING (path = 'users' AND is_admin())
  WITH CHECK (path = 'users' AND is_admin());

DROP POLICY IF EXISTS update_self ON documents;
CREATE POLICY update_self ON documents FOR UPDATE TO ohsms_browser
  USING (path = 'users' AND id = app_uid())
  WITH CHECK (path = 'users' AND id = app_uid());

DROP POLICY IF EXISTS delete_user ON documents;
CREATE POLICY delete_user ON documents FOR DELETE TO ohsms_browser
  USING (path = 'users' AND is_admin());

-- ── documents: restrictive (AND) ─────────────────────────────────────────────

DROP POLICY IF EXISTS gate_password ON documents;
CREATE POLICY gate_password ON documents AS RESTRICTIVE FOR ALL TO ohsms_browser
  USING (
    password_ok()
    OR (path = 'users' AND id = app_uid())
  )
  WITH CHECK (
    password_ok()
    OR (path = 'users' AND id = app_uid())
  );

DROP POLICY IF EXISTS gate_server_only ON documents;
CREATE POLICY gate_server_only ON documents AS RESTRICTIVE FOR ALL TO ohsms_browser
  USING (NOT server_only_path(path))
  WITH CHECK (NOT server_only_path(path));

DROP POLICY IF EXISTS gate_medical_read ON documents;
CREATE POLICY gate_medical_read ON documents AS RESTRICTIVE FOR SELECT TO ohsms_browser
  USING (NOT is_medical(path) OR is_manager());

DROP POLICY IF EXISTS gate_auditor_insert ON documents;
CREATE POLICY gate_auditor_insert ON documents AS RESTRICTIVE FOR INSERT TO ohsms_browser
  WITH CHECK (
    COALESCE(app_profile()->>'role', '') <> 'auditor'
    OR collection_of(path) = 'auditLogs'
  );

DROP POLICY IF EXISTS gate_auditor_update ON documents;
CREATE POLICY gate_auditor_update ON documents AS RESTRICTIVE FOR UPDATE TO ohsms_browser
  USING (COALESCE(app_profile()->>'role', '') <> 'auditor')
  WITH CHECK (COALESCE(app_profile()->>'role', '') <> 'auditor');

DROP POLICY IF EXISTS gate_auditor_delete ON documents;
CREATE POLICY gate_auditor_delete ON documents AS RESTRICTIVE FOR DELETE TO ohsms_browser
  USING (COALESCE(app_profile()->>'role', '') <> 'auditor');

DROP POLICY IF EXISTS gate_audit_immutable ON documents;
CREATE POLICY gate_audit_immutable ON documents AS RESTRICTIVE FOR UPDATE TO ohsms_browser
  USING (collection_of(path) <> 'auditLogs')
  WITH CHECK (collection_of(path) <> 'auditLogs');

DROP POLICY IF EXISTS gate_audit_no_delete ON documents;
CREATE POLICY gate_audit_no_delete ON documents AS RESTRICTIVE FOR DELETE TO ohsms_browser
  USING (collection_of(path) <> 'auditLogs');

DROP POLICY IF EXISTS gate_crypto_keys ON documents;
CREATE POLICY gate_crypto_keys ON documents AS RESTRICTIVE FOR ALL TO ohsms_browser
  USING (NOT (collection_of(path) = 'meta' AND id = 'cryptoKeys'))
  WITH CHECK (NOT (collection_of(path) = 'meta' AND id = 'cryptoKeys'));

-- ── files: manager delete, and the union regression ─────────────────────────

DROP POLICY IF EXISTS files_read ON files;
CREATE POLICY files_read ON files FOR SELECT TO ohsms_browser
  USING (is_approved());

DROP POLICY IF EXISTS files_insert ON files;
CREATE POLICY files_insert ON files FOR INSERT TO ohsms_browser
  WITH CHECK (is_writer() AND path LIKE 'files/%' AND path NOT LIKE '%..%');

-- Product rule: mirrors mayDeleteFile. Auditor and member cannot.
DROP POLICY IF EXISTS files_delete_manager ON files;
CREATE POLICY files_delete_manager ON files FOR DELETE TO ohsms_browser
  USING (is_manager() AND path LIKE 'files/%' AND path NOT LIKE '%..%');

DROP POLICY IF EXISTS union_delete_broad ON policy_union;
CREATE POLICY union_delete_broad ON policy_union FOR SELECT TO ohsms_browser
  USING (is_approved());

DROP POLICY IF EXISTS union_delete_broad_d ON policy_union;
CREATE POLICY union_delete_broad_d ON policy_union FOR DELETE TO ohsms_browser
  USING (is_approved());

DROP POLICY IF EXISTS union_auditor_cannot_delete ON policy_union;
CREATE POLICY union_auditor_cannot_delete ON policy_union AS RESTRICTIVE FOR DELETE TO ohsms_browser
  USING (COALESCE(app_profile()->>'role', '') <> 'auditor');

GRANT EXECUTE ON FUNCTION app_uid() TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION app_profile() TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION collection_of(text) TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION root_of(text) TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION is_medical(text) TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION server_only_path(text) TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION special_path(text) TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION password_ok() TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION is_approved() TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION is_writer() TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION is_manager() TO ohsms_browser, ohsms_worker;
GRANT EXECUTE ON FUNCTION is_admin() TO ohsms_browser, ohsms_worker;

-- The SECURITY DEFINER helpers above run as their owner, and only an owner
-- that bypasses row level security keeps the policy from re-entering itself:
-- app_profile() reads users, whose policy calls app_profile(). On an embedded
-- or self-run Postgres the owner is a superuser and that held by accident. On
-- a managed Postgres the owner is the ordinary login role, every member read
-- recursed until "stack depth limit exceeded", and the server could not serve
-- one signed-in page. Owned by the bypass role instead. ALTER OWNER needs that
-- role to be able to create in the schema.
GRANT USAGE, CREATE ON SCHEMA public TO ohsms_worker;
ALTER FUNCTION app_profile() OWNER TO ohsms_worker;
ALTER FUNCTION password_ok() OWNER TO ohsms_worker;
ALTER FUNCTION is_approved() OWNER TO ohsms_worker;
ALTER FUNCTION is_writer() OWNER TO ohsms_worker;
ALTER FUNCTION is_manager() OWNER TO ohsms_worker;
ALTER FUNCTION is_admin() OWNER TO ohsms_worker;
