import 'server-only'

import { prisma } from '@/lib/db/prisma'
import { logger } from '@/lib/logger'
import { emitRunRequested, emitRunRecoveryRequested } from '@/lib/automation/events'
import { claimRunForRecovery, finalizeRun } from '@/lib/services/workflow-runs'
import type { WorkflowRunTrigger } from '@prisma/client'

/**
 * Recovery for orphaned PENDING runs (Phase 2C).
 *
 * A run row is created inside the enrolling transaction and its event is
 * emitted only after that transaction commits. If the process dies in
 * between — or Inngest rejects the send — the run exists but nothing is
 * scheduled. This sweep finds those and re-emits.
 *
 * Re-emission is safe by construction, not by careful timing:
 *  - the event id is derived from the run id, so Inngest collapses duplicates;
 *  - the function is keyed `idempotency: event.data.runId`;
 *  - `claimRun` only moves PENDING -> RUNNING, so a second execution of an
 *    already-running or finished run does nothing;
 *  - every step short-circuits on its own terminal row.
 *
 * This sweep reads `workflow_runs` directly. While the product was
 * multi-tenant it could not: the sweep is inherently cross-tenant (it does not
 * know which organizations have orphans) and the table was under FORCE ROW
 * LEVEL SECURITY, so it went through a narrow SECURITY DEFINER function owned
 * by a dedicated NOLOGIN role. Single-tenant there is no policy to satisfy and
 * no cross-tenant read to make, so the function, the role and the privileged
 * provisioning step they required are all gone.
 */

/** A run younger than this may simply be mid-emit; leave it alone. */
export const PENDING_RUN_RECOVERY_THRESHOLD_MS = 2 * 60 * 1000

const DEFAULT_LIMIT = 50

export type RecoverPendingRunsResult = {
  found: number
  reemitted: number
}

export async function recoverPendingRuns(options?: {
  olderThanMs?: number
  limit?: number
}): Promise<RecoverPendingRunsResult> {
  const olderThanMs = options?.olderThanMs ?? PENDING_RUN_RECOVERY_THRESHOLD_MS
  const limit = options?.limit ?? DEFAULT_LIMIT
  const cutoff = new Date(Date.now() - olderThanMs)

  const runs = await prisma.workflowRun.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    select: { id: true, leadId: true, trigger: true },
    // Oldest first: the longest-orphaned run is the one most worth rescuing
    // when the limit truncates the sweep.
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  let reemitted = 0
  for (const run of runs) {
    try {
      await emitRunRequested({
        runId: run.id,
        leadId: run.leadId,
        trigger: run.trigger,
      })
      reemitted++
      logger.info('Re-emitted orphaned automation run', {
        runId: run.id,
        leadId: run.leadId,
        status: 'PENDING',
      })
    } catch (error) {
      // One bad emit must not abort the sweep — the next pass retries it.
      logger.error('Failed to re-emit orphaned automation run', {
        runId: run.id,
        cause: error,
      })
    }
  }

  return { found: runs.length, reemitted }
}

/**
 * Recovery for WorkflowRun rows stuck RUNNING — a separate mechanism from the
 * PENDING sweep above, because it needs a different staleness signal.
 *
 * =============================================================================
 * WHY A RUN CAN BE STUCK RUNNING AT ALL
 * =============================================================================
 * `leadQualificationPipeline`'s own `retries: 2` (lib/inngest/functions.ts)
 * already recovers an ordinary worker crash: Inngest replays the function,
 * `claimRun` sees RUNNING and returns RESUMED, and `claimStep` resumes the
 * interrupted step. A run can only be left RUNNING forever once THAT recovery
 * has also been exhausted or bypassed — Inngest's own retries used up against
 * a repeatedly-failing cause, a run cancelled from the Inngest dashboard, or a
 * deploy that breaks replay continuity. This sweep is the residual safety net
 * for exactly that case, not a replacement for Inngest's own retries.
 *
 * =============================================================================
 * STALENESS SIGNAL
 * =============================================================================
 * GREATEST(run.updatedAt, MAX(updatedAt of that run's RUNNING step)), computed
 * in the query below. Only a RUNNING step counts: a step that already reached
 * SUCCEEDED/FAILED/etc. has an updatedAt that is a historical fact, not a
 * liveness signal. Using the step-level signal (not just the run's own
 * updatedAt, which is untouched
 * between claimRun and finalizeRun) lets the threshold stay tight enough to
 * matter without ever mistaking a step legitimately mid-provider-call for
 * dead — see RUNNING_RUN_STALE_THRESHOLD_MS below for the margin this assumes.
 *
 * =============================================================================
 * WHAT HAPPENS TO A DETECTED ORPHAN
 * =============================================================================
 * Below the recovery-attempt cap: `claimRunForRecovery` bumps
 * `WorkflowRun.recoveryAttempts` (conditionally — race-safe against another
 * sweep tick or a run that is genuinely finishing right now) and this
 * re-requests execution via `emitRunRecoveryRequested`, which folds the new
 * generation into both the event id and the value the function's
 * `idempotency` CEL expression reads — see that function's doc comment for
 * why a plain re-emit of the same key is not trusted here. Execution then
 * resumes through the ordinary path: `claimRun` sees RUNNING and returns
 * RESUMED, `claimStep` reclaims whatever step was left non-terminal. No new
 * WorkflowRun is ever created, and no WorkflowStepRun is ever touched
 * directly by this sweep — resumption is what corrects it, via the existing
 * `claimStep`.
 *
 * At the cap: `finalizeRun(..., 'FAILED')` — the same conditional transition
 * used everywhere, so it is a no-op if the run has meanwhile actually
 * finished. This is what releases the `workflow_runs_one_active_per_lead_key`
 * partial unique index, making a future run for that lead possible again.
 */

