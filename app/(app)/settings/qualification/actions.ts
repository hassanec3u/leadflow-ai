'use server'

import { GENERIC_ERROR_MESSAGE, isAppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import {
  saveQualificationConfig,
  type QualificationConfigView,
} from '@/lib/services/qualification-config'

/**
 * Server action bridging the Qualification settings form to its service.
 *
 * Thin by design, like app/(app)/leads/actions.ts: the service validates, the
 * service authorises (ADMIN via `integrations:manage`), and this only maps a
 * failure to a client-safe message. The caller is resolved from the session
 * inside the service.
 */
export type SaveQualificationConfigResult =
  | { ok: true; data: QualificationConfigView }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> }

export async function saveQualificationConfigAction(
  input: unknown,
): Promise<SaveQualificationConfigResult> {
  try {
    return { ok: true, data: await saveQualificationConfig(input) }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
    }
    logger.error('Unexpected saveQualificationConfig failure', { error })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}
