/**
 * Phase 2.0 mock data — UX validation only.
 *
 * Nothing here touches the database, Inngest, or any provider: every value is a
 * hand-written sample so the Automation screens can be reviewed before the
 * pipeline engine is built (docs/roadmap.md, Phase 2).
 *
 * Shapes deliberately mirror the eventual `WorkflowRun` / `WorkflowRunStep`
 * records described in docs/architecture.md §5, and the derived step states
 * follow the documented pipeline rules (score < 70 → email skipped; AI failure
 * → downstream steps not executed), so swapping this module for real reads is a
 * mechanical change rather than a redesign.
 */

export type WorkflowStatus = 'ACTIVE' | 'PAUSED' | 'DRAFT'
export type RunStatus = 'COMPLETED' | 'RUNNING' | 'FAILED'
export type StepState = 'COMPLETED' | 'IN_PROGRESS' | 'PENDING' | 'FAILED' | 'SKIPPED'

/** AI score at or above this qualifies the lead; below it, outreach is skipped. */
export const QUALIFICATION_THRESHOLD = 70

export const AUTOMATION_RUNS_PAGE_SIZE = 8

export type PipelineStepKey =
  | 'new_lead'
  | 'enrich'
  | 'ai_qualification'
  | 'score_tag'
  | 'add_to_crm'
  | 'send_email'
  | 'notify_team'

export type PipelineStep = {
  key: PipelineStepKey
  /** 1-based position in the fixed pipeline. */
  order: number
  name: string
  /** Secondary line: what the step does. */
  detail: string
}

/** The fixed MVP pipeline. Not user-editable — see docs/architecture.md §10. */
export const PIPELINE_STEPS: readonly PipelineStep[] = [
  { key: 'new_lead', order: 1, name: 'New Lead', detail: 'Trigger: Website Form' },
  { key: 'enrich', order: 2, name: 'Enrich Lead', detail: 'Enrichment' },
  { key: 'ai_qualification', order: 3, name: 'AI Qualification', detail: 'Score & Qualification' },
  { key: 'score_tag', order: 4, name: 'Score & Tag', detail: 'Score & Lead Tags' },
  { key: 'add_to_crm', order: 5, name: 'Add to CRM', detail: 'Create/Update Lead' },
  { key: 'send_email', order: 6, name: 'Send Email', detail: 'Outreach Email' },
  { key: 'notify_team', order: 7, name: 'Notify Team', detail: 'Internal Notification' },
] as const

/** `new_lead` is the trigger, so a run's step list starts at `enrich`. */
export const EXECUTED_STEPS = PIPELINE_STEPS.filter((step) => step.key !== 'new_lead')

/** Sample per-step durations, so every run reads consistently. */
const STEP_DURATIONS: Record<PipelineStepKey, string> = {
  new_lead: '—',
  enrich: '1m 12s',
  ai_qualification: '28s',
  score_tag: '8s',
  add_to_crm: '15s',
  send_email: '4s',
  notify_team: '2s',
}

export type RunStep = {
  key: PipelineStepKey
  order: number
  name: string
  detail: string
  state: StepState
  /** Right-hand duration, or null while a step has not produced one. */
  duration: string | null
  /** Short reason shown beside a non-completed state ("Not qualified", "Blocked"). */
  note?: string
  /** Full explanation for a skipped step, so SKIPPED is never ambiguous. */
  reason?: string
  /** AI qualification result callout. */
  score?: { value: number; threshold: number; qualified: boolean }
  /** Failure callout. */
  error?: { message: string; attempts: number }
}

