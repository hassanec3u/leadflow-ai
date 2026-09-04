import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2G — the Automation read services.
 *
 * `@/lib/db/prisma` is an in-memory fake mimicking Prisma plus Postgres RLS:
 * a row is visible only when its `organizationId` matches whatever the last
 * `withTenant()` established, exactly as tests/unit/automation-enrollment.test.ts
 * does. So a service that forgot tenant scoping surfaces here as cross-tenant
 * leakage. Real RLS on these tables is proven separately in
 * tests/integration/automation-domain.test.ts.
 */

const ACME = 'org_acme'
const GLOBEX = 'org_globex'
const NOW = new Date('2026-09-02T12:00:00.000Z')

type Row = Record<string, unknown> & { organizationId?: string }

const state = vi.hoisted(() => ({
  currentOrg: null as string | null,
  role: 'ADMIN' as 'ADMIN' | 'MANAGER' | 'SALES_REP',
  organizationId: 'org_acme',
  workflows: [] as Row[],
  enrollments: [] as Row[],
  runs: [] as Row[],
  stepRuns: [] as Row[],
  leads: [] as Row[],
}))

/** RLS in miniature: only the current tenant's rows exist. */
const visible = (rows: Row[]) => rows.filter((row) => row.organizationId === state.currentOrg)

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true
    if (value !== null && typeof value === 'object' && 'gte' in (value as object)) {
      return (row[key] as Date) >= ((value as { gte: Date }).gte as Date)
    }
    return row[key] === value
  })
}

function sortDesc(rows: Row[], key: string) {
  return [...rows].sort((a, b) => (b[key] as Date).getTime() - (a[key] as Date).getTime())
}

/** Attaches the relations the service selects, as Prisma would. */
function hydrate(run: Row) {
  return {
    ...run,
    lead: state.leads.find((lead) => lead.id === run.leadId),
    stepRuns: state.stepRuns.filter((step) => step.workflowRunId === run.id),
  }
}

const txClient = {
  $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
    state.currentOrg = (values[0] as string) ?? null
    return 1
  },
  workflow: {
    findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
      visible(state.workflows).find((row) => matches(row, where)) ?? null,
  },
  workflowEnrollment: {
    count: async () => visible(state.enrollments).length,
  },
  workflowRun: {
    findFirst: async ({ where }: { where?: Record<string, unknown> }) => {
      const found = sortDesc(visible(state.runs), 'createdAt').find((row) => matches(row, where))
      return found ? hydrate(found) : null
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      sortDesc(visible(state.runs), 'createdAt')
        .filter((row) => matches(row, where))
        .map(hydrate),
    count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      visible(state.runs).filter((row) => matches(row, where)).length,
    groupBy: async () => {
      const counts = new Map<string, number>()
      for (const run of visible(state.runs)) {
        const status = run.status as string
        counts.set(status, (counts.get(status) ?? 0) + 1)
      }
      return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }))
    },
  },
  lead: {
    findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
      visible(state.leads).find((row) => matches(row, where)) ?? null,
  },
}

vi.mock('@/lib/db/prisma', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient) },
}))

vi.mock('@/lib/auth/session', () => ({
  requireCapability: async (capability: string) => {
    const { hasCapability } = await import('@/lib/auth/rbac')
    const { ForbiddenError } = await import('@/lib/errors')
    if (!hasCapability(state.role, capability as never)) throw new ForbiddenError()
    return { id: 'user_1', organizationId: state.organizationId, role: state.role }
  },
}))

async function service() {
  return import('@/lib/services/automation-read')
}

function seedRun(options: {
  id: string
  organizationId: string
  status: string
  leadId: string
  steps?: Array<{
    step: string
    status: string
    attempts?: number
    errorCode?: string | null
    errorMessage?: string | null
    output?: unknown
  }>
  createdAt?: Date
}) {
  state.runs.push({
    id: options.id,
    organizationId: options.organizationId,
    workflowId: `wf_${options.organizationId}`,
    workflowEnrollmentId: `enr_${options.id}`,
    leadId: options.leadId,
    version: 1,
    trigger: 'AUTOMATIC',
    status: options.status,
    createdAt: options.createdAt ?? new Date('2026-09-02T10:00:00.000Z'),
    startedAt: new Date('2026-09-02T10:00:05.000Z'),
    completedAt:
      options.status === 'RUNNING' || options.status === 'PENDING'
        ? null
        : new Date('2026-09-02T10:01:00.000Z'),
  })
  for (const step of options.steps ?? []) {
    state.stepRuns.push({
      workflowRunId: options.id,
      step: step.step,
      status: step.status,
      attempts: step.attempts ?? 1,
      startedAt: new Date('2026-09-02T10:00:10.000Z'),
      completedAt: new Date('2026-09-02T10:00:20.000Z'),
      errorCode: step.errorCode ?? null,
      errorMessage: step.errorMessage ?? null,
      output: step.output ?? null,
    })
  }
}

