import 'server-only'

import { createHash } from 'node:crypto'

import { prisma } from '@/lib/db/prisma'

/**
 * Pre-tenant organization lookup from a Website Form capture secret
 * (Phase 2E-1) — the second deliberate, narrowly-scoped exception to
 * `organizations`' tenant RLS policy.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * A public Website Form submission carries no session and no tenant context:
 * resolving WHICH organization it belongs to is the entire job. But
 * `organizations` is protected by FORCE ROW LEVEL SECURITY requiring
 * `id = current_org_id()`, and there is no tenant context yet at this point in
 * the flow — the ordinary Prisma client would correctly see zero rows.
 *
 * Structurally identical to lib/auth/auth-lookup.ts, and solved the same way:
 * one narrow SECURITY DEFINER function owned by a dedicated NOLOGIN role
 * (`leadflow_form_capture`), provisioned by
 * prisma/manual/003_provision_form_capture_role.sql. That function returns
 * exactly ONE column — the organization id — and nothing else about the
 * organization.
 *
 * =============================================================================
 * THE PLAINTEXT SECRET NEVER REACHES POSTGRES
 * =============================================================================
 * Hashing happens here, in the application, and only the hash is sent. So the
 * credential cannot surface in a query log, in `pg_stat_activity`, or in a
 * database error message — a stronger position than the email-based auth
 * lookup, which necessarily sends its input value.
 */

/**
 * SHA-256, hex. Deterministic on purpose: this credential is looked UP by its
 * hash, so a per-hash salt (bcrypt) would turn one indexed equality into a
 * scan of every organization. Safe because the secret is 256 bits of CSPRNG
 * output — it has no dictionary surface for a salt to defend. See
 * lib/services/organization-form-capture.ts for generation.
 */
export function hashFormCaptureSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Resolve the organization a capture secret belongs to, or null.
 *
 * Returns null for every failure mode without distinguishing them — unknown
 * secret, malformed secret, revoked secret, soft-deleted organization all look
 * identical to the caller, so the endpoint cannot be used as an oracle for
 * which secrets or organizations exist.
 *
 * Never throws for a bad secret, and never includes the secret (or its hash)
 * in anything it returns.
 */
export async function resolveOrganizationIdFromFormCaptureSecret(
  secret: string | null | undefined,
): Promise<string | null> {
  if (typeof secret !== 'string') return null

  const trimmed = secret.trim()
  if (trimmed === '') return null

  const rows = await prisma.$queryRaw<{ organizationId: string }[]>`
    SELECT * FROM form_capture_lookup_organization(${hashFormCaptureSecret(trimmed)})
  `

  return rows[0]?.organizationId ?? null
}
