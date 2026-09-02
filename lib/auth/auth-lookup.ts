import 'server-only'

import { prisma } from '@/lib/db/prisma'
import type { Role } from '@/lib/auth/rbac'

/**
 * Pre-authentication user lookup — the ONE deliberate, narrowly-scoped
 * exception to `users`' tenant RLS policy.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * Auth.js's Credentials provider must find a user by exact email BEFORE any
 * organization is known — the email lookup is what determines which
 * organization the session belongs to. `users` is protected by
 * `FORCE ROW LEVEL SECURITY` requiring `organizationId = current_org_id()`
 * for any visibility at all, and there is no tenant context yet at this
 * point in the flow. Querying `users` through the ordinary Prisma client
 * (which carries no tenant context) would — correctly, per that policy — see
 * zero rows, making login impossible.
 *
 * =============================================================================
 * WHAT THE EXCEPTION ACTUALLY IS
 * =============================================================================
 * This function calls a single PostgreSQL SECURITY DEFINER function,
 * `auth_lookup_user_by_email` (prisma/migrations/20260901000200_.../migration.sql),
 * owned by a dedicated, NOLOGIN role (`leadflow_auth_lookup`) that holds
 * SELECT on exactly seven named columns of `users` — nothing else, on no
 * other table. A companion RLS policy (`users_auth_lookup`) grants read
 * visibility ONLY to that one inert role; the general `users_tenant_isolation`
 * policy is completely untouched and still governs the application's normal
 * runtime role (`leadflow_app`) for every other access path.
 *
 * =============================================================================
 * WHY THIS IS NOT A GENERAL BYPASS
 * =============================================================================
 * - The database function accepts only an email, does one static exact-match
 *   query, and returns at most one row of a fixed, minimal shape. It cannot
 *   be parameterized into a broader query and does not accept an
 *   organizationId from any caller.
 * - `leadflow_auth_lookup` is NOLOGIN — nothing can connect to the database
 *   as that role directly, ever.
 * - `EXECUTE` on the function is revoked from PUBLIC and granted only to the
 *   application's runtime role, `leadflow_app`.
 * - This is the ONLY place in the codebase that calls this function. Every
 *   other query, including everything that runs after a session is
 *   established, goes through `withTenant()` and the ordinary, fully
 *   RLS-enforced path (see lib/db/tenant.ts, lib/auth/session.ts).
 *
 * =============================================================================
 * INJECTION SAFETY
 * =============================================================================
 * The database function is `LANGUAGE sql` with one static, parameterized
 * query — there is no dynamic SQL construction inside it, so its argument can
 * never be interpreted as SQL syntax. On the application side, `$queryRaw`'s
 * tagged-template form binds `${email}` as a query parameter (via the
 * underlying `pg` driver), not by string interpolation — so this call is
 * parameterized end to end.
 */

export type AuthLookupUser = {
  id: string
  email: string
  name: string | null
  image: string | null
  passwordHash: string | null
  organizationId: string
  role: Role
}

export async function findUserForAuthentication(email: string): Promise<AuthLookupUser | null> {
  const rows = await prisma.$queryRaw<AuthLookupUser[]>`
    SELECT * FROM auth_lookup_user_by_email(${email})
  `
  return rows[0] ?? null
}
