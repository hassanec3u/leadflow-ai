import 'server-only'

import type { LeadQualificationOutcome, WorkflowRunStatus, WorkflowStepKind } from '@prisma/client'

import { logger } from '@/lib/logger'
import {
  claimRun,
  claimStep,
  completeStep,
  finalizeRun,
  loadLeadFacts,
  loadRunForExecution,
  pinQualificationConfigForRun,
  applyAiQualification,
  type RunForExecution,
} from '@/lib/services/workflow-runs'
import {
  getProviderRegistry,
  isRetriableProviderError,
  providerErrorCode,
  ProviderCallError,
  type EnrichmentResult,
  type LeadFacts,
  type ProviderRegistry,
  type QualificationConfig,
} from '@/lib/automation/providers'
import {
  isCriticalStep,
  isQualifyingScore,
  PIPELINE_STEPS,
  retryDelayMs,
  STEP_MAX_ATTEMPTS,
  STEP_REASON,
} from '@/lib/automation/pipeline'
import {
  parseAiQualificationOutput,
  type ParsedAiQualification,
} from '@/lib/validation/automation-ai'

/**
 * The fixed-pipeline execution engine (Phase 2C).
 *
 * Deliberately free of any Inngest import: Inngest supplies durability
 * (memoizing completed steps, retrying a crashed function) through the
 * injected `stepRunner`, and nothing else. That keeps every business rule
 * below directly testable, and means a different runner could drive the same
 * engine without touching these semantics.
 *
 * Two structural rules make replay safe:
 *
 *  1. A step closure NEVER mutates pipeline state. It returns a JSON result,
 *     and the caller applies it. On replay the closure does not run — only its
 *     memoized return value comes back — so state must be rebuilt from that
 *     value or it would silently be lost.
 *  2. No provider call happens inside a database transaction. Each step
 *     claims (transaction), calls its provider (no transaction), then
 *     persists (transaction).
 */

/** Injected by the runner. Inngest maps this onto `step.run`; tests call the fn directly. */
export type StepRunner = <T>(id: string, fn: () => Promise<T>) => Promise<T>

export type ExecuteWorkflowRunInput = {
  runId: string
  stepRunner?: StepRunner
}

export type ExecuteWorkflowRunDeps = {
  providers?: ProviderRegistry
  sleep?: (ms: number) => Promise<void>
}

export type StepOutcomeStatus = 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'BLOCKED'

export type StepResult = {
  status: StepOutcomeStatus
  output?: Record<string, unknown> | null
  errorCode?: string | null
}

export type ExecuteWorkflowRunResult = {
  outcome: 'COMPLETED' | 'ABORTED' | 'ALREADY_TERMINAL'
  runStatus: WorkflowRunStatus | null
  reason?: string
  steps?: Partial<Record<WorkflowStepKind, StepResult>>
}

type Terminal = {
  status: Extract<WorkflowRunStatus, 'FAILED' | 'BLOCKED'>
  step: WorkflowStepKind
  errorCode: string | null
}

