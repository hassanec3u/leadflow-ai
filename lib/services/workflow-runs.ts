import 'server-only'

import { Prisma } from '@prisma/client'
import type {
  LeadQualificationOutcome,
  WorkflowRunStatus,
  WorkflowStepKind,
  WorkflowStepRunStatus,
} from '@prisma/client'

import { prisma } from '@/lib/db/prisma'
import { isUniqueConstraintViolation, UNIQUE_CONSTRAINTS } from '@/lib/db/prisma-errors'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { emitRunRequested } from '@/lib/automation/events'
import type { LeadFacts } from '@/lib/automation/providers'
import { DEFAULT_ICP, DEFAULT_QUALIFICATION_THRESHOLD } from '@/lib/validation/qualification-config'

/**
 * Run and step persistence for the execution engine (Phase 2C).
 *
 * Two rules are load-bearing here:
 *
 *  1. NO provider/network call ever happens inside one of these functions —
 *     a transaction must never be held open across network I/O. The engine
 *     calls claim -> (provider, no transaction) -> persist.
 *  2. Transitions are expressed as CONDITIONAL updates (`updateMany` with the
 *     expected current state in the WHERE clause), never read-then-write, so
 *     two concurrent executions cannot both believe they won.
 *
 * Every function that issues more than one statement wraps them in an explicit
 * `prisma.$transaction`. That is not decoration: these functions previously
 * inherited a transaction from `withTenant()`, and the read-then-conditional-
 * write pairs below (claimRun, claimRunForRecovery, claimStep,
 * applyAiQualification) depend on seeing a single snapshot.
 */

export type RunForExecution = {
  id: string
  workflowId: string
  workflowEnrollmentId: string
  leadId: string
  version: number
  trigger: 'AUTOMATIC' | 'MANUAL_RERUN'
  status: WorkflowRunStatus
}

export type StepRunRecord = {
  id: string
  step: WorkflowStepKind
  status: WorkflowStepRunStatus
  attempts: number
  output: Prisma.JsonValue | null
  errorCode: string | null
}

const RUN_SELECT = {
  id: true,
  workflowId: true,
  workflowEnrollmentId: true,
  leadId: true,
  version: true,
  trigger: true,
  status: true,
} as const

const STEP_SELECT = {
  id: true,
  step: true,
  status: true,
  attempts: true,
  output: true,
  errorCode: true,
} as const

const TERMINAL_STEP_STATES: ReadonlySet<WorkflowStepRunStatus> = new Set<WorkflowStepRunStatus>([
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'BLOCKED',
])

export const TERMINAL_RUN_STATES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
])

/**
 * Load a run by id, or null when it does not exist.
 *
 * The engine reads everything it acts on from this row rather than from the
 * event payload, so a stale or forged event naming an unknown run simply
 * aborts.
 */
export async function loadRunForExecution(runId: string): Promise<RunForExecution | null> {
  if (!runId) return null

  return prisma.workflowRun.findFirst({ where: { id: runId }, select: RUN_SELECT })
}

export type ClaimRunResult =
  | { outcome: 'CLAIMED' }
  | { outcome: 'RESUMED' }
  | { outcome: 'ALREADY_TERMINAL'; status: WorkflowRunStatus }

/**
 * Move a run PENDING -> RUNNING.
 *
 * `RESUMED` means the run was already RUNNING: either this execution is a
 * retry after a crash (Inngest replays the function and memoized steps are
 * skipped) or a concurrent worker owns it — the per-run concurrency key makes
 * the latter vanishingly unlikely, and every step transition is independently
 * guarded, so resuming is safe either way.
 */
export async function claimRun(runId: string): Promise<ClaimRunResult> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.workflowRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    })
    if (claimed.count === 1) return { outcome: 'CLAIMED' as const }

    const current = await tx.workflowRun.findFirst({
      where: { id: runId },
      select: { status: true },
    })
    if (!current) throw new NotFoundError('Workflow run not found.')
    if (current.status === 'RUNNING') return { outcome: 'RESUMED' as const }
    return { outcome: 'ALREADY_TERMINAL' as const, status: current.status }
  })
}

