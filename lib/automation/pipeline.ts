import type { WorkflowStepKind } from '@prisma/client'

/**
 * The fixed MVP pipeline definition (Phase 2C).
 *
 * Pure data and pure functions — no I/O, no Prisma, no provider imports — so
 * the rules below can be read and unit-tested in one place instead of being
 * spread across the engine. There is no WorkflowStep table and no builder
 * (docs/architecture.md §10): this module IS the definition.
 *
 * "New Lead" is the enrollment/trigger event, not a step, so it has no entry.
 */

/** AI score at or above this qualifies the lead. Defined ONCE, here. */
export const QUALIFICATION_THRESHOLD = 70

/**
 * Execution order. Changing this array changes the pipeline.
 *
 * `ADD_TO_CRM` was removed (LeadFlow's own `Lead` row is already the system
 * of record — see docs/product-spec.md §1 and §10 — so syncing it to an
 * external CRM mid-pipeline was redundant business logic, not a real
 * requirement). It is deliberately still a member of the `WorkflowStepKind`
 * DB enum below and of `STEP_MAX_ATTEMPTS`: existing `WorkflowStepRun` rows
 * from before this change carry that value and must stay readable, and
 * Postgres has no non-destructive way to drop an enum value that rows still
 * reference. New runs simply never create a row with that step again.
 */
export const PIPELINE_STEPS = [
  'ENRICH',
  'AI_QUALIFY',
  'SCORE_AND_TAG',
  'SEND_EMAIL',
  'NOTIFY_TEAM',
] as const satisfies readonly WorkflowStepKind[]

/**
 * A critical step's terminal failure fails the whole run and stops the
 * pipeline. A non-critical step's failure is recorded and execution continues
 * — a failed notification must not invalidate work that already succeeded.
 */
const CRITICAL_STEPS: ReadonlySet<WorkflowStepKind> = new Set<WorkflowStepKind>([
  'ENRICH',
  'AI_QUALIFY',
  'SCORE_AND_TAG',
  'SEND_EMAIL',
])

export function isCriticalStep(step: WorkflowStepKind): boolean {
  return CRITICAL_STEPS.has(step)
}

/**
 * Total provider attempts per step, retries included (1 = no retry).
 * Central, per the Phase 2C brief — the engine reads these and nothing else
 * decides how many times a provider is called.
 *
 * `ADD_TO_CRM` keeps an entry only because `WorkflowStepKind` still carries
 * the value (see the note on `PIPELINE_STEPS` above) and this map is typed
 * exhaustively over that enum — it is never read, since the step is no
 * longer in `PIPELINE_STEPS`.
 */
export const STEP_MAX_ATTEMPTS: Record<WorkflowStepKind, number> = {
  ENRICH: 3,
  AI_QUALIFY: 3,
  SCORE_AND_TAG: 1, // DB-only; a failure here is a bug, not a transient fault.
  ADD_TO_CRM: 3,
  SEND_EMAIL: 3,
  NOTIFY_TEAM: 2,
}

/** Exponential backoff between provider attempts within a step. */
export const RETRY_BASE_DELAY_MS = 250

export function retryDelayMs(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
}

/**
 * Whether a score qualifies, against the threshold the run was pinned to.
 *
 * The threshold is a PARAMETER now, not a constant read at call time: a run
 * must be judged against the configuration attached to it, never against
 * whatever an admin happens to have saved since. `QUALIFICATION_THRESHOLD`
 * remains the default for organizations that have never configured one.
 */
export function isQualifyingScore(
  score: number,
  threshold: number = QUALIFICATION_THRESHOLD,
): boolean {
  return score >= threshold
}

/**
 * Reason codes stored on `WorkflowStepRun.errorCode`. Skipped/blocked steps
 * carry one too, so "why did nothing happen here?" is always answerable from
 * the row itself rather than from prose in a log.
 */
export const STEP_REASON = {
  providerNotConfigured: 'provider_not_configured',
  emailProviderNotConfigured: 'email_provider_not_configured',
  aiProviderNotConfigured: 'ai_provider_not_configured',
  belowThreshold: 'below_threshold',
  /**
   * An operator switched this step off (Workflow.notifyTeamEnabled).
   *
   * Deliberately distinct from `providerNotConfigured`: "I chose not to run
   * this" and "nothing is connected to run it" are different situations, and a
   * run has to stay able to tell them apart afterwards.
   */
  stepDisabled: 'step_disabled',
  upstreamFailed: 'upstream_failed',
  upstreamBlocked: 'upstream_blocked',
  missingAiResult: 'missing_ai_result',
  aiOutputMalformed: 'ai_output_malformed',
  aiBudgetExceeded: 'ai_budget_exceeded',
  providerFailed: 'provider_failed',
} as const

export type StepReason = (typeof STEP_REASON)[keyof typeof STEP_REASON]
