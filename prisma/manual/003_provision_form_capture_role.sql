-- LeadFlow AI — Website Form capture tenant-resolution SECURITY DEFINER exception
--
-- ONE-TIME, PRIVILEGED setup. Run once per database by a superuser (or a role
-- with CREATEROLE), e.g.:
--   docker exec -i <postgres-container> psql -U <superuser> -d <db> \
--     < prisma/manual/003_provision_form_capture_role.sql
--
-- WHY THIS IS NOT A PRISMA MIGRATION:
-- `prisma migrate deploy` runs as leadflow_app, which is deliberately
-- NOSUPERUSER/NOCREATEROLE (docs/architecture.md §4). Creating a role, and
-- creating a function AS that role, both need privileges it does not have.
-- Identical reasoning to prisma/manual/001 and /002.
--
-- =============================================================================
-- WHY THIS EXCEPTION EXISTS
-- =============================================================================
-- A public Website Form submission arrives with NO session and NO tenant
-- context: the whole point of the capture secret is to DETERMINE which
-- organization the submission belongs to. But `organizations` carries FORCE
-- ROW LEVEL SECURITY with
--   USING ("id" = current_org_id())
-- and with no tenant context set (there can be none yet), that condition is
-- never true for any row. Same inherent conflict as the pre-authentication
-- user lookup in manual/001 — "the identity-establishing query cannot itself
-- require the identity it establishes" — and it is solved the same way rather
-- than by weakening the tenant policy.
--
-- =============================================================================
-- HOW THIS EXCEPTION IS SCOPED
-- =============================================================================
-- 1. `leadflow_form_capture` is a NOLOGIN role — nothing can connect as it.
-- 2. It holds SELECT on exactly THREE named columns of `organizations`
--    (id, formCaptureSecretHash, deletedAt). No other column — notably not
--    `name` or `slug` — and no other table.
-- 3. A NEW, ADDITIONAL policy (organizations_form_capture_lookup) grants
--    SELECT visibility ONLY `TO leadflow_form_capture`. The pre-existing
--    `organizations_tenant_isolation` policy is untouched and still governs
--    every other access path, including all of leadflow_app's normal traffic.
-- 4. The function is SECURITY DEFINER, owned by `leadflow_form_capture`.
-- 5. EXECUTE is revoked from PUBLIC and granted ONLY to `leadflow_app`.
--
-- =============================================================================
-- WHY THIS CANNOT BECOME A GENERAL RLS BYPASS
-- =============================================================================
-- The function takes a SHA-256 HASH and returns ONE column: "organizationId".
-- It returns nothing else about the organization, and it cannot be used to
-- enumerate: a caller must already possess a valid secret to learn anything,
-- and what it learns is an id it is by definition entitled to act on. There is
-- no wildcard, no LIKE, no "return all rows" input — an unmatched hash yields
-- zero rows. Soft-deleted organizations are excluded, so a closed account's
-- secret stops working immediately.
--
-- Note the plaintext secret NEVER reaches PostgreSQL: hashing happens in the
-- application (lib/auth/form-capture-lookup.ts), so the credential cannot
-- appear in query logs, `pg_stat_activity`, or an error message.
--
-- =============================================================================
-- DESIGN NOTE — DO NOT GRANT ROLE MEMBERSHIP
-- =============================================================================
-- Never write `GRANT leadflow_form_capture TO leadflow_app`. PostgreSQL
-- matches row-security policies by ROLE MEMBERSHIP, so that single statement
-- would make the permissive `organizations_form_capture_lookup` policy
-- (USING (true)) apply to leadflow_app's OWN ordinary queries — letting the
-- general application role read every organization row, with no tenant
-- context, across every tenant. manual/001 documents this exact mistake being
-- made and caught in this project. The function is therefore created directly
-- AS `leadflow_form_capture` via a superuser's unconditional `SET ROLE`, so no
-- ownership transfer — and no membership grant — is ever needed. leadflow_app
-- ends up with exactly one relationship to this mechanism: EXECUTE on one
-- function.

-- ---------------------------------------------------------------------------
-- 1. The dedicated, inert role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadflow_form_capture') THEN
    CREATE ROLE leadflow_form_capture
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Exactly the three columns the lookup needs. Not `name`, not `slug`.
GRANT SELECT ("id", "formCaptureSecretHash", "deletedAt")
  ON "organizations" TO leadflow_form_capture;

-- Needed so the CREATE FUNCTION below (run as this role via SET ROLE) can
-- create the function in the public schema. Schema-level CREATE only —
-- unrelated to role membership, and NOLOGIN means it is never used at runtime.
GRANT USAGE, CREATE ON SCHEMA public TO leadflow_form_capture;

-- ---------------------------------------------------------------------------
-- 2. Narrow, role-scoped read policy — SELECT only, one role only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "organizations_form_capture_lookup" ON "organizations";
CREATE POLICY "organizations_form_capture_lookup" ON "organizations"
  FOR SELECT
  TO leadflow_form_capture
  USING (true);

-- ---------------------------------------------------------------------------
-- 3. The lookup function, created directly AS leadflow_form_capture.
--
-- LANGUAGE sql with a single static, parameterized query — no dynamic SQL —
-- so `p_secret_hash` can never be interpreted as SQL syntax regardless of its
-- content. `SET search_path = public, pg_temp` is standard SECURITY DEFINER
-- hardening: without it an object in another role's search path could shadow
-- `organizations` and hijack the function.
--
-- The empty/NULL guard matters: without it a NULL hash would match every
-- organization whose secret has not been issued yet (NULL = NULL is NULL, so
-- in practice it returns nothing — but the guard makes the intent explicit and
-- survives a future rewrite).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS form_capture_lookup_organization(text);

SET ROLE leadflow_form_capture;

CREATE FUNCTION form_capture_lookup_organization(p_secret_hash text)
RETURNS TABLE ("organizationId" text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT o."id"
  FROM "organizations" o
  WHERE p_secret_hash IS NOT NULL
    AND p_secret_hash <> ''
    AND o."formCaptureSecretHash" = p_secret_hash
    AND o."deletedAt" IS NULL
  LIMIT 1;
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. Lock down who may call it: leadflow_app only, explicitly not PUBLIC.
--    A FUNCTION-level EXECUTE grant, not role membership.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION form_capture_lookup_organization(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION form_capture_lookup_organization(text) TO leadflow_app;
