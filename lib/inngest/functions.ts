import { inngest } from '@/lib/inngest/client'
import { AUTOMATION_RUN_REQUESTED, type AutomationRunRequestedData } from '@/lib/automation/events'
import { executeWorkflowRun } from '@/lib/automation/engine'
import { ensureProviderRegistry } from '@/lib/automation/provider-registry'
import { recoverPendingRuns, recoverStuckRunningRuns } from '@/lib/services/workflow-recovery'

/**
 * Inngest functions (Phase 2C) — thin adapters.
 *
 * All pipeline semantics live in lib/automation/engine.ts. Inngest supplies
 * exactly two things here: durability (`step.run` memoizes a completed step,
 * so a replayed function does not re-execute it) and delivery guarantees.
 *
 * Verified against the installed SDK (inngest@4): `createFunction` takes
 * (options, handler) with `triggers` inside options; `idempotency`,
 * `concurrency` and `retries` are supported option keys; the handler context
 * exposes `event`, `step`, `runId` and `attempt`. `idempotency` and
 * `concurrency.key` are CEL expressions over `event` — the installed type
 * declarations' own doc comment for `ConcurrencyOption.key` documents string
 * concatenation as `event.data.user_id + "-" + event.data.account_id`, which
 * is exactly the pattern `idempotency` below relies on.
 *
 * On failure semantics: the engine's steps never throw — each returns a
 * status that is persisted on its own `WorkflowStepRun` row, and the engine
 * itself decides the run's terminal state. So this adapter does not depend on
 * catching step errors after Inngest exhausts retries; provider retries are
 * governed centrally by STEP_MAX_ATTEMPTS (lib/automation/pipeline.ts), and
 * the function-level `retries` below exists only for crash recovery, where a
 * replay resumes past already-memoized steps.
 */
export const leadQualificationPipeline = inngest.createFunction(
  {
    id: 'lead-qualification-pipeline',
    triggers: [{ event: AUTOMATION_RUN_REQUESTED }],
    // Collapses a duplicate delivery of the SAME generation into one
    // execution — an ordinary emit or a PENDING-recovery re-emit always
    // carries generation "0", so this behaves exactly as before for both.
    // A RUNNING-recovery re-emit (lib/automation/events.ts's
    // emitRunRecoveryRequested) carries a fresh generation each time, so it
    // is never collapsed with a previous, already-exhausted attempt at the
    // same runId — see that function's doc comment for why this project does
    // not rely on Inngest's own dedup window recognising a terminal failure.
    idempotency: 'event.data.runId + "-" + event.data.recoveryGeneration',
    // Still keyed on runId alone (not generation): at most one concurrent
    // execution per RUN, across every generation, is what actually matters —
    // the DB claim (claimRun/claimStep) is the real belt-and-braces here.
    concurrency: { limit: 1, key: 'event.data.runId' },
    // Crash recovery only — provider retries happen inside the engine.
    retries: 2,
  },
  async ({ event, step }) => {
    const data = event.data as AutomationRunRequestedData

    return executeWorkflowRun(
      {
        runId: data.runId,
        // A claim: the engine verifies it against the run under RLS.
        organizationId: data.organizationId,
        // `step.run` returns the JSON-serialized result on replay, which is
        // exactly what the engine expects to rebuild its state from.
        stepRunner: (id, fn) => step.run(id, fn) as ReturnType<typeof fn>,
      },
      // Installs the production providers on first use (Phase 2D-2); slots
      // with no configured vendor stay null and behave exactly as before.
      { providers: ensureProviderRegistry() },
    )
  },
)

/**
 * Sweeps two distinct kinds of orphaned run (see
 * lib/services/workflow-recovery.ts): created but never scheduled (PENDING),
 * and stuck mid-execution because Inngest's own `retries: 2` above was
 * exhausted without ever reaching a terminal state (RUNNING). Two separate
 * `step.run` calls so either is independently retryable/observable in
 * Inngest's own UI. Deliberately a plain cron calling two functions — not a
 * scheduler framework.
 */
export const reconcilePendingRuns = inngest.createFunction(
  { id: 'automation-reconcile-pending-runs', triggers: [{ cron: '*/5 * * * *' }], retries: 1 },
  async ({ step }) => {
    const pending = await step.run('recover-pending-runs', () => recoverPendingRuns())
    const running = await step.run('recover-stuck-running-runs', () => recoverStuckRunningRuns())
    return { pending, running }
  },
)

export const automationFunctions = [leadQualificationPipeline, reconcilePendingRuns]
