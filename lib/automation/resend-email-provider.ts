import 'server-only'

import { Resend } from 'resend'

import {
  ProviderCallError,
  type EmailProvider,
  type LeadFacts,
  type ProviderCall,
} from '@/lib/automation/providers'
import { getEnv } from '@/lib/env'

/**
 * Resend outreach email provider (Phase 4 — the `SEND_EMAIL` step).
 *
 * WHO RECEIVES THIS: the PROSPECT, not the team. Only leads captured through
 * the Website Form auto-enroll (lib/services/automation-enrollment.ts), so
 * every recipient has just asked to be contacted — this is a reply to their
 * own enquiry, not cold outbound. That is what the message is written to be:
 * an acknowledgement, not a pitch.
 *
 * WHAT IT DELIBERATELY DOES NOT SEND: the `summary` on the call. That field
 * is the AI's explanation of the SCORE, written for the sales team — it says
 * things like "company details not verified, authority in doubt", and the
 * qualification prompt is instructed to note attempted prompt-injection there
 * too. Mailing it to the prospect would leak internal scoring rationale, so
 * this provider ignores the field entirely rather than reformatting it.
 *
 * Verified against the installed SDK (resend@6) rather than assumed:
 *   - `client.emails.send(payload, options)` where options carries
 *     `idempotencyKey`;
 *   - it RESOLVES with `{ data, error }` and does not throw on an API error —
 *     so every failure path below reads `error`, it does not catch;
 *   - success is `{ data: { id }, error: null }`;
 *   - `error` is `{ name, message, statusCode }` where `name` is Resend's
 *     documented error-code vocabulary, which `classifyError` maps.
 */

/** Reason codes this provider can raise; each carries a retry decision. */
export const EMAIL_PROVIDER_ERROR = {
  auth: 'email_provider_auth_failed',
  rateLimited: 'email_provider_rate_limited',
  unavailable: 'email_provider_unavailable',
  requestInvalid: 'email_provider_request_invalid',
  quotaExceeded: 'email_provider_quota_exceeded',
  malformed: 'email_response_malformed',
} as const

/**
 * The minimal subset of the Resend client this provider uses. Declaring it
 * lets tests inject a fake without a network call or an API key, and keeps
 * the provider honest about how little of the SDK it depends on.
 */
export type ResendEmailClient = {
  emails: {
    send: (
      payload: { from: string; to: string; subject: string; text: string },
      options?: { idempotencyKey?: string },
    ) => Promise<{
      data: { id: string } | null
      error: { name: string; message: string; statusCode: number | null } | null
    }>
  }
}

/**
 * Resend error codes worth another attempt.
 *
 * `concurrent_idempotent_requests` belongs here specifically: it means a
 * request carrying this same key is in flight right now, so backing off and
 * retrying is exactly the correct response — the second attempt will collapse
 * onto the first rather than sending twice.
 */
const RETRIABLE_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit_exceeded',
  'internal_server_error',
  'application_error',
  'concurrent_idempotent_requests',
])

const AUTH_ERRORS: ReadonlySet<string> = new Set([
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_access',
  'security_error',
])

/**
 * A quota is not a rate limit: waiting a few hundred milliseconds cannot fix
 * it, so retrying only burns the step's attempt budget. Same reasoning the AI
 * budget guard uses (docs/architecture.md §7).
 */
const QUOTA_ERRORS: ReadonlySet<string> = new Set([
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
])

export type OutreachEmail = { subject: string; text: string }

/** First name only — "Bonjour Marc" reads human, "Bonjour Marc Dubois" does not. */
function firstName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  return trimmed.split(/\s+/)[0] ?? null
}

/**
 * The acknowledgement message.
 *
 * Content rules, each load-bearing:
 *
 *  - Only facts we can state safely: their first name, and the message THEY
 *    wrote. Nothing derived from the AI, nothing about our assessment of them.
 *  - Their own words are quoted back because it is the one personalisation
 *    that cannot be wrong — it is their text returning to its author. It also
 *    proves a human will read it, which is the promise the mail makes.
 *  - `formMessage` never reaches the SUBJECT. A subject is an email header,
 *    and a newline inside a header is how header injection (a smuggled `Bcc:`)
 *    works. Keeping prospect text in the body only removes the class entirely.
 *  - Plain text, no HTML: nothing to escape, so nothing to escape wrongly.
 */