beforeEach(() => {
  state.currentOrg = null
  state.role = 'ADMIN'
  state.organizationId = ACME
  state.workflows = [
    {
      id: 'wf_org_acme',
      organizationId: ACME,
      type: 'LEAD_QUALIFICATION',
      status: 'ACTIVE',
      version: 3,
      createdAt: NOW,
    },
    {
      id: 'wf_org_globex',
      organizationId: GLOBEX,
      type: 'LEAD_QUALIFICATION',
      status: 'PAUSED',
      version: 1,
      createdAt: NOW,
    },
  ]
  state.enrollments = [
    { id: 'enr_a', organizationId: ACME },
    { id: 'enr_b', organizationId: GLOBEX },
  ]
  state.leads = [
    {
      id: 'lead_acme',
      organizationId: ACME,
      name: 'Ada',
      email: 'ada@acme.test',
      company: 'Acme',
      formMessage: 'We need this before Q1.',
      aiScore: 91,
      qualificationOutcome: 'QUALIFIED',
      qualificationSource: 'AI',
      qualificationUpdatedAt: NOW,
      deletedAt: null,
    },
    {
      id: 'lead_globex',
      organizationId: GLOBEX,
      name: 'Bob',
      email: 'bob@globex.test',
      company: 'Globex',
      formMessage: null,
      aiScore: 20,
      qualificationOutcome: 'UNQUALIFIED',
      qualificationSource: 'AI',
      qualificationUpdatedAt: NOW,
      deletedAt: null,
    },
    {
      id: 'lead_deleted',
      organizationId: ACME,
      name: 'Gone',
      email: 'gone@acme.test',
      company: null,
      formMessage: null,
      aiScore: null,
      qualificationOutcome: null,
      qualificationSource: null,
      qualificationUpdatedAt: null,
      deletedAt: NOW,
    },
  ]
  state.runs = []
  state.stepRuns = []
})

describe('tenant isolation', () => {
  it('never returns another organization’s runs', async () => {
    seedRun({ id: 'run_acme', organizationId: ACME, status: 'SUCCEEDED', leadId: 'lead_acme' })
    seedRun({
      id: 'run_globex',
      organizationId: GLOBEX,
      status: 'SUCCEEDED',
      leadId: 'lead_globex',
    })

    const { listWorkflowRuns } = await service()
    const runs = await listWorkflowRuns(NOW)

    expect(runs.map((run) => run.id)).toEqual(['run_acme'])
  })

  it('returns null for a run id belonging to another organization', async () => {
    seedRun({
      id: 'run_globex',
      organizationId: GLOBEX,
      status: 'SUCCEEDED',
      leadId: 'lead_globex',
    })

    const { getWorkflowRunDetail } = await service()

    // Same result as an id that never existed — no oracle.
    expect(await getWorkflowRunDetail('run_globex', NOW)).toBeNull()
    expect(await getWorkflowRunDetail('run_does_not_exist', NOW)).toBeNull()
  })

  it('reads the caller’s own workflow, not another tenant’s', async () => {
    const { getAutomationOverview } = await service()

    const acme = await getAutomationOverview(NOW)
    expect(acme.workflow).toMatchObject({ status: 'ACTIVE', version: 'v3' })

    state.organizationId = GLOBEX
    const globex = await getAutomationOverview(NOW)
    expect(globex.workflow).toMatchObject({ status: 'PAUSED', version: 'v1' })
  })
})

