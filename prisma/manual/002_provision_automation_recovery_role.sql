-- LeadFlow AI — automation recovery SECURITY DEFINER exception (Phase 2C)
--
-- ONE-TIME, PRIVILEGED setup. Run once per database by a superuser, e.g.:
--   docker exec -i <postgres-container> psql -U <superuser> -d <db> \
--     < prisma/manual/002_provision_automation_recovery_role.sql
--
-- Same shape, and the same reasoning, as
-- prisma/manual/001_provision_auth_lookup_role.sql — read that file's design
-- note first; every constraint it describes applies here too.
--
-- =============================================================================
-- WHY THIS EXCEPTION EXISTS
-- =============================================================================
-- A WorkflowRun row is created inside the enrolling transaction; its Inngest
-- event is emitted only after that transaction commits. A crash in between
-- leaves a PENDING run that nothing will ever execute. The reconciler sweeps
-- for those — but it cannot know WHICH organizations have orphans, and
-- `workflow_runs` is under FORCE ROW LEVEL SECURITY requiring
-- `"organizationId" = current_org_id()`, which no cross-tenant sweep can
-- satisfy. This is the same "the query that must run before a tenant context
-- exists" conflict the auth lookup has, and it gets the same narrow answer.
--
-- =============================================================================
-- HOW THIS EXCEPTION IS SCOPED
-- =============================================================================
-- 1. `leadflow_automation_recovery` is NOLOGIN — nothing can connect as it.
-- 2. It holds SELECT on exactly six columns of ONE table (workflow_runs).
--    No other column, no other table. Notably NOT the leads table: the sweep
--    never sees lead data, only ids.
-- 3. Its policy is SELECT-only AND restricted to `status = 'PENDING'` — the
--    role cannot see a running or finished run at all. It can never write.
-- 4. The function takes no organization argument and cannot be parameterized
--    into a broader query: the filters are static and it returns at most
--    `LEAST(max_rows, 200)` rows.
-- 5. EXECUTE is revoked from PUBLIC and granted only to `leadflow_app`.
-- 6. Recovery only re-emits an event. Execution itself goes through the
--    ordinary RLS path, where the engine re-verifies the organization against
--    the run before touching anything.
--
-- As in 001: NEVER `GRANT leadflow_automation_recovery TO leadflow_app`.
-- Policies match by role MEMBERSHIP, so that grant would hand the general
-- application role this policy's cross-tenant visibility.

-- ---------------------------------------------------------------------------
-- 1. The dedicated, inert role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadflow_automation_recovery') THEN
    CREATE ROLE leadflow_automation_recovery
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT SELECT ("id", "organizationId", "leadId", "trigger", "status", "createdAt")
  ON workflow_runs TO leadflow_automation_recovery;

GRANT USAGE, CREATE ON SCHEMA public TO leadflow_automation_recovery;

-- ---------------------------------------------------------------------------
-- 2. Narrow, role-scoped read policy — SELECT only, PENDING rows only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "workflow_runs_recovery_read" ON "workflow_runs";
CREATE POLICY "workflow_runs_recovery_read" ON "workflow_runs"
  FOR SELECT
  TO leadflow_automation_recovery
  USING ("status" = 'PENDING');

-- ---------------------------------------------------------------------------
-- 3. The sweep function, created directly AS the recovery role (so no
--    ownership transfer, and therefore no membership grant, is ever needed).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS automation_pending_runs_for_recovery(int, int);

SET ROLE leadflow_automation_recovery;

CREATE FUNCTION automation_pending_runs_for_recovery(older_than_seconds int, max_rows int)
RETURNS TABLE (
  id text,
  "organizationId" text,
  "leadId" text,
  trigger "WorkflowRunTrigger"
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT r."id", r."organizationId", r."leadId", r."trigger"
  FROM workflow_runs r
  WHERE r."status" = 'PENDING'
    AND r."createdAt" < NOW() - make_interval(secs => GREATEST(older_than_seconds, 0))
  ORDER BY r."createdAt"
  LIMIT LEAST(GREATEST(max_rows, 0), 200);
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. Only the application role may call it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION automation_pending_runs_for_recovery(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION automation_pending_runs_for_recovery(int, int) TO leadflow_app;
