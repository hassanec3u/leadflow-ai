import 'server-only'

import bcrypt from 'bcryptjs'

import { findUserForAuthentication } from '@/lib/auth/auth-lookup'
import type { Role } from '@/lib/auth/rbac'
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
 */

export type VerifiedUser = {
  id: string
  email: string
  name: string | null
  image: string | null
  organizationId: string
  role: Role
}

const DUMMY_HASH = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu'

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<VerifiedUser | null> {
  const user = await findUserForAuthentication(email)
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
    organizationId: user.organizationId,
    role: user.role,
  }
}
