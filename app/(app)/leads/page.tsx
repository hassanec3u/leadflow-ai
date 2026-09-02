import { LeadsView } from '@/components/leads/leads-view'
import { requireUser } from '@/lib/auth/session'
import { GENERIC_ERROR_MESSAGE, isAppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { DEFAULT_LEADS_QUERY } from '@/lib/validation/leads'
import { listLeads, type ListLeadsResult } from '@/lib/services/leads'

export const metadata = { title: 'Leads — LeadFlow AI' }

/**
 * Leads page (Phase 1C — real data).
 *
 * The first page of results is fetched here, server-side, through the same
 * Lead service every later interaction uses (app/(app)/leads/actions.ts) —
 * this avoids a loading flash on first paint without duplicating any listing
 * logic. `requireUser()`/`listLeads()` derive the organization from the
 * session; no id is ever passed in from this page.
 *
 * Add Lead / row delete remain local/mock interactions in the UI for this
 * task — see components/leads/leads-view.tsx.
 */
export default async function LeadsPage() {
  await requireUser()

  let initialResult: ListLeadsResult | null = null
  let initialError: string | null = null

  try {
    initialResult = await listLeads(DEFAULT_LEADS_QUERY)
  } catch (error) {
    initialError = isAppError(error) ? error.message : GENERIC_ERROR_MESSAGE
    if (!isAppError(error)) {
      logger.error('Unexpected listLeads failure on initial Leads page load', { error })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LeadsView initialResult={initialResult} initialError={initialError} />
    </div>
  )
}
