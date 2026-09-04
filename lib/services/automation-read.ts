import 'server-only'

import type { Prisma, WorkflowStepKind } from '@prisma/client'

import { requireCapability } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { QUALIFICATION_THRESHOLD } from '@/lib/automation/pipeline'
import { parseAiQualificationOutput } from '@/lib/validation/automation-ai'
import {
  absoluteTime,
  currentStepLabel,
  daysSince,
  durationLabel,
  outcomeLabel,
  PIPELINE_STEP_VIEWS,
  relativeTime,
  runReference,
  type AiTelemetryView,
  type Kpi,
  type LogEntryView,
  type RunStepView,
  type WorkflowRunView,
  type WorkflowSummaryView,
} from '@/lib/automation/view-model'

/**
 * Read services for the Automation screens (Phase 2G).
 *
 * Every function here gates on `requireCapability('automation:manage')`
 * against the session before reading anything.
 *
 * Read-only by construction: nothing in this module writes.
 */

const RUNS_WINDOW_DAYS = 7
const RECENT_RUNS_LIMIT = 200

function windowStart(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000)
}

/** The one fixed workflow, or null when no lead has ever been captured. */
async function findWorkflow(db: Pick<typeof prisma, 'workflow'>) {
  return db.workflow.findFirst({
    where: { type: 'LEAD_QUALIFICATION' },
    select: { id: true, status: true, version: true, createdAt: true, notifyTeamEnabled: true },
  })
}

const RUN_WITH_LEAD_SELECT = {
  id: true,
  status: true,
  trigger: true,
  version: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  lead: {
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      formMessage: true,
      aiScore: true,
    },
  },
  stepRuns: {
    select: {
      step: true,
      status: true,
      attempts: true,
      startedAt: true,
      completedAt: true,
      output: true,
      errorCode: true,
      errorMessage: true,
    },
  },
} satisfies Prisma.WorkflowRunSelect

type RunWithLead = Prisma.WorkflowRunGetPayload<{ select: typeof RUN_WITH_LEAD_SELECT }>

/**
 * Build the five fixed step rows for a run.
 *
 * Always five, in `PIPELINE_STEPS` order, whether or not the engine has
 * reached them: a step with no row yet is PENDING, which is what "not
 * started" means. Statuses are passed through untouched — SKIPPED stays
 * SKIPPED, BLOCKED stays BLOCKED.
 *
 * A run created before ADD_TO_CRM was removed from the pipeline may still
 * carry an `ADD_TO_CRM` `WorkflowStepRun` row in the database — nothing
 * deletes it — but it is not one of the five keys `PIPELINE_STEP_VIEWS`
 * iterates, so it does not appear here. That row stays intact and queryable
 * directly; it is simply outside what this fixed, current-pipeline view
 * renders. Every OTHER field on such a run (status, the five current steps,
 * AI output, logs) is unaffected — see tests/unit/automation-read.test.ts.
 */
/**
 * Re-read the persisted AI output through the SAME validation boundary the
 * engine used to write it (lib/validation/automation-ai.ts).
 *
 * Reusing it rather than trusting the stored JSON means a row written by an
 * older prompt version, or hand-edited, cannot put an unexpected shape on
 * screen — it simply yields null and the block is not rendered.
 */
function readAiOutput(run: RunWithLead) {
  const row = run.stepRuns.find((stepRun) => stepRun.step === 'AI_QUALIFY')
  if (!row || row.status !== 'SUCCEEDED') return null
  return parseAiQualificationOutput(row.output)
}

function toStepViews(run: RunWithLead): RunStepView[] {
  const byStep = new Map(run.stepRuns.map((stepRun) => [stepRun.step as WorkflowStepKind, stepRun]))

  return PIPELINE_STEP_VIEWS.map((step) => {
    const row = byStep.get(step.key)

    if (!row) {
      return { ...step, state: 'PENDING' as const, duration: null, attempts: 0 }
    }

    const view: RunStepView = {
      ...step,
      state: row.status,
      duration: durationLabel(row.startedAt, row.completedAt),
      attempts: row.attempts,
      ...(row.errorCode ? { note: row.errorCode } : {}),
    }

    if (row.status === 'FAILED') {
      view.error = {
        // Operator-facing message persisted by the engine. Provider payloads
        // and credentials never reach this column (see lib/automation/engine.ts).
        message: row.errorMessage ?? row.errorCode ?? 'Step failed',
        attempts: row.attempts,
      }
    }
    if (row.status === 'SKIPPED' || row.status === 'BLOCKED') {
      view.reason = row.errorCode ?? undefined
    }
    if (step.key === 'AI_QUALIFY' && row.status === 'SUCCEEDED') {
      if (run.lead.aiScore !== null) {
        view.score = {
          value: run.lead.aiScore,
          threshold: QUALIFICATION_THRESHOLD,
          qualified: run.lead.aiScore >= QUALIFICATION_THRESHOLD,
        }
      }
      const ai = readAiOutput(run)
      if (ai) {
        view.aiResult = {
          summary: ai.summary,
          recommendedAction: ai.recommendedAction,
          keywords: ai.keywords,
        }
      }
    }

    return view
  })
}

