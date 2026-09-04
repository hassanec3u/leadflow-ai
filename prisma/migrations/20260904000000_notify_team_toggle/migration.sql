-- Notify Team step toggle.
--
-- `status` (ACTIVE/PAUSED) stops the whole pipeline; this turns off one
-- optional step while the rest keeps running. Defaults to true so existing
-- behaviour is unchanged.
--
-- NOTE: `prisma migrate diff` also proposed dropping
-- "workflow_runs_status_createdAt_idx" here. That DROP was deliberately NOT
-- kept: the index is hand-written in 0_init to support the PENDING-run
-- recovery sweep (lib/services/workflow-recovery.ts), and Prisma cannot
-- express it in schema.prisma, so every future diff will keep reporting it as
-- drift. It is not drift — do not let a later regeneration remove it.

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN     "notifyTeamEnabled" BOOLEAN NOT NULL DEFAULT true;
