import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2E-1 — the admin issue/rotate service.
 *
 * Authorisation, secret generation and the "plaintext exactly once" rule are
 * proven here against an in-memory Prisma fake. The parts that only real
 * PostgreSQL can prove — tenant isolation, the SECURITY DEFINER exception,
 * fail-closed RLS, role grants — live in
 * tests/integration/form-capture-tenant-auth.test.ts.
 */

const state = vi.hoisted(() => {
  type FakeOrg = {
    id: string
    name: string
    formCaptureSecretHash: string | null
    deletedAt: Date | null
  }
  return {
    orgs: [] as FakeOrg[],
    /** Tenant context set by the last withTenant(), mirroring app.current_org_id. */
    currentOrg: null as string | null,
    user: {
      id: 'user_admin',
      email: 'admin@acme.test',
      name: 'Admin',
      role: 'ADMIN' as 'ADMIN' | 'MANAGER' | 'SALES_REP',
      organizationId: 'org_acme',
    },
    logs: [] as { level: string; message: string; context: unknown }[],
  }
})

/** Only rows of the current tenant are visible — the RLS rule, in miniature. */
const visibleOrgs = () => state.orgs.filter((org) => org.id === state.currentOrg)

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
  },
}))

const txClient = {
  $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    state.currentOrg = (values[0] as string) ?? null
    return 1
  },
  organization: {
    findFirst: async ({ where }: { where: { id?: string; deletedAt?: null } }) => {
      return (
        visibleOrgs().find(
          (org) =>
            (where.id === undefined || org.id === where.id) &&
            (where.deletedAt === undefined || org.deletedAt === null),
        ) ?? null
      )
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string }
      data: { formCaptureSecretHash: string }
    }) => {
      const targets = visibleOrgs().filter((org) => org.id === where.id)
      for (const org of targets) org.formCaptureSecretHash = data.formCaptureSecretHash
      return { count: targets.length }
    },
  },
}

vi.mock('@/lib/auth/session', () => ({
  requireCapability: async (capability: string) => {
    const { hasCapability } = await import('@/lib/auth/rbac')
    const { ForbiddenError } = await import('@/lib/errors')
    if (!hasCapability(state.user.role, capability as never)) {
      throw new ForbiddenError()
    }
    return state.user
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: (message: string, context: unknown) =>
      state.logs.push({ level: 'info', message, context }),
    warn: (message: string, context: unknown) =>
      state.logs.push({ level: 'warn', message, context }),
    error: (message: string, context: unknown) =>
      state.logs.push({ level: 'error', message, context }),
  },
}))

async function importService() {
  return import('@/lib/services/organization-form-capture')
}

beforeEach(() => {
  state.orgs = [
    { id: 'org_acme', name: 'Acme Inc', formCaptureSecretHash: null, deletedAt: null },
    { id: 'org_globex', name: 'Globex Corp', formCaptureSecretHash: null, deletedAt: null },
  ]
  state.currentOrg = null
  state.user = {
    id: 'user_admin',
    email: 'admin@acme.test',
    name: 'Admin',
    role: 'ADMIN',
    organizationId: 'org_acme',
  }
  state.logs = []
})