/**
 * An activity trail derived from the step rows themselves.
 *
 * There is no log table in Phase 2, and inventing entries would be worse than
 * showing fewer: every line below corresponds to a real persisted step
 * transition, with its real timestamp and its real reason code.
 */
function toLogEntries(steps: RunStepView[], run: RunWithLead): LogEntryView[] {
  const byStep = new Map(run.stepRuns.map((stepRun) => [stepRun.step, stepRun]))

  return steps
    .filter((step) => step.state !== 'PENDING')
    .map((step) => {
      const row = byStep.get(step.key)
      const at = row?.completedAt ?? row?.startedAt ?? null
      const level: LogEntryView['level'] =
        step.state === 'FAILED' ? 'error' : step.state === 'SUCCEEDED' ? 'info' : 'warn'
      const suffix = step.note ? ` (${step.note})` : ''

      return {
        time: absoluteTime(at),
        level,
        message: `${step.name}: ${step.state.toLowerCase()}${suffix}`,
      }
    })
}

function toRunView(run: RunWithLead, now: Date): WorkflowRunView {
  const steps = toStepViews(run)
  const ai = readAiOutput(run)
  const startedAt = run.startedAt ?? run.createdAt

  return {
    id: run.id,
    reference: runReference(run.id),
    lead: {
      id: run.lead.id,
      name: run.lead.name,
      email: run.lead.email,
      company: run.lead.company ?? '—',
    },
    status: run.status,
    outcomeLabel: outcomeLabel(run.status, steps),
    trigger: run.trigger === 'AUTOMATIC' ? 'Website Form' : 'Manual re-run',
    version: `v${run.version}`,
    enrolledAtLabel: absoluteTime(run.createdAt),
    startedLabel: relativeTime(startedAt, now),
    startedDaysAgo: daysSince(startedAt, now),
    durationLabel: durationLabel(run.startedAt, run.completedAt) ?? '—',
    currentStepLabel: currentStepLabel(run.status, steps),
    completedAtLabel: run.completedAt ? absoluteTime(run.completedAt) : null,
    aiScore: run.lead.aiScore,
    formMessage: run.lead.formMessage,
    aiTelemetry: ai
      ? ({
          model: ai.model ?? null,
          promptVersion: ai.promptVersion ?? null,
          totalTokens: ai.tokenUsage ?? null,
          inputTokens: ai.inputTokens ?? null,
          outputTokens: ai.outputTokens ?? null,
        } satisfies AiTelemetryView)
      : null,
    steps,
    input: [
      { label: 'Name', value: run.lead.name },
      { label: 'Email', value: run.lead.email },
      { label: 'Company', value: run.lead.company ?? '—' },
      { label: 'Trigger', value: run.trigger === 'AUTOMATIC' ? 'Website Form' : 'Manual re-run' },
    ],
    logs: toLogEntries(steps, run),
  }
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

export type AutomationOverview = {
  workflow: WorkflowSummaryView | null
  kpis: Kpi[]
}

/**
 * Headline metrics plus the single pipeline.
 *
 * Counts come from real aggregate queries. Where a figure cannot be computed
 * from stored data it is not shown at all rather than estimated — there is no
 * invented trend on this screen.
 */
export async function getAutomationOverview(now: Date = new Date()): Promise<AutomationOverview> {
  await requireCapability('automation:manage')

  // Transaction: these aggregates are shown side by side as one picture, so
  // they must be counted against a single snapshot.
  return prisma.$transaction(async (tx) => {
    const workflow = await findWorkflow(tx)
    if (!workflow) return { workflow: null, kpis: [] }

    const since = windowStart(RUNS_WINDOW_DAYS, now)

    // One grouped query for the whole-history breakdown, one for the window,
    // one for the latest run — no per-status round trips.
    const [byStatus, runsInWindow, lastRun, enrollments] = await Promise.all([
      tx.workflowRun.groupBy({ by: ['status'], _count: { _all: true } }),
      tx.workflowRun.count({ where: { createdAt: { gte: since } } }),
      tx.workflowRun.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true, startedAt: true },
      }),
      tx.workflowEnrollment.count(),
    ])

    const count = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0

    const succeeded = count('SUCCEEDED')
    const failed = count('FAILED')
    const blocked = count('BLOCKED')
    const running = count('RUNNING')
    const pending = count('PENDING')
    const total = succeeded + failed + blocked + running + pending
    const terminal = succeeded + failed + blocked
    const successRate = terminal === 0 ? 0 : Math.round((succeeded / terminal) * 100)

    return {
      workflow: {
        id: workflow.id,
        name: 'AI Lead Qualification Pipeline',
        description: 'Automatically qualify new leads and engage sales.',
        status: workflow.status,
        notifyTeamEnabled: workflow.notifyTeamEnabled,
        trigger: 'Website Form',
        version: `v${workflow.version}`,
        runsWindowLabel: String(runsInWindow),
        successRate,
        lastRunLabel: relativeTime(lastRun?.startedAt ?? lastRun?.createdAt ?? null, now),
        lastRunStatus: lastRun?.status ?? null,
        stats: [
          { label: 'Total Runs', value: String(total) },
          { label: 'Succeeded', value: String(succeeded) },
          { label: 'Failed', value: String(failed) },
          { label: 'Blocked', value: String(blocked) },
          { label: 'Running', value: String(running + pending) },
          { label: 'Enrollments', value: String(enrollments) },
        ],
      },
      kpis: [
        { key: 'total-runs', label: 'Total Runs', value: String(total), tone: 'primary' },
        { key: 'success-rate', label: 'Success Rate', value: `${successRate}%`, tone: 'success' },
        { key: 'running', label: 'Running', value: String(running + pending), tone: 'running' },
        { key: 'failed', label: 'Failed', value: String(failed + blocked), tone: 'failed' },
      ],
    }
  })
}

