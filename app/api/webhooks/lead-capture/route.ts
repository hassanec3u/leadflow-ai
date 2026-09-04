import { createHash, timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { withApiErrorHandling } from '@/lib/api/handler'
import { checkRateLimit, pruneRateLimitWindows } from '@/lib/api/rate-limit'
import { getEnv } from '@/lib/env'
import { AppError, UnauthenticatedError, ValidationError } from '@/lib/errors'
import { captureAutomaticLead } from '@/lib/services/automation-enrollment'

/**
 * Public Website Form lead capture (Phase 2E-2).
 *
 *   POST /api/webhooks/lead-capture
 *
 * The production entry point of the Phase 2 automation chain: form submission
 * -> authentication -> captureAutomaticLead() -> WorkflowEnrollment ->
 * PENDING WorkflowRun -> automation/run.requested -> Inngest -> engine. The
 * path is the one docs/architecture.md §6 specifies.
 *
 * Deliberately thin. Every business rule — email normalisation, duplicate
 * merge, workflow lookup, PAUSED handling, enrollment uniqueness, the PENDING
 * run, emitting after commit — stays in `captureAutomaticLead()` and is not
 * reimplemented, re-checked or second-guessed here. This file does four
 * things: rate limit, authenticate, validate input, delegate.
 *
 * =============================================================================
 * WHY THIS ENDPOINT IS SAFE TO EXPOSE ANONYMOUSLY
 * =============================================================================
 * It is guarded by a shared secret (FORM_CAPTURE_SECRET) compared in constant
 * time, and it never reads an identifier from the request body that could
 * redirect where the lead lands: `workflowId` and `ownerId` are not merely
 * rejected as authority — they are never read at all (see `buildCaptureInput`).
 *
 * While the product was multi-tenant this endpoint additionally had to RESOLVE
 * which tenant a submission belonged to, which is why the secret lived hashed
 * on a table and was looked up through a SECURITY DEFINER function. There is
 * one tenant now, so the secret only has to authenticate — it identifies
 * nothing — and an environment variable is the right home for it.
 */

/** No Auth.js, no session, no cookies — this route is anonymous by design. */
export const dynamic = 'force-dynamic'

/**
 * Per-source-IP, applied BEFORE the secret is checked, so an attacker cannot
 * brute-force secrets for free.
 */
const IP_LIMIT = 30
const IP_WINDOW_MS = 60_000

/**
 * Applied AFTER authentication. A valid credential still cannot run up an
 * unbounded enrichment/OpenAI bill (architecture.md §132). One secret serves
 * the whole deployment, so this bucket is global rather than per-caller —
 * which is what makes it a spend ceiling.
 */
const AUTHENTICATED_LIMIT = 120
const AUTHENTICATED_WINDOW_MS = 60_000

/**
 * Identical response for every authentication failure — absent secret, wrong
 * secret, or no secret configured on the server at all. The endpoint must not
 * be usable as an oracle for how it is configured.
 */
function authenticationFailed(): never {
  throw new UnauthenticatedError('Invalid capture credentials.')
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are SHA-256'd first so that `timingSafeEqual` always receives two
 * equal-length (32-byte) buffers — it throws on a length mismatch, and feeding
 * it raw inputs would both crash on a short guess and leak the expected length
 * through that crash. Digesting normalises length without weakening anything:
 * the comparison is still over the full value.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function rateLimited(retryAfterSeconds: number): never {
  throw new AppError('RATE_LIMITED', 'Too many requests. Please try again shortly.', {
    logContext: { retryAfterSeconds },
  })
}

/**
 * The presented secret.
 *
 * Two accepted forms because form builders and webhook tools differ in what
 * they can send: `Authorization: Bearer <secret>` is the universal default,
 * and `X-LeadFlow-Capture-Secret` mirrors the plain-header style the project
 * already uses when CALLING vendors (Apollo's `x-api-key`, Prospeo's `X-KEY`).
 * The value is returned, never logged.
 */
function readSecret(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1].trim()
  }

  return request.headers.get('x-leadflow-capture-secret')?.trim() ?? null
}

/**
 * Best-effort client identity for the pre-authentication limit.
 *
 * NOTE: `x-forwarded-for` is client-controlled unless a trusted proxy
 * overwrites it, so this bucket is spoofable in a deployment that terminates
 * traffic without one. It is a cost-abuse speed bump, not an access control —
 * the post-authentication limit below is the one that binds an authenticated
 * caller.
 */
function clientBucket(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim()
  return `lead-capture:ip:${ip && ip !== '' ? ip : 'unknown'}`
}

/**
 * Allowlist the four fields `captureAutomaticLead()` accepts, and force the
 * source.
 *
 * Building the object explicitly — rather than passing the parsed body
 * through — is what makes `workflowId`, `ownerId` and any other field
 * structurally incapable of reaching the service: they are never copied. `source` is set here, after the client's value is discarded, so a
 * submission claiming MANUAL or CSV_IMPORT cannot dodge the automatic
 * enrollment eligibility rule (docs/product-spec.md §8).
 */
function buildCaptureInput(body: Record<string, unknown>) {
  return {
    name: body.name,
    email: body.email,
    company: body.company,
    phone: body.phone,
    // The prospect's own words — the only channel through which a lead can
    // state intent. Validated and length-capped by the schema in the service.
    formMessage: body.formMessage,
    // Server-forced. Never read from the request.
    source: 'WEBSITE_FORM' as const,
  }
}

export const POST = withApiErrorHandling(async (request: Request): Promise<NextResponse> => {
  pruneRateLimitWindows()

  // 1. Rate limit BEFORE authentication, so failed attempts are bounded too.
  const ipLimit = checkRateLimit(clientBucket(request), {
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
  })
  if (!ipLimit.allowed) rateLimited(ipLimit.retryAfterSeconds)

  // 2. Authenticate on the credential alone — never on anything in the payload.
  const secret = readSecret(request)
  const expected = getEnv().FORM_CAPTURE_SECRET
  // No secret configured => nobody can authenticate. The safe direction, and
  // indistinguishable from a wrong secret to the caller.
  if (!secret || !expected || !secretMatches(secret, expected)) authenticationFailed()

  // 3. Bound what an authenticated caller can cost.
  const spendLimit = checkRateLimit('lead-capture:authenticated', {
    limit: AUTHENTICATED_LIMIT,
    windowMs: AUTHENTICATED_WINDOW_MS,
  })
  if (!spendLimit.allowed) rateLimited(spendLimit.retryAfterSeconds)

  // 4. Parse. A malformed body is a client error, not a 500.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ValidationError('Request body must be valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.')
  }

  // 5. Delegate. The service validates with `automaticLeadCaptureSchema` and
  //    owns every business rule; nothing above duplicated any of it.
  await captureAutomaticLead(buildCaptureInput(body as Record<string, unknown>))

  // 202: the lead is recorded, but qualification runs asynchronously through
  // Inngest, so the work is accepted rather than complete.
  //
  // The body is deliberately bare. Reporting whether the lead was newly
  // created, or whether it enrolled, would turn this anonymous endpoint into
  // an oracle telling an attacker which email addresses already exist in the
  // CRM. Acceptance is all a form needs to know.
  return NextResponse.json({ status: 'accepted' }, { status: 202 })
})
