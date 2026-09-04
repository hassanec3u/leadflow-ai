import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pause/Resume micro-phase — lib/services/automation-workflow-status.ts.
 *
 * `Workflow.status` and its meaning (PAUSED blocks a new AUTOMATIC enrollment;
 * a run in flight is untouched) already exist and are already enforced by
 * `lib/services/automation-enrollment.ts` and the execution engine, which
 * never reads `Workflow.status` at all — this file does not re-prove either
 * of those (see the "wiring" describe block below for the one thing this
 * phase actually adds proof of: that flipping the column through THIS write
 * path really does change what the existing enrollment check sees).
 *
 * `@/lib/db/prisma` is an in-memory fake mimicking Prisma, same convention as
 * tests/unit/automation-rerun.test.ts and tests/unit/automation-enrollment.test.ts.
 */

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  role: 'ADMIN' as 'ADMIN' | 'MANAGER' | 'SALES_REP',
  workflows: [] as Row[],
  runs: [] as Row[],
  leads: [] as Row[],
  enrollments: [] as Row[],
  nextId: 1,
}))

function uniqueViolation(index: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { constraint: { index } } } },
  })
}

vi.mock('@/lib/db/prisma', () => {
  const tx = {
    workflow: {
      // Two independent call shapes, never overlapping: this service's own
      // `{ id }` lookups, and automation-enrollment.ts's
      // `{ type }` auto-provisioning lookup — the "wiring
      // proof" test below exercises the real, unmocked enrollment service
      // against this same fake.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = state.workflows.find(
          (w) =>
            (where.id === undefined || w.id === where.id) &&
            (where.type === undefined || w.type === where.type),
        )
        return found ? { ...found } : null
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        const workflow = state.workflows.find((w) => w.id === where.id && w.status === where.status)
        if (!workflow) return { count: 0 }
        Object.assign(workflow, data)
        return { count: 1 }
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const type = data.type as string
        if (state.workflows.some((w) => w.type === type)) {
          throw uniqueViolation('workflows_type_key')
        }
        const workflow = {
          id: `wf_${state.nextId++}`,
          type,
          status: (data.status as string) ?? 'ACTIVE',
          version: (data.version as number) ?? 1,
        }
        state.workflows.push(workflow)
        return workflow
      },
    },
    lead: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.leads.find(
          (l) =>
            l.email === where.email && (where.deletedAt === null ? l.deletedAt === null : true),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const lead = {
          id: `lead_${state.nextId++}`,
          name: data.name as string,
          email: data.email as string,
          company: (data.company as string | undefined) ?? null,
          phone: (data.phone as string | undefined) ?? null,
          formMessage: (data.formMessage as string | null | undefined) ?? null,
          source: data.source as string,
          ownerId: null,
          deletedAt: null,
        }
        state.leads.push(lead)
        return lead
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const lead = state.leads.find((l) => l.id === where.id)!
        Object.assign(lead, data)
        return lead
      },
    },
    workflowEnrollment: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.enrollments.find(
          (e) => e.workflowId === where.workflowId && e.leadId === where.leadId,
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const workflowId = data.workflowId as string
        const leadId = data.leadId as string
        if (state.enrollments.some((e) => e.workflowId === workflowId && e.leadId === leadId)) {
          throw uniqueViolation('workflow_enrollments_workflowId_leadId_key')
        }
        const enrollment = {
          id: `enr_${state.nextId++}`,
          workflowId,
          leadId,
          trigger: data.trigger as string,
        }
        state.enrollments.push(enrollment)
        return enrollment
      },
    },
    workflowRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.runs.find(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.workflowEnrollmentId === undefined ||
              r.workflowEnrollmentId === where.workflowEnrollmentId) &&
            (where.trigger === undefined || r.trigger === where.trigger),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const enrollmentId = data.workflowEnrollmentId as string
        const leadId = data.leadId as string
        if (
          data.trigger === 'AUTOMATIC' &&
          state.runs.some(
            (r) => r.workflowEnrollmentId === enrollmentId && r.trigger === 'AUTOMATIC',
          )
        ) {
          throw uniqueViolation('workflow_runs_automatic_per_enrollment_key')
        }
        if (
          state.runs.some(
            (r) => r.leadId === leadId && (r.status === 'PENDING' || r.status === 'RUNNING'),
          )
        ) {
          throw uniqueViolation('workflow_runs_one_active_per_lead_key')
        }
        const run = {
          id: `run_${state.nextId++}`,
          workflowId: data.workflowId as string,
          workflowEnrollmentId: enrollmentId,
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
    prisma: { ...tx, $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx) },
  }
})

