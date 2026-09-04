import bcrypt from 'bcryptjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Valid credentials succeed, an invalid password is rejected, and an unknown
 * email is rejected the SAME way — uniform failure, so the response never
 * reveals whether an account exists.
 *
 * The user lookup is doubled here. It used to be a dedicated SECURITY DEFINER
 * module (lib/auth/auth-lookup.ts) that existed only to read `users` before a
 * tenant context could exist; single-tenant it is an ordinary Prisma read.
 */

const findUserMock = vi.fn()

vi.mock('@/lib/db/prisma', () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => findUserMock(...args) } },
}))

const KNOWN_USER = {
  id: 'user_1',
  email: 'admin@acme.test',
  name: 'Admin',
  image: null,
  role: 'ADMIN' as const,
}

describe('verifyCredentials', () => {
  beforeEach(() => {
    findUserMock.mockReset()
  })

  // --- 2. Valid credentials can successfully log in ------------------------
  it('returns the user for valid credentials', async () => {
    const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 4)
    findUserMock.mockResolvedValue({ ...KNOWN_USER, passwordHash })

    const { verifyCredentials } = await import('@/lib/auth/verify-credentials')
    const result = await verifyCredentials('admin@acme.test', 'correct-horse-battery-staple')

    expect(result).toMatchObject({ id: 'user_1', email: 'admin@acme.test', role: 'ADMIN' })
    // The hash itself must never be part of the returned session-worthy shape.
    expect(result).not.toHaveProperty('passwordHash')
  })

  // --- 3. Invalid password is rejected -------------------------------------
  it('rejects an invalid password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 4)
    findUserMock.mockResolvedValue({ ...KNOWN_USER, passwordHash })

    const { verifyCredentials } = await import('@/lib/auth/verify-credentials')
    const result = await verifyCredentials('admin@acme.test', 'wrong-password')

    expect(result).toBeNull()
  })

  // --- 4. Unknown email is rejected without revealing account existence ---
  it('rejects an unknown email the same way as a wrong password (uniform failure)', async () => {
    findUserMock.mockResolvedValue(null)

    const { verifyCredentials } = await import('@/lib/auth/verify-credentials')
    const unknownEmailResult = await verifyCredentials('nobody@acme.test', 'anything')

    expect(unknownEmailResult).toBeNull()
  })

  it('still performs a bcrypt comparison when no user is found (constant-work timing)', async () => {
    findUserMock.mockResolvedValue(null)
    const compareSpy = vi.spyOn(bcrypt, 'compare')

    const { verifyCredentials } = await import('@/lib/auth/verify-credentials')
    await verifyCredentials('nobody@acme.test', 'anything')

    // A response that skips the compare entirely for unknown users would
    // create a timing side-channel revealing whether the email is registered.
    expect(compareSpy).toHaveBeenCalledTimes(1)
    compareSpy.mockRestore()
  })

  it('never returns a user object with a null/missing password hash, even if returned by the lookup', async () => {
    findUserMock.mockResolvedValue({ ...KNOWN_USER, passwordHash: null })

    const { verifyCredentials } = await import('@/lib/auth/verify-credentials')
    const result = await verifyCredentials('admin@acme.test', 'anything')

    expect(result).toBeNull()
  })
})