export function buildOutreachEmail({ lead }: { lead: LeadFacts }): OutreachEmail {
  const first = firstName(lead.name)
  const greeting = first ? `Bonjour ${first},` : 'Bonjour,'
  const subject = first ? `Merci pour votre message, ${first}` : 'Merci pour votre message'

  // Absent rather than empty: an empty quote block would look broken.
  const quoted = lead.formMessage?.trim()
  const quoteBlock = quoted ? `\n\nVous nous avez écrit :\n« ${quoted} »` : ''

  const text = `${greeting}

Merci de nous avoir contactés via notre site. Votre message est bien arrivé, et un membre de l'équipe vous répondra personnellement sous 24 heures ouvrées.${quoteBlock}

Si vous souhaitez accélérer les choses, répondez directement à cet email.

À très vite.`

  return { subject, text }
}

/**
 * Maps a Resend error onto the engine's retry semantics.
 *
 * The message deliberately carries only the vendor's error code and status —
 * never the recipient or their message. This text lands in
 * `WorkflowStepRun.errorMessage`, which is displayed in the app and logged.
 */
function classifyError(error: {
  name: string
  message: string
  statusCode: number | null
}): ProviderCallError {
  const status = error.statusCode ?? 'unknown'

  if (AUTH_ERRORS.has(error.name)) {
    return new ProviderCallError(
      EMAIL_PROVIDER_ERROR.auth,
      `Resend rejected the credentials (${error.name}, status ${status})`,
      { retriable: false },
    )
  }

  if (QUOTA_ERRORS.has(error.name)) {
    return new ProviderCallError(
      EMAIL_PROVIDER_ERROR.quotaExceeded,
      `Resend sending quota exhausted (${error.name})`,
      { retriable: false },
    )
  }

  if (error.name === 'rate_limit_exceeded') {
    return new ProviderCallError(EMAIL_PROVIDER_ERROR.rateLimited, 'Resend rate limit reached', {
      retriable: true,
    })
  }

  if (RETRIABLE_ERRORS.has(error.name)) {
    return new ProviderCallError(
      EMAIL_PROVIDER_ERROR.unavailable,
      `Resend is temporarily unavailable (${error.name}, status ${status})`,
      { retriable: true },
    )
  }

  // Everything else Resend names is a problem with the request itself
  // (validation, bad address, unknown route) — repeating it changes nothing.
  return new ProviderCallError(
    EMAIL_PROVIDER_ERROR.requestInvalid,
    `Resend rejected the request (${error.name}, status ${status})`,
    { retriable: false },
  )
}

export type ResendEmailProviderOptions = {
  client: ResendEmailClient
  /** `From` header. Accepts Resend's `Name <address@domain>` form. */
  from: string
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend'
  private readonly client: ResendEmailClient
  private readonly from: string

  constructor(options: ResendEmailProviderOptions) {
    this.client = options.client
    this.from = options.from
  }

  async send(
    input: ProviderCall & { lead: LeadFacts; summary: string | null },
  ): Promise<{ providerMessageId: string }> {
    const { subject, text } = buildOutreachEmail({ lead: input.lead })

    const response = await this.client.emails.send(
      { from: this.from, to: input.lead.email, subject, text },
      // The engine's own retries reuse this key (it is the WorkflowStepRun id,
      // stable across attempts), so a retried step collapses server-side
      // instead of mailing the prospect twice.
      { idempotencyKey: input.idempotencyKey },
    )

    if (response.error) {
      throw classifyError(response.error)
    }

    const id = response.data?.id
    if (!id) {
      // A success with no id means we cannot record what was sent. Inventing
      // an id would make the run claim a traceability it does not have.
      throw new ProviderCallError(
        EMAIL_PROVIDER_ERROR.malformed,
        'Resend reported success without a message id',
        { retriable: false },
      )
    }

    return { providerMessageId: id }
  }
}

/**
 * Builds the provider from validated environment, or null when Resend is not
 * configured — which leaves the registry slot null, so the engine keeps its
 * existing BLOCKED behaviour for a qualified lead exactly as before.
 *
 * BOTH variables are required. A key without a verified sender address cannot
 * send anything, so treating that as "configured" would turn a setup mistake
 * into a per-run provider failure instead of the honest "not connected".
 */
export function createResendEmailProvider(): ResendEmailProvider | null {
  const env = getEnv()
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM_ADDRESS) return null

  return new ResendEmailProvider({
    client: new Resend(env.RESEND_API_KEY),
    from: env.EMAIL_FROM_ADDRESS,
  })
}
