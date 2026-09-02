-- LeadFlow AI — per-organization qualification config (ICP micro-phase)
--
-- WHY APPEND-ONLY:
-- A WorkflowRun's score is only explainable if the configuration it was judged
-- against can still be read. A mutable settings row would answer "what is the
-- ICP now?", never "what was it when this lead scored 65 in March?". So a save
-- INSERTS a new version and the run points at the row it used. Rows are never
-- updated and never deleted — the Restrict foreign key below enforces that
-- rather than merely documenting it.
--
-- Deliberately NOT versioned through `Workflow.version`: a bare number cannot
-- restore the ICP text that produced a past score.

CREATE TABLE "qualification_config_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "icp" TEXT NOT NULL,
    "instructions" TEXT,
    "threshold" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qualification_config_versions_pkey" PRIMARY KEY ("id")
);

-- One row per (organization, version). The insert itself serialises two admins
-- saving at once: the loser sees the violation and retries against the new
-- latest, so a version number can never be reused with different content.
CREATE UNIQUE INDEX "qualification_config_versions_organizationId_version_key"
  ON "qualification_config_versions"("organizationId", "version");
CREATE INDEX "qualification_config_versions_organizationId_idx"
  ON "qualification_config_versions"("organizationId");

ALTER TABLE "qualification_config_versions"
  ADD CONSTRAINT "qualification_config_versions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, identical in shape to every other tenant-owned table
-- (docs/architecture.md §4): FORCE so even the table owner is subject to it,
-- and WITH CHECK so a tenant cannot plant a row inside another organization.
ALTER TABLE "qualification_config_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qualification_config_versions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "qualification_config_versions_tenant_isolation"
  ON "qualification_config_versions"
  FOR ALL
  USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());

-- The config a run was judged against. Nullable: runs created before this
-- existed have none, and a run may fail before reaching AI qualification.
ALTER TABLE "workflow_runs" ADD COLUMN "qualificationConfigVersionId" TEXT;

-- RESTRICT, never CASCADE: deleting the config a historical run was judged
-- against would destroy the explanation of its score.
ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_qualificationConfigVersionId_fkey"
  FOREIGN KEY ("qualificationConfigVersionId")
  REFERENCES "qualification_config_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
