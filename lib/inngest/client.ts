import { Inngest } from 'inngest'

/**
 * Inngest client (Phase 2C).
 *
 * Inngest reads INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY from the environment
 * itself; both are optional in local development (the dev server needs
 * neither) and are declared in lib/env.ts so a deployment that omits them is
 * a documented choice rather than a surprise. The signing key is what makes
 * `/api/inngest` safe to expose: Inngest signs its requests and the serve
 * handler verifies them, so the endpoint is not a public execution trigger.
 */
export const inngest = new Inngest({ id: 'leadflow-ai' })
