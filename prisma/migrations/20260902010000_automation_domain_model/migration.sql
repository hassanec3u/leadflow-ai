-- LeadFlow AI — Automation domain model (Phase 2A)
--
-- See docs/architecture.md §10 (single fixed pipeline, not a multi-workflow
-- builder) and docs/roadmap.md Phase 2. This migration ships the persistence
-- shape only: no enrollment service, no Inngest, no execution, no providers,
-- no API/UI. The pipeline's steps are fixed in application code
-- (WorkflowStepKind) — there is deliberately no WorkflowStep table.
--
-- RLS follows the exact pattern established in
-- prisma/migrations/20260901000100_rls/migration.sql and reused by
-- prisma/migrations/20260902000000_lead_foundation/migration.sql (see that
-- file's header for the full rationale on FORCE, SET LOCAL, and fail-closed
-- semantics). `current_org_id()` already exists from that migration.
--
-- One exception to the plain "organizationId = current_org_id()" shape:
-- workflow_step_runs carries no organizationId column (a step run has no
-- independent existence outside its WorkflowRun — see the Prisma model doc
-- comment), so its policy scopes tenancy by joining to workflow_runs instead.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "WorkflowType" AS ENUM ('LEAD_QUALIFICATION');

CREATE TYPE "WorkflowStatus" AS ENUM ('ACTIVE', 'PAUSED');

CREATE TYPE "WorkflowEnrollmentTrigger" AS ENUM ('AUTOMATIC');

CREATE TYPE "WorkflowRunTrigger" AS ENUM ('AUTOMATIC', 'MANUAL_RERUN');

CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TYPE "WorkflowStepKind" AS ENUM ('ENRICH', 'AI_QUALIFY', 'SCORE_AND_TAG', 'ADD_TO_CRM', 'SEND_EMAIL', 'NOTIFY_TEAM');

CREATE TYPE "WorkflowStepRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- ---------------------------------------------------------------------------
-- workflows — one fixed pipeline per organization, auto-provisioned
-- (Phase 2B). Uniqueness on (organizationId, type) enforces "exactly one
-- LEAD_QUALIFICATION workflow per org" at the database level.
-- ---------------------------------------------------------------------------
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "WorkflowType" NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workflows_organizationId_idx" ON "workflows"("organizationId");

CREATE UNIQUE INDEX "workflows_organizationId_type_key" ON "workflows"("organizationId", "type");

ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflows" FORCE ROW LEVEL SECURITY;

CREATE POLICY "workflows_tenant_isolation" ON "workflows"
  FOR ALL
  USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());

-- ---------------------------------------------------------------------------
-- workflow_enrollments — automatic-enrollment identity: a lead is never
-- auto-enrolled in the same workflow more than once (docs/product-spec.md §8
-- dedup rule). Holds enrollment identity/metadata only, not execution state.
-- ---------------------------------------------------------------------------
CREATE TABLE "workflow_enrollments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "trigger" "WorkflowEnrollmentTrigger" NOT NULL DEFAULT 'AUTOMATIC',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workflow_enrollments_organizationId_idx" ON "workflow_enrollments"("organizationId");

CREATE INDEX "workflow_enrollments_leadId_idx" ON "workflow_enrollments"("leadId");

-- Automatic-enrollment identity: the same lead is never auto-enrolled in the
-- same workflow more than once.
CREATE UNIQUE INDEX "workflow_enrollments_workflowId_leadId_key" ON "workflow_enrollments"("workflowId", "leadId");

ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_enrollments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "workflow_enrollments_tenant_isolation" ON "workflow_enrollments"
  FOR ALL
  USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());

-- ---------------------------------------------------------------------------
-- workflow_runs — one execution instance of a workflow for one lead.
-- Distinct from workflow_enrollments: re-running (Phase 2B, explicit user
-- action) creates a new WorkflowRun from the beginning, not a new enrollment.
-- ---------------------------------------------------------------------------
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowEnrollmentId" TEXT,
    "leadId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "trigger" "WorkflowRunTrigger" NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workflow_runs_organizationId_idx" ON "workflow_runs"("organizationId");

CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");

CREATE INDEX "workflow_runs_leadId_idx" ON "workflow_runs"("leadId");

CREATE INDEX "workflow_runs_workflowEnrollmentId_idx" ON "workflow_runs"("workflowEnrollmentId");

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull (not Cascade): a MANUAL_RERUN run has no enrollment, and an
-- enrollment being removed should not delete the historical runs it produced.
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowEnrollmentId_fkey" FOREIGN KEY ("workflowEnrollmentId") REFERENCES "workflow_enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "workflow_runs_tenant_isolation" ON "workflow_runs"
  FOR ALL
  USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());

-- ---------------------------------------------------------------------------
-- workflow_step_runs — execution record for one step within one
-- WorkflowRun. Retries are represented by "attempts" on this same row; there
-- is no separate StepAttempt history table for MVP.
--
-- Not tenant-owned directly (no organizationId column): tenant isolation is
-- enforced by joining to workflow_runs.organizationId in its RLS policy.
-- ---------------------------------------------------------------------------
CREATE TABLE "workflow_step_runs" (
    "id" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "step" "WorkflowStepKind" NOT NULL,
    "status" "WorkflowStepRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "input" JSONB,
    "output" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);

-- A given run executes each step at most once (retries increment "attempts"
-- on the same row, they do not create new rows).
CREATE UNIQUE INDEX "workflow_step_runs_workflowRunId_step_key" ON "workflow_step_runs"("workflowRunId", "step");

ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_step_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_step_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "workflow_step_runs_tenant_isolation" ON "workflow_step_runs"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "workflow_runs" wr
      WHERE wr."id" = "workflow_step_runs"."workflowRunId"
        AND wr."organizationId" = current_org_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "workflow_runs" wr
      WHERE wr."id" = "workflow_step_runs"."workflowRunId"
        AND wr."organizationId" = current_org_id()
    )
  );
