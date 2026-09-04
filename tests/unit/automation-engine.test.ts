import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AiQualificationProvider,
  EmailProvider,
  EnrichmentProvider,
  NotificationProvider,
  ProviderRegistry,
} from '@/lib/automation/providers'

/**
 * Phase 2C — the fixed-pipeline execution engine.
 *
 * Same approach as tests/unit/automation-enrollment.test.ts: `@/lib/db/prisma`
 * is an in-memory fake that mimics enough of Prisma to prove the engine's own
 * logic. Providers are hand-written fakes — no vendor implementations exist in
 * this phase and none are needed to prove the failure semantics.
 *
 * Real Postgres constraints for these tables are proven separately in
 * tests/integration/automation-execution.test.ts.
 */

const state = vi.hoisted(() => {
  type Lead = {
    id: string
    name: string
    email: string
    company: string | null
    phone: string | null
    source: string
    aiScore: number | null
    qualificationOutcome: string | null
    qualificationSource: string | null
    qualificationUpdatedAt: Date | null
    deletedAt: Date | null
  }
  type Workflow = {
    id: string
    type: string
    status: string
    version: number
  }
  type Enrollment = { id: string; workflowId: string; leadId: string }
  /** Append-only qualification config versions. */
  type ConfigVersion = {
    id: string
    version: number
    icp: string
    instructions: string | null
    threshold: number
  }
  type Run = {
    id: string
    workflowId: string
    workflowEnrollmentId: string
    leadId: string
    version: number
    trigger: string
    status: string
    qualificationConfigVersionId?: string | null
    startedAt: Date | null
    completedAt: Date | null
    createdAt: Date
    updatedAt: Date
    recoveryAttempts: number
    lastRecoveryAttemptAt: Date | null
  }
  type StepRun = {
    id: string
    workflowRunId: string
    step: string
    status: string
    attempts: number
    output: unknown
    errorCode: string | null
    errorMessage: string | null
    startedAt: Date | null
    completedAt: Date | null
  }

  const leads: Lead[] = []
  const workflows: Workflow[] = []
  const enrollments: Enrollment[] = []
  const runs: Run[] = []
  const stepRuns: StepRun[] = []
  const configVersions: ConfigVersion[] = []
  let counter = 0
  /** Set to a step name to make the NEXT completeStep for it throw once. */
  let failPersistForStep: string | null = null

  return {
    leads,
    workflows,
    enrollments,
    runs,
    stepRuns,
    configVersions,
    reset() {
      leads.length = 0
      workflows.length = 0
      enrollments.length = 0
      runs.length = 0
      stepRuns.length = 0
      configVersions.length = 0
      counter = 0
      failPersistForStep = null
    },
    id(prefix: string) {
      counter += 1
      return `${prefix}_${counter}`
    },
    runById(runId: string) {
      return runs.find((r) => r.id === runId) ?? null
    },
    failPersistOnce(step: string) {
      failPersistForStep = step
    },
    consumePersistFailure(step: string) {
      if (failPersistForStep === step) {
        failPersistForStep = null
        return true
      }
      return false
    },
  }
})

vi.mock('@/lib/automation/events', () => ({
  AUTOMATION_RUN_REQUESTED: 'automation/run.requested',
  emitRunRequested: (payload: unknown) => emitRunRequestedMock(payload),
  emitRunRecoveryRequested: (payload: unknown, generation: number) =>
    emitRunRecoveryRequestedMock(payload, generation),
}))

const emitRunRequestedMock = vi.fn(async (payload: unknown) => {
  void payload
})

