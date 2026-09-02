import type { WorkflowRunStatus, WorkflowStepKind, WorkflowStepRunStatus } from '@prisma/client'

import { PIPELINE_STEPS, QUALIFICATION_THRESHOLD } from '@/lib/automation/pipeline'

/**
 * View models for the Automation screens (Phase 2G).
 *
 * Pure shapes and pure formatting — no Prisma, no I/O — so the presentation
 * layer has one typed contract and the read services in
 * lib/services/automation-read.ts have one place to map into.
 *
 * The run and step statuses here are the DATABASE enums verbatim, not a
 * reduced UI vocabulary. That is deliberate: collapsing BLOCKED into FAILED,
 * or SKIPPED into either, would destroy exactly the distinctions the engine
 * works hard to record (docs/architecture.md §5) — "no email provider
 * configured" is not the same event as "the email provider rejected the
 * send", and an operator looking at this screen needs to tell them apart.
 */

export type RunStatus = WorkflowRunStatus
export type StepState = WorkflowStepRunStatus
export type WorkflowStatusView = 'ACTIVE' | 'PAUSED'

export { QUALIFICATION_THRESHOLD }

export const AUTOMATION_RUNS_PAGE_SIZE = 8

/** Human labels for the six fixed steps, in `PIPELINE_STEPS` order. */
const STEP_PRESENTATION: Record<WorkflowStepKind, { name: string; detail: string }> = {
  ENRICH: { name: 'Enrich Lead', detail: 'Enrichment' },
  AI_QUALIFY: { name: 'AI Qualification', detail: 'Score & Qualification' },
  SCORE_AND_TAG: { name: 'Score & Tag', detail: 'Score & Lead Tags' },
  ADD_TO_CRM: { name: 'Add to CRM', detail: 'Create/Update Lead' },
  SEND_EMAIL: { name: 'Send Email', detail: 'Outreach Email' },
  NOTIFY_TEAM: { name: 'Notify Team', detail: 'Internal Notification' },
}

export type PipelineStepView = {
  key: WorkflowStepKind
  /** 1-based position in the fixed pipeline. */
  order: number
  name: string
  detail: string
}

/**
 * The pipeline as displayed — derived from `PIPELINE_STEPS`, never re-listed.
 * Changing the engine's step order changes this screen automatically.
 */
export const PIPELINE_STEP_VIEWS: readonly PipelineStepView[] = PIPELINE_STEPS.map(
  (step, index) => ({
    key: step,
    order: index + 1,
    ...STEP_PRESENTATION[step],
  }),
)

/**
 * What the model actually wrote, as persisted on the AI_QUALIFY step.
 *
 * The score alone answers "how much"; only this answers "why". Every field is
 * LLM-generated prose derived from untrusted lead text, so it renders as text
 * and is never presented as a verified fact — the model hedges deliberately
 * ("contact CLAIMS to be VP"), and that hedge has to survive display.
 */
export type AiQualificationView = {
  summary: string
  recommendedAction: string
  keywords: string[]
}

