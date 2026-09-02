import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * auth-1 / tenancy-1 in tests.json.
 *
 * Proves the central multi-tenancy rule: the organization is derived from the
 * authenticated session, and an organizationId supplied by the client is never
 * consulted. Auth.js and Prisma are mocked here because the behaviour under
 * test is our resolution logic, not their internals — the database-enforced
 * half of this guarantee is covered by rls-tenant-isolation.test.ts.
 */

const authMock = vi.fn()
const findUniqueUserMock = vi.fn()
const findUniqueOrgMock = vi.fn()

vi.mock('@/lib/auth/config', () => ({
  auth: () => authMock(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => findUniqueUserMock(...args) },
    organization: { findUnique: (...args: unknown[]) => findUniqueOrgMock(...args) },
  },
}))

const ACME_USER = {
  id: 'user_acme_admin',
  email: 'admin@acme.test',
  name: 'Acme Admin',
  role: 'ADMIN' as const,
  organizationId: 'org_acme',
  organization: { deletedAt: null },
}

async function importSession() {
  // Re-import per test so React's cache() memoisation does not bleed across cases.
  vi.resetModules()
  return import('@/lib/auth/session')
}

describe('session-derived tenancy', () => {
  beforeEach(() => {
    authMock.mockReset()
    findUniqueUserMock.mockReset()
    findUniqueOrgMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { getCurrentUser } = await importSession()

    expect(await getCurrentUser()).toBeNull()
    // No session must mean no database lookup at all.
    expect(findUniqueUserMock).not.toHaveBeenCalled()
  })

  it('resolves the organization from the session user record', async () => {
    authMock.mockResolvedValue({ user: { id: 'user_acme_admin' } })
    findUniqueUserMock.mockResolvedValue(ACME_USER)

    const { getCurrentUser } = await importSession()
    const user = await getCurrentUser()

    expect(user?.organizationId).toBe('org_acme')
    // Looked up strictly by the session's user id — nothing else is consulted.
    expect(findUniqueUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_acme_admin' } }),
    )
  })

  it('re-reads the user from the database rather than trusting session claims', async () => {
    // The session claims ADMIN; the database says the role was downgraded.
    authMock.mockResolvedValue({
      user: { id: 'user_acme_admin', role: 'ADMIN', organizationId: 'org_globex' },
    })
    findUniqueUserMock.mockResolvedValue({ ...ACME_USER, role: 'SALES_REP' })

    const { getCurrentUser } = await importSession()
    const user = await getCurrentUser()

    // Database wins on both counts — a stale token cannot retain privileges,
    // and cannot redirect the caller into another tenant.
    expect(user?.role).toBe('SALES_REP')
    expect(user?.organizationId).toBe('org_acme')
  })

  it('refuses access when the organization is soft-deleted', async () => {
    authMock.mockResolvedValue({ user: { id: 'user_acme_admin' } })
    findUniqueUserMock.mockResolvedValue({
      ...ACME_USER,
      organization: { deletedAt: new Date() },
    })

    const { getCurrentUser } = await importSession()
    expect(await getCurrentUser()).toBeNull()
  })

  it('refuses access when the user no longer exists', async () => {
    authMock.mockResolvedValue({ user: { id: 'user_deleted' } })
    findUniqueUserMock.mockResolvedValue(null)

    const { getCurrentUser } = await importSession()
    expect(await getCurrentUser()).toBeNull()
  })

  it('requireUser throws UnauthenticatedError when signed out', async () => {
    authMock.mockResolvedValue(null)
    const { requireUser } = await importSession()

    await expect(requireUser()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 })
  })
})

describe('role and capability enforcement', () => {
  beforeEach(() => {
    authMock.mockReset()
    findUniqueUserMock.mockReset()
  })

  it('allows a permitted role and rejects a non-permitted one', async () => {
    authMock.mockResolvedValue({ user: { id: 'user_acme_admin' } })
    findUniqueUserMock.mockResolvedValue(ACME_USER)

    const { requireRole } = await importSession()
    await expect(requireRole('ADMIN')).resolves.toMatchObject({ role: 'ADMIN' })

    const rep = await importSession()
    findUniqueUserMock.mockResolvedValue({ ...ACME_USER, role: 'SALES_REP' })
    await expect(rep.requireRole('ADMIN')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    })
  })

  it('blocks a SALES_REP from a capability reserved for managers and admins', async () => {
    authMock.mockResolvedValue({ user: { id: 'user_acme_rep' } })
    findUniqueUserMock.mockResolvedValue({ ...ACME_USER, role: 'SALES_REP' })

    const { requireCapability } = await importSession()

    // This is the server-side check that makes hiding the nav item irrelevant
    // to security — a rep navigating directly to /campaigns is refused.
    await expect(requireCapability('campaigns:manage')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('allows an ADMIN through a capability check', async () => {
    authMock.mockResolvedValue({ user: { id: 'user_acme_admin' } })
    findUniqueUserMock.mockResolvedValue(ACME_USER)

    const { requireCapability } = await importSession()
    await expect(requireCapability('integrations:manage')).resolves.toMatchObject({
      id: 'user_acme_admin',
    })
  })
})
