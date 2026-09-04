import 'server-only'

import bcrypt from 'bcryptjs'

import type { Role } from '@/lib/auth/rbac'
import { prisma } from '@/lib/db/prisma'
import { logger } from '@/lib/logger'

/**
 * Verify an email/password pair against the database.
 *
 * Extracted from Auth.js's `authorize()` callback (which is not independently
 * callable/testable as configured inline) so this logic — and specifically
 * the uniform-failure property below — has a direct unit test.
 *
 * Uniform failure for "no such user" and "wrong password": a distinct
 * response would let an attacker enumerate registered email addresses. The
 * bcrypt compare still runs against a dummy hash when the user is absent so
 * the timing profile does not reveal existence either.
 *
 * This reads `users` through the ordinary Prisma client. While the product was
 * multi-tenant it could not: `users` was under FORCE ROW LEVEL SECURITY keyed
 * to a tenant that this very query was what established, so the lookup needed a
 * dedicated SECURITY DEFINER function and NOLOGIN role to escape the deadlock.
 * Single-tenant, there is no tenant to establish and no policy to escape, so
 * that machinery is gone.
 */

export type VerifiedUser = {
  id: string
  email: string
  name: string | null
  image: string | null
  role: Role
}

const DUMMY_HASH = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu'

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<VerifiedUser | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      passwordHash: true,
      role: true,
    },
  })

  const hashToCompare = user?.passwordHash ?? DUMMY_HASH
  const passwordMatches = await bcrypt.compare(password, hashToCompare)

  if (!user?.passwordHash || !passwordMatches) {
    logger.warn('Credential sign-in failed', { email })
    return null
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: user.role,
  }
}
