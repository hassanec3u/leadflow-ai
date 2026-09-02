-- LeadFlow AI — authentication pre-lookup SECURITY DEFINER exception
--
-- ONE-TIME, PRIVILEGED setup. Run once per database by a superuser (or a role
-- with CREATEROLE), e.g.:
--   docker exec -i <postgres-container> psql -U <superuser> -d <db> \
--     < prisma/manual/001_provision_auth_lookup_role.sql
--
-- WHY THIS IS NOT A PRISMA MIGRATION:
-- `prisma migrate deploy` runs as the application's own database role
-- (leadflow_app), which is deliberately NOSUPERUSER/NOCREATEROLE (see
-- docs/architecture.md §4). Every statement below needs privileges beyond
-- that role's — see the design note further down for exactly why, including
-- a real mistake this project made and fixed while first implementing this.
--
-- =============================================================================
-- WHY THIS EXCEPTION EXISTS
-- =============================================================================
-- Auth.js's Credentials provider must locate a user by EXACT EMAIL before any
-- organization is known — the email lookup is what determines the org. But
-- `users` carries FORCE ROW LEVEL SECURITY with
--   USING ("organizationId" = current_org_id())
-- and with no tenant context set (there can be none yet), that condition is
-- never true for any row. This is an inherent conflict between "the very
-- first, identity-establishing query of a session" and "every row requires a
-- tenant context that only exists after that query succeeds" — not a bug in
-- the general RLS design, which is otherwise correct and unchanged.
--
-- =============================================================================
-- HOW THIS EXCEPTION IS SCOPED
-- =============================================================================
-- 1. `leadflow_auth_lookup` is a NOLOGIN role — nothing can ever connect to
--    the database as this role directly.
-- 2. It holds SELECT on exactly the 7 named columns of `users` that Auth.js
--    needs. No other column, no other table.
-- 3. A NEW, ADDITIONAL policy (users_auth_lookup) grants SELECT visibility
--    ONLY `TO leadflow_auth_lookup`. The pre-existing `users_tenant_isolation`
--    policy is untouched and still governs every other access path,
--    including all of leadflow_app's normal traffic.
-- 4. The lookup function is `SECURITY DEFINER`, owned by
--    `leadflow_auth_lookup` — SECURITY DEFINER functions run with their
--    OWNER's privileges, which is the only reason this role's narrow grant
--    has any effect. It accepts exactly one argument (email), performs one
--    static, parameterized exact-match query, returns at most one row, and
--    only the columns Auth.js needs.
-- 5. `EXECUTE` on the function is revoked from PUBLIC and granted ONLY to
--    `leadflow_app` (a FUNCTION-level grant — this lets leadflow_app CALL the
--    function; it grants nothing else, and critically is NOT role
--    membership — see the design note below for why that distinction is the
--    entire point).
--
-- =============================================================================
-- DESIGN NOTE — A REAL MISTAKE, AND WHY THIS SCRIPT IS SHAPED THE WAY IT IS
-- =============================================================================
-- The first version of this fix created the function AS `leadflow_app`, then
-- ran `ALTER FUNCTION ... OWNER TO leadflow_auth_lookup` to hand it off.
-- That ALTER requires the CURRENT role to be a MEMBER of the new owner, so it
-- also did `GRANT leadflow_auth_lookup TO leadflow_app`.
--
-- That membership grant was a real, serious defect, caught by testing against
-- a real user row before shipping: PostgreSQL's row-security policies match
-- "TO role_name" by ROLE MEMBERSHIP, not literal identity — so once
-- leadflow_app inherited leadflow_auth_lookup, the new `users_auth_lookup`
-- policy (USING (true)) applied to leadflow_app'S OWN ORDINARY QUERIES too,
-- as an OR'd permissive policy. The general application role could suddenly
-- read every user row across every tenant, with no tenant context at all —
-- exactly the "no BYPASSRLS-shaped mechanism" outcome this fix is required to
-- avoid.
--
-- The fix: never grant `leadflow_auth_lookup` to `leadflow_app` at all. This
-- script creates the function directly AS `leadflow_auth_lookup` (via a
-- superuser's unconditional `SET ROLE`, which needs no prior membership), so
-- no ownership transfer — and no membership grant — is ever required.
-- `leadflow_app` ends up with exactly one relationship to this mechanism:
-- EXECUTE on one function. That is not role membership, confers no inherited
-- privileges, and cannot make it match the `users_auth_lookup` policy.
--
-- If you ever touch this script: do not (re)introduce
-- `GRANT leadflow_auth_lookup TO leadflow_app` (or to any other login-capable
-- role). Doing so silently defeats tenant isolation for whoever receives it.

-- ---------------------------------------------------------------------------
-- 1. The dedicated, inert role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadflow_auth_lookup') THEN
    CREATE ROLE leadflow_auth_lookup
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Exactly the columns Auth.js's Credentials provider needs to verify a
-- password and establish a session. No other column, and no other table.
GRANT SELECT (id, email, name, image, "passwordHash", "organizationId", role)
  ON users TO leadflow_auth_lookup;

-- Needed so the CREATE FUNCTION below (run as this role via SET ROLE) can
-- create the function in the public schema at all. This is a schema-level
-- CREATE privilege, unrelated to role membership — it does not let anything
-- log in as leadflow_auth_lookup (NOLOGIN) or let leadflow_app inherit it.
GRANT USAGE, CREATE ON SCHEMA public TO leadflow_auth_lookup;

-- ---------------------------------------------------------------------------
-- 2. Narrow, role-scoped read policy — SELECT only, one role only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "users_auth_lookup" ON "users";
CREATE POLICY "users_auth_lookup" ON "users"
  FOR SELECT
  TO leadflow_auth_lookup
  USING (true);

-- ---------------------------------------------------------------------------
-- 3. The lookup function, created directly AS leadflow_auth_lookup.
--
-- Run as a superuser, `SET ROLE` needs no prior grant — this is precisely
-- how the design note above avoids ever granting leadflow_app membership in
-- leadflow_auth_lookup.
--
-- LANGUAGE sql with a single static query — not `EXECUTE format(...)` or any
-- other dynamic-SQL construction — means `p_email` can never be interpreted
-- as SQL syntax, regardless of its content: it is always bound as a plain
-- text value. This makes the function immune to SQL injection by
-- construction, not by input sanitisation.
--
-- `lower(btrim(p_email))` matches the normalisation already applied to every
-- email before it reaches the database (lib/validation/auth.ts's emailSchema:
-- `.trim().toLowerCase()`).
--
-- `SET search_path = public, pg_temp` is standard SECURITY DEFINER hardening:
-- without it, an object created earlier in another role's search path could
-- shadow `users` or the enum type and hijack this function's behavior.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_lookup_user_by_email(text);

SET ROLE leadflow_auth_lookup;

CREATE FUNCTION auth_lookup_user_by_email(p_email text)
RETURNS TABLE (
  id text,
  email text,
  name text,
  image text,
  "passwordHash" text,
  "organizationId" text,
  role "Role"
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.email, u.name, u.image, u."passwordHash", u."organizationId", u.role
  FROM users u
  WHERE u.email = lower(btrim(p_email))
  LIMIT 1;
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. Lock down who may call it: leadflow_app only, explicitly not PUBLIC.
--    This is a FUNCTION-level EXECUTE grant, not role membership — it lets
--    leadflow_app call the function; it grants no other privilege and does
--    not make leadflow_app match the users_auth_lookup policy for its own
--    ordinary queries. See the design note above.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION auth_lookup_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(text) TO leadflow_app;
