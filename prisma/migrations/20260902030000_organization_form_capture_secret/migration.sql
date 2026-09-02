-- LeadFlow AI — Website Form capture secret (Phase 2E-1)
--
-- Adds the per-organization capture credential required by
-- docs/architecture.md §6 ("our own inbound lead-capture endpoint is
-- authenticated via a per-org signing secret we issue"). Without it a public
-- Website Form endpoint has no trusted way to resolve a tenant, and the only
-- alternatives would be to trust an organization identifier supplied by the
-- client — which CLAUDE.md §4 forbids outright.
--
-- ONLY the hash is stored. The plaintext secret exists exactly once, in the
-- response to the admin who issued it, and is never persisted or logged.
--
-- The hash is SHA-256 (deterministic), NOT bcrypt: this credential is looked
-- up BY its hash, and a per-hash salt would turn one indexed equality into a
-- scan of every organization. That is safe here precisely because the secret
-- is 256 bits of CSPRNG output rather than a human-chosen password.
--
-- RLS is untouched: `organizations` keeps ENABLE + FORCE ROW LEVEL SECURITY
-- and its existing `organizations_tenant_isolation` policy, so an authenticated
-- admin can only ever read or write its own organization's hash. Resolving a
-- secret BEFORE any tenant context exists is a separate, deliberately narrow
-- exception provisioned by prisma/manual/003_provision_form_capture_role.sql —
-- the same SECURITY DEFINER + NOLOGIN-role pattern already used for the
-- pre-authentication user lookup (prisma/manual/001).

ALTER TABLE "organizations" ADD COLUMN "formCaptureSecretHash" TEXT;

-- One secret can never resolve to two organizations. Postgres permits many
-- NULLs under a unique index, so organizations without a secret are unaffected.
CREATE UNIQUE INDEX "organizations_formCaptureSecretHash_key"
  ON "organizations"("formCaptureSecretHash");
