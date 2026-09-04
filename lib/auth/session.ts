import 'server-only'

import { cache } from 'react'

import { auth } from '@/lib/auth/config'
import { type Capability, hasCapability } from '@/lib/auth/rbac'
import { prisma } from '@/lib/db/prisma'
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors'

/**
 * Data Access Layer for identity and authorization.
 *
 * This is the ONLY sanctioned way to learn who the caller is. The application
 * is single-tenant, so there is no organization to resolve — but authorization
 * is unchanged and still happens here, server-side, close to the data.
 *
 * Following the Next.js guidance for App Router auth: checks live here, not
 * solely in the proxy layer, which performs only an optimistic redirect.
 *
 * `cache()` memoises per render pass, so a layout and several server components
 * resolving the current user in the same request share one database read.
 */

export type CurrentUser = {
  id: string
  email: string
  name: string | null
  role: 'ADMIN' | 'MANAGER' | 'SALES_REP'
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

  if (!userId) return null

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  })

  if (!user) return null

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
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