/** Must exceed the worst realistic single-step duration with real margin —
 * ENRICH/AI_QUALIFY each budget up to 3 provider attempts with backoff, and a
 * slow provider call has been observed mid-session to take 15-20s on its own.
 * Configurable rather than hardcoded logic, like the PENDING threshold above,
 * so it can be tuned from real observed latencies without a code change. */
export const RUNNING_RUN_STALE_THRESHOLD_MS = 10 * 60 * 1000

/** Bounds how many times recovery re-requests execution before giving up. */
export const MAX_RECOVERY_ATTEMPTS = 3

const RUNNING_DEFAULT_LIMIT = 50

type RecoverableRunningRun = {
  id: string
  leadId: string
  trigger: WorkflowRunTrigger
  recoveryAttempts: number
}

export type RecoverStuckRunningRunsResult = {
  found: number
  reemitted: number
  failed: number
}

export async function recoverStuckRunningRuns(options?: {
  olderThanMs?: number
  limit?: number
  maxAttempts?: number
}): Promise<RecoverStuckRunningRunsResult> {
  const olderThanSeconds = Math.floor(
    (options?.olderThanMs ?? RUNNING_RUN_STALE_THRESHOLD_MS) / 1000,
  )
  const limit = options?.limit ?? RUNNING_DEFAULT_LIMIT
  const maxAttempts = options?.maxAttempts ?? MAX_RECOVERY_ATTEMPTS

  // Raw SQL, not a Prisma query: the staleness signal is
  // GREATEST(run.updatedAt, MAX(RUNNING step updatedAt)), which Prisma's query
  // API cannot express. This is an ordinary query on the application's own
  // role — the SECURITY DEFINER function it replaces existed only to escape
  // RLS, not to compute anything the application could not.
  const runs = await prisma.$queryRaw<RecoverableRunningRun[]>`
    SELECT r."id", r."leadId", r."trigger", r."recoveryAttempts"
    FROM "workflow_runs" r
    LEFT JOIN LATERAL (
      SELECT MAX(s."updatedAt") AS last_running_step_at
      FROM "workflow_step_runs" s
      WHERE s."workflowRunId" = r."id" AND s."status" = 'RUNNING'
    ) steps ON TRUE
    WHERE r."status" = 'RUNNING'
      AND GREATEST(r."updatedAt", COALESCE(steps.last_running_step_at, r."updatedAt"))
          < NOW() - (${olderThanSeconds} * INTERVAL '1 second')
    ORDER BY r."updatedAt" ASC
    LIMIT ${limit}
  `

  let reemitted = 0
  let failed = 0

  for (const run of runs) {
    try {
      const claim = await claimRunForRecovery(run.id, maxAttempts)

      if (claim.outcome === 'NOT_RUNNING') {
        // Already resolved (finished, or another tick claimed it) — nothing
        // to do this pass.
        continue
      }

      if (claim.outcome === 'EXHAUSTED') {
        await finalizeRun(run.id, 'FAILED')
        failed++
        logger.warn('Stuck automation run exhausted recovery attempts; failed', {
          runId: run.id,
          leadId: run.leadId,
          recoveryAttempts: run.recoveryAttempts,
        })
        continue
      }

      await emitRunRecoveryRequested(
        {
          runId: run.id,
          leadId: run.leadId,
          trigger: run.trigger,
        },
        claim.generation,
      )
      reemitted++
      logger.info('Re-requested execution of a stuck automation run', {
        runId: run.id,
        leadId: run.leadId,
        status: 'RUNNING',
        generation: claim.generation,
      })
    } catch (error) {
      // One bad run must not abort the sweep — the next pass retries it.
      logger.error('Failed to recover a stuck automation run', {
        runId: run.id,
        cause: error,
      })
    }
  }

  return { found: runs.length, reemitted, failed }
}