/** The pipeline screen: the real workflow plus its real fixed steps. */
export async function getWorkflowDetail(now: Date = new Date()) {
  const overview = await getAutomationOverview(now)
  return { workflow: overview.workflow, steps: PIPELINE_STEP_VIEWS }
}

/**
 * Runs for the list screen, newest first.
 *
 * Capped at `RECENT_RUNS_LIMIT`: the existing screen filters, searches and
 * paginates on the client, so this returns a bounded recent window rather
 * than inventing a server-side pagination API the UI does not ask for. The
 * lead and step rows come back through relations in ONE query — no N+1.
 */
export async function listWorkflowRuns(now: Date = new Date()): Promise<WorkflowRunView[]> {
  await requireCapability('automation:manage')

  const runs = await prisma.workflowRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: RECENT_RUNS_LIMIT,
    select: RUN_WITH_LEAD_SELECT,
  })

  return runs.map((run) => toRunView(run, now))
}

/** One run with its step rows, or null when it does not exist. */
export async function getWorkflowRunDetail(
  runId: string,
  now: Date = new Date(),
): Promise<WorkflowRunView | null> {
  await requireCapability('automation:manage')

  const run = await prisma.workflowRun.findFirst({
    where: { id: runId },
    select: RUN_WITH_LEAD_SELECT,
  })

  return run ? toRunView(run, now) : null
}

export type LeadAutomationStatus = {
  latestRun: WorkflowRunView | null
  qualification: {
    aiScore: number | null
    outcome: 'QUALIFIED' | 'UNQUALIFIED' | null
    source: 'AI' | 'HUMAN' | null
    updatedAtLabel: string | null
  }
} | null

/**
 * The Lead detail Automation tab.
 *
 * Returns null when the lead does not exist OR is soft-deleted — matching how
 * the rest of the Leads surface treats a deleted record.
 */
export async function getLeadAutomationStatus(
  leadId: string,
  now: Date = new Date(),
): Promise<LeadAutomationStatus> {
  await requireCapability('automation:manage')

  // Transaction: the lead and its latest run are rendered as one state.
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: {
        aiScore: true,
        qualificationOutcome: true,
        qualificationSource: true,
        qualificationUpdatedAt: true,
      },
    })
    if (!lead) return null

    const run = await tx.workflowRun.findFirst({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: RUN_WITH_LEAD_SELECT,
    })

    return {
      latestRun: run ? toRunView(run, now) : null,
      qualification: {
        aiScore: lead.aiScore,
        outcome: lead.qualificationOutcome,
        source: lead.qualificationSource,
        updatedAtLabel: lead.qualificationUpdatedAt
          ? relativeTime(lead.qualificationUpdatedAt, now)
          : null,
      },
    }
  })
}