/** Operator-facing attribution and cost. Never shown on the sales-facing lead panel. */
export type AiTelemetryView = {
  model: string | null
  promptVersion: string | null
  totalTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export type RunStepView = {
  key: WorkflowStepKind
  order: number
  name: string
  detail: string
  state: StepState
  /** Elapsed time, or null when the step has not produced one. */
  duration: string | null
  attempts: number
  /** Short reason beside a non-succeeded state — the persisted errorCode. */
  note?: string
  /** Operator-facing failure message, as persisted on the step row. */
  reason?: string
  score?: { value: number; threshold: number; qualified: boolean }
  /** Present only on a succeeded AI_QUALIFY step whose output still parses. */
  aiResult?: AiQualificationView
  error?: { message: string; attempts: number }
}

export type LogEntryView = {
  time: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export type RunLeadView = {
  id: string
  name: string
  email: string
  company: string
}

export type WorkflowRunView = {
  id: string
  /** Short display reference derived from the run id — never a fabricated number. */
  reference: string
  lead: RunLeadView
  status: RunStatus
  outcomeLabel: string
  trigger: string
  version: string
  enrolledAtLabel: string
  startedLabel: string
  /** Backs the date-range filter on the Runs list. */
  startedDaysAgo: number
  durationLabel: string
  currentStepLabel: string
  completedAtLabel: string | null
  aiScore: number | null
  /**
   * What the prospect wrote on the form, or null. A dedicated field rather
   * than an `input` row: it is free text of arbitrary length and needs a
   * full-width block, not a right-aligned summary value.
   */
  formMessage: string | null
  /** Null when the run never produced a readable AI result. */
  aiTelemetry: AiTelemetryView | null
  steps: RunStepView[]
  input: Array<{ label: string; value: string }>
  logs: LogEntryView[]
}

export type WorkflowSummaryView = {
  id: string
  name: string
  description: string
  status: WorkflowStatusView
  trigger: string
  version: string
  runsWindowLabel: string
  successRate: number
  lastRunLabel: string
  lastRunStatus: RunStatus | null
  stats: Array<{ label: string; value: string }>
}

export type KpiTone = 'primary' | 'success' | 'running' | 'failed'

export type Kpi = {
  key: string
  label: string
  value: string
  tone: KpiTone
  trend?: { direction: 'up' | 'down'; label: string; positive: boolean }
}

// ---------------------------------------------------------------------------
// Formatting helpers — shared so every screen renders a timestamp identically.
// ---------------------------------------------------------------------------

export function relativeTime(date: Date | null, now: Date = new Date()): string {
  if (!date) return '—'

  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function daysSince(date: Date | null, now: Date = new Date()): number {
  if (!date) return Number.POSITIVE_INFINITY
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000)
}

export function absoluteTime(date: Date | null): string {
  if (!date) return '—'
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

/** Elapsed time between two instants, or null when it cannot be known. */
export function durationLabel(from: Date | null, to: Date | null): string | null {
  if (!from || !to) return null

  const totalSeconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

/** A stable, short display reference. Derived, never a counter we do not keep. */
export function runReference(runId: string): string {
  return `#${runId.slice(-6)}`
}

/**
 * One-line outcome for the run summary.
 *
 * Each terminal state gets its own sentence: a SUCCEEDED run whose email was
 * skipped is a materially different result from one that sent, and BLOCKED is
 * never described as a failure.
 */
export function outcomeLabel(status: RunStatus, steps: RunStepView[]): string {
  const emailStep = steps.find((step) => step.key === 'SEND_EMAIL')

  switch (status) {
    case 'PENDING':
      return 'Queued'
    case 'RUNNING':
      return 'In progress'
    case 'BLOCKED':
      return 'Blocked — configuration required'
    case 'FAILED': {
      const failed = steps.find((step) => step.state === 'FAILED')
      return failed ? `Failed at ${failed.name}` : 'Failed'
    }
    case 'SUCCEEDED':
      return emailStep?.state === 'SKIPPED' ? 'Success (email skipped)' : 'Success'
  }
}

/**
 * The "Current Step" column.
 *
 * Reports what is actually happening rather than guessing: the running step
 * while in flight, the step that ended the run when it stopped, and the plain
 * terminal state otherwise.
 */
export function currentStepLabel(status: RunStatus, steps: RunStepView[]): string {
  if (status === 'PENDING') return 'Queued'

  const running = steps.find((step) => step.state === 'RUNNING')
  if (running) return running.name

  const blocked = steps.find((step) => step.state === 'BLOCKED')
  if (status === 'BLOCKED' && blocked) return `${blocked.name} (blocked)`

  const failed = steps.find((step) => step.state === 'FAILED')
  if (status === 'FAILED' && failed) return `${failed.name} (failed)`

  if (status === 'SUCCEEDED') return 'Completed'

  // RUNNING with no step yet claimed: the run is claimed, work not started.
  return 'Starting'
}
