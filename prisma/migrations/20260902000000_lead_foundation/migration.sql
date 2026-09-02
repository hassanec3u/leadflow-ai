-- LeadFlow AI — Lead database foundation (Phase 1A)
--
-- See docs/product-spec.md §5 (Lead field list) and docs/roadmap.md Phase 1.
-- This migration ships the Lead table and its RLS policy only — no CRUD, no
-- API, no CSV import, no AI qualification, no workflow engine.
--
-- RLS follows the exact pattern established in
-- prisma/migrations/20260901000100_rls/migration.sql (see that file's header
-- for the full rationale on FORCE, SET LOCAL, and fail-closed semantics).
-- `current_org_id()` already exists from that migration and is reused as-is.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "LeadSource" AS ENUM ('WEBSITE_FORM', 'WEBHOOK', 'LINKEDIN', 'GOOGLE_ADS', 'REFERRAL', 'MANUAL', 'CSV_IMPORT');

CREATE TYPE "LeadQualification" AS ENUM ('HOT', 'WARM', 'COLD');

CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'ENRICHING', 'QUALIFIED', 'EMAILED', 'EMAIL_OPENED', 'REPLIED', 'CONVERTED', 'LOST');

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "source" "LeadSource" NOT NULL,
    "aiScore" INTEGER,
    "qualification" "LeadQualification",
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- Supports RLS/tenant-scoped lookups and is the prefix of the unique index
-- below, so it also backs plain organizationId-only queries.
CREATE INDEX "leads_organizationId_idx" ON "leads"("organizationId");

-- Tenant-scoped dedup (docs/product-spec.md §5): a repeat submission with the
-- same email within an org updates the existing row instead of creating a
-- duplicate. Deliberately scoped to (organizationId, email), NOT a global
-- unique on email alone — the same person may be a lead at two different
-- tenant organizations.
CREATE UNIQUE INDEX "leads_organizationId_email_key" ON "leads"("organizationId", "email");

ALTER TABLE "leads" ADD CONSTRAINT "leads_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT (not CASCADE): a user who owns leads cannot be deleted out from
-- under them until they are reassigned — reassignment behavior/UI is not
-- Phase 1A.
ALTER TABLE "leads" ADD CONSTRAINT "leads_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row Level Security — same shape as organizations/users
-- (prisma/migrations/20260901000100_rls/migration.sql).
-- ---------------------------------------------------------------------------
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;

CREATE POLICY "leads_tenant_isolation" ON "leads"
  FOR ALL
  USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());