const emitRunRecoveryRequestedMock = vi.fn(async (payload: unknown, generation: number) => {
  void payload
  void generation
})

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
    lead: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.leads.find((l) => l.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        const lead = state.leads.find((l) => l.id === where.id)
        if (!lead) return { count: 0 }
        // The conditional qualification write: OR: [{source: null}, {source: 'AI'}]
        if (Array.isArray(where.OR)) {
          const allowed = (where.OR as Array<{ qualificationSource: string | null }>).some(
            (clause) => clause.qualificationSource === lead.qualificationSource,
          )
          if (!allowed) return { count: 0 }
        }
        Object.assign(lead, data)
        return { count: 1 }
      },
    },
    workflow: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.workflows.find(
          (w) =>
            (where.id === undefined || w.id === where.id) &&
            (where.type === undefined || w.type === where.type),
        ) ?? null,
    },
    qualificationConfigVersion: {
      findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const rows = state.configVersions
          .filter((c) => where?.id === undefined || c.id === where.id)
          .sort((a, b) => b.version - a.version)
        return rows[0] ?? null
      },
    },
    workflowRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = state.runs.find(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.workflowEnrollmentId === undefined ||
              r.workflowEnrollmentId === where.workflowEnrollmentId) &&
            (where.trigger === undefined || r.trigger === where.trigger),
        )
        // A snapshot copy, like real Prisma returns — never a live reference
        // into `state.runs`, or a concurrent write elsewhere could be observed
        // through a variable that is supposed to hold a point-in-time read.
        return found ? { ...found } : null
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        const run = state.runs.find(
          (r) =>
            r.id === where.id &&
            (where.status === undefined || r.status === where.status) &&
            (where.recoveryAttempts === undefined || r.recoveryAttempts === where.recoveryAttempts),
        )
        if (!run) return { count: 0 }
        Object.assign(run, data)
        return { count: 1 }
      },
      // The PENDING-orphan sweep is an ordinary query now (it used to go
      // through a SECURITY DEFINER function to escape RLS), so the fake has to
      // answer it like Prisma would.
      findMany: async ({
        where,
        take,
      }: {
        where?: Record<string, unknown>
        take?: number
      } = {}) => {
        const createdAtFilter = where?.createdAt as { lt?: Date } | undefined
        const rows = state.runs.filter(
          (r) =>
            (where?.status === undefined || r.status === where.status) &&
            (createdAtFilter?.lt === undefined || r.createdAt < createdAtFilter.lt),
        )
        return rows.slice(0, take).map((r) => ({ ...r }))
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const trigger = data.trigger as string
        const enrollmentId = data.workflowEnrollmentId as string
        const leadId = data.leadId as string
        if (
          trigger === 'AUTOMATIC' &&
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
          id: state.id('run'),
          workflowId: data.workflowId as string,
          workflowEnrollmentId: enrollmentId,
          leadId,
          version: data.version as number,
          trigger,
          status: (data.status as string) ?? 'PENDING',
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          recoveryAttempts: 0,
          lastRecoveryAttemptAt: null,
        }
        state.runs.push(run)
        return run
      },
    },
    workflowStepRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.stepRuns.find(
          (s) => s.workflowRunId === where.workflowRunId && s.step === where.step,
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const workflowRunId = data.workflowRunId as string
        const step = data.step as string
        if (state.stepRuns.some((s) => s.workflowRunId === workflowRunId && s.step === step)) {
          throw uniqueViolation('workflow_step_runs_workflowRunId_step_key')
        }
        const stepRun = {
          id: state.id('step'),
          workflowRunId,
          step,
          status: data.status as string,
          attempts: (data.attempts as number) ?? 0,
          output: null,
          errorCode: null,
          errorMessage: null,
          startedAt: (data.startedAt as Date) ?? null,
          completedAt: null,
        }
        state.stepRuns.push(stepRun)
        return stepRun
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const stepRun = state.stepRuns.find((s) => s.id === where.id)!
        const { attempts, ...rest } = data as { attempts?: { increment: number } }
        if (attempts?.increment) stepRun.attempts += attempts.increment
        Object.assign(stepRun, rest)
        return stepRun
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Record<string, unknown>
      }) => {
        const stepRun = state.stepRuns.find((s) => s.id === where.id)
        if (!stepRun) return { count: 0 }
        // Simulates a crash between a successful provider call and the write
        // that records it (test 19).
        if (state.consumePersistFailure(stepRun.step)) {
          throw new Error('simulated database failure while persisting step result')
        }
        Object.assign(stepRun, data)
        return { count: 1 }
      },
    },
  }

  return {
    // The same delegates are reachable directly on `prisma` and inside a
    // `$transaction` callback, because the services now use both: single
    // statements go straight to the client, multi-statement sequences take a
    // transaction.
    prisma: {
      ...tx,
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
      $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    },
  }
})

const queryRawMock = vi.fn(async (...args: unknown[]) => {
  void args
  return [] as unknown[]
})

async function importEngine() {
  vi.resetModules()
  return import('@/lib/automation/engine')
}

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

function makeEnrichment(): EnrichmentProvider & { enrich: ReturnType<typeof vi.fn> } {
  const enrich = vi.fn(async () => ({ provider: 'fake', data: { employees: 120 } }))
  return { name: 'fake-enrichment', enrich } as never
}

function makeAi(score = 85): AiQualificationProvider & { qualify: ReturnType<typeof vi.fn> } {
  const qualify = vi.fn(async () => ({
    score,
    summary: 'Looks promising',
    keywords: ['crm'],
    recommendedAction: 'Book a call',
  }))
  return { name: 'fake-ai', qualify } as never
}

function makeEmail(): EmailProvider & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({ providerMessageId: 'msg_1' }))
  return { name: 'fake-email', send } as never
}

function makeNotification(): NotificationProvider & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => ({ ref: 'slack_1' }))
  return { name: 'fake-notification', notify } as never
}

function makeRegistry(overrides: Partial<ProviderRegistry> = {}): ProviderRegistry {
  return {
    enrichment: makeEnrichment(),
    ai: makeAi(),
    email: makeEmail(),
    notification: makeNotification(),
    aiBudget: null,
    ...overrides,
  }
}

