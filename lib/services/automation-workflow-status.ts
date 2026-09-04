import 'server-only'

import type { WorkflowStatus } from '@prisma/client'

import { requireCapability } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { NotFoundError } from '@/lib/errors'

/**
 * Pause / Resume the single workflow (Pause/Resume micro-phase).
 *
 * `Workflow.status` (`ACTIVE` | `PAUSED`) and its meaning already exist and are
 * already enforced — this module adds no new business rule:
 *  - `enrollLeadIfEligible` (lib/services/automation-enrollment.ts) refuses a
 *    new AUTOMATIC enrollment whenever `workflow.status !== 'ACTIVE'`, so
 *    setting PAUSED here is what blocks the next capture from enrolling —
 *    nothing about capture itself changes.
 *  - Nothing in the execution engine (lib/automation/engine.ts) or the run
 *    persistence layer (lib/services/workflow-runs.ts) reads `Workflow.status`
 *    at all, so a run already PENDING/RUNNING is completely unaffected by
 *    this transition — there is no code path left to add that would stop it.
 *
 * This module is therefore only the write path: enforce `automation:manage`
 * (ADMIN + MANAGER) against the session, and flip the one column.
 */

export type WorkflowStatusResult = { id: string; status: WorkflowStatus }

/**
 * Conditional transition, same idiom as `claimRun`/`finalizeRun`
 * (lib/services/workflow-runs.ts): the `updateMany` is keyed on the expected
 * SOURCE status, never a read-then-write, so two concurrent toggles can never
 * race past each other into a lost update.
 *
 * Idempotent by design: if the workflow is already in `target` — a duplicate
 * click, or a concurrent toggle that got there first — the conditional update
 * matches zero rows and the fallback read reports that same state back as
 * success, never a conflict. There is no "wrong" state to error on; the only
 * failure is the workflow not existing at all.
 */
async function setWorkflowStatus(
  workflowId: string,
  target: WorkflowStatus,
): Promise<WorkflowStatusResult> {
  await requireCapability('automation:manage')
  const source: WorkflowStatus = target === 'PAUSED' ? 'ACTIVE' : 'PAUSED'

  // Transaction: the conditional update and its fallback read must agree on
  // one snapshot, or a concurrent toggle makes the reported state a lie.
  return prisma.$transaction(async (tx) => {
    const updated = await tx.workflow.updateMany({
      where: { id: workflowId, status: source },
      data: { status: target },
    })
    if (updated.count === 1) {
      return { id: workflowId, status: target }
    }

    const current = await tx.workflow.findFirst({
      where: { id: workflowId },
      select: { id: true, status: true },
    })
    if (!current) throw new NotFoundError('Workflow not found.')
    return { id: current.id, status: current.status }
  })
}

export function pauseWorkflowForCurrentUser(workflowId: string): Promise<WorkflowStatusResult> {
  return setWorkflowStatus(workflowId, 'PAUSED')
}

export function resumeWorkflowForCurrentUser(workflowId: string): Promise<WorkflowStatusResult> {
  return setWorkflowStatus(workflowId, 'ACTIVE')
}

export type NotifyTeamResult = { id: string; notifyTeamEnabled: boolean }

/**
 * Switch the NOTIFY_TEAM step on or off.
 *
 * Deliberately separate from `status`: pausing stops the pipeline enrolling
 * anything, while this turns off one optional step and leaves the rest
 * running. The engine reads the flag at step time
 * (`isNotifyTeamEnabled` in lib/services/workflow-runs.ts), so a change takes
 * effect on runs already in flight that have not reached the step yet.
 *
 * Same conditional-update idiom, and the same idempotence, as
 * `setWorkflowStatus` above: setting it to the value it already holds is a
 * success reporting that state, not a conflict.
 */
export async function setNotifyTeamEnabledForCurrentUser(
  workflowId: string,
  enabled: boolean,
): Promise<NotifyTeamResult> {
  await requireCapability('automation:manage')

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workflow.updateMany({
      where: { id: workflowId, notifyTeamEnabled: !enabled },
      data: { notifyTeamEnabled: enabled },
    })
    if (updated.count === 1) {
      return { id: workflowId, notifyTeamEnabled: enabled }
    }

    const current = await tx.workflow.findFirst({
      where: { id: workflowId },
      select: { id: true, notifyTeamEnabled: true },
    })
    if (!current) throw new NotFoundError('Workflow not found.')
    return { id: current.id, notifyTeamEnabled: current.notifyTeamEnabled }
  })
}