export type LogEntry = {
  time: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export type WorkflowRun = {
  id: string
  /** Display reference, e.g. "#1256". */
  reference: string
  lead: { name: string; email: string; company: string }
  status: RunStatus
  /** One-line outcome for the run summary, e.g. "Success (Email Skipped)". */
  outcomeLabel: string
  trigger: string
  version: string
  enrolledAtLabel: string
  startedLabel: string
  /** Backs the date-range filter on the Runs list. */
  startedDaysAgo: number
  durationLabel: string
  /** "Current Step" column: the running step, the failing step, or "Completed". */
  currentStepLabel: string
  completedAtLabel: string | null
  aiScore: number | null
  steps: RunStep[]
  input: Array<{ label: string; value: string }>
  logs: LogEntry[]
}

type RunOutcome = 'QUALIFIED' | 'UNQUALIFIED' | 'RUNNING' | 'AI_FAILED'

type RunSeed = {
  id: string
  reference: string
  lead: { name: string; email: string; company: string }
  outcome: RunOutcome
  aiScore: number | null
  startedLabel: string
  startedDaysAgo: number
  durationLabel: string
  enrolledAtLabel: string
  completedAtLabel: string | null
  /** Only for a RUNNING seed: the step currently executing. */
  runningStepKey?: PipelineStepKey
}

const RUN_SEEDS: readonly RunSeed[] = [
  {
    id: 'run-1256',
    reference: '#1256',
    lead: { name: 'John Smith', email: 'john.smith@acme.com', company: 'Acme Corp' },
    outcome: 'RUNNING',
    aiScore: 82,
    startedLabel: '2m ago',
    startedDaysAgo: 0,
    durationLabel: '2m 34s',
    enrolledAtLabel: 'Sep 1, 2026 10:30 AM',
    completedAtLabel: null,
    runningStepKey: 'send_email',
  },
  {
    id: 'run-1255',
    reference: '#1255',
    lead: { name: 'Mary Johnson', email: 'mary.johnson@techflow.io', company: 'TechFlow' },
    outcome: 'RUNNING',
    aiScore: null,
    startedLabel: '5m ago',
    startedDaysAgo: 0,
    durationLabel: '1m 20s',
    enrolledAtLabel: 'Sep 1, 2026 10:27 AM',
    completedAtLabel: null,
    runningStepKey: 'ai_qualification',
  },
  {
    id: 'run-1241',
    reference: '#1241',
    lead: { name: 'Robert Brown', email: 'robert.brown@innovate.com', company: 'Innovate Ltd' },
    outcome: 'AI_FAILED',
    aiScore: null,
    startedLabel: '12m ago',
    startedDaysAgo: 0,
    durationLabel: '3m 12s',
    enrolledAtLabel: 'Sep 1, 2026 10:20 AM',
    completedAtLabel: null,
  },
  {
    id: 'run-1240',
    reference: '#1240',
    lead: { name: 'Emily Martinez', email: 'emily@globalscale.co', company: 'GlobalScale' },
    outcome: 'QUALIFIED',
    aiScore: 88,
    startedLabel: '18m ago',
    startedDaysAgo: 0,
    durationLabel: '2m 01s',
    enrolledAtLabel: 'Sep 1, 2026 10:14 AM',
    completedAtLabel: 'Sep 1, 2026 10:16 AM',
  },
  {
    id: 'run-1238',
    reference: '#1238',
    lead: { name: 'David Thompson', email: 'david@nextgen.com', company: 'NextGen Systems' },
    outcome: 'QUALIFIED',
    aiScore: 74,
    startedLabel: '25m ago',
    startedDaysAgo: 0,
    durationLabel: '1m 45s',
    enrolledAtLabel: 'Sep 1, 2026 10:07 AM',
    completedAtLabel: 'Sep 1, 2026 10:09 AM',
  },
  {
    id: 'run-1235',
    reference: '#1235',
    lead: { name: 'Laura White', email: 'laura@brightcore.com', company: 'BrightCore' },
    outcome: 'QUALIFIED',
    aiScore: 91,
    startedLabel: '32m ago',
    startedDaysAgo: 0,
    durationLabel: '2m 21s',
    enrolledAtLabel: 'Sep 1, 2026 10:00 AM',
    completedAtLabel: 'Sep 1, 2026 10:02 AM',
  },
  {
    id: 'run-1250',
    reference: '#1250',
    lead: { name: 'Michael Johnson', email: 'michael.johnson@sample.com', company: 'Sample Inc' },
    outcome: 'UNQUALIFIED',
    aiScore: 42,
    startedLabel: '1h ago',
    startedDaysAgo: 0,
    durationLabel: '1m 08s',
    enrolledAtLabel: 'Sep 1, 2026 09:32 AM',
    completedAtLabel: 'Sep 1, 2026 09:33 AM',
  },
  {
    id: 'run-1231',
    reference: '#1231',
    lead: { name: 'Sophie Davis', email: 'sophie@capitalline.com', company: 'CapitalLine' },
    outcome: 'QUALIFIED',
    aiScore: 79,
    startedLabel: '1h ago',
    startedDaysAgo: 0,
    durationLabel: '1m 58s',
    enrolledAtLabel: 'Sep 1, 2026 09:24 AM',
    completedAtLabel: 'Sep 1, 2026 09:26 AM',
  },
  {
    id: 'run-1226',
    reference: '#1226',
    lead: { name: 'Daniel Lee', email: 'daniel.lee@northwind.io', company: 'Northwind' },
    outcome: 'QUALIFIED',
    aiScore: 85,
    startedLabel: '3h ago',
    startedDaysAgo: 0,
    durationLabel: '2m 12s',
    enrolledAtLabel: 'Sep 1, 2026 07:41 AM',
    completedAtLabel: 'Sep 1, 2026 07:43 AM',
  },
  {
    id: 'run-1198',
    reference: '#1198',
    lead: { name: 'John Smith', email: 'john.smith@acme.com', company: 'Acme Corp' },
    outcome: 'QUALIFIED',
    aiScore: 82,
    startedLabel: '4h ago',
    startedDaysAgo: 0,
    durationLabel: '2m 09s',
    enrolledAtLabel: 'Sep 1, 2026 06:30 AM',
    completedAtLabel: 'Sep 1, 2026 06:32 AM',
  },
  {
    id: 'run-1190',
    reference: '#1190',
    lead: { name: 'Priya Nair', email: 'priya@lumenworks.com', company: 'Lumen Works' },
    outcome: 'UNQUALIFIED',
    aiScore: 51,
    startedLabel: '6h ago',
    startedDaysAgo: 0,
    durationLabel: '1m 14s',
    enrolledAtLabel: 'Sep 1, 2026 04:52 AM',
    completedAtLabel: 'Sep 1, 2026 04:53 AM',
  },
  {
    id: 'run-1184',
    reference: '#1184',
    lead: { name: 'Tom Becker', email: 'tom.becker@orbitalq.com', company: 'Orbital Q' },
    outcome: 'QUALIFIED',
    aiScore: 77,
    startedLabel: '1d ago',
    startedDaysAgo: 1,
    durationLabel: '2m 03s',
    enrolledAtLabel: 'Aug 31, 2026 03:18 PM',
    completedAtLabel: 'Aug 31, 2026 03:20 PM',
  },
  {
    id: 'run-1179',
    reference: '#1179',
    lead: { name: 'Anna Kowalski', email: 'anna@vertexpay.eu', company: 'VertexPay' },
    outcome: 'AI_FAILED',
    aiScore: null,
    startedLabel: '1d ago',
    startedDaysAgo: 1,
    durationLabel: '3m 40s',
    enrolledAtLabel: 'Aug 31, 2026 11:05 AM',
    completedAtLabel: null,
  },
  {
    id: 'run-1172',
    reference: '#1172',
    lead: { name: 'Chris Bennett', email: 'chris@fieldstone.co', company: 'Fieldstone' },
    outcome: 'QUALIFIED',
    aiScore: 83,
    startedLabel: '2d ago',
    startedDaysAgo: 2,
    durationLabel: '1m 52s',
    enrolledAtLabel: 'Aug 30, 2026 02:44 PM',
    completedAtLabel: 'Aug 30, 2026 02:46 PM',
  },
  {
    id: 'run-1168',
    reference: '#1168',
    lead: { name: 'Grace Oduya', email: 'grace@harborlight.io', company: 'Harborlight' },
    outcome: 'QUALIFIED',
    aiScore: 95,
    startedLabel: '2d ago',
    startedDaysAgo: 2,
    durationLabel: '2m 27s',
    enrolledAtLabel: 'Aug 30, 2026 09:12 AM',
    completedAtLabel: 'Aug 30, 2026 09:14 AM',
  },
  {
    id: 'run-1160',
    reference: '#1160',
    lead: { name: 'Victor Alonso', email: 'victor@quantabuild.com', company: 'QuantaBuild' },
    outcome: 'UNQUALIFIED',
    aiScore: 38,
    startedLabel: '4d ago',
    startedDaysAgo: 4,
    durationLabel: '1m 05s',
    enrolledAtLabel: 'Aug 28, 2026 04:31 PM',
    completedAtLabel: 'Aug 28, 2026 04:32 PM',
  },
  {
    id: 'run-1151',
    reference: '#1151',
    lead: { name: 'Hannah Cole', email: 'hannah@driftwave.app', company: 'Driftwave' },
    outcome: 'QUALIFIED',
    aiScore: 72,
    startedLabel: '5d ago',
    startedDaysAgo: 5,
    durationLabel: '2m 16s',
    enrolledAtLabel: 'Aug 27, 2026 10:08 AM',
    completedAtLabel: 'Aug 27, 2026 10:10 AM',
  },
  {
    id: 'run-1144',
    reference: '#1144',
    lead: { name: 'Owen Fitzgerald', email: 'owen@arcadiagrp.com', company: 'Arcadia Group' },
    outcome: 'QUALIFIED',
    aiScore: 89,
    startedLabel: '9d ago',
    startedDaysAgo: 9,
    durationLabel: '1m 49s',
    enrolledAtLabel: 'Aug 23, 2026 01:22 PM',
    completedAtLabel: 'Aug 23, 2026 01:24 PM',
  },
  {
    id: 'run-1132',
    reference: '#1132',
    lead: { name: 'Yuki Tanaka', email: 'yuki@sakuralabs.jp', company: 'Sakura Labs' },
    outcome: 'UNQUALIFIED',
    aiScore: 61,
    startedLabel: '12d ago',
    startedDaysAgo: 12,
    durationLabel: '1m 11s',
    enrolledAtLabel: 'Aug 20, 2026 08:47 AM',
    completedAtLabel: 'Aug 20, 2026 08:48 AM',
  },
  {
    id: 'run-1120',
    reference: '#1120',
    lead: { name: 'Marcus Reid', email: 'marcus@stonebridge.co', company: 'Stonebridge' },
    outcome: 'QUALIFIED',
    aiScore: 80,
    startedLabel: '21d ago',
    startedDaysAgo: 21,
    durationLabel: '2m 05s',
    enrolledAtLabel: 'Aug 11, 2026 11:36 AM',
    completedAtLabel: 'Aug 11, 2026 11:38 AM',
  },
]

function statusFor(outcome: RunOutcome): RunStatus {
  if (outcome === 'RUNNING') return 'RUNNING'
  if (outcome === 'AI_FAILED') return 'FAILED'
  return 'COMPLETED'
}

function outcomeLabelFor(outcome: RunOutcome): string {
  switch (outcome) {
    case 'RUNNING':
      return 'In progress'
    case 'AI_FAILED':
      return 'Failed'
    case 'UNQUALIFIED':
      return 'Success (Email Skipped)'
    case 'QUALIFIED':
      return 'Success'
  }
}

/**
 * Derives a run's per-step states from its outcome, applying the documented
 * pipeline rules so no sample can contradict them:
 *
 * - qualified (score ≥ 70): every step completes.
 * - unqualified (score < 70): Send Email and Notify Team are SKIPPED, and the
 *   run still succeeds — skipped is not failed.
 * - AI failure: the AI step fails after its retries and no later step executes,
 *   so no email is ever sent.
 */
function buildSteps(seed: RunSeed): RunStep[] {
  const runningIndex = seed.runningStepKey
    ? EXECUTED_STEPS.findIndex((step) => step.key === seed.runningStepKey)
    : -1

  return EXECUTED_STEPS.map((step, index) => {
    const base = {
      key: step.key,
      order: index + 1,
      name: step.name,
      detail: step.detail,
    }

    if (seed.outcome === 'AI_FAILED') {
      if (step.key === 'enrich') {
        return { ...base, state: 'COMPLETED' as const, duration: STEP_DURATIONS.enrich }
      }
      if (step.key === 'ai_qualification') {
        return {
          ...base,
          state: 'FAILED' as const,
          duration: '3m 45s',
          error: { message: 'AI provider unavailable', attempts: 3 },
        }
      }
      return {
        ...base,
        state: 'SKIPPED' as const,
        duration: null,
        note: 'Blocked',
        ...(step.key === 'send_email'
          ? { reason: 'Not executed — AI Qualification failed, so no email was sent.' }
          : {}),
      }
    }

    if (seed.outcome === 'RUNNING') {
      if (index < runningIndex) {
        return { ...base, state: 'COMPLETED' as const, duration: STEP_DURATIONS[step.key] }
      }
      if (index === runningIndex) {
        return { ...base, state: 'IN_PROGRESS' as const, duration: null, note: 'Running…' }
      }
      return { ...base, state: 'PENDING' as const, duration: null, note: 'Waiting' }
    }

    const qualified = seed.outcome === 'QUALIFIED'

    if (!qualified && (step.key === 'send_email' || step.key === 'notify_team')) {
      return {
        ...base,
        state: 'SKIPPED' as const,
        duration: null,
        note: 'Not qualified',
        ...(step.key === 'send_email'
          ? {
              reason: `Reason: Lead did not meet qualification threshold (${QUALIFICATION_THRESHOLD}). No email was sent.`,
            }
          : {}),
      }
    }

    return {
      ...base,
      state: 'COMPLETED' as const,
      duration: STEP_DURATIONS[step.key],
      ...(step.key === 'ai_qualification' && seed.aiScore !== null
        ? {
            score: {
              value: seed.aiScore,
              threshold: QUALIFICATION_THRESHOLD,
              qualified,
            },
          }
        : {}),
    }
  })
}

function buildInput(seed: RunSeed): Array<{ label: string; value: string }> {
  return [
    { label: 'Name', value: seed.lead.name },
    { label: 'Email', value: seed.lead.email },
    { label: 'Company', value: seed.lead.company },
    { label: 'Source', value: 'Website Form' },
    { label: 'Form', value: 'Request a demo' },
    { label: 'Message', value: 'Interested in automating our inbound lead follow-up.' },
    { label: 'Submitted At', value: seed.enrolledAtLabel },
  ]
}

function buildLogs(seed: RunSeed, steps: RunStep[]): LogEntry[] {
  const logs: LogEntry[] = [
    {
      time: seed.enrolledAtLabel,
      level: 'info',
      message: `Run ${seed.reference} enrolled from Website Form`,
    },
  ]

  for (const step of steps) {
    if (step.state === 'COMPLETED') {
      logs.push({
        time: seed.enrolledAtLabel,
        level: 'info',
        message: `${step.name} completed in ${step.duration}`,
      })
    }
    if (step.state === 'IN_PROGRESS') {
      logs.push({ time: seed.enrolledAtLabel, level: 'info', message: `${step.name} started` })
    }
    if (step.state === 'SKIPPED') {
      logs.push({
        time: seed.enrolledAtLabel,
        level: 'warn',
        message: `${step.name} skipped — ${step.note}`,
      })
    }
    if (step.state === 'FAILED') {
      logs.push({
        time: seed.enrolledAtLabel,
        level: 'error',
        message: `${step.name} failed after ${step.error?.attempts} attempts — ${step.error?.message}`,
      })
    }
  }

  return logs
}

function currentStepLabel(seed: RunSeed, steps: RunStep[]): string {
  if (seed.outcome === 'RUNNING') {
    return steps.find((step) => step.state === 'IN_PROGRESS')?.name ?? 'Running'
  }
  if (seed.outcome === 'AI_FAILED') {
    return steps.find((step) => step.state === 'FAILED')?.name ?? 'Failed'
  }
  return 'Completed'
}

function toRun(seed: RunSeed): WorkflowRun {
  const steps = buildSteps(seed)

  return {
    id: seed.id,
    reference: seed.reference,
    lead: seed.lead,
    status: statusFor(seed.outcome),
    outcomeLabel: outcomeLabelFor(seed.outcome),
    trigger: 'Website Form',
    version: '1.0.0',
    enrolledAtLabel: seed.enrolledAtLabel,
    startedLabel: seed.startedLabel,
    startedDaysAgo: seed.startedDaysAgo,
    durationLabel: seed.durationLabel,
    currentStepLabel: currentStepLabel(seed, steps),
    completedAtLabel: seed.completedAtLabel,
    aiScore: seed.aiScore,
    steps,
    input: buildInput(seed),
    logs: buildLogs(seed, steps),
  }
}

export const MOCK_RUNS: readonly WorkflowRun[] = RUN_SEEDS.map(toRun)

export function getMockRun(runId: string): WorkflowRun | undefined {
  return MOCK_RUNS.find((run) => run.id === runId)
}

/**
 * The completed run shown on the Lead detail Automation tab. Lead detail is
 * driven by real records, so this sample is labelled as preview data in the UI.
 */
export const LEAD_AUTOMATION_RUN_ID = 'run-1198'

/** Seven-day success-rate trend for the workflow's success card. */
export const SUCCESS_RATE_SERIES: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'May 23', value: 88 },
  { label: 'May 24', value: 90 },
  { label: 'May 25', value: 86 },
  { label: 'May 26', value: 92 },
  { label: 'May 27', value: 91 },
  { label: 'May 28', value: 93 },
  { label: 'May 29', value: 94 },
]