/** Seeds a lead, workflow, enrollment and a PENDING run. */
function seedRun(options: { leadOverrides?: Record<string, unknown> } = {}) {
  const lead = {
    id: state.id('lead'),
    name: 'Jane Prospect',
    email: 'jane@prospect.test',
    company: 'Acme Corp',
    phone: null,
    source: 'WEBSITE_FORM',
    aiScore: null,
    qualificationOutcome: null,
    qualificationSource: null,
    qualificationUpdatedAt: null,
    deletedAt: null,
    ...options.leadOverrides,
  }
  const workflow = {
    id: state.id('wf'),
    type: 'LEAD_QUALIFICATION',
    status: 'ACTIVE',
    version: 1,
  }
  const enrollment = {
    id: state.id('enr'),
    workflowId: workflow.id,
    leadId: lead.id,
  }
  const run = {
    id: state.id('run'),
    workflowId: workflow.id,
    workflowEnrollmentId: enrollment.id,
    leadId: lead.id,
    version: 1,
    trigger: 'AUTOMATIC',
    status: 'PENDING',
    startedAt: null,
    completedAt: null,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
    updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    recoveryAttempts: 0,
    lastRecoveryAttemptAt: null,
  }

  state.leads.push(lead as never)
  state.workflows.push(workflow as never)
  state.enrollments.push(enrollment as never)
  state.runs.push(run as never)

  return { lead, workflow, enrollment, run }
}

const noSleep = async () => undefined

function stepStatus(runId: string, step: string) {
  return state.stepRuns.find((s) => s.workflowRunId === runId && s.step === step)
}