export type RecoveryClaimResult =
  | { outcome: 'RECOVERED'; generation: number }
  | { outcome: 'EXHAUSTED' }
  /** Not our concern: already terminal, or another sweep already claimed it. */
  | { outcome: 'NOT_RUNNING' }

/**
 * Bump `recoveryAttempts` and hand back the new generation, or report that
 * the recovery budget is exhausted — for the RUNNING-orphan sweep
 * (lib/services/workflow-recovery.ts) to act on.
 *
 * The increment is a CONDITIONAL update keyed on the `recoveryAttempts` value
 * just read, not a read-then-write: two sweep ticks racing on the same run
 * (or the same run genuinely finishing between the sweep's read and this call)
 * means the loser's `updateMany` matches zero rows and gets `NOT_RUNNING`
 * back — never a lost update, never two generations minted for one attempt.
 * Same conditional-update idiom as `claimRun`/`finalizeRun`.
 *
 * Never touches a `WorkflowStepRun` — resumption reads and reclaims those
 * itself via the ordinary `claimStep` path once execution is re-requested.
 */
export async function claimRunForRecovery(
  runId: string,
  maxAttempts: number,
): Promise<RecoveryClaimResult> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.workflowRun.findFirst({
      where: { id: runId, status: 'RUNNING' },
      select: { recoveryAttempts: true },
    })
    if (!current) return { outcome: 'NOT_RUNNING' as const }
    if (current.recoveryAttempts >= maxAttempts) return { outcome: 'EXHAUSTED' as const }

    const generation = current.recoveryAttempts + 1
    const updated = await tx.workflowRun.updateMany({
      where: { id: runId, status: 'RUNNING', recoveryAttempts: current.recoveryAttempts },
      data: { recoveryAttempts: generation, lastRecoveryAttemptAt: new Date() },
    })
    if (updated.count === 0) return { outcome: 'NOT_RUNNING' as const }

    return { outcome: 'RECOVERED' as const, generation }
  })
}

/** Terminal transition. Conditional on the run still being RUNNING. */
export async function finalizeRun(
  runId: string,
  status: Extract<WorkflowRunStatus, 'SUCCEEDED' | 'FAILED' | 'BLOCKED'>,
): Promise<void> {
  await prisma.workflowRun.updateMany({
    where: { id: runId, status: 'RUNNING' },
    data: { status, completedAt: new Date() },
  })
}

export async function loadLeadFacts(leadId: string): Promise<LeadFacts | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      phone: true,
      formMessage: true,
      source: true,
    },
  })
  return lead ?? null
}

export type PinnedQualificationConfig = {
  versionId: string | null
  version: number
  icp: string
  instructions: string | null
  threshold: number
}

/**
 * The qualification configuration a run is judged against, pinned to the run.
 *
 * Called once when execution starts. If the run already carries a version —
 * which it will on every Inngest replay — that version is returned unchanged
 * and current settings are NOT consulted. That is the whole point: an admin
 * editing the ICP mid-run must not move the bar under it, and replaying the
 * same row must reach the same verdict.
 *
 * When no configuration has ever been saved the defaults apply and nothing is
 * pinned: there is no version row to point at, and inventing one would record
 * a decision the admin never made.
 *
 * Lives here rather than beside the admin read/save service on purpose: this
 * runs inside the engine, which must stay free of any session dependency —
 * importing `lib/auth/session` here would drag next-auth into the pipeline.
 */