describe('authorisation', () => {
  it.each(['SALES_REP'] as const)('refuses %s without automation:manage', async (role) => {
    state.role = role
    const { listWorkflowRuns } = await service()

    await expect(listWorkflowRuns(NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('allows MANAGER, which already holds automation:manage', async () => {
    state.role = 'MANAGER'
    const { listWorkflowRuns } = await service()

    await expect(listWorkflowRuns(NOW)).resolves.toEqual([])
  })
})

describe('overview', () => {
  it('computes real counts and a real success rate', async () => {
    seedRun({ id: 'r1', organizationId: ACME, status: 'SUCCEEDED', leadId: 'lead_acme' })
    seedRun({ id: 'r2', organizationId: ACME, status: 'SUCCEEDED', leadId: 'lead_acme' })
    seedRun({ id: 'r3', organizationId: ACME, status: 'FAILED', leadId: 'lead_acme' })
    seedRun({ id: 'r4', organizationId: ACME, status: 'BLOCKED', leadId: 'lead_acme' })
    seedRun({ id: 'r5', organizationId: ACME, status: 'RUNNING', leadId: 'lead_acme' })

    const { getAutomationOverview } = await service()
    const { workflow, kpis } = await getAutomationOverview(NOW)

    // 2 succeeded of 4 terminal runs.
    expect(workflow?.successRate).toBe(50)
    expect(kpis.find((kpi) => kpi.key === 'total-runs')?.value).toBe('5')
    expect(kpis.find((kpi) => kpi.key === 'running')?.value).toBe('1')
    // Failed KPI counts blocked too, but the workflow stats keep them apart.
    expect(workflow?.stats).toContainEqual({ label: 'Failed', value: '1' })
    expect(workflow?.stats).toContainEqual({ label: 'Blocked', value: '1' })
  })

  it('reports no workflow at all when the organization has never captured a lead', async () => {
    state.workflows = []
    const { getAutomationOverview } = await service()

    const result = await getAutomationOverview(NOW)
    expect(result.workflow).toBeNull()
    expect(result.kpis).toEqual([])
  })

  it('publishes no invented trend on any KPI', async () => {
    seedRun({ id: 'r1', organizationId: ACME, status: 'SUCCEEDED', leadId: 'lead_acme' })
    const { getAutomationOverview } = await service()

    const { kpis } = await getAutomationOverview(NOW)
    expect(kpis.every((kpi) => kpi.trend === undefined)).toBe(true)
  })

  it('returns an empty run list rather than failing when there are no runs', async () => {
    const { listWorkflowRuns } = await service()
    expect(await listWorkflowRuns(NOW)).toEqual([])
  })
})

describe('run detail and step states', () => {
  it('always returns the five fixed steps in pipeline order', async () => {
    seedRun({ id: 'run_1', organizationId: ACME, status: 'RUNNING', leadId: 'lead_acme' })
    const { getWorkflowRunDetail } = await service()

    const run = await getWorkflowRunDetail('run_1', NOW)
    expect(run?.steps.map((step) => step.key)).toEqual([
      'ENRICH',
      'AI_QUALIFY',
      'SCORE_AND_TAG',
      'SEND_EMAIL',
      'NOTIFY_TEAM',
    ])
    // No row yet means not started, which is PENDING.
    expect(run?.steps.every((step) => step.state === 'PENDING')).toBe(true)
  })

  it('an old run with a historical ADD_TO_CRM WorkflowStepRun row still reads cleanly', async () => {
    // ADD_TO_CRM is retired (lib/automation/pipeline.ts) but the DB enum
    // still carries it for rows created before this change — nothing deletes
    // those rows. This proves the read service does not choke on one: it
    // simply is not one of the five keys the fixed view renders.
    seedRun({
      id: 'run_legacy',
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      steps: [{ step: 'ADD_TO_CRM', status: 'SUCCEEDED', output: { recordId: 'rec_1' } }],
    })
    const { getWorkflowRunDetail } = await service()

    const run = await getWorkflowRunDetail('run_legacy', NOW)
    expect(run?.status).toBe('SUCCEEDED')
    expect(run?.steps.map((step) => step.key)).toEqual([
      'ENRICH',
      'AI_QUALIFY',
      'SCORE_AND_TAG',
      'SEND_EMAIL',
      'NOTIFY_TEAM',
    ])
    expect(run?.steps.find((step) => (step.key as string) === 'ADD_TO_CRM')).toBeUndefined()
  })

  it('keeps SKIPPED distinct from FAILED and BLOCKED', async () => {
    seedRun({
      id: 'run_mixed',
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      steps: [
        { step: 'ENRICH', status: 'SKIPPED', errorCode: 'provider_not_configured' },
        { step: 'AI_QUALIFY', status: 'SUCCEEDED' },
        { step: 'SEND_EMAIL', status: 'SKIPPED', errorCode: 'below_threshold' },
        { step: 'NOTIFY_TEAM', status: 'SUCCEEDED' },
      ],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_mixed', NOW)
    const byKey = new Map(run?.steps.map((step) => [step.key, step]))

    expect(byKey.get('ENRICH')?.state).toBe('SKIPPED')
    expect(byKey.get('SEND_EMAIL')?.state).toBe('SKIPPED')
    expect(byKey.get('SEND_EMAIL')?.reason).toBe('below_threshold')
    expect(byKey.get('SEND_EMAIL')?.error).toBeUndefined()
  })

  it('surfaces BLOCKED as BLOCKED, with its reason', async () => {
    seedRun({
      id: 'run_blocked',
      organizationId: ACME,
      status: 'BLOCKED',
      leadId: 'lead_acme',
      steps: [
        { step: 'SEND_EMAIL', status: 'BLOCKED', errorCode: 'email_provider_not_configured' },
      ],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_blocked', NOW)

    expect(run?.status).toBe('BLOCKED')
    expect(run?.outcomeLabel).toBe('Blocked — configuration required')
    expect(run?.currentStepLabel).toBe('Send Email (blocked)')
  })

  it('surfaces FAILED with its attempts and persisted message', async () => {
    seedRun({
      id: 'run_failed',
      organizationId: ACME,
      status: 'FAILED',
      leadId: 'lead_acme',
      steps: [
        {
          step: 'ENRICH',
          status: 'FAILED',
          attempts: 3,
          errorCode: 'provider_failed',
          errorMessage: 'Could not reach Prospeo',
        },
      ],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_failed', NOW)
    const enrich = run?.steps.find((step) => step.key === 'ENRICH')

    expect(run?.status).toBe('FAILED')
    expect(enrich?.error).toEqual({ message: 'Could not reach Prospeo', attempts: 3 })
    expect(run?.currentStepLabel).toBe('Enrich Lead (failed)')
    expect(run?.outcomeLabel).toBe('Failed at Enrich Lead')
  })

  it('names the running step as the current step', async () => {
    seedRun({
      id: 'run_running',
      organizationId: ACME,
      status: 'RUNNING',
      leadId: 'lead_acme',
      steps: [
        { step: 'ENRICH', status: 'SUCCEEDED' },
        { step: 'AI_QUALIFY', status: 'RUNNING' },
      ],
    })
    const { getWorkflowRunDetail } = await service()

    expect((await getWorkflowRunDetail('run_running', NOW))?.currentStepLabel).toBe(
      'AI Qualification',
    )
  })

  it('reports a succeeded run whose email was skipped as such', async () => {
    seedRun({
      id: 'run_unqualified',
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      steps: [{ step: 'SEND_EMAIL', status: 'SKIPPED', errorCode: 'below_threshold' }],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_unqualified', NOW)

    expect(run?.outcomeLabel).toBe('Success (email skipped)')
    expect(run?.currentStepLabel).toBe('Completed')
  })

  it('derives log entries only from real step rows', async () => {
    seedRun({
      id: 'run_logs',
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      steps: [{ step: 'ENRICH', status: 'SUCCEEDED' }],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_logs', NOW)

    // One executed step -> exactly one entry. Nothing invented.
    expect(run?.logs).toHaveLength(1)
    expect(run?.logs[0]?.message).toContain('Enrich Lead')
  })
})

describe('AI output is surfaced, not just the score', () => {
  const AI_OUTPUT = {
    model: 'gpt-5',
    score: 65,
    summary: 'Strong fit and stated intent, but the email domain looks test-like.',
    keywords: ['logistics', 'salesforce-replacement'],
    recommendedAction: 'Verify the contact, then book a demo this week.',
    promptVersion: 'lead-qualification-v2',
    tokenUsage: 2385,
    inputTokens: 728,
    outputTokens: 1657,
  }

  function seedScoredRun(id: string) {
    seedRun({
      id,
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      steps: [{ step: 'AI_QUALIFY', status: 'SUCCEEDED', output: AI_OUTPUT }],
    })
  }

  it('exposes the summary, recommended action and keywords on the AI step', async () => {
    seedScoredRun('run_ai')
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_ai', NOW)
    const aiStep = run?.steps.find((step) => step.key === 'AI_QUALIFY')

    expect(aiStep?.aiResult).toEqual({
      summary: 'Strong fit and stated intent, but the email domain looks test-like.',
      recommendedAction: 'Verify the contact, then book a demo this week.',
      keywords: ['logistics', 'salesforce-replacement'],
    })
  })

  it('still exposes the score alongside the reasoning', async () => {
    seedScoredRun('run_ai_score')
    const { getWorkflowRunDetail } = await service()
    const aiStep = (await getWorkflowRunDetail('run_ai_score', NOW))?.steps.find(
      (step) => step.key === 'AI_QUALIFY',
    )

    expect(aiStep?.score).toEqual({ value: 91, threshold: 70, qualified: true })
  })

  it('exposes model, prompt version and token cost as run telemetry', async () => {
    seedScoredRun('run_ai_tel')
    const { getWorkflowRunDetail } = await service()

    expect((await getWorkflowRunDetail('run_ai_tel', NOW))?.aiTelemetry).toEqual({
      model: 'gpt-5',
      promptVersion: 'lead-qualification-v2',
      totalTokens: 2385,
      inputTokens: 728,
      outputTokens: 1657,
    })
  })

  it('reports no telemetry and no reasoning when the AI step never succeeded', async () => {
    seedRun({
      id: 'run_ai_failed',
      organizationId: ACME,
      status: 'FAILED',
      leadId: 'lead_acme',
      steps: [{ step: 'AI_QUALIFY', status: 'FAILED', errorCode: 'ai_output_malformed' }],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_ai_failed', NOW)

    expect(run?.aiTelemetry).toBeNull()
    expect(run?.steps.find((step) => step.key === 'AI_QUALIFY')?.aiResult).toBeUndefined()
  })

  it('ignores a stored output that no longer parses, rather than rendering it raw', async () => {
    seedRun({
      id: 'run_ai_legacy',
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      steps: [{ step: 'AI_QUALIFY', status: 'SUCCEEDED', output: { score: 'not-a-number' } }],
    })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_ai_legacy', NOW)

    // Re-read through the same validation boundary the engine wrote it with,
    // so a legacy or hand-edited row cannot put an unexpected shape on screen.
    expect(run?.steps.find((step) => step.key === 'AI_QUALIFY')?.aiResult).toBeUndefined()
    expect(run?.aiTelemetry).toBeNull()
  })
})

describe('form message on the run', () => {
  it('exposes the prospect message on the run view', async () => {
    seedRun({ id: 'run_msg', organizationId: ACME, status: 'SUCCEEDED', leadId: 'lead_acme' })
    const { getWorkflowRunDetail } = await service()

    expect((await getWorkflowRunDetail('run_msg', NOW))?.formMessage).toBe(
      'We need this before Q1.',
    )
  })

  it('exposes null when the prospect wrote nothing', async () => {
    state.organizationId = GLOBEX
    seedRun({ id: 'run_none', organizationId: GLOBEX, status: 'SUCCEEDED', leadId: 'lead_globex' })
    const { getWorkflowRunDetail } = await service()

    // Distinct from an empty string: nothing was stated.
    expect((await getWorkflowRunDetail('run_none', NOW))?.formMessage).toBeNull()
  })

  it('keeps the message out of the right-aligned input rows', async () => {
    seedRun({ id: 'run_rows', organizationId: ACME, status: 'SUCCEEDED', leadId: 'lead_acme' })
    const { getWorkflowRunDetail } = await service()
    const run = await getWorkflowRunDetail('run_rows', NOW)

    // It gets its own full-width block; a summary row would truncate it.
    expect(run?.input.map((entry) => entry.label)).toEqual(['Name', 'Email', 'Company', 'Trigger'])
  })
})

describe('lead automation status', () => {
  it('returns the latest run plus the real qualification', async () => {
    seedRun({
      id: 'old',
      organizationId: ACME,
      status: 'FAILED',
      leadId: 'lead_acme',
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
    })
    seedRun({
      id: 'latest',
      organizationId: ACME,
      status: 'SUCCEEDED',
      leadId: 'lead_acme',
      createdAt: new Date('2026-09-02T10:00:00.000Z'),
    })

    const { getLeadAutomationStatus } = await service()
    const status = await getLeadAutomationStatus('lead_acme', NOW)

    expect(status?.latestRun?.id).toBe('latest')
    expect(status?.qualification).toMatchObject({ aiScore: 91, outcome: 'QUALIFIED', source: 'AI' })
  })

  it('reports no run for a lead that never enrolled', async () => {
    const { getLeadAutomationStatus } = await service()
    const status = await getLeadAutomationStatus('lead_acme', NOW)

    // Distinct from a failed run: there is simply nothing.
    expect(status).not.toBeNull()
    expect(status?.latestRun).toBeNull()
  })

  it('does not expose a soft-deleted lead', async () => {
    const { getLeadAutomationStatus } = await service()
    expect(await getLeadAutomationStatus('lead_deleted', NOW)).toBeNull()
  })

  it('does not expose a lead from another organization', async () => {
    const { getLeadAutomationStatus } = await service()
    expect(await getLeadAutomationStatus('lead_globex', NOW)).toBeNull()
  })
})
