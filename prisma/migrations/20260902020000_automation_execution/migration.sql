-- LeadFlow AI — Automation execution engine (Phase 2C)
--
-- Schema support for running the fixed pipeline. See docs/architecture.md §5
-- (data flow), §10 (single fixed pipeline) and the Phase 2C decisions D1–D3.
--
-- This migration adds no new tables: Phase 2A's four models already carry the
-- execution shape. What it adds is (1) the qualification-outcome columns the
-- pipeline writes, (2) the BLOCKED states, (3) the D3 enrollment requirement,
-- and (4) the two partial unique indexes that make execution idempotent.
--
-- RLS: no new policies. Every table touched here is already covered by the
-- policies installed in 20260901000100_rls / 20260902000000_lead_foundation /
-- 20260902010000_automation_domain_model, and none of them are weakened.

-- ---------------------------------------------------------------------------
-- D1 — qualification outcome, kept separate from status and from the
-- Hot/Warm/Cold bucket.
-- ---------------------------------------------------------------------------
CREATE TYPE "LeadQualificationOutcome" AS ENUM ('QUALIFIED', 'UNQUALIFIED');

CREATE TYPE "QualificationSource" AS ENUM ('AI', 'HUMAN');

ALTER TABLE "leads" ADD COLUMN "qualificationOutcome" "LeadQualificationOutcome";
ALTER TABLE "leads" ADD COLUMN "qualificationSource" "QualificationSource";
ALTER TABLE "leads" ADD COLUMN "qualificationUpdatedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- D2 — BLOCKED, for a configuration/precondition that stops the workflow
-- completing normally (e.g. a qualified lead in an org with no email provider
-- connected). NOT for a provider that was called and failed — that is FAILED.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12+
-- as long as the new value is not USED in the same transaction. Nothing below
-- references 'BLOCKED', so this is safe under `prisma migrate deploy`.
-- ---------------------------------------------------------------------------
ALTER TYPE "WorkflowRunStatus" ADD VALUE 'BLOCKED';

ALTER TYPE "WorkflowStepRunStatus" ADD VALUE 'BLOCKED';

-- ---------------------------------------------------------------------------
-- D3 — every run belongs to an enrollment, including a manual re-run.
--
-- A MANUAL_RERUN creates a NEW run against the SAME enrollment, so the column
-- becomes NOT NULL and the FK switches from SET NULL to CASCADE (SET NULL is
-- not expressible on a NOT NULL column, and a run cannot outlive the
-- enrollment it belongs to).
-- ---------------------------------------------------------------------------
ALTER TABLE "workflow_runs" ALTER COLUMN "workflowEnrollmentId" SET NOT NULL;

ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_workflowEnrollmentId_fkey";

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowEnrollmentId_fkey" FOREIGN KEY ("workflowEnrollmentId") REFERENCES "workflow_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Idempotency — two PARTIAL unique indexes.
--
-- Prisma has no filtered-index syntax for PostgreSQL, so these are hand-written
-- here and documented on the WorkflowRun model. They are load-bearing, not
-- optimizations: they are what makes duplicate event delivery and concurrent
-- execution safe at the database level rather than by application timing.
-- ---------------------------------------------------------------------------

-- At most ONE automatic run per enrollment (invariants 1 + 2): a duplicate
-- capture, a re-delivered event, or two concurrent captures cannot produce a
-- second automatic run. Manual re-runs are unconstrained by this index.
CREATE UNIQUE INDEX "workflow_runs_automatic_per_enrollment_key"
  ON "workflow_runs" ("workflowEnrollmentId")
  WHERE "trigger" = 'AUTOMATIC';

-- At most ONE in-flight run per lead. This is what makes "re-run" safe: a
-- manual re-run cannot start while another run for the same lead is still
-- PENDING or RUNNING, so two executions can never race over the same Lead row.
CREATE UNIQUE INDEX "workflow_runs_one_active_per_lead_key"
  ON "workflow_runs" ("leadId")
  WHERE "status" IN ('PENDING', 'RUNNING');

-- Recovery sweep support: the reconciler looks for old PENDING runs.
CREATE INDEX "workflow_runs_status_createdAt_idx" ON "workflow_runs" ("status", "createdAt");