type PipelineState = {
  lead: LeadFacts
  /**
   * The qualification configuration this run is judged against, pinned when
   * execution starts. Read once — an admin editing the ICP mid-run must not
   * move the bar under it, and a replay must reach the same verdict.
   */
  config: QualificationConfig
  enrichment: EnrichmentResult | null
  ai: ParsedAiQualification | null
  effectiveOutcome: LeadQualificationOutcome | null
  terminal: Terminal | null
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function executeWorkflowRun(
  input: ExecuteWorkflowRunInput,
  deps: ExecuteWorkflowRunDeps = {},
): Promise<ExecuteWorkflowRunResult> {
  const providers = deps.providers ?? getProviderRegistry()
  const sleep = deps.sleep ?? defaultSleep
  const stepRunner: StepRunner = input.stepRunner ?? ((_id, fn) => fn())

  // The run row is the authority for everything below; the event payload is
  // only a handle. An event naming a run that does not exist aborts here.
  const run = await loadRunForExecution(input.runId)
  if (!run) {
    logger.warn('Automation run not found; aborting', {
      runId: input.runId,
    })
    return { outcome: 'ABORTED', runStatus: null, reason: 'run_not_found' }
  }

  const claim = await claimRun(run.id)
  if (claim.outcome === 'ALREADY_TERMINAL') {
    logger.info('Automation run already terminal; nothing to execute', {
      runId: run.id,
      leadId: run.leadId,
      status: claim.status,
    })
    return { outcome: 'ALREADY_TERMINAL', runStatus: claim.status }
  }

  const lead = await loadLeadFacts(run.leadId)
  if (!lead) {
    await finalizeRun(run.id, 'FAILED')
    logger.error('Automation run has no visible lead; failing run', {
      runId: run.id,
      leadId: run.leadId,
    })
    return { outcome: 'ABORTED', runStatus: 'FAILED', reason: 'lead_not_visible' }
  }

  // Pinned before any step runs, and idempotent: a replay returns the version
  // already attached to the run rather than re-reading current settings.
  const config = await pinQualificationConfigForRun(run.id)

  const state: PipelineState = {
    lead,
    config,
    enrichment: null,
    ai: null,
    effectiveOutcome: null,
    terminal: null,
  }
  const steps: Partial<Record<WorkflowStepKind, StepResult>> = {}

  for (const step of PIPELINE_STEPS) {
    if (state.terminal && !shouldStillRunAfterTermination(step, state.terminal)) {
      const reason =
        state.terminal.status === 'BLOCKED'
          ? STEP_REASON.upstreamBlocked
          : STEP_REASON.upstreamFailed
      steps[step] = await stepRunner(`${step}:skipped`, () => recordSkippedStep(run, step, reason))
      continue
    }

    const result = await stepRunner(step, () =>
      runStepWithRetries({ run, state, providers, sleep, step }),
    )
    steps[step] = result
    applyStepResult(state, step, result)
  }

  const runStatus: Extract<WorkflowRunStatus, 'SUCCEEDED' | 'FAILED' | 'BLOCKED'> =
    state.terminal?.status ?? 'SUCCEEDED'
  await finalizeRun(run.id, runStatus)

  logger.info('Automation run finished', {
    runId: run.id,
    leadId: run.leadId,
    status: runStatus,
    trigger: run.trigger,
    version: run.version,
  })

  return { outcome: 'COMPLETED', runStatus, steps }
}

/**
 * After a terminal step, everything downstream is SKIPPED — with one
 * deliberate exception: a SEND_EMAIL failure (or configuration block) must
 * still notify the team, because "we could not contact this qualified lead"
 * is precisely the thing a human needs told. An earlier failure (enrichment,
 * AI) skips NOTIFY_TEAM as well: nothing was sent and nothing is actionable
 * beyond the manual-review flag the failed run already carries.
 */
function shouldStillRunAfterTermination(step: WorkflowStepKind, terminal: Terminal): boolean {
  return step === 'NOTIFY_TEAM' && terminal.step === 'SEND_EMAIL'
}

function applyStepResult(state: PipelineState, step: WorkflowStepKind, result: StepResult): void {
  if (result.status === 'SUCCEEDED') {
    if (step === 'ENRICH') {
      state.enrichment = (result.output as EnrichmentResult | undefined) ?? null
    }
    if (step === 'AI_QUALIFY') {
      state.ai = (result.output as ParsedAiQualification | undefined) ?? null
    }
    if (step === 'SCORE_AND_TAG') {
      const output = result.output as { effectiveOutcome?: LeadQualificationOutcome } | undefined
      state.effectiveOutcome = output?.effectiveOutcome ?? null
    }
    return
  }

  if (result.status === 'BLOCKED') {
    state.terminal = { status: 'BLOCKED', step, errorCode: result.errorCode ?? null }
    return
  }

  if (result.status === 'FAILED' && isCriticalStep(step)) {
    state.terminal = { status: 'FAILED', step, errorCode: result.errorCode ?? null }
  }
  // A non-critical failure (NOTIFY_TEAM) is recorded on its own row and the
  // pipeline continues — the run can still succeed.
}

async function recordSkippedStep(
  run: RunForExecution,
  step: WorkflowStepKind,
  reason: string,
): Promise<StepResult> {
  const claim = await claimStep(run.id, step)
  if (claim.kind === 'memoized')
    return memoizedResult(claim.stepRun.status, claim.stepRun.output, claim.stepRun.errorCode)

  await completeStep(claim.stepRun.id, {
    status: 'SKIPPED',
    errorCode: reason,
  })
  logger.info('Automation step skipped', {
    runId: run.id,
    leadId: run.leadId,
    step,
    attempt: claim.stepRun.attempts,
    status: 'SKIPPED',
    errorCode: reason,
  })
  return { status: 'SKIPPED', errorCode: reason }
}

function memoizedResult(status: string, output: unknown, errorCode: string | null): StepResult {
  return {
    status: status as StepOutcomeStatus,
    output: (output as Record<string, unknown> | null) ?? null,
    errorCode,
  }
}

/**
 * Execute one step, retrying transient provider failures up to the step's
 * central attempt budget (lib/automation/pipeline.ts).
 *
 * `attempts` is incremented by the claim on every real attempt, so the row's
 * counter is the number of executions started — retries included — and never
 * moves for a memoized step.
 */
async function runStepWithRetries(args: {
  run: RunForExecution
  state: PipelineState
  providers: ProviderRegistry
  sleep: (ms: number) => Promise<void>
  step: WorkflowStepKind
}): Promise<StepResult> {
  const { run, step, sleep } = args
  const maxAttempts = STEP_MAX_ATTEMPTS[step]

  for (;;) {
    const claim = await claimStep(run.id, step)
    if (claim.kind === 'memoized') {
      return memoizedResult(claim.stepRun.status, claim.stepRun.output, claim.stepRun.errorCode)
    }

    // The PERSISTED count, not a counter local to this invocation. claimStep
    // increments this on every real claim — including one made by a replayed
    // or recovery-resumed invocation after a crash — so the budget below
    // stays bounded across an arbitrary number of crash-and-resume cycles,
    // not just within a single execution attempt.
    const attempt = claim.stepRun.attempts
    const stepRunId = claim.stepRun.id
    const startedAt = Date.now()

    try {
      const result = await performStep(args, stepRunId)
      await completeStep(stepRunId, {
        status: result.status,
        output: result.output ?? null,
        errorCode: result.errorCode ?? null,
      })
      logger.info('Automation step finished', {
        runId: run.id,
        leadId: run.leadId,
        step,
        attempt,
        status: result.status,
        durationMs: Date.now() - startedAt,
        errorCode: result.errorCode ?? null,
      })
      return result
    } catch (error) {
      const errorCode = providerErrorCode(error, STEP_REASON.providerFailed)
      const canRetry = isRetriableProviderError(error) && attempt < maxAttempts

      logger.warn('Automation step attempt failed', {
        runId: run.id,
        leadId: run.leadId,
        step,
        attempt,
        status: canRetry ? 'RETRYING' : 'FAILED',
        durationMs: Date.now() - startedAt,
        errorCode,
      })

      if (canRetry) {
        await sleep(retryDelayMs(attempt))
        continue
      }

      // Only the error's own message is persisted (operator-facing, on the
      // row); provider payloads and prompts are never logged or stored here.
      await completeStep(stepRunId, {
        status: 'FAILED',
        errorCode,
        errorMessage: error instanceof Error ? error.message : 'Unknown provider failure',
      })
      return { status: 'FAILED', errorCode }
    }
  }
}

/**
 * One attempt at one step: preconditions, then the provider call.
 *
 * Preconditions that mean "this step does not apply" return SKIPPED/BLOCKED
 * (no retry — retrying a missing provider changes nothing). Anything thrown
 * is a provider failure and is subject to the retry budget.
 */
async function performStep(
  args: {
    run: RunForExecution
    state: PipelineState
    providers: ProviderRegistry
    step: WorkflowStepKind
  },
  stepRunId: string,
): Promise<StepResult> {
  const { run, state, providers, step } = args
  const call = { idempotencyKey: stepRunId }

  switch (step) {
    case 'ENRICH': {
      // Optional provider: nothing connected means the pipeline proceeds with
      // unenriched data (docs/architecture.md §5), which is NOT a failure.
      if (!providers.enrichment) {
        return { status: 'SKIPPED', errorCode: STEP_REASON.providerNotConfigured }
      }
      const result = await providers.enrichment.enrich({ ...call, lead: state.lead })
      return { status: 'SUCCEEDED', output: { ...result } }
    }

    case 'AI_QUALIFY': {
      // Required provider: without it the run cannot complete normally, and
      // saying so explicitly beats silently "succeeding" with no score.
      if (!providers.ai) {
        return { status: 'BLOCKED', errorCode: STEP_REASON.aiProviderNotConfigured }
      }
      // Budget is checked BEFORE the paid call; exceeding it is not something
      // a retry can fix, so the guard throws non-retriably.
      await providers.aiBudget?.assertWithinBudget()

      const raw = await providers.ai.qualify({
        ...call,
        // Admin-authored, so it may shape the instructions — fenced in its own
        // block, with the immutable security rules always after it.
        config: state.config,
        // Lead-supplied text crosses this boundary as DATA. Providers must
        // pass it as user content, never concatenated into system/instruction
        // text (docs/architecture.md §6).
        lead: state.lead,
        enrichment: state.enrichment,
      })

      const parsed = parseAiQualificationOutput(raw)
      if (!parsed) {
        // Malformed output is a failure, never a guessed score: aiScore stays
        // null and the lead goes to manual review.
        throw new ProviderCallError(
          STEP_REASON.aiOutputMalformed,
          'AI qualification output failed schema validation',
        )
      }
      return { status: 'SUCCEEDED', output: { ...parsed } }
    }

    case 'SCORE_AND_TAG': {
      const ai = state.ai
      if (!ai) return { status: 'SKIPPED', errorCode: STEP_REASON.missingAiResult }

      // The threshold from the run's pinned config, never the current one.
      const outcome: LeadQualificationOutcome = isQualifyingScore(ai.score, state.config.threshold)
        ? 'QUALIFIED'
        : 'UNQUALIFIED'
      const applied = await applyAiQualification(state.lead.id, {
        score: ai.score,
        outcome,
      })

      return {
        status: 'SUCCEEDED',
        output: {
          score: ai.score,
          aiOutcome: outcome,
          humanOverride: applied.humanOverride,
          // Downstream eligibility follows the EFFECTIVE outcome, so a human
          // decision governs whether an email goes out, not the AI's view.
          effectiveOutcome: applied.effectiveOutcome,
        },
      }
    }

    // ADD_TO_CRM is retired: it no longer appears in PIPELINE_STEPS
    // (lib/automation/pipeline.ts), so performStep is never called with it
    // for a real run — this case exists solely because WorkflowStepKind
    // (the Prisma/DB enum) still carries the value for historical
    // WorkflowStepRun rows, and TypeScript requires this switch to stay
    // exhaustive over that type. It is unreachable in practice.
    case 'ADD_TO_CRM':
      throw new Error('ADD_TO_CRM is retired and is never scheduled by PIPELINE_STEPS')

    case 'SEND_EMAIL': {
      // Threshold first: an unqualified lead is never emailed, whether or not
      // a provider happens to be connected, and that is a SUCCESSFUL outcome.
      if (state.effectiveOutcome !== 'QUALIFIED') {
        return { status: 'SKIPPED', errorCode: STEP_REASON.belowThreshold }
      }
      if (!providers.email) {
        return { status: 'BLOCKED', errorCode: STEP_REASON.emailProviderNotConfigured }
      }
      const result = await providers.email.send({
        ...call,
        lead: state.lead,
        summary: state.ai?.summary ?? null,
      })
      return { status: 'SUCCEEDED', output: { providerMessageId: result.providerMessageId } }
    }

    case 'NOTIFY_TEAM': {
      if (!providers.notification) {
        return { status: 'SKIPPED', errorCode: STEP_REASON.providerNotConfigured }
      }
      const kind =
        state.terminal?.status === 'FAILED'
          ? 'run_failed'
          : state.terminal?.status === 'BLOCKED'
            ? 'run_blocked'
            : 'run_succeeded'
      const result = await providers.notification.notify({
        ...call,
        lead: state.lead,
        runId: run.id,
        kind,
        detail: state.terminal?.errorCode ?? null,
      })
      return { status: 'SUCCEEDED', output: { ref: result.ref } }
    }
  }
}
