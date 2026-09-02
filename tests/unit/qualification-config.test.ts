import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Per-organization qualification configuration.
 *
 * `@/lib/db/prisma` is an in-memory fake mimicking Prisma plus Postgres RLS —
 * a row is visible only when its `organizationId` matches whatever the last
 * `withTenant()` established — so a service that forgot tenant scoping shows
 * up here as cross-tenant leakage. Real RLS on the table is a migration
 * concern and is enforced independently.
 */

const ACME = 'org_acme'
const GLOBEX = 'org_globex'

type Version = {
  id: string
  organizationId: string
  version: number
  icp: string
  instructions: string | null
  threshold: number
  createdById: string | null
  createdAt: Date
}

const state = vi.hoisted(() => ({
  currentOrg: null as string | null,
  role: 'ADMIN' as 'ADMIN' | 'MANAGER' | 'SALES_REP',
  organizationId: 'org_acme',
  versions: [] as Version[],
  runs: [] as { id: string; organizationId: string; qualificationConfigVersionId: string | null }[],
  logs: [] as { message: string; context: unknown }[],
  seq: 0,
}))

const visible = <T extends { organizationId: string }>(rows: T[]) =>
  rows.filter((row) => row.organizationId === state.currentOrg)

const txClient = {
  $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
    state.currentOrg = (values[0] as string) ?? null
    return 1
  },
  qualificationConfigVersion: {
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const rows = visible(state.versions)
        .filter(
          (row) =>
            (where?.id === undefined || row.id === where.id) &&
            (where?.organizationId === undefined || row.organizationId === where.organizationId),
        )
        .sort((a, b) => b.version - a.version)
      return rows[0] ?? null
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const organizationId = data.organizationId as string
      const version = data.version as number
      if (
        state.versions.some((v) => v.organizationId === organizationId && v.version === version)
      ) {
        const { Prisma } = await import('@prisma/client')
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['organizationId', 'version'] },
        })
      }
      state.seq += 1
      const row: Version = {
        id: `cfg_${state.seq}`,
        organizationId,
        version,
        icp: data.icp as string,
        instructions: (data.instructions as string | null) ?? null,
        threshold: data.threshold as number,
        createdById: (data.createdById as string | null) ?? null,
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      }
      state.versions.push(row)
      return row
    },
  },
  workflowRun: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      visible(state.runs).find((r) => r.id === where.id) ?? null,
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      const run = visible(state.runs).find((r) => r.id === where.id)
      if (!run) return { count: 0 }
      Object.assign(run, data)
      return { count: 1 }
    },
  },
}

vi.mock('@/lib/db/prisma', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient) },
}))

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => ({
    id: 'user_1',
    organizationId: state.organizationId,
    role: state.role,
  }),
  requireCapability: async (capability: string) => {
    const { hasCapability } = await import('@/lib/auth/rbac')
    const { ForbiddenError } = await import('@/lib/errors')
    if (!hasCapability(state.role, capability as never)) throw new ForbiddenError()
    return { id: 'user_1', organizationId: state.organizationId, role: state.role }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: (message: string, context: unknown) => state.logs.push({ message, context }),
    warn: () => {},
    error: () => {},
  },
}))

const service = () => import('@/lib/services/qualification-config')
const runService = () => import('@/lib/services/workflow-runs')

const VALID = { icp: 'Mid-market B2B SaaS in Europe.', instructions: null, threshold: 80 }

beforeEach(() => {
  state.currentOrg = null
  state.role = 'ADMIN'
  state.organizationId = ACME
  state.versions = []
  state.runs = [
    { id: 'run_acme', organizationId: ACME, qualificationConfigVersionId: null },
    { id: 'run_globex', organizationId: GLOBEX, qualificationConfigVersionId: null },
  ]
  state.logs = []
  state.seq = 0
})

describe('defaults', () => {
  it('reports LeadFlow defaults before an admin has saved anything', async () => {
    const { getQualificationConfig } = await service()
    const config = await getQualificationConfig()

    expect(config).toMatchObject({ version: 0, threshold: 70, isCustomised: false })
    expect(config.icp.length).toBeGreaterThan(0)
  })
})

describe('RBAC', () => {
  it.each(['MANAGER', 'SALES_REP'] as const)('refuses %s from saving', async (role) => {
    state.role = role
    const { saveQualificationConfig } = await service()

    await expect(saveQualificationConfig(VALID)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.versions).toHaveLength(0)
  })

  it('lets anyone signed in READ the configuration', async () => {
    state.role = 'SALES_REP'
    const { getQualificationConfig } = await service()

    // A rep looking at a score of 38 deserves to know what judged it.
    await expect(getQualificationConfig()).resolves.toMatchObject({ threshold: 70 })
  })
})

