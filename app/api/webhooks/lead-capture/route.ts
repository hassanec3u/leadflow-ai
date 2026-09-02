import { NextResponse } from 'next/server'

import { withApiErrorHandling } from '@/lib/api/handler'
import { checkRateLimit, pruneRateLimitWindows } from '@/lib/api/rate-limit'
import { resolveOrganizationIdFromFormCaptureSecret } from '@/lib/auth/form-capture-lookup'
import { AppError, UnauthenticatedError, ValidationError } from '@/lib/errors'
import { captureAutomaticLead } from '@/lib/services/automation-enrollment'

/**
 * Public Website Form lead capture (Phase 2E-2).
 *
 *   POST /api/webhooks/lead-capture
 *
 * The production entry point the whole Phase 2 automation chain was missing:
 * form submission -> tenant authentication -> captureAutomaticLead() ->
 * WorkflowEnrollment -> PENDING WorkflowRun -> automation/run.requested ->
 * Inngest -> engine. The path is the one docs/architecture.md §6 specifies.
 *
 * Deliberately thin. Every business rule — email normalisation, duplicate
 * merge, workflow lookup, PAUSED handling, enrollment uniqueness, the PENDING
 * run, emitting after commit — stays in `captureAutomaticLead()` and is not
 * reimplemented, re-checked or second-guessed here. This file does four
 * things: rate limit, authenticate the tenant, validate input, delegate.
 *
 * =============================================================================
 * WHY THIS ENDPOINT IS SAFE TO EXPOSE ANONYMOUSLY
 * =============================================================================
 * It never reads an organization identifier from the request. The tenant is
 * resolved exclusively from a per-organization capture secret, through
 * `resolveOrganizationIdFromFormCaptureSecret()` (Phase 2E-1), which looks the
 * secret up by hash via a narrow SECURITY DEFINER function. `organizationId`,
 * `slug`, `workflowId` and `ownerId` in the body are not merely rejected as
 * authority — they are never read at all (see `buildCaptureInput`). Postgres
 * RLS remains the second barrier: everything after resolution runs inside
 * `withTenant()` within the service.
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
 * Per-organization, applied AFTER resolution. A valid credential still cannot
 * run up an unbounded enrichment/OpenAI bill (architecture.md §132).
 */
const ORG_LIMIT = 120
const ORG_WINDOW_MS = 60_000

/**
 * Identical response for every authentication failure — absent secret, unknown
 * secret, rotated-away secret, soft-deleted organization. The endpoint must
 * not be usable as an oracle for which secrets or organizations exist.
 */
function authenticationFailed(): never {
  throw new UnauthenticatedError('Invalid capture credentials.')
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
 * the per-organization limit below is the one that binds an authenticated
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
 * through — is what makes `organizationId`, `workflowId`, `ownerId` and any
 * other field structurally incapable of reaching the service: they are never
 * copied. `source` is set here, after the client's value is discarded, so a
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

  // 2. Resolve the tenant from the credential alone — never from the payload.
  const secret = readSecret(request)
  if (!secret) authenticationFailed()

  const organizationId = await resolveOrganizationIdFromFormCaptureSecret(secret)
  if (!organizationId) authenticationFailed()

  // 3. Now that a tenant is known, bound what one credential can cost.
  const orgLimit = checkRateLimit(`lead-capture:org:${organizationId}`, {
    limit: ORG_LIMIT,
    windowMs: ORG_WINDOW_MS,
  })
  if (!orgLimit.allowed) rateLimited(orgLimit.retryAfterSeconds)

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
  await captureAutomaticLead(organizationId, buildCaptureInput(body as Record<string, unknown>))

  // 202: the lead is recorded, but qualification runs asynchronously through
  // Inngest, so the work is accepted rather than complete.
  //
  // The body is deliberately bare. Reporting whether the lead was newly
  // created, or whether it enrolled, would turn this anonymous endpoint into
  // an oracle telling an attacker which email addresses already exist in a
  // given organization's CRM. Acceptance is all a form needs to know.
  return NextResponse.json({ status: 'accepted' }, { status: 202 })
})
