'use server'

import { parseLeadsCsv } from '@/lib/csv'
import { getLeadAutomationStatus, type LeadAutomationStatus } from '@/lib/services/automation-read'
import { GENERIC_ERROR_MESSAGE, isAppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import {
  createLead,
  deleteLead,
  importLeads,
  listLeads,
  updateLead,
  type ImportLeadsResult,
  type Lead,
  type ListLeadsResult,
} from '@/lib/services/leads'

/**
 * Server actions bridging the Leads UI to the Lead service.
 *
 * Thin by design (see app/(auth)/actions.ts for the same pattern): parsing
 * happens in the service, not here; each action only invokes it and maps
 * failures to a client-safe message (+ field errors where useful).
 * `organizationId` never appears in any input here — it comes from the
 * session inside the service (via `requireUser()`/`withTenant()`).
 */
export type ListLeadsActionResult =
  { ok: true; data: ListLeadsResult } | { ok: false; message: string }

export async function listLeadsAction(query: unknown): Promise<ListLeadsActionResult> {
  try {
    const data = await listLeads(query)
    return { ok: true, data }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message }
    }

    logger.error('Unexpected listLeads failure', { error })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}

export type LeadMutationActionResult =
  { ok: true; data: Lead } | { ok: false; message: string; fieldErrors?: Record<string, string[]> }

export async function createLeadAction(input: unknown): Promise<LeadMutationActionResult> {
  try {
    const data = await createLead(input)
    return { ok: true, data }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
    }

    logger.error('Unexpected createLead failure', { error })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}

export async function updateLeadAction(
  id: string,
  input: unknown,
): Promise<LeadMutationActionResult> {
  try {
    const data = await updateLead(id, input)
    return { ok: true, data }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
    }

    logger.error('Unexpected updateLead failure', { error, leadId: id })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}

export type ImportLeadsActionResult =
  { ok: true; data: ImportLeadsResult } | { ok: false; message: string }

/**
 * Parses the uploaded CSV text server-side (never trusting client-parsed
 * rows) and imports it through the same Lead service used everywhere else.
 */
export async function importLeadsAction(csvText: string): Promise<ImportLeadsActionResult> {
  const parsed = parseLeadsCsv(csvText)
  if ('error' in parsed) {
    return { ok: false, message: parsed.error }
  }

  try {
    const data = await importLeads(parsed.rows)
    return { ok: true, data }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message }
    }

    logger.error('Unexpected importLeads failure', { error })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}

export type DeleteLeadActionResult = { ok: true } | { ok: false; message: string }

export async function deleteLeadAction(id: string): Promise<DeleteLeadActionResult> {
  try {
    await deleteLead(id)
    return { ok: true }
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, message: error.message }
    }

    logger.error('Unexpected deleteLead failure', { error, leadId: id })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}

export type LeadAutomationActionResult =
  { ok: true; data: LeadAutomationStatus } | { ok: false; message: string }

/**
 * Read a lead's real automation state for the Lead detail Automation tab.
 *
 * Fetched on demand rather than with the leads list: the detail panel is
 * closed by default, so preloading this for every row would be work nobody
 * asked for. A caller without `automation:manage` gets `data: null` — the tab
 * simply shows nothing, which keeps the existing permission boundary exactly
 * where it is instead of widening it.
 */
export async function getLeadAutomationAction(leadId: string): Promise<LeadAutomationActionResult> {
  try {
    return { ok: true, data: await getLeadAutomationStatus(leadId) }
  } catch (error) {
    if (isAppError(error)) {
      return error.code === 'FORBIDDEN'
        ? { ok: true, data: null }
        : { ok: false, message: error.message }
    }
    logger.error('Unexpected getLeadAutomationStatus failure', { leadId, error })
    return { ok: false, message: GENERIC_ERROR_MESSAGE }
  }
}