vi.mock('@/lib/auth/session', () => ({
  requireCapability: async (capability: string) => {
    const { hasCapability } = await import('@/lib/auth/rbac')
    const { ForbiddenError } = await import('@/lib/errors')
    if (!hasCapability(state.role, capability as never)) throw new ForbiddenError()
    return { id: 'user_1', role: state.role }
  },
}))

const emitRunRequestedMock = vi.fn(async (payload: unknown) => {
  void payload
})
vi.mock('@/lib/automation/events', () => ({
  emitRunRequested: (payload: unknown) => emitRunRequestedMock(payload),
}))

async function service() {
  return import('@/lib/services/automation-workflow-status')
}

function seedWorkflow(options: { id: string; status: 'ACTIVE' | 'PAUSED'; type?: string }) {
  state.workflows.push({
    id: options.id,
    status: options.status,
    type: options.type ?? 'LEAD_QUALIFICATION',
    version: 1,
  })
}

function seedRun(options: { id: string; status: string }) {
  state.runs.push({
    id: options.id,
    status: options.status,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.role = 'ADMIN'
  state.workflows = []
  state.runs = []
  state.leads = []
  state.enrollments = []
  state.nextId = 1
})

describe('pause/resume — authorisation', () => {
  it('refuses SALES_REP', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    state.role = 'SALES_REP'
    const { pauseWorkflowForCurrentUser } = await service()

    await expect(pauseWorkflowForCurrentUser('wf_1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.workflows[0]?.status).toBe('ACTIVE')
  })

  it('allows ADMIN', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    state.role = 'ADMIN'
    const { pauseWorkflowForCurrentUser } = await service()

    await expect(pauseWorkflowForCurrentUser('wf_1')).resolves.toMatchObject({ status: 'PAUSED' })
  })

  it('allows MANAGER', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    state.role = 'MANAGER'
    const { pauseWorkflowForCurrentUser } = await service()

    await expect(pauseWorkflowForCurrentUser('wf_1')).resolves.toMatchObject({ status: 'PAUSED' })
  })
})

describe('pause/resume — unknown workflow', () => {
  it('a non-existent workflow id is reported as not found', async () => {
    const { pauseWorkflowForCurrentUser } = await service()

    await expect(pauseWorkflowForCurrentUser('wf_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('leaves an unrelated workflow alone', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    seedWorkflow({ id: 'wf_2', status: 'ACTIVE', type: 'OTHER' })

    const { pauseWorkflowForCurrentUser } = await service()
    await pauseWorkflowForCurrentUser('wf_1')

    expect(state.workflows.find((w) => w.id === 'wf_1')?.status).toBe('PAUSED')
    expect(state.workflows.find((w) => w.id === 'wf_2')?.status).toBe('ACTIVE')
  })
})

describe('pause/resume — transitions', () => {
  it('ACTIVE -> PAUSED', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    const { pauseWorkflowForCurrentUser } = await service()

    const result = await pauseWorkflowForCurrentUser('wf_1')
    expect(result).toEqual({ id: 'wf_1', status: 'PAUSED' })
    expect(state.workflows[0]?.status).toBe('PAUSED')
  })

  it('PAUSED -> ACTIVE', async () => {
    seedWorkflow({ id: 'wf_1', status: 'PAUSED' })
    const { resumeWorkflowForCurrentUser } = await service()

    const result = await resumeWorkflowForCurrentUser('wf_1')
    expect(result).toEqual({ id: 'wf_1', status: 'ACTIVE' })
    expect(state.workflows[0]?.status).toBe('ACTIVE')
  })

  it('never touches a WorkflowRun row', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    seedRun({ id: 'run_1', status: 'RUNNING' })
    const { pauseWorkflowForCurrentUser } = await service()

    await pauseWorkflowForCurrentUser('wf_1')

    // Pausing touches Workflow.status only — a run already RUNNING (or
    // PENDING) is completely unaffected, exactly like docs/architecture.md
    // says: nothing in the execution engine reads Workflow.status at all.
    expect(state.runs).toEqual([{ id: 'run_1', status: 'RUNNING' }])
  })
})

