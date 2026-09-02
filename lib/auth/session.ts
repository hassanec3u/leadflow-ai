import 'server-only'

import { cache } from 'react'

import { auth } from '@/lib/auth/config'
import { type Capability, hasCapability } from '@/lib/auth/rbac'
import { withTenant } from '@/lib/db/tenant'
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors'

/**
 * Data Access Layer for identity and tenancy.
 *
 * This is the ONLY sanctioned way to learn who the caller is and which
 * organization they belong to. The organization is always derived from the
 * authenticated session — an organizationId arriving in a request body, query
 * string, header, or route parameter is never trusted.
 *
 * Following the Next.js guidance for App Router auth: checks live here (close
 * to the data), not solely in the proxy layer, which performs only an
 * optimistic redirect.
 *
 * `cache()` memoises per render pass, so a layout and several server components
 * resolving the current user in the same request share one database read.
 */

export type CurrentUser = {
  id: string
  email: string
  name: string | null
  role: 'ADMIN' | 'MANAGER' | 'SALES_REP'
  organizationId: string
}

export type CurrentOrganization = {
  id: string
  name: string
  slug: string
}

/**
 * Resolve the signed-in user, or null when there is no valid session.
 *
 * The user is re-read from the database rather than trusted wholesale from the
 * JWT: a token issued before a role change or a user deletion would otherwise
 * keep conferring stale privileges until it expired.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth()
  const userId = session?.user?.id
  const organizationId = session?.user?.organizationId

  if (!userId || !organizationId) return null

  // User is a tenant-owned table under RLS (FORCE ROW LEVEL SECURITY): it must
  // be read through withTenant(), or the query matches zero rows regardless of
  // a valid session. organizationId is already known from the signed JWT, so
  // no extra lookup is needed to establish tenant context here.
  const user = await withTenant(organizationId, (tx) =>
    tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        organizationId: true,
        organization: { select: { deletedAt: true } },
      },
    }),
  )

  if (!user) return null

  // A soft-deleted organization must not continue to grant access, even to a
  // session that was valid when it was issued.
  if (user.organization.deletedAt) return null

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    organizationId: user.organizationId,
  }
})

/** Like getCurrentUser, but throws when unauthenticated. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) {
    throw new UnauthenticatedError()
  }
  return user
}

/** The current tenant, or null when unauthenticated. */
export const getCurrentOrganization = cache(async (): Promise<CurrentOrganization | null> => {
  const user = await getCurrentUser()
  if (!user) return null

  // Same RLS requirement as getCurrentUser: Organization is tenant-owned and
  // must be read through withTenant().
  const organization = await withTenant(user.organizationId, (tx) =>
    tx.organization.findUnique({
      where: { id: user.organizationId },
      select: { id: true, name: true, slug: true, deletedAt: true },
    }),
  )

  if (!organization || organization.deletedAt) return null

  return { id: organization.id, name: organization.name, slug: organization.slug }
})

/** Like getCurrentOrganization, but throws when unauthenticated. */
export async function requireOrganization(): Promise<CurrentOrganization> {
  const organization = await getCurrentOrganization()
  if (!organization) {
    throw new UnauthenticatedError()
  }
  return organization
}

/**
 * Assert the caller holds one of `allowedRoles`.
 *
 * Server-side only. Hiding a button in the UI is presentation, not
 * authorization — every privileged path calls this.
 */
export async function requireRole(
  ...allowedRoles: Array<CurrentUser['role']>
): Promise<CurrentUser> {
  const user = await requireUser()

  if (!allowedRoles.includes(user.role)) {
    throw new ForbiddenError(undefined, {
      userId: user.id,
      requiredRoles: allowedRoles,
      actualRole: user.role,
    })
  }

  return user
}

/**
 * Assert the caller holds `capability`.
 *
 * Preferred over `requireRole` for anything non-trivial: it expresses intent
 * ("may manage integrations") rather than a role list that has to be updated in
 * every call site when the matrix changes.
 */
export async function requireCapability(capability: Capability): Promise<CurrentUser> {
  const user = await requireUser()

  if (!hasCapability(user.role, capability)) {
    throw new ForbiddenError(undefined, {
      userId: user.id,
      requiredCapability: capability,
      actualRole: user.role,
    })
  }

  return user
}
