-- LeadFlow AI — initial schema (single-tenant).
--
-- This migration replaces the ten migrations that existed while the product
-- was multi-tenant. Row level security, the current_org_id() helper and the
-- four SECURITY DEFINER roles those migrations installed are all gone: with
-- one tenant there are no rows to isolate. See docs/architecture.md §4.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'SALES_REP');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEBSITE_FORM', 'WEBHOOK', 'LINKEDIN', 'GOOGLE_ADS', 'REFERRAL', 'MANUAL', 'CSV_IMPORT');

-- CreateEnum
CREATE TYPE "LeadQualification" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "LeadQualificationOutcome" AS ENUM ('QUALIFIED', 'UNQUALIFIED');

-- CreateEnum
CREATE TYPE "QualificationSource" AS ENUM ('AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'ENRICHING', 'QUALIFIED', 'EMAILED', 'EMAIL_OPENED', 'REPLIED', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "WorkflowType" AS ENUM ('LEAD_QUALIFICATION');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "WorkflowEnrollmentTrigger" AS ENUM ('AUTOMATIC');

-- CreateEnum
CREATE TYPE "WorkflowRunTrigger" AS ENUM ('AUTOMATIC', 'MANUAL_RERUN');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "WorkflowStepKind" AS ENUM ('ENRICH', 'AI_QUALIFY', 'SCORE_AND_TAG', 'ADD_TO_CRM', 'SEND_EMAIL', 'NOTIFY_TEAM');

-- CreateEnum
CREATE TYPE "WorkflowStepRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'BLOCKED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "role" "Role" NOT NULL DEFAULT 'SALES_REP',
    "slackUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "formMessage" TEXT,
    "source" "LeadSource" NOT NULL,
    "aiScore" INTEGER,
    "qualification" "LeadQualification",
    "qualificationOutcome" "LeadQualificationOutcome",
    "qualificationSource" "QualificationSource",
    "qualificationUpdatedAt" TIMESTAMP(3),
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "type" "WorkflowType" NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_enrollments" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "trigger" "WorkflowEnrollmentTrigger" NOT NULL DEFAULT 'AUTOMATIC',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowEnrollmentId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "qualificationConfigVersionId" TEXT,
    "trigger" "WorkflowRunTrigger" NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastRecoveryAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualification_config_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "icp" TEXT NOT NULL,
    "instructions" TEXT,
    "threshold" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qualification_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "leads_email_key" ON "leads"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_type_key" ON "workflows"("type");

-- CreateIndex
CREATE INDEX "workflow_enrollments_leadId_idx" ON "workflow_enrollments"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_enrollments_workflowId_leadId_key" ON "workflow_enrollments"("workflowId", "leadId");

-- CreateIndex
CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_runs_leadId_idx" ON "workflow_runs"("leadId");

-- CreateIndex
CREATE INDEX "workflow_runs_workflowEnrollmentId_idx" ON "workflow_runs"("workflowEnrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "qualification_config_versions_version_key" ON "qualification_config_versions"("version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_runs_workflowRunId_step_key" ON "workflow_step_runs"("workflowRunId", "step");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowEnrollmentId_fkey" FOREIGN KEY ("workflowEnrollmentId") REFERENCES "workflow_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_qualificationConfigVersionId_fkey" FOREIGN KEY ("qualificationConfigVersionId") REFERENCES "qualification_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written indexes Prisma cannot express.
--
-- Prisma has no filtered-index syntax for PostgreSQL, so the two PARTIAL
-- unique indexes below are written here and documented on the WorkflowRun
-- model. They are load-bearing, not optimizations: they are what makes
-- duplicate event delivery and concurrent execution safe at the database
-- level rather than by application timing. Do not drop them by regenerating
-- the schema from the database.
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
