'use server'

import { GENERIC_ERROR_MESSAGE, isAppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { requestManualRerunForCurrentUser } from '@/lib/services/automation-rerun'

/**
 * Server action bridging Run Detail's "Re-run Workflow" button to the Manual
 * Rerun service. Thin by design, like app/(app)/leads/actions.ts: the
 * service authorises (`automation:manage`, ADMIN + MANAGER) and enforces
 * every rerun rule; this only maps a failure to a client-safe message.
 * `organizationId` never appears here — it comes from the session inside
 * the service.
 */
export type RequestManualRerunActionResult =
  { ok: true; runId: string } | { ok: false; message: string }

export async function requestManualRerunAction(
  sourceRunId: string,
): Promise<RequestManualRerunActionResult> {
  try {
    const run = await requestManualRerunForCurrentUser(sourceRunId)
    return { ok: true, runId: run.id }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message }
    }

    logger.error('Unexpected requestManualRerun failure', { error, sourceRunId })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}
