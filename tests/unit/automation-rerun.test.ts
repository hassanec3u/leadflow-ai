import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Manual Rerun micro-phase — the session-aware wrapper
 * (lib/services/automation-rerun.ts) around the already-tested
 * `requestManualRerun` (lib/services/workflow-runs.ts, exercised in
 * tests/unit/automation-engine.test.ts "24."/"25.").
 *
 * This file does NOT re-test what `requestManualRerun` itself already
 * guarantees (same enrollment, PENDING/MANUAL_RERUN, the active-run
 * conflict, the post-commit emit) — it tests the one thing this module adds:
 * resolving the caller from the session and enforcing `automation:manage`
 * before anything else runs. `@/lib/db/prisma` is an in-memory fake mimicking
 * Prisma plus Postgres RLS, same convention as
 * tests/unit/automation-enrollment.test.ts and tests/unit/automation-read.test.ts.
 */

const ACME = 'org_acme'
const GLOBEX = 'org_globex'

type Row = Record<string, unknown> & { organizationId?: string }

const state = vi.hoisted(() => ({
  currentOrg: null as string | null,
  role: 'ADMIN' as 'ADMIN' | 'MANAGER' | 'SALES_REP',
  organizationId: 'org_acme',
  workflows: [] as Row[],
  runs: [] as Row[],
  nextId: 0,
}))

const visible = (row: Row) => row.organizationId === state.currentOrg

vi.mock('@/lib/db/prisma', async () => {
  const { Prisma } = await import('@prisma/client')

  function uniqueViolation(index: string) {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { constraint: { index } } } },
    })
  }

  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      state.currentOrg = (values[0] as string) ?? null
      return 1
    },
    workflow: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.workflows.find((w) => visible(w) && w.id === where.id) ?? null,
    },
    workflowRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = state.runs.find((r) => visible(r) && r.id === where.id)
        return found ? { ...found } : null
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const leadId = data.leadId as string
        if (
          state.runs.some(
            (r) => r.leadId === leadId && (r.status === 'PENDING' || r.status === 'RUNNING'),
          )
        ) {
          throw uniqueViolation('workflow_runs_one_active_per_lead_key')
        }
        const run = {
          id: `run_${state.nextId++}`,
          organizationId: data.organizationId as string,
          workflowId: data.workflowId as string,
          workflowEnrollmentId: data.workflowEnrollmentId as string,
          leadId,
          version: data.version as number,
          trigger: data.trigger as string,
          status: (data.status as string) ?? 'PENDING',
        }
        state.runs.push(run)
        return run
      },
    },
  }

  return {
    prisma: { $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx) },
  }
})

vi.mock('@/lib/auth/session', () => ({
  requireCapability: async (capability: string) => {
    const { hasCapability } = await import('@/lib/auth/rbac')
    const { ForbiddenError } = await import('@/lib/errors')
    if (!hasCapability(state.role, capability as never)) throw new ForbiddenError()
    return { id: 'user_1', organizationId: state.organizationId, role: state.role }
  },
}))

const emitRunRequestedMock = vi.fn(async (payload: unknown) => {
  void payload
})
vi.mock('@/lib/automation/events', () => ({
  emitRunRequested: (payload: unknown) => emitRunRequestedMock(payload),
}))

async function service() {
  return import('@/lib/services/automation-rerun')
}

