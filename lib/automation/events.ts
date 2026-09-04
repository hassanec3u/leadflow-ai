import 'server-only'

import type { WorkflowRunTrigger } from '@prisma/client'

import { inngest } from '@/lib/inngest/client'

/**
 * The automation event contract (Phase 2C).
 *
 * Exactly one event drives execution. `runId` is the authoritative handle;
 * every other field is observability. The engine loads the run by id and
 * reads everything it acts on from that row, never from the payload — so a
 * forged or stale event can at worst re-request a run that already exists.
 */
export const AUTOMATION_RUN_REQUESTED = 'automation/run.requested' as const

export type AutomationRunRequestedData = {
  runId: string
  /** Observability only; the engine reads the authoritative lead from the run. */
  leadId: string
  trigger: WorkflowRunTrigger
}

/**
 * The event payload as it actually travels over the wire — one field beyond
 * `AutomationRunRequestedData`. Kept separate rather than added to the public
 * type so every existing caller of `emitRunRequested` is unaffected: they
 * still pass the same four fields, and this file is the only place that
 * knows the wire also carries a generation.
 *
 * A STRING, not a number: `leadQualificationPipeline`'s `idempotency` config
 * is a CEL expression (verified against the installed SDK's own type
 * declarations — `ConcurrencyOption.key`'s doc gives
 * `event.data.user_id + "-" + event.data.account_id` as the documented
 * pattern for combining two event.data fields) that concatenates this value
 * with `runId` using `+`. Keeping both operands strings avoids any assumption
 * about whether the CEL environment Inngest evaluates this in auto-coerces or
 * exposes a cast function for a numeric field — nothing here needs to guess.
 */
type AutomationRunRequestedEventData = AutomationRunRequestedData & {
  /** "0" for every ordinary and PENDING-recovery emission — see below. */
  recoveryGeneration: string
}

/**
 * Emit a run request.
 *
 * MUST be called AFTER the enrolling transaction commits: an event emitted
 * inside the transaction could be delivered (and the run executed) before —
 * or without — the row it refers to ever existing.
 *
 * The event id is derived from the run id so a re-emitted event (a retried
 * caller, or the reconciler sweeping an orphaned PENDING run) collapses into
 * the same Inngest event rather than starting a second execution. That
 * collapsing is exactly what is wanted here — a PENDING run has never been
 * scheduled, so re-emitting is a no-op if it already was.
 */
export async function emitRunRequested(data: AutomationRunRequestedData): Promise<void> {
  await inngest.send({
    id: `run:${data.runId}`,
    name: AUTOMATION_RUN_REQUESTED,
    data: { ...data, recoveryGeneration: '0' } satisfies AutomationRunRequestedEventData,
  })
}

/**
 * Re-request execution of a run the RUNNING-orphan sweep believes is stuck
 * (lib/services/workflow-recovery.ts).
 *
 * Deliberately NOT `emitRunRequested` with the same event id: that function
 * exists precisely to collapse repeat deliveries into one execution, which is
 * the opposite of what is needed once a run's PREVIOUS execution attempt has
 * already run its course (through Inngest's own `retries: 2` and, potentially,
 * one or more earlier recovery sweeps) and left the run stuck regardless. This
 * project has no way to verify from the installed SDK whether Inngest's own
 * idempotency window still collapses a duplicate key after the original
 * attempt reached a terminal (failed) outcome — so recovery never relies on
 * that being true. Every recovery attempt gets its own `generation`, folded
 * into BOTH the event id (ingestion-level dedup) and `recoveryGeneration`
 * (which the function's `idempotency` CEL expression reads), guaranteeing a
 * genuinely new key each time regardless of how the server's dedup window
 * actually behaves.
 *
 * `generation` is the value `WorkflowRun.recoveryAttempts` was just bumped
 * to (lib/services/workflow-runs.ts's `claimRunForRecovery`) — never invented
 * here, so a generation number is never reused for two different attempts at
 * the same run, and the same call retried (e.g. after a transient send
 * failure) reuses the identical id/key and collapses safely.
 */
export async function emitRunRecoveryRequested(
  data: AutomationRunRequestedData,
  generation: number,
): Promise<void> {
  await inngest.send({
    id: `run:${data.runId}:recovery:${generation}`,
    name: AUTOMATION_RUN_REQUESTED,
    data: {
      ...data,
      recoveryGeneration: String(generation),
    } satisfies AutomationRunRequestedEventData,
  })
}
