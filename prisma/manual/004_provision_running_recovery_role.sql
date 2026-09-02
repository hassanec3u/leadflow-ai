-- LeadFlow AI — RUNNING-orphan recovery SECURITY DEFINER exception (Recovery micro-phase)
--
-- ONE-TIME, PRIVILEGED setup. Run once per database by a superuser, e.g.:
--   docker exec -i <postgres-container> psql -U <superuser> -d <db> \
--     < prisma/manual/004_provision_running_recovery_role.sql
--
-- Same shape, and the same reasoning, as prisma/manual/002 (the PENDING-run
-- recovery exception) — read that file's design note first; every constraint
-- it describes applies here too.
--
-- =============================================================================
-- WHY THIS IS A SEPARATE ROLE/FUNCTION, NOT AN EXTENSION OF manual/002
-- =============================================================================
-- manual/002's policy is deliberately narrowed to `status = 'PENDING'` and
-- reads only `workflow_runs`. A RUNNING-orphan sweep needs a DIFFERENT
-- staleness signal — it must also read `workflow_step_runs` to find the most
-- recent RUNNING step, since a step claim updates far more granularly than
-- the run row itself (see the doc comment on
-- lib/services/workflow-recovery.ts's recoverStuckRunningRuns). Broadening
-- the existing PENDING policy to also cover RUNNING, or adding a
-- cross-table grant to that role, would widen an exception that was
-- deliberately kept narrow for one purpose into one serving two different
-- staleness semantics. Two small, independently-auditable exceptions beat one
-- broadened one — the same principle every SECURITY DEFINER exception in this
-- project already follows.
--
-- =============================================================================
-- HOW THIS EXCEPTION IS SCOPED
-- =============================================================================
-- 1. `leadflow_running_recovery` is NOLOGIN — nothing can connect as it.
-- 2. It holds SELECT on exactly five columns of `workflow_runs` and exactly
--    three columns of `workflow_step_runs`. No other column, no other table
--    — notably not `leads`, and not the JSON `input`/`output` columns on
--    `workflow_step_runs`, which may carry step-scoped provider data.
-- 3. Its two policies are SELECT-only and restricted to `status = 'RUNNING'`
--    on both tables — the role cannot see a pending, succeeded, failed, or
--    blocked row at all, and can never write.
-- 4. The function takes no organization argument and cannot be parameterized
--    into a broader query: the filters are static, and it returns at most
--    `LEAST(max_rows, 200)` rows, oldest-stale-first.
-- 5. EXECUTE is revoked from PUBLIC and granted only to `leadflow_app`.
-- 6. The function only SELECTs candidate ids and their current
--    `recoveryAttempts` count. All WRITES — bumping the counter, re-emitting
--    the recovery event, or finalizing a run FAILED — happen afterward
--    through the ordinary, fully RLS-enforced `leadflow_app` path under
--    `withTenant()` (lib/services/workflow-runs.ts's `claimRunForRecovery`),
--    exactly mirroring how manual/002's PENDING sweep only ever reads
--    cross-tenant and re-emits through the normal path.
--
-- As in 001/002/003: NEVER `GRANT leadflow_running_recovery TO leadflow_app`.
-- Policies match by role MEMBERSHIP, so that grant would hand the general
-- application role this policy's cross-tenant visibility.

-- ---------------------------------------------------------------------------
-- 1. The dedicated, inert role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadflow_running_recovery') THEN
    CREATE ROLE leadflow_running_recovery
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT SELECT ("id", "organizationId", "leadId", "trigger", "status", "updatedAt", "recoveryAttempts")
  ON workflow_runs TO leadflow_running_recovery;

-- Only what is needed to compute "is a step currently claimed, and when was
-- it last touched" — never the step's own input/output/error columns.
GRANT SELECT ("workflowRunId", "status", "updatedAt")
  ON workflow_step_runs TO leadflow_running_recovery;

GRANT USAGE, CREATE ON SCHEMA public TO leadflow_running_recovery;

-- ---------------------------------------------------------------------------
-- 2. Narrow, role-scoped read policies — SELECT only, RUNNING rows only, on
--    both tables.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "workflow_runs_running_recovery_read" ON "workflow_runs";
CREATE POLICY "workflow_runs_running_recovery_read" ON "workflow_runs"
  FOR SELECT
  TO leadflow_running_recovery
  USING ("status" = 'RUNNING');

DROP POLICY IF EXISTS "workflow_step_runs_running_recovery_read" ON "workflow_step_runs";
CREATE POLICY "workflow_step_runs_running_recovery_read" ON "workflow_step_runs"
  FOR SELECT
  TO leadflow_running_recovery
  USING ("status" = 'RUNNING');

-- ---------------------------------------------------------------------------
-- 3. The sweep function, created directly AS the recovery role (so no
--    ownership transfer, and therefore no membership grant, is ever needed).
--
-- Staleness signal: GREATEST(run.updatedAt, MAX(RUNNING step.updatedAt)).
-- Only RUNNING step rows count — a SUCCEEDED/FAILED/SKIPPED/BLOCKED step's
-- updatedAt is a historical fact, not a liveness signal; only a step someone
-- might still be mid-provider-call on tells us the run could still be alive.
-- When no step is currently RUNNING (a crash between two steps), the run's
-- own updatedAt is the only signal, via COALESCE.
--
-- LANGUAGE sql with a single static, parameterized query — no dynamic SQL —
-- so neither argument can be interpreted as SQL syntax. `SET search_path`
-- guards against an object in another role's search path shadowing these
-- tables.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS automation_running_runs_for_recovery(int, int);

SET ROLE leadflow_running_recovery;

CREATE FUNCTION automation_running_runs_for_recovery(older_than_seconds int, max_rows int)
RETURNS TABLE (
  id text,
  "organizationId" text,
  "leadId" text,
  trigger "WorkflowRunTrigger",
  "recoveryAttempts" int
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    r."id",
    r."organizationId",
    r."leadId",
    r."trigger",
    r."recoveryAttempts"
  FROM workflow_runs r
  LEFT JOIN workflow_step_runs sr
    ON sr."workflowRunId" = r."id" AND sr."status" = 'RUNNING'
  WHERE r."status" = 'RUNNING'
  GROUP BY r."id", r."organizationId", r."leadId", r."trigger", r."recoveryAttempts", r."updatedAt"
  HAVING GREATEST(r."updatedAt", COALESCE(MAX(sr."updatedAt"), r."updatedAt"))
       < NOW() - make_interval(secs => GREATEST(older_than_seconds, 0))
  ORDER BY GREATEST(r."updatedAt", COALESCE(MAX(sr."updatedAt"), r."updatedAt"))
  LIMIT LEAST(GREATEST(max_rows, 0), 200);
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. Only the application role may call it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION automation_running_runs_for_recovery(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION automation_running_runs_for_recovery(int, int) TO leadflow_app;