export async function pinQualificationConfigForRun(
  runId: string,
): Promise<PinnedQualificationConfig> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.workflowRun.findFirst({
      where: { id: runId },
      select: { qualificationConfigVersionId: true },
    })

    if (run?.qualificationConfigVersionId) {
      const pinned = await tx.qualificationConfigVersion.findFirst({
        where: { id: run.qualificationConfigVersionId },
      })
      if (pinned) {
        return {
          versionId: pinned.id,
          version: pinned.version,
          icp: pinned.icp,
          instructions: pinned.instructions,
          threshold: pinned.threshold,
        }
      }
    }

    const latest = await tx.qualificationConfigVersion.findFirst({
      orderBy: { version: 'desc' },
    })

    if (!latest) {
      return {
        versionId: null,
        version: 0,
        icp: DEFAULT_ICP,
        instructions: null,
        threshold: DEFAULT_QUALIFICATION_THRESHOLD,
      }
    }

    await tx.workflowRun.updateMany({
      where: { id: runId },
      data: { qualificationConfigVersionId: latest.id },
    })

    return {
      versionId: latest.id,
      version: latest.version,
      icp: latest.icp,
      instructions: latest.instructions,
      threshold: latest.threshold,
    }
  })
}

export type StepClaim =
  | { kind: 'memoized'; stepRun: StepRunRecord }
  | { kind: 'claimed'; stepRun: StepRunRecord }

/**
 * Claim a step for execution: create-or-update its row to RUNNING and
 * increment `attempts`.
 *
 * A step that already reached a terminal state is returned as `memoized` and
 * must NOT be executed again — this is the guard that stops a retried or
 * replayed execution from calling a provider a second time for work that is
 * already recorded as done (there is no partial "retry just this step"
 * feature; a re-run is a whole new WorkflowRun).
 *
 * `attempts` counts executions started, so it increments on every real
 * attempt and never on a memoized short-circuit.
 */
export async function claimStep(
  workflowRunId: string,
  step: WorkflowStepKind,
): Promise<StepClaim> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.workflowStepRun.findFirst({
      where: { workflowRunId, step },
      select: STEP_SELECT,
    })

    if (existing && TERMINAL_STEP_STATES.has(existing.status)) {
      return { kind: 'memoized' as const, stepRun: existing }
    }

    if (existing) {
      const updated = await tx.workflowStepRun.update({
        where: { id: existing.id },
        data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date() },
        select: STEP_SELECT,
      })
      return { kind: 'claimed' as const, stepRun: updated }
    }

    try {
      const created = await tx.workflowStepRun.create({
        data: { workflowRunId, step, status: 'RUNNING', attempts: 1, startedAt: new Date() },
        select: STEP_SELECT,
      })
      return { kind: 'claimed' as const, stepRun: created }
    } catch (error) {
      // Lost a create race: the unique (workflowRunId, step) constraint is the
      // authority, so fall back to whatever the winner wrote.
      if (!isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.stepPerRun)) throw error

      const winner = await tx.workflowStepRun.findFirst({
        where: { workflowRunId, step },
        select: STEP_SELECT,
      })
      if (!winner) throw error
      if (TERMINAL_STEP_STATES.has(winner.status)) {
        return { kind: 'memoized' as const, stepRun: winner }
      }
      const updated = await tx.workflowStepRun.update({
        where: { id: winner.id },
        data: { status: 'RUNNING', attempts: { increment: 1 } },
        select: STEP_SELECT,
      })
      return { kind: 'claimed' as const, stepRun: updated }
    }
  })
}

export type StepCompletion = {
  status: Extract<WorkflowStepRunStatus, 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'BLOCKED'>
  /**
   * Step-scoped result only — never a full Lead snapshot. Typed loosely here
   * and narrowed at the boundary below: callers build plain JSON objects, and
   * Prisma's InputJsonValue is awkward to thread through the engine's own
   * result types for no safety gain.
   */
  output?: Record<string, unknown> | null
  /** Reason code for every non-succeeded outcome (see STEP_REASON). */
  errorCode?: string | null
  errorMessage?: string | null
}