describe('issueFormCaptureSecret', () => {
  it('returns the plaintext secret once and stores only its hash', async () => {
    const { issueFormCaptureSecret } = await importService()
    const { hashFormCaptureSecret } = await import('@/lib/auth/form-capture-lookup')

    const { secret } = await issueFormCaptureSecret()

    expect(secret).toMatch(/^lfwf_/)
    const stored = state.orgs.find((org) => org.id === 'org_acme')?.formCaptureSecretHash
    expect(stored).toBe(hashFormCaptureSecret(secret))
    expect(stored).not.toBe(secret)
    expect(stored).toHaveLength(64)
  })

  it('generates a high-entropy, non-repeating secret', async () => {
    const { issueFormCaptureSecret, rotateFormCaptureSecret } = await importService()

    const first = await issueFormCaptureSecret()
    const second = await rotateFormCaptureSecret()

    expect(first.secret).not.toBe(second.secret)
    // 32 bytes base64url = 43 chars, plus the 5-char prefix.
    expect(first.secret).toHaveLength(48)
  })

  it('writes only to the caller’s own organization', async () => {
    const { issueFormCaptureSecret } = await importService()
    await issueFormCaptureSecret()

    expect(state.orgs.find((org) => org.id === 'org_globex')?.formCaptureSecretHash).toBeNull()
  })

  it('refuses to silently replace an existing secret', async () => {
    const { issueFormCaptureSecret } = await importService()
    await issueFormCaptureSecret()

    // A second issue would take a live Website Form offline.
    await expect(issueFormCaptureSecret()).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('rotateFormCaptureSecret', () => {
  it('invalidates the previous secret immediately', async () => {
    const { issueFormCaptureSecret, rotateFormCaptureSecret } = await importService()
    const { hashFormCaptureSecret } = await import('@/lib/auth/form-capture-lookup')

    const original = await issueFormCaptureSecret()
    const rotated = await rotateFormCaptureSecret()

    const stored = state.orgs.find((org) => org.id === 'org_acme')?.formCaptureSecretHash
    expect(stored).toBe(hashFormCaptureSecret(rotated.secret))
    expect(stored).not.toBe(hashFormCaptureSecret(original.secret))
  })

  it('works even when no secret exists yet', async () => {
    const { rotateFormCaptureSecret } = await importService()

    await expect(rotateFormCaptureSecret()).resolves.toMatchObject({
      secret: expect.stringMatching(/^lfwf_/),
    })
  })
})

describe('authorisation', () => {
  it.each(['MANAGER', 'SALES_REP'] as const)('refuses %s for issue', async (role) => {
    state.user.role = role
    const { issueFormCaptureSecret } = await importService()

    await expect(issueFormCaptureSecret()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it.each(['MANAGER', 'SALES_REP'] as const)('refuses %s for rotate', async (role) => {
    state.user.role = role
    const { rotateFormCaptureSecret } = await importService()

    await expect(rotateFormCaptureSecret()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('writes nothing when authorisation fails', async () => {
    state.user.role = 'MANAGER'
    const { issueFormCaptureSecret } = await importService()

    await issueFormCaptureSecret().catch(() => {})

    expect(state.orgs.find((org) => org.id === 'org_acme')?.formCaptureSecretHash).toBeNull()
  })

  it('uses the existing integrations:manage capability — ADMIN only', async () => {
    const { hasCapability } = await import('@/lib/auth/rbac')

    expect(hasCapability('ADMIN', 'integrations:manage')).toBe(true)
    expect(hasCapability('MANAGER', 'integrations:manage')).toBe(false)
    expect(hasCapability('SALES_REP', 'integrations:manage')).toBe(false)
  })
})

describe('no leakage', () => {
  it('never logs the secret or its hash', async () => {
    const { issueFormCaptureSecret } = await importService()
    const { secret } = await issueFormCaptureSecret()
    const { hashFormCaptureSecret } = await import('@/lib/auth/form-capture-lookup')

    const serialized = JSON.stringify(state.logs)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(hashFormCaptureSecret(secret))
    // The event itself IS logged — just without the credential.
    expect(state.logs.some((entry) => entry.message.includes('capture secret'))).toBe(true)
  })

  it('never puts the secret in an error message', async () => {
    const { issueFormCaptureSecret } = await importService()
    const first = await issueFormCaptureSecret()

    const error = (await issueFormCaptureSecret().catch((e: unknown) => e)) as Error

    expect(error.message).not.toContain(first.secret)
    expect(error.message).toBe('A form capture secret already exists. Rotate it instead.')
  })

  it('never returns the hash to the caller', async () => {
    const { issueFormCaptureSecret } = await importService()
    const result = await issueFormCaptureSecret()

    expect(Object.keys(result)).toEqual(['secret'])
  })

  it('hasFormCaptureSecret reports presence as a boolean, never the value', async () => {
    const { issueFormCaptureSecret, hasFormCaptureSecret } = await importService()

    expect(await hasFormCaptureSecret()).toBe(false)
    await issueFormCaptureSecret()
    expect(await hasFormCaptureSecret()).toBe(true)
  })
})

describe('hashFormCaptureSecret', () => {
  it('is deterministic and hex-encoded SHA-256', async () => {
    const { hashFormCaptureSecret } = await import('@/lib/auth/form-capture-lookup')

    const hash = hashFormCaptureSecret('lfwf_fixture')
    expect(hash).toBe(hashFormCaptureSecret('lfwf_fixture'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashFormCaptureSecret('lfwf_fixture_other')).not.toBe(hash)
  })
})
