-- LeadFlow AI — RUNNING-orphan recovery tracking (Recovery micro-phase)
--
-- Two additive, nullable/defaulted columns on WorkflowRun. No RLS change is
-- needed: the existing "workflow_runs_tenant_isolation" policy scopes on
-- organizationId, which these columns do not touch, and a plain column
-- addition changes nothing about row visibility.
--
-- WHY THESE COLUMNS: a WorkflowRun can be left RUNNING forever if Inngest
-- itself exhausts its own retries (see docs/architecture — the pipeline's
-- function-level `retries: 2` already recovers an ordinary worker crash by
-- replaying; these columns exist only for the residual case where even that
-- gives up). Recovery re-requests execution a bounded number of times before
-- giving up and finalizing the run FAILED, which is what frees the
-- one-active-run-per-lead partial unique index for a future run.
ALTER TABLE "workflow_runs" ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workflow_runs" ADD COLUMN "lastRecoveryAttemptAt" TIMESTAMP(3);