describe('validation', () => {
  it.each([
    ['an empty ICP', { ...VALID, icp: '   ' }],
    ['an ICP over 5000 characters', { ...VALID, icp: 'x'.repeat(5001) }],
    ['instructions over 3000 characters', { ...VALID, instructions: 'x'.repeat(3001) }],
    ['a threshold above 100', { ...VALID, threshold: 101 }],
    ['a negative threshold', { ...VALID, threshold: -1 }],
    ['a fractional threshold', { ...VALID, threshold: 70.5 }],
  ])('rejects %s', async (_label, input) => {
    const { saveQualificationConfig } = await service()

    await expect(saveQualificationConfig(input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it.each([0, 100])('accepts the boundary threshold %d', async (threshold) => {
    const { saveQualificationConfig } = await service()

    await expect(saveQualificationConfig({ ...VALID, threshold })).resolves.toMatchObject({
      threshold,
    })
  })
})

describe('append-only versioning', () => {
  it('creates version 1 on the first save', async () => {
    const { saveQualificationConfig } = await service()

    expect(await saveQualificationConfig(VALID)).toMatchObject({ version: 1, threshold: 80 })
  })

  it('inserts a new version rather than updating the previous one', async () => {
    const { saveQualificationConfig } = await service()

    await saveQualificationConfig(VALID)
    const second = await saveQualificationConfig({ ...VALID, threshold: 60 })

    expect(second.version).toBe(2)
    // The old row survives untouched — that is what makes a past score explainable.
    expect(state.versions).toHaveLength(2)
    expect(state.versions[0]).toMatchObject({ version: 1, threshold: 80 })
  })

  it('does not create a duplicate version when nothing changed', async () => {
    const { saveQualificationConfig } = await service()

    await saveQualificationConfig(VALID)
    const again = await saveQualificationConfig(VALID)

    expect(again.version).toBe(1)
    expect(state.versions).toHaveLength(1)
  })

  it('never logs the ICP content, only the event', async () => {
    const { saveQualificationConfig } = await service()
    await saveQualificationConfig(VALID)

    expect(JSON.stringify(state.logs)).not.toContain('Mid-market B2B SaaS')
  })
})

describe('tenant isolation', () => {
  it('never returns another organization’s configuration', async () => {
    const { saveQualificationConfig, getQualificationConfig } = await service()
    await saveQualificationConfig(VALID)

    state.organizationId = GLOBEX
    expect(await getQualificationConfig()).toMatchObject({ version: 0, isCustomised: false })
  })

  it('starts version numbering independently per organization', async () => {
    const { saveQualificationConfig } = await service()
    await saveQualificationConfig(VALID)

    state.organizationId = GLOBEX
    expect(await saveQualificationConfig({ ...VALID, icp: 'Globex ICP.' })).toMatchObject({
      version: 1,
    })
  })
})

describe('pinning a config to a run', () => {
  it('falls back to the defaults and pins nothing when none was ever saved', async () => {
    const { pinQualificationConfigForRun } = await runService()

    const pinned = await pinQualificationConfigForRun(ACME, 'run_acme')
    expect(pinned).toMatchObject({ versionId: null, version: 0, threshold: 70 })
    // Nothing to point at — inventing a version would record a decision the
    // admin never made.
    expect(state.runs[0]?.qualificationConfigVersionId).toBeNull()
  })

  it('pins the latest version on first execution', async () => {
    const { saveQualificationConfig } = await service()
    await saveQualificationConfig(VALID)
    const { pinQualificationConfigForRun } = await runService()

    const pinned = await pinQualificationConfigForRun(ACME, 'run_acme')
    expect(pinned).toMatchObject({ version: 1, threshold: 80 })
    expect(state.runs[0]?.qualificationConfigVersionId).toBe(pinned.versionId)
  })

  it('keeps the pinned version even after the admin saves a new one', async () => {
    const { saveQualificationConfig } = await service()
    const { pinQualificationConfigForRun } = await runService()

    await saveQualificationConfig(VALID)
    const first = await pinQualificationConfigForRun(ACME, 'run_acme')

    await saveQualificationConfig({ ...VALID, threshold: 10, icp: 'Rewritten ICP.' })

    // Re-reading (an Inngest replay) must reach the SAME verdict, so the run
    // keeps the config it was judged against — never the current one.
    const again = await pinQualificationConfigForRun(ACME, 'run_acme')
    expect(again.versionId).toBe(first.versionId)
    expect(again.threshold).toBe(80)
    expect(again.icp).toBe(VALID.icp)
  })

  it('does not pin another tenant’s config onto a run', async () => {
    const { saveQualificationConfig } = await service()
    await saveQualificationConfig(VALID)

    const { pinQualificationConfigForRun } = await runService()
    // Globex has no config of its own and cannot see Acme's.
    expect(await pinQualificationConfigForRun(GLOBEX, 'run_globex')).toMatchObject({
      versionId: null,
      threshold: 70,
    })
  })
})
