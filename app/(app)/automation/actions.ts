'use server'

import { GENERIC_ERROR_MESSAGE, isAppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import {
  pauseWorkflowForCurrentUser,
  resumeWorkflowForCurrentUser,
  type WorkflowStatusResult,
} from '@/lib/services/automation-workflow-status'

/**
 * Server actions bridging the Pause/Resume controls (Automation overview and
 * Pipeline detail) to the workflow status service. Thin by design, like
 * app/(app)/automation/runs/actions.ts: the service authorises
 * (`automation:manage`, ADMIN + MANAGER) and enforces the transition; this
 * only maps a failure to a client-safe message. The caller is resolved from
 * the session inside the service.
 */
export type SetWorkflowStatusActionResult =
  { ok: true; data: WorkflowStatusResult } | { ok: false; message: string }

export async function pauseWorkflowAction(
  workflowId: string,
): Promise<SetWorkflowStatusActionResult> {
  try {
    return { ok: true, data: await pauseWorkflowForCurrentUser(workflowId) }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message }
    }
    logger.error('Unexpected pauseWorkflow failure', { error, workflowId })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}

export async function resumeWorkflowAction(
  workflowId: string,
): Promise<SetWorkflowStatusActionResult> {
  try {
    return { ok: true, data: await resumeWorkflowForCurrentUser(workflowId) }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message }
    }
    logger.error('Unexpected resumeWorkflow failure', { error, workflowId })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}