export const MVP_WORKFLOW = {
  id: 'ai-lead-qualification-pipeline',
  name: 'AI Lead Qualification Pipeline',
  description: 'Automatically qualify new leads and engage sales.',
  status: 'ACTIVE' as WorkflowStatus,
  trigger: 'Website Form',
  version: '1.0.0',
  runs7d: '1,248',
  successRate: 94,
  successRateTrendLabel: '8% vs last 7 days',
  lastRunLabel: '2 minutes ago',
  lastRunStatus: 'COMPLETED' as RunStatus,
  stats: [
    { label: 'Total Runs', value: '1,248' },
    { label: 'Completed', value: '1,171' },
    { label: 'Failed', value: '18' },
    { label: 'Running', value: '156' },
    { label: 'Paused', value: '0' },
  ],
} as const

export type KpiTone = 'primary' | 'success' | 'running' | 'failed'

export type Kpi = {
  key: string
  label: string
  value: string
  tone: KpiTone
  trend: { direction: 'up' | 'down'; label: string; positive: boolean }
}

export const AUTOMATION_KPIS: readonly Kpi[] = [
  {
    key: 'total-runs',
    label: 'Total Runs',
    value: '1,248',
    tone: 'primary',
    trend: { direction: 'up', label: '12% vs last 7 days', positive: true },
  },
  {
    key: 'success-rate',
    label: 'Success Rate',
    value: '94%',
    tone: 'success',
    trend: { direction: 'up', label: '8% vs last 7 days', positive: true },
  },
  {
    key: 'running',
    label: 'Running',
    value: '156',
    tone: 'running',
    trend: { direction: 'up', label: '5 vs last 7 days', positive: true },
  },
  {
    key: 'failed',
    label: 'Failed',
    value: '18',
    tone: 'failed',
    trend: { direction: 'down', label: '3 vs last 7 days', positive: true },
  },
]
