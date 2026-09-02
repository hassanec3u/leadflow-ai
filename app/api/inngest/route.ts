import { serve } from 'inngest/next'

import { inngest } from '@/lib/inngest/client'
import { automationFunctions } from '@/lib/inngest/functions'

/**
 * Inngest's execution endpoint (Phase 2C).
 *
 * This is NOT a public trigger for the pipeline: Inngest signs its requests
 * and `serve` verifies them against INNGEST_SIGNING_KEY, so an unsigned POST
 * cannot execute a workflow. Nothing here reads tenant data — the functions
 * it dispatches to derive the organization from the run row under RLS.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: automationFunctions,
})
