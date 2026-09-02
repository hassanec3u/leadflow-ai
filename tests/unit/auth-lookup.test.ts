import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for the application-side wrapper around the
 * `auth_lookup_user_by_email` SECURITY DEFINER function. The database-level
 * RLS/security guarantees are proven against real PostgreSQL in
 * tests/integration/auth-lookup-security-definer.test.ts; this file covers
 * the wrapper's own contract: it calls the right function, parameterized, and
 * shapes the result correctly.
 */

const queryRawMock = vi.fn()

vi.mock('@/lib/db/prisma', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRawMock(...args) },
}))

describe('findUserForAuthentication', () => {
  beforeEach(() => {
    queryRawMock.mockReset()
  })

  it('returns the single matching row', async () => {
    queryRawMock.mockResolvedValue([
      {
        id: 'user_1',
        email: 'admin@acme.test',
        name: 'Admin',
        image: null,
        passwordHash: '$2a$12$hash',
        organizationId: 'org_acme',
        role: 'ADMIN',
      },
    ])

    const { findUserForAuthentication } = await import('@/lib/auth/auth-lookup')
    const result = await findUserForAuthentication('admin@acme.test')

    expect(result).toMatchObject({ id: 'user_1', organizationId: 'org_acme' })
  })

  it('returns null when no row matches', async () => {
    queryRawMock.mockResolvedValue([])

    const { findUserForAuthentication } = await import('@/lib/auth/auth-lookup')
    expect(await findUserForAuthentication('nobody@acme.test')).toBeNull()
  })

  it('calls the SECURITY DEFINER function via a parameterized query, not string interpolation', async () => {
    queryRawMock.mockResolvedValue([])

    const { findUserForAuthentication } = await import('@/lib/auth/auth-lookup')
    await findUserForAuthentication("'; DROP TABLE users; --")

    // Prisma's $queryRaw tagged template passes [strings, ...values] — the
    // hostile input must appear only as a bound value, never spliced into the
    // SQL text itself.
    const [strings, ...values] = queryRawMock.mock.calls[0] as [string[], ...unknown[]]
    expect(values).toContain("'; DROP TABLE users; --")
    expect(strings.join('')).not.toContain('DROP TABLE')
    expect(strings.join('')).toContain('auth_lookup_user_by_email')
  })
})