describe('Automation execution engine', () => {
  beforeEach(() => {
    state.reset()
    emitRunRequestedMock.mockClear()
    emitRunRecoveryRequestedMock.mockClear()
    queryRawMock.mockReset()
    queryRawMock.mockResolvedValue([])
  })

  it('1. happy path: every step succeeds and the run succeeds', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()
    const providers = makeRegistry()

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('SUCCEEDED')
    for (const step of ['ENRICH', 'AI_QUALIFY', 'SCORE_AND_TAG', 'SEND_EMAIL', 'NOTIFY_TEAM']) {
      expect(stepStatus(run.id, step)?.status).toBe('SUCCEEDED')
    }
    // ADD_TO_CRM is retired — a fresh run creates no row for it at all.
    expect(stepStatus(run.id, 'ADD_TO_CRM')).toBeUndefined()
    expect(state.leads.find((l) => l.id === lead.id)?.aiScore).toBe(85)
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('QUALIFIED')
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationSource).toBe('AI')
    expect((providers.email as ReturnType<typeof makeEmail>).send).toHaveBeenCalledTimes(1)
  })

  it('2. score 42: UNQUALIFIED, email SKIPPED(below_threshold), notify still runs, run SUCCEEDED', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()
    const providers = makeRegistry({ ai: makeAi(42) })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('SUCCEEDED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('SKIPPED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.errorCode).toBe('below_threshold')
    expect(stepStatus(run.id, 'NOTIFY_TEAM')?.status).toBe('SUCCEEDED')
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('UNQUALIFIED')
    expect((providers.email as ReturnType<typeof makeEmail>).send).not.toHaveBeenCalled()
  })

  describe('configured threshold', () => {
    /** Save a config version directly — the engine reads, never writes it. */
    function seedConfig(threshold: number) {
      state.configVersions.push({
        id: `cfg_${state.configVersions.length + 1}`,
        version: state.configVersions.length + 1,
        icp: 'Configured ICP.',
        instructions: null,
        threshold,
      })
    }

    it('uses the configured threshold instead of the built-in 70', async () => {
      seedConfig(90)
      const { executeWorkflowRun } = await importEngine()
      const { run, lead } = seedRun()

      // 80 clears the default 70 but not the configured 90.
      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ ai: makeAi(80) }), sleep: noSleep },
      )

      expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('UNQUALIFIED')
      expect(stepStatus(run.id, 'SEND_EMAIL')?.errorCode).toBe('below_threshold')
    })

    it('qualifies below 70 when the configured bar is lower', async () => {
      seedConfig(30)
      const { executeWorkflowRun } = await importEngine()
      const { run, lead } = seedRun()

      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ ai: makeAi(42) }), sleep: noSleep },
      )

      expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('QUALIFIED')
      expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('SUCCEEDED')
    })

    it('pins the config version onto the run', async () => {
      seedConfig(90)
      const { executeWorkflowRun } = await importEngine()
      const { run } = seedRun()

      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ ai: makeAi(80) }), sleep: noSleep },
      )

      // Explainability: the run records which configuration judged it.
      expect(state.runs.find((r) => r.id === run.id)?.qualificationConfigVersionId).toBe('cfg_1')
    })

    it('passes the organization config to the AI provider', async () => {
      seedConfig(55)
      const { executeWorkflowRun } = await importEngine()
      const { run } = seedRun()
      const ai = makeAi(60)

      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ ai }), sleep: noSleep },
      )

      expect(ai.qualify.mock.calls[0]?.[0]).toMatchObject({
        config: { icp: 'Configured ICP.', threshold: 55 },
      })
    })

    it('falls back to the built-in threshold when the organization configured none', async () => {
      const { executeWorkflowRun } = await importEngine()
      const { run, lead } = seedRun()

      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ ai: makeAi(70) }), sleep: noSleep },
      )

      expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('QUALIFIED')
      // Nothing pinned: there is no version row to point at.
      expect(state.runs.find((r) => r.id === run.id)?.qualificationConfigVersionId).toBeFalsy()
    })
  })

  it('3. score 70 (threshold boundary) qualifies and is emailed', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()
    const providers = makeRegistry({ ai: makeAi(70) })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('SUCCEEDED')
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('QUALIFIED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('SUCCEEDED')
  })

  it('4. score 100 qualifies', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()

    await executeWorkflowRun(
      { runId: run.id },
      { providers: makeRegistry({ ai: makeAi(100) }), sleep: noSleep },
    )

    expect(state.leads.find((l) => l.id === lead.id)?.aiScore).toBe(100)
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('QUALIFIED')
  })

  it('5. score 0 does not qualify and is never emailed', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()
    const providers = makeRegistry({ ai: makeAi(0) })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    // 0 is a real score, not "unscored": it is stored, and it disqualifies.
    expect(state.leads.find((l) => l.id === lead.id)?.aiScore).toBe(0)
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBe('UNQUALIFIED')
    expect(result.runStatus).toBe('SUCCEEDED')
    expect((providers.email as ReturnType<typeof makeEmail>).send).not.toHaveBeenCalled()
  })

  it('6. enrichment provider absent: step SKIPPED and the pipeline continues', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()

    const result = await executeWorkflowRun(
      { runId: run.id },
      { providers: makeRegistry({ enrichment: null }), sleep: noSleep },
    )

    expect(stepStatus(run.id, 'ENRICH')?.status).toBe('SKIPPED')
    expect(stepStatus(run.id, 'ENRICH')?.errorCode).toBe('provider_not_configured')
    expect(result.runStatus).toBe('SUCCEEDED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('SUCCEEDED')
  })

  it('7. enrichment terminal failure: FAILED, downstream SKIPPED, run FAILED, no email', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const enrichment = makeEnrichment()
    enrichment.enrich.mockRejectedValue(new Error('enrichment upstream down'))
    const providers = makeRegistry({ enrichment })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('FAILED')
    expect(stepStatus(run.id, 'ENRICH')?.status).toBe('FAILED')
    expect(stepStatus(run.id, 'ENRICH')?.attempts).toBe(3)
    for (const step of ['AI_QUALIFY', 'SCORE_AND_TAG', 'SEND_EMAIL', 'NOTIFY_TEAM']) {
      expect(stepStatus(run.id, step)?.status).toBe('SKIPPED')
      expect(stepStatus(run.id, step)?.errorCode).toBe('upstream_failed')
    }
    expect((providers.email as ReturnType<typeof makeEmail>).send).not.toHaveBeenCalled()
  })

  it('8. AI terminal failure: FAILED, aiScore stays null, run FAILED, no email', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()
    const ai = makeAi()
    ai.qualify.mockRejectedValue(new Error('model unavailable'))
    const providers = makeRegistry({ ai })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('FAILED')
    expect(stepStatus(run.id, 'AI_QUALIFY')?.status).toBe('FAILED')
    expect(stepStatus(run.id, 'AI_QUALIFY')?.attempts).toBe(3)
    expect(state.leads.find((l) => l.id === lead.id)?.aiScore).toBeNull()
    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('SKIPPED')
    expect((providers.email as ReturnType<typeof makeEmail>).send).not.toHaveBeenCalled()
  })

  it('9. malformed AI output is a failure, never a guessed score', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun()
    const ai = makeAi()
    ai.qualify.mockResolvedValue({ score: 'very high', summary: '' } as never)
    const providers = makeRegistry({ ai })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('FAILED')
    expect(stepStatus(run.id, 'AI_QUALIFY')?.errorCode).toBe('ai_output_malformed')
    expect(state.leads.find((l) => l.id === lead.id)?.aiScore).toBeNull()
    expect(state.leads.find((l) => l.id === lead.id)?.qualificationOutcome).toBeNull()
  })

  it('10. AI budget exceeded is non-retriable: one attempt, no provider call, run FAILED', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { ProviderCallError } = await import('@/lib/automation/providers')
    const { run } = seedRun()
    const ai = makeAi()
    const providers = makeRegistry({
      ai,
      aiBudget: {
        assertWithinBudget: async () => {
          throw new ProviderCallError('ai_budget_exceeded', 'Monthly AI budget exhausted', {
            retriable: false,
          })
        },
      },
    })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('FAILED')
    expect(stepStatus(run.id, 'AI_QUALIFY')?.status).toBe('FAILED')
    expect(stepStatus(run.id, 'AI_QUALIFY')?.errorCode).toBe('ai_budget_exceeded')
    expect(stepStatus(run.id, 'AI_QUALIFY')?.attempts).toBe(1)
    expect(ai.qualify).not.toHaveBeenCalled()
  })

  it('11. a human qualification decision is never overwritten by the AI', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run, lead } = seedRun({
      leadOverrides: { qualificationOutcome: 'QUALIFIED', qualificationSource: 'HUMAN' },
    })
    // AI would say UNQUALIFIED; the human already said QUALIFIED.
    const providers = makeRegistry({ ai: makeAi(30) })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    const stored = state.leads.find((l) => l.id === lead.id)
    expect(stored?.qualificationOutcome).toBe('QUALIFIED')
    expect(stored?.qualificationSource).toBe('HUMAN')
    // The AI's own suggestion is still recorded — it is a suggestion, not the decision.
    expect(stored?.aiScore).toBe(30)
    expect(stepStatus(run.id, 'SCORE_AND_TAG')?.status).toBe('SUCCEEDED')
    // Downstream follows the effective (human) outcome.
    expect((providers.email as ReturnType<typeof makeEmail>).send).toHaveBeenCalledTimes(1)
    expect(result.runStatus).toBe('SUCCEEDED')
  })

  // 12. Formerly "CRM failure is non-blocking" — ADD_TO_CRM is retired (see
  // lib/automation/pipeline.ts). The general rule it proved (a non-critical
  // step's failure does not fail the run) is still covered by the NOTIFY_TEAM
  // failure case below.

  it('13. qualified lead + no email provider: SEND_EMAIL BLOCKED and run BLOCKED', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const providers = makeRegistry({ email: null })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('BLOCKED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.errorCode).toBe('email_provider_not_configured')
    expect(result.runStatus).toBe('BLOCKED')
    // The team is still told: a qualified lead went uncontacted.
    expect(stepStatus(run.id, 'NOTIFY_TEAM')?.status).toBe('SUCCEEDED')
  })

  it('14. email terminal failure: run FAILED and the team is still notified', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const email = makeEmail()
    email.send.mockRejectedValue(new Error('smtp refused'))
    const notification = makeNotification()
    const providers = makeRegistry({ email, notification })

    const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(result.runStatus).toBe('FAILED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('FAILED')
    expect(stepStatus(run.id, 'SEND_EMAIL')?.attempts).toBe(3)
    expect(stepStatus(run.id, 'NOTIFY_TEAM')?.status).toBe('SUCCEEDED')
    expect(notification.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'run_failed' }),
    )
  })

  it('15. notification failure is non-blocking: run outcome unchanged', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const notification = makeNotification()
    notification.notify.mockRejectedValue(new Error('slack down'))

    const result = await executeWorkflowRun(
      { runId: run.id },
      { providers: makeRegistry({ notification }), sleep: noSleep },
    )

    expect(stepStatus(run.id, 'NOTIFY_TEAM')?.status).toBe('FAILED')
    expect(result.runStatus).toBe('SUCCEEDED')
  })

  it('16. a transient failure is retried and the attempt counter reflects it', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const enrichment = makeEnrichment()
    enrichment.enrich
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ provider: 'fake', data: {} })

    const result = await executeWorkflowRun(
      { runId: run.id },
      { providers: makeRegistry({ enrichment }), sleep: noSleep },
    )

    expect(enrichment.enrich).toHaveBeenCalledTimes(2)
    expect(stepStatus(run.id, 'ENRICH')?.status).toBe('SUCCEEDED')
    expect(stepStatus(run.id, 'ENRICH')?.attempts).toBe(2)
    expect(result.runStatus).toBe('SUCCEEDED')
  })

  it('17. a duplicate event for the same run does not execute it twice', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const providers = makeRegistry()

    const first = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })
    const second = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(first.runStatus).toBe('SUCCEEDED')
    expect(second.outcome).toBe('ALREADY_TERMINAL')
    expect((providers.email as ReturnType<typeof makeEmail>).send).toHaveBeenCalledTimes(1)
    expect((providers.ai as ReturnType<typeof makeAi>).qualify).toHaveBeenCalledTimes(1)
  })

  it('18. a step that already succeeded is memoized, not re-executed', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const email = makeEmail()
    const providers = makeRegistry({ email })

    await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    // Re-open the run as a crash-resume would, then execute again.
    const stored = state.runs.find((r) => r.id === run.id)!
    stored.status = 'PENDING'

    await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(email.send).toHaveBeenCalledTimes(1)
    expect(stepStatus(run.id, 'SEND_EMAIL')?.attempts).toBe(1)
  })

  it('19. provider succeeded but the DB write failed: retried with the SAME idempotency key', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const email = makeEmail()
    state.failPersistOnce('SEND_EMAIL')

    const result = await executeWorkflowRun(
      { runId: run.id },
      { providers: makeRegistry({ email }), sleep: noSleep },
    )

    expect(email.send).toHaveBeenCalledTimes(2)
    const firstKey = email.send.mock.calls[0]?.[0]?.idempotencyKey
    const secondKey = email.send.mock.calls[1]?.[0]?.idempotencyKey
    expect(firstKey).toBeDefined()
    // Stable across the retry — a provider that honours idempotency keys
    // de-duplicates the second send rather than mailing the lead twice.
    expect(secondKey).toBe(firstKey)
    expect(stepStatus(run.id, 'SEND_EMAIL')?.status).toBe('SUCCEEDED')
    expect(result.runStatus).toBe('SUCCEEDED')
  })

  it('22a. an event naming an unknown run aborts without calling a provider', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { run } = seedRun()
    const providers = makeRegistry()

    const result = await executeWorkflowRun(
      { runId: 'run_does_not_exist' },
      { providers, sleep: noSleep },
    )

    expect(result.outcome).toBe('ABORTED')
    expect(result.reason).toBe('run_not_found')
    // The real run is untouched.
    expect(state.runs.find((r) => r.id === run.id)?.status).toBe('PENDING')
    expect((providers.ai as ReturnType<typeof makeAi>).qualify).not.toHaveBeenCalled()
  })

  it('23a. an empty runId aborts without touching anything', async () => {
    const { executeWorkflowRun } = await importEngine()
    seedRun()

    const result = await executeWorkflowRun(
      { runId: '' },
      { providers: makeRegistry(), sleep: noSleep },
    )

    expect(result.outcome).toBe('ABORTED')
    expect(state.stepRuns).toHaveLength(0)
  })

  it('24. a manual re-run creates a NEW run on the SAME enrollment', async () => {
    const { requestManualRerun } = await import('@/lib/services/workflow-runs')
    const { run, enrollment } = seedRun()

    // The original run must be finished before a re-run is allowed.
    state.runs.find((r) => r.id === run.id)!.status = 'FAILED'

    const rerun = await requestManualRerun(run.id)

    expect(rerun.id).not.toBe(run.id)
    expect(rerun.workflowEnrollmentId).toBe(enrollment.id)
    expect(rerun.trigger).toBe('MANUAL_RERUN')
    expect(rerun.status).toBe('PENDING')
    expect(rerun.version).toBe(1)
    expect(state.runs.filter((r) => r.workflowEnrollmentId === enrollment.id)).toHaveLength(2)
    expect(emitRunRequestedMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: rerun.id, trigger: 'MANUAL_RERUN' }),
    )
  })

  it('24a. a manual re-run executes exactly the five current pipeline steps, no ADD_TO_CRM row', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { requestManualRerun } = await import('@/lib/services/workflow-runs')
    const { run } = seedRun()
    state.runs.find((r) => r.id === run.id)!.status = 'FAILED'

    const rerun = await requestManualRerun(run.id)
    const result = await executeWorkflowRun(
      { runId: rerun.id },
      { providers: makeRegistry(), sleep: noSleep },
    )

    expect(result.runStatus).toBe('SUCCEEDED')
    const rerunSteps = state.stepRuns.filter((s) => s.workflowRunId === rerun.id)
    expect(rerunSteps.map((s) => s.step).sort()).toEqual(
      ['ENRICH', 'AI_QUALIFY', 'SCORE_AND_TAG', 'SEND_EMAIL', 'NOTIFY_TEAM'].sort(),
    )
    expect(rerunSteps.every((s) => s.status === 'SUCCEEDED')).toBe(true)
  })

  it('25. a manual re-run is refused while another run for the lead is active', async () => {
    const { requestManualRerun } = await import('@/lib/services/workflow-runs')
    const { run } = seedRun()

    // The seeded run is still PENDING — i.e. active.
    await expect(requestManualRerun(run.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(state.runs).toHaveLength(1)
    expect(emitRunRequestedMock).not.toHaveBeenCalled()
  })

  it('26. an orphaned PENDING run is recovered, and re-emission is harmless', async () => {
    const { executeWorkflowRun } = await importEngine()
    const { recoverPendingRuns } = await import('@/lib/services/workflow-recovery')
    const { run } = seedRun()

    // The seeded run is PENDING and older than the (zero) threshold, so the
    // sweep's own query finds it — no stubbing needed any more.
    const firstSweep = await recoverPendingRuns({ olderThanMs: 0 })
    expect(firstSweep).toEqual({ found: 1, reemitted: 1 })
    expect(emitRunRequestedMock).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }))

    // The re-emitted event executes the run exactly once...
    const providers = makeRegistry()
    await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    // ...and a second sweep + duplicate delivery changes nothing.
    await recoverPendingRuns({ olderThanMs: 0 })
    const second = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

    expect(second.outcome).toBe('ALREADY_TERMINAL')
    expect((providers.email as ReturnType<typeof makeEmail>).send).toHaveBeenCalledTimes(1)
  })

  describe('retry budget survives a crash-and-resume', () => {
    it('does not grant a fresh local budget when a step resumes with attempts already at the cap', async () => {
      const { executeWorkflowRun } = await importEngine()
      const { run } = seedRun()

      // Simulate the state left behind by a crash mid-ENRICH after 3 real
      // attempts (STEP_MAX_ATTEMPTS for ENRICH) had already been claimed and
      // spent — the row is RUNNING, non-terminal, never completed.
      run.status = 'RUNNING'
      state.stepRuns.push({
        id: state.id('step'),
        workflowRunId: run.id,
        step: 'ENRICH',
        status: 'RUNNING',
        attempts: 3,
        output: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        completedAt: null,
      })

      const enrichment = makeEnrichment()
      enrichment.enrich.mockRejectedValue(new Error('still failing'))

      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ enrichment }), sleep: noSleep },
      )

      // The resumed claim brings attempts to 4 (3 already spent + this one).
      // With the persisted count as the source of truth, 4 >= maxAttempts(3)
      // means the very first call this invocation is also the last — no
      // fresh 3-attempt budget granted by the local loop.
      expect(enrichment.enrich).toHaveBeenCalledTimes(1)
      expect(stepStatus(run.id, 'ENRICH')?.status).toBe('FAILED')
      expect(stepStatus(run.id, 'ENRICH')?.attempts).toBe(4)
    })

    it('still allows the full budget within a single fresh execution', async () => {
      const { executeWorkflowRun } = await importEngine()
      const { run } = seedRun()
      const enrichment = makeEnrichment()
      enrichment.enrich.mockRejectedValue(new Error('always fails'))

      await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ enrichment }), sleep: noSleep },
      )

      // No prior crash: attempts starts at 0, so the ordinary 3-attempt
      // budget is unaffected by this fix.
      expect(enrichment.enrich).toHaveBeenCalledTimes(3)
      expect(stepStatus(run.id, 'ENRICH')?.attempts).toBe(3)
    })
  })

  describe('27. a stuck RUNNING run is recovered by generation, not by relying on Inngest dedup', () => {
    it('never recovers a fresh RUNNING run', async () => {
      const { recoverStuckRunningRuns } = await import('@/lib/services/workflow-recovery')
      const { run } = seedRun()
      run.status = 'RUNNING'

      // The SECURITY DEFINER function itself enforces the staleness filter in
      // real Postgres (see tests/integration/automation-execution.test.ts);
      // here the fake stands in for "the sweep found nothing" because this
      // run's updatedAt is fresh.
      queryRawMock.mockResolvedValue([])

      const result = await recoverStuckRunningRuns()

      expect(result).toEqual({ found: 0, reemitted: 0, failed: 0 })
      expect(emitRunRecoveryRequestedMock).not.toHaveBeenCalled()
      expect(run.status).toBe('RUNNING')
    })

    it('re-requests execution of a genuinely stale RUNNING run, with generation 1', async () => {
      const { recoverStuckRunningRuns } = await import('@/lib/services/workflow-recovery')
      const { run } = seedRun()
      run.status = 'RUNNING'

      queryRawMock.mockResolvedValue([
        {
          id: run.id,
          leadId: run.leadId,
          trigger: 'AUTOMATIC',
          recoveryAttempts: 0,
        },
      ])

      const result = await recoverStuckRunningRuns()

      expect(result).toEqual({ found: 1, reemitted: 1, failed: 0 })
      expect(run.recoveryAttempts).toBe(1)
      expect(run.status).toBe('RUNNING')
      expect(emitRunRecoveryRequestedMock).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id }),
        1,
      )
    })

    it('carries a distinct generation each sweep, never relying on Inngest deduplicating the same runId', async () => {
      const { recoverStuckRunningRuns } = await import('@/lib/services/workflow-recovery')
      const { run } = seedRun()
      run.status = 'RUNNING'
      run.recoveryAttempts = 1

      queryRawMock.mockResolvedValue([
        {
          id: run.id,
          leadId: run.leadId,
          trigger: 'AUTOMATIC',
          recoveryAttempts: 1,
        },
      ])

      await recoverStuckRunningRuns()

      expect(run.recoveryAttempts).toBe(2)
      expect(emitRunRecoveryRequestedMock).toHaveBeenCalledWith(expect.anything(), 2)
    })

    it('finalizes FAILED once the recovery-attempt cap is reached, freeing the lead', async () => {
      const { recoverStuckRunningRuns } = await import('@/lib/services/workflow-recovery')
      const { run } = seedRun()
      run.status = 'RUNNING'
      run.recoveryAttempts = 3 // already at MAX_RECOVERY_ATTEMPTS

      queryRawMock.mockResolvedValue([
        {
          id: run.id,
          leadId: run.leadId,
          trigger: 'AUTOMATIC',
          recoveryAttempts: 3,
        },
      ])

      const result = await recoverStuckRunningRuns()

      expect(result).toEqual({ found: 1, reemitted: 0, failed: 1 })
      expect(run.status).toBe('FAILED')
      // No further generation minted for an attempt that is being abandoned.
      expect(run.recoveryAttempts).toBe(3)
      expect(emitRunRecoveryRequestedMock).not.toHaveBeenCalled()
    })

    it('never touches a WorkflowStepRun directly', async () => {
      const { recoverStuckRunningRuns } = await import('@/lib/services/workflow-recovery')
      const { run } = seedRun()
      run.status = 'RUNNING'
      const stepRun = {
        id: state.id('step'),
        workflowRunId: run.id,
        step: 'ENRICH',
        status: 'RUNNING',
        attempts: 1,
        output: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        completedAt: null,
      }
      state.stepRuns.push(stepRun)

      queryRawMock.mockResolvedValue([
        {
          id: run.id,
          leadId: run.leadId,
          trigger: 'AUTOMATIC',
          recoveryAttempts: 0,
        },
      ])

      await recoverStuckRunningRuns()

      // Untouched — resumption via claimStep is what corrects it, not this sweep.
      expect(stepRun.status).toBe('RUNNING')
      expect(stepRun.attempts).toBe(1)
    })

    it('is race-safe: a lost conditional update skips this tick rather than double-incrementing', async () => {
      const { claimRunForRecovery } = await import('@/lib/services/workflow-runs')
      const { run } = seedRun()
      run.status = 'RUNNING'

      // Two ticks read the same recoveryAttempts before either writes.
      const [first, second] = await Promise.all([
        claimRunForRecovery(run.id, 3),
        claimRunForRecovery(run.id, 3),
      ])

      const outcomes = [first.outcome, second.outcome].sort()
      // Exactly one wins with generation 1; the other sees NOT_RUNNING rather
      // than also minting a (wrong) generation 1, or silently double-bumping.
      expect(outcomes).toEqual(['NOT_RUNNING', 'RECOVERED'])
      expect(run.recoveryAttempts).toBe(1)
    })

    it('skips a run the sweep reported but that is no longer RUNNING', async () => {
      const { recoverStuckRunningRuns } = await import('@/lib/services/workflow-recovery')
      const { run } = seedRun()
      // The staleness query saw it RUNNING; by the time the write path runs it
      // has finished. The conditional claim must fail closed rather than
      // resurrect a completed run.
      run.status = 'SUCCEEDED'

      queryRawMock.mockResolvedValue([
        {
          id: run.id,
          leadId: run.leadId,
          trigger: 'AUTOMATIC',
          recoveryAttempts: 0,
        },
      ])

      await recoverStuckRunningRuns()

      expect(run.recoveryAttempts).toBe(0)
      expect(emitRunRecoveryRequestedMock).not.toHaveBeenCalled()
    })
  })

  describe('resumption mechanics after a recovered RUNNING run', () => {
    it('resumes a RUNNING run with zero prior StepRun rows exactly like a fresh execution', async () => {
      const { executeWorkflowRun } = await importEngine()
      const { run } = seedRun()

      // What claimRunForRecovery leaves behind before re-execution: the run
      // itself already RUNNING (crashed before claiming any step), no
      // WorkflowStepRun rows exist yet at all.
      run.status = 'RUNNING'
      expect(state.stepRuns.filter((s) => s.workflowRunId === run.id)).toHaveLength(0)

      const providers = makeRegistry()
      const result = await executeWorkflowRun({ runId: run.id }, { providers, sleep: noSleep })

      expect(result.runStatus).toBe('SUCCEEDED')
      expect(stepStatus(run.id, 'ENRICH')?.status).toBe('SUCCEEDED')
      expect(stepStatus(run.id, 'AI_QUALIFY')?.status).toBe('SUCCEEDED')
      expect((providers.ai as ReturnType<typeof makeAi>).qualify).toHaveBeenCalledTimes(1)
    })

    it('resumes a StepRun left RUNNING below its attempt cap via the existing claimStep path', async () => {
      const { executeWorkflowRun } = await importEngine()
      const { run } = seedRun()
      run.status = 'RUNNING'

      // A crash mid-ENRICH after a single real attempt — non-terminal, not
      // yet at STEP_MAX_ATTEMPTS. Recovery never touches this row directly;
      // only claimStep (invoked from inside executeWorkflowRun) may.
      state.stepRuns.push({
        id: state.id('step'),
        workflowRunId: run.id,
        step: 'ENRICH',
        status: 'RUNNING',
        attempts: 1,
        output: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        completedAt: null,
      })

      const enrichment = makeEnrichment()
      const result = await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry({ enrichment }), sleep: noSleep },
      )

      // Resumed, not re-created: attempts continues from the persisted count.
      expect(enrichment.enrich).toHaveBeenCalledTimes(1)
      expect(stepStatus(run.id, 'ENRICH')?.status).toBe('SUCCEEDED')
      expect(stepStatus(run.id, 'ENRICH')?.attempts).toBe(2)
      expect(result.runStatus).toBe('SUCCEEDED')
    })

    it('a full recovery cycle — claim, recovery-requested event, re-execution — completes the run', async () => {
      const { executeWorkflowRun } = await importEngine()
      const { claimRunForRecovery } = await import('@/lib/services/workflow-runs')
      const { run } = seedRun()
      run.status = 'RUNNING'
      state.stepRuns.push({
        id: state.id('step'),
        workflowRunId: run.id,
        step: 'ENRICH',
        status: 'RUNNING',
        attempts: 1,
        output: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        completedAt: null,
      })

      const claim = await claimRunForRecovery(run.id, 3)
      expect(claim.outcome).toBe('RECOVERED')
      if (claim.outcome !== 'RECOVERED') throw new Error('unreachable')

      // What the sweep emits — a distinct generation, never assumed to dedup
      // against the original event by Inngest.
      await emitRunRecoveryRequestedMock(
        { runId: run.id, leadId: run.leadId, trigger: run.trigger },
        claim.generation,
      )
      expect(emitRunRecoveryRequestedMock).toHaveBeenCalledWith(expect.anything(), 1)

      // What the Inngest function does on receiving that event: execute.
      const result = await executeWorkflowRun(
        { runId: run.id },
        { providers: makeRegistry(), sleep: noSleep },
      )

      expect(result.runStatus).toBe('SUCCEEDED')
      expect(run.recoveryAttempts).toBe(1)
      // No new WorkflowRun was ever created — recovery resumed the existing one.
      expect(state.runs.filter((r) => r.leadId === run.leadId)).toHaveLength(1)
    })
  })
})
