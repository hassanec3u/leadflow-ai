-- LeadFlow AI — Lead ownership becomes optional (Phase 1.1 business-rules closure)
--
-- A Lead may exist "Unassigned" (ownerId = null). No fake system owner, no
-- auto-assignment to an admin — see lib/services/leads.ts `resolveOwnerId()`.
-- The FK (leads_ownerId_fkey, ON DELETE RESTRICT) is unaffected: RESTRICT
-- simply does not apply to rows with a null ownerId, and continues to protect
-- assigned leads from an owner being deleted out from under them.
-- Existing assigned leads are untouched by this migration.

ALTER TABLE "leads" ALTER COLUMN "ownerId" DROP NOT NULL;
