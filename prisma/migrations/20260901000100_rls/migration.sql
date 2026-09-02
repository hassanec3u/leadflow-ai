-- LeadFlow AI — Row Level Security foundation (Phase 0)
--
-- See docs/architecture.md §4 (Multi-Tenancy) and §11 (Phase 0 implementation).
--
-- Design notes, because the details here are what make RLS actually work:
--
-- 1. FORCE ROW LEVEL SECURITY is essential, not decorative.
--    Plain ENABLE ROW LEVEL SECURITY does NOT apply to the table's owner. Our
--    application connects as the role that owns these tables, so with ENABLE
--    alone every policy below would be silently bypassed and this file would be
--    security theatre. FORCE applies policies to the owner too.
--
-- 2. Tenant context travels in a session GUC, `app.current_org_id`, set with
--    SET LOCAL inside a transaction by lib/db/tenant.ts. SET LOCAL is
--    transaction-scoped, so it is safe with connection pooling (PgBouncer /
--    Neon pooled endpoints): the value cannot leak into another request that
--    later borrows the same physical connection.
--
-- 3. current_setting(..., true) uses the missing_ok form, returning NULL rather
--    than raising when the GUC was never set. Combined with the policy shape
--    below, an unset context matches ZERO rows — the safe direction. A query
--    that forgets to establish tenant context returns nothing rather than
--    returning everything.
--
-- 4. Policies are written FOR ALL with both USING (read/update/delete
--    visibility) and WITH CHECK (insert/update writes), so a tenant can neither
--    read another tenant's rows nor write rows attributed to another tenant.

-- ---------------------------------------------------------------------------
-- Helper: resolve the current tenant from the session GUC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_org_id() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '');
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- organizations — a tenant may only see and modify its own organization row.
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organizations_tenant_isolation" ON "organizations"
  FOR ALL
  USING ("id" = current_org_id())
  WITH CHECK ("id" = current_org_id());

-- ---------------------------------------------------------------------------
-- users — scoped by the organizationId column carried on every row.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_tenant_isolation" ON "users"
  FOR ALL
  USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());

-- ---------------------------------------------------------------------------
-- Auth.js infrastructure tables (accounts, sessions, verification_tokens).
--
-- These are deliberately NOT under RLS.
--
-- Reason: Auth.js must read `sessions` / `accounts` / `verification_tokens`
-- during sign-in — i.e. BEFORE any organization is known. There is no tenant
-- context to enforce at that point, so an RLS policy could only ever be
-- "always true", which would add no security while breaking authentication.
--
-- These tables hold no tenant business data; they hold auth identifiers keyed
-- to a userId. Tenant isolation is enforced one hop later: the moment a session
-- resolves to a user, lib/auth/session.ts derives organizationId from that user
-- record and every subsequent tenant query runs under RLS.
--
-- This is a deliberate, documented exception rather than an oversight.
-- ---------------------------------------------------------------------------