function seedRun(options: {
  id: string
  organizationId: string
  status: string
  leadId?: string
  enrollmentId?: string
}) {
  state.runs.push({
    id: options.id,
    organizationId: options.organizationId,
    workflowId: `wf_${options.organizationId}`,
    workflowEnrollmentId: options.enrollmentId ?? `enr_${options.id}`,
    leadId: options.leadId ?? `lead_${options.id}`,
    version: 1,
    trigger: 'AUTOMATIC',
    status: options.status,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.currentOrg = null
  state.role = 'ADMIN'
  state.organizationId = ACME
  state.nextId = 0
  state.workflows = [
    { id: 'wf_org_acme', organizationId: ACME, version: 1 },
    { id: 'wf_org_globex', organizationId: GLOBEX, version: 1 },
  ]
  state.runs = []
})

describe('requestManualRerunForCurrentUser — authorisation', () => {
  it('refuses SALES_REP', async () => {
    seedRun({ id: 'run_1', organizationId: ACME, status: 'FAILED' })
    state.role = 'SALES_REP'
    const { requestManualRerunForCurrentUser } = await service()

    await expect(requestManualRerunForCurrentUser('run_1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(state.runs).toHaveLength(1) // nothing created
  })

  it('allows ADMIN', async () => {
    seedRun({ id: 'run_1', organizationId: ACME, status: 'FAILED' })
    state.role = 'ADMIN'
    const { requestManualRerunForCurrentUser } = await service()

    const rerun = await requestManualRerunForCurrentUser('run_1')
    expect(rerun.trigger).toBe('MANUAL_RERUN')
  })

  it('allows MANAGER', async () => {
    seedRun({ id: 'run_1', organizationId: ACME, status: 'FAILED' })
    state.role = 'MANAGER'
    const { requestManualRerunForCurrentUser } = await service()

    const rerun = await requestManualRerunForCurrentUser('run_1')
    expect(rerun.trigger).toBe('MANUAL_RERUN')
  })
})

describe('requestManualRerunForCurrentUser — tenancy', () => {
  it('takes the organization from the session, never from the caller', async () => {
    seedRun({ id: 'run_acme', organizationId: ACME, status: 'FAILED' })
    seedRun({ id: 'run_globex', organizationId: GLOBEX, status: 'FAILED' })
    state.organizationId = ACME

    const { requestManualRerunForCurrentUser } = await service()
    const rerun = await requestManualRerunForCurrentUser('run_acme')

    expect(rerun.organizationId).toBe(ACME)
  })

  it('cannot rerun a run belonging to another organization', async () => {
    seedRun({ id: 'run_globex', organizationId: GLOBEX, status: 'FAILED' })
    state.organizationId = ACME // signed in as an ACME user

    const { requestManualRerunForCurrentUser } = await service()

    // Invisible under RLS from ACME's tenant context — same as an id that
    // never existed, no cross-tenant oracle.
    await expect(requestManualRerunForCurrentUser('run_globex')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(state.runs).toHaveLength(1)
  })
})

describe('requestManualRerunForCurrentUser — new run creation', () => {
  it('creates a new MANUAL_RERUN run on the same enrollment', async () => {
    seedRun({
      id: 'run_1',
      organizationId: ACME,
      status: 'FAILED',
      leadId: 'lead_1',
      enrollmentId: 'enr_1',
    })

    const { requestManualRerunForCurrentUser } = await service()
    const rerun = await requestManualRerunForCurrentUser('run_1')

    expect(rerun.id).not.toBe('run_1')
    expect(rerun.workflowEnrollmentId).toBe('enr_1')
    expect(rerun.trigger).toBe('MANUAL_RERUN')
    expect(rerun.status).toBe('PENDING')
    expect(emitRunRequestedMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: rerun.id, trigger: 'MANUAL_RERUN' }),
    )
  })
})

describe('requestManualRerunForCurrentUser — double-click / concurrency', () => {
  it('a second concurrent rerun for the same lead is refused as a conflict, not a second run', async () => {
    seedRun({
      id: 'run_1',
      organizationId: ACME,
      status: 'FAILED',
      leadId: 'lead_1',
      enrollmentId: 'enr_1',
    })

    const { requestManualRerunForCurrentUser } = await service()

    const [first, second] = await Promise.allSettled([
      requestManualRerunForCurrentUser('run_1'),
      requestManualRerunForCurrentUser('run_1'),
    ])

    const outcomes = [first.status, second.status].sort()
    expect(outcomes).toEqual(['fulfilled', 'rejected'])

    const rejected = first.status === 'rejected' ? first : (second as PromiseRejectedResult)
    expect(rejected.reason).toMatchObject({ code: 'CONFLICT' })

    // Exactly one new run — the original plus one rerun, never two.
    expect(state.runs).toHaveLength(2)
    expect(emitRunRequestedMock).toHaveBeenCalledTimes(1)
  })
})