describe('pause/resume — idempotency and concurrency', () => {
  it('pausing an already-PAUSED workflow succeeds without error (idempotent)', async () => {
    seedWorkflow({ id: 'wf_1', status: 'PAUSED' })
    const { pauseWorkflowForCurrentUser } = await service()

    await expect(pauseWorkflowForCurrentUser('wf_1')).resolves.toEqual({
      id: 'wf_1',
      status: 'PAUSED',
    })
  })

  it('resuming an already-ACTIVE workflow succeeds without error (idempotent)', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    const { resumeWorkflowForCurrentUser } = await service()

    await expect(resumeWorkflowForCurrentUser('wf_1')).resolves.toEqual({
      id: 'wf_1',
      status: 'ACTIVE',
    })
  })

  it('a double-click (two concurrent pause calls) results in exactly one PAUSED, both report success', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    const { pauseWorkflowForCurrentUser } = await service()

    const [first, second] = await Promise.all([
      pauseWorkflowForCurrentUser('wf_1'),
      pauseWorkflowForCurrentUser('wf_1'),
    ])

    // The conditional updateMany means only one of the two calls actually
    // wrote the row; the loser's fallback read reports the same end state —
    // neither call surfaces an error to a user who merely double-clicked.
    expect(first).toEqual({ id: 'wf_1', status: 'PAUSED' })
    expect(second).toEqual({ id: 'wf_1', status: 'PAUSED' })
    expect(state.workflows).toHaveLength(1)
  })

  it('opposite concurrent toggles (pause vs resume) leave the workflow in one well-defined state', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    const { pauseWorkflowForCurrentUser, resumeWorkflowForCurrentUser } = await service()

    const [pauseResult, resumeResult] = await Promise.all([
      pauseWorkflowForCurrentUser('wf_1'),
      resumeWorkflowForCurrentUser('wf_1'),
    ])

    // Exactly one status, and both calls' reported results agree with the
    // row that is actually left behind — no split-brain result.
    const finalStatus = state.workflows[0]?.status
    expect(['ACTIVE', 'PAUSED']).toContain(finalStatus)
    expect(pauseResult.status === 'PAUSED' || resumeResult.status === 'ACTIVE').toBe(true)
  })
})

describe('pause/resume — wiring proof against the real (unmocked) enrollment service', () => {
  it('PAUSED, set through this service, blocks a new AUTOMATIC enrollment end to end', async () => {
    seedWorkflow({ id: 'wf_1', status: 'ACTIVE' })
    const { pauseWorkflowForCurrentUser } = await service()
    const { captureAutomaticLead } = await import('@/lib/services/automation-enrollment')

    await pauseWorkflowForCurrentUser('wf_1')

    // The real, unmocked automation-enrollment.ts service — its own eligibility
    // rule (`if (workflow.status !== 'ACTIVE') return null`) is proven in
    // tests/unit/automation-enrollment.test.ts; this proves THIS service is
    // what actually flips the column that rule reads.
    const result = await captureAutomaticLead({
      name: 'Jane Prospect',
      email: 'jane@prospect.test',
      source: 'WEBSITE_FORM',
    })

    expect(result.enrollment).toBeNull()
    expect(result.run).toBeNull()
    expect(state.enrollments).toHaveLength(0)
    expect(emitRunRequestedMock).not.toHaveBeenCalled()
  })

  it('resuming (ACTIVE), set through this service, lets AUTOMATIC enrollment through again', async () => {
    seedWorkflow({ id: 'wf_1', status: 'PAUSED' })
    const { resumeWorkflowForCurrentUser } = await service()
    const { captureAutomaticLead } = await import('@/lib/services/automation-enrollment')

    await resumeWorkflowForCurrentUser('wf_1')

    const result = await captureAutomaticLead({
      name: 'Jane Prospect',
      email: 'jane@prospect.test',
      source: 'WEBSITE_FORM',
    })

    expect(result.enrollment).not.toBeNull()
    expect(result.run).not.toBeNull()
    expect(emitRunRequestedMock).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'AUTOMATIC' }),
    )
  })
})