export async function completeStep(
  stepRunId: string,
  completion: StepCompletion,
): Promise<void> {
  await prisma.workflowStepRun.updateMany({
    where: { id: stepRunId },
    data: {
      status: completion.status,
      completedAt: new Date(),
      ...(completion.output === undefined
        ? {}
        : {
            output: (completion.output ?? Prisma.DbNull) as Prisma.InputJsonValue,
          }),
      errorCode: completion.errorCode ?? null,
      errorMessage: completion.errorMessage ?? null,
    },
  })
}

/**
 * Write the AI's qualification decision.
 *
 * `aiScore` is always written when the AI succeeded — it is the model's
 * suggestion and is not owned by anyone else. The qualification OUTCOME is
 * written only when no human owns it, via a single conditional UPDATE: a
 * read-then-write would leave a window in which a human decision made
 * mid-run is silently overwritten. `updated.count === 0` is exactly the
 * "a human owns this" signal.
 */
export async function applyAiQualification(
  leadId: string,
  input: { score: number; outcome: LeadQualificationOutcome },
): Promise<{ humanOverride: boolean; effectiveOutcome: LeadQualificationOutcome | null }> {
  return prisma.$transaction(async (tx) => {
    await tx.lead.updateMany({ where: { id: leadId }, data: { aiScore: input.score } })

    const updated = await tx.lead.updateMany({
      where: {
        id: leadId,
        // Explicit null/AI list rather than `not: 'HUMAN'`: SQL's NOT (col =
        // value) does not match NULL rows, and this column is null until
        // something first decides.
        OR: [{ qualificationSource: null }, { qualificationSource: 'AI' }],
      },
      data: {
        qualificationOutcome: input.outcome,
        qualificationSource: 'AI',
        qualificationUpdatedAt: new Date(),
      },
    })

    const lead = await tx.lead.findFirst({
      where: { id: leadId },
      select: { qualificationOutcome: true },
    })

    return {
      humanOverride: updated.count === 0,
      effectiveOutcome: lead?.qualificationOutcome ?? null,
    }
  })
}

/**
 * Start a manual re-run: a NEW WorkflowRun, from the beginning, against the
 * SAME enrollment (decision D3). There is no partial retry of a failed step.
 *
 * The active-run partial unique index is the authority on "not while another
 * run is in flight" — this maps that violation to a ConflictError rather than
 * relying on a check-then-insert that a concurrent caller could slip past.
 *
 * Authorization is the CALLER's responsibility: the server action that reaches
 * this must have called `requireCapability('automation:manage')` first. This
 * module is deliberately session-free (see pinQualificationConfigForRun) and
 * therefore cannot check for itself.
 */
export async function requestManualRerun(sourceRunId: string): Promise<RunForExecution> {
  const created = await prisma.$transaction(async (tx) => {
    const source = await tx.workflowRun.findFirst({
      where: { id: sourceRunId },
      select: RUN_SELECT,
    })
    if (!source) throw new NotFoundError('Workflow run not found.')

    const workflow = await tx.workflow.findFirst({
      where: { id: source.workflowId },
      select: { id: true, version: true },
    })
    if (!workflow) throw new NotFoundError('Workflow not found.')

    try {
      return await tx.workflowRun.create({
        data: {
          workflowId: source.workflowId,
          workflowEnrollmentId: source.workflowEnrollmentId,
          leadId: source.leadId,
          // Copied at creation time, so this run records the definition it
          // actually executed even if the workflow is versioned later.
          version: workflow.version,
          trigger: 'MANUAL_RERUN',
          status: 'PENDING',
        },
        select: RUN_SELECT,
      })
    } catch (error) {
      if (isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.activeRunPerLead)) {
        throw new ConflictError('A workflow run is already in progress for this lead.')
      }
      throw error
    }
  })

  // Emitted only after the transaction commits — an event delivered before
  // the row exists would execute against nothing.
  await emitRunRequested({
    runId: created.id,
    leadId: created.leadId,
    trigger: 'MANUAL_RERUN',
  })

  return created
}
