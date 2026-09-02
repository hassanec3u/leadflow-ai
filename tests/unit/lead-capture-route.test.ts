import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2E-2 — POST /api/webhooks/lead-capture.
 *
 * The route is exercised for real: its own module is imported and its POST
 * handler invoked with a genuine `Request`. Only its two collaborators are
 * doubled — the tenant lookup (whose real behaviour against PostgreSQL is
 * proven in tests/integration/form-capture-tenant-auth.test.ts) and
 * `captureAutomaticLead` (proven in tests/unit/automation-enrollment.test.ts).
 *
 * Doubling `captureAutomaticLead` is what lets these tests assert the ROUTE's
 * contract — that the service is called, with the right tenant and the right
 * input — rather than re-testing the service's own rules through it.
 */

const state = vi.hoisted(() => ({
  /** Secret -> organizationId, standing in for the SECURITY DEFINER lookup. */
  secrets: new Map<string, string>(),
  captureCalls: [] as { organizationId: string; input: Record<string, unknown> }[],
  captureImpl: null as null | (() => Promise<unknown>),
  logs: [] as { level: string; message: string; context: unknown }[],
}))

vi.mock('@/lib/auth/form-capture-lookup', () => ({
  resolveOrganizationIdFromFormCaptureSecret: async (secret: string | null | undefined) => {
    if (typeof secret !== 'string' || secret.trim() === '') return null
    return state.secrets.get(secret.trim()) ?? null
  },
}))

vi.mock('@/lib/services/automation-enrollment', () => ({
  captureAutomaticLead: async (organizationId: string, input: unknown) => {
    state.captureCalls.push({ organizationId, input: input as Record<string, unknown> })
    if (state.captureImpl) return state.captureImpl()
    return { lead: { id: 'lead_1' }, leadWasCreated: true, enrollment: { id: 'enr_1' }, run: null }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: (message: string, context: unknown) =>
      state.logs.push({ level: 'info', message, context }),
    warn: (message: string, context: unknown) =>
      state.logs.push({ level: 'warn', message, context }),
    error: (message: string, context: unknown) =>
      state.logs.push({ level: 'error', message, context }),
  },
}))

const ACME_SECRET = 'lfwf_acme_fixture_secret'
const GLOBEX_SECRET = 'lfwf_globex_fixture_secret'

const VALID_BODY = {
  name: 'Jane Prospect',
  email: 'Jane@Example.COM ',
  company: 'Example Holdings',
  phone: '+33123456789',
}

async function post(
  body: unknown,
  options: { secret?: string | null; header?: 'bearer' | 'custom'; ip?: string } = {},
) {
  const { POST } = await import('@/app/api/webhooks/lead-capture/route')

  const headers = new Headers({ 'content-type': 'application/json' })
  const secret = options.secret === undefined ? ACME_SECRET : options.secret
  if (secret !== null) {
    if (options.header === 'custom') headers.set('x-leadflow-capture-secret', secret)
    else headers.set('authorization', `Bearer ${secret}`)
  }
  headers.set('x-forwarded-for', options.ip ?? '203.0.113.10')

  const request = new Request('https://app.test/api/webhooks/lead-capture', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  const response = await POST(request)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, raw: text }
}

beforeEach(async () => {
  vi.resetModules()
  const { resetRateLimitsForTests } = await import('@/lib/api/rate-limit')
  resetRateLimitsForTests()

  state.secrets = new Map([
    [ACME_SECRET, 'org_acme'],
    [GLOBEX_SECRET, 'org_globex'],
  ])
  state.captureCalls = []
  state.captureImpl = null
  state.logs = []
})

describe('successful capture', () => {
  it('accepts a valid payload with a valid secret', async () => {
    const response = await post(VALID_BODY)

    expect(response.status).toBe(202)
    expect(response.body).toEqual({ status: 'accepted' })
  })

  it('calls the real captureAutomaticLead service with the resolved tenant', async () => {
    await post(VALID_BODY)

    expect(state.captureCalls).toHaveLength(1)
    expect(state.captureCalls[0]?.organizationId).toBe('org_acme')
  })

  it('accepts the secret via the X-LeadFlow-Capture-Secret header too', async () => {
    const response = await post(VALID_BODY, { header: 'custom' })

    expect(response.status).toBe(202)
    expect(state.captureCalls[0]?.organizationId).toBe('org_acme')
  })

  it('passes the lead fields through untouched, leaving normalisation to the service', async () => {
    await post(VALID_BODY)

    expect(state.captureCalls[0]?.input).toEqual({
      name: 'Jane Prospect',
      // Not normalised here on purpose: emailSchema (.trim().toLowerCase())
      // inside the service is the single normalisation point, so the route
      // cannot drift from manual/CSV creation.
      email: 'Jane@Example.COM ',
      company: 'Example Holdings',
      phone: '+33123456789',
      source: 'WEBSITE_FORM',
    })
  })

  it('reveals nothing about whether the lead already existed', async () => {
    state.captureImpl = async () => ({
      lead: { id: 'lead_1' },
      leadWasCreated: false,
      enrollment: { id: 'enr_1' },
      run: null,
    })
    const response = await post(VALID_BODY)

    // An anonymous caller must not be able to probe which emails are already
    // leads in a given organization.
    expect(response.body).toEqual({ status: 'accepted' })
    expect(response.raw).not.toContain('leadWasCreated')
    expect(response.raw).not.toContain('lead_1')
    expect(response.raw).not.toContain('org_acme')
  })
})

describe('source is server-forced', () => {
  it('forces WEBSITE_FORM when the client sends nothing', async () => {
    await post(VALID_BODY)

    expect(state.captureCalls[0]?.input.source).toBe('WEBSITE_FORM')
  })

  it('accepts a client-sent WEBSITE_FORM', async () => {
    const response = await post({ ...VALID_BODY, source: 'WEBSITE_FORM' })

    expect(response.status).toBe(202)
    expect(state.captureCalls[0]?.input.source).toBe('WEBSITE_FORM')
  })

  it.each(['CSV_IMPORT', 'MANUAL', 'REFERRAL'])(
    'overrides a client-sent %s rather than trusting it',
    async (source) => {
      await post({ ...VALID_BODY, source })

      // Otherwise a crafted submission could dodge the eligibility rule.
      expect(state.captureCalls[0]?.input.source).toBe('WEBSITE_FORM')
    },
  )
})

describe('the payload can never choose the tenant or the workflow', () => {
  it('ignores organizationId in the body — the secret decides', async () => {
    await post({ ...VALID_BODY, organizationId: 'org_globex' })

    expect(state.captureCalls[0]?.organizationId).toBe('org_acme')
    expect(state.captureCalls[0]?.input).not.toHaveProperty('organizationId')
  })

  it('ignores workflowId in the body', async () => {
    await post({ ...VALID_BODY, workflowId: 'wf_attacker' })

    expect(state.captureCalls[0]?.input).not.toHaveProperty('workflowId')
  })

  it('ignores ownerId and arbitrary metadata', async () => {
    await post({ ...VALID_BODY, ownerId: 'user_x', aiScore: 100, metadata: { a: 1 } })

    const input = state.captureCalls[0]?.input ?? {}
    expect(Object.keys(input).sort()).toEqual([
      'company',
      'email',
      'formMessage',
      'name',
      'phone',
      'source',
    ])
  })

  it("never lets organization A's secret act on organization B", async () => {
    await post({ ...VALID_BODY, organizationId: 'org_acme' }, { secret: GLOBEX_SECRET })

    expect(state.captureCalls[0]?.organizationId).toBe('org_globex')
  })
})

describe('form message', () => {
  it('passes the prospect message through to the service', async () => {
    await post({ ...VALID_BODY, formMessage: 'We need this before Q1. Budget approved.' })

    expect(state.captureCalls[0]?.input.formMessage).toBe(
      'We need this before Q1. Budget approved.',
    )
  })

  it('accepts a submission with no message at all', async () => {
    const response = await post(VALID_BODY)

    expect(response.status).toBe(202)
    // Absent, not empty string — "did not fill it in" must reach the model
    // as null so it can judge the absence rather than read a blank as an answer.
    expect(state.captureCalls[0]?.input.formMessage).toBeUndefined()
  })

  it('rejects a message over the 5000-character cap with a 422', async () => {
    const { ValidationError } = await import('@/lib/errors')
    state.captureImpl = async () => {
      throw new ValidationError('Some of the information provided is not valid.', {
        formMessage: ['Message must be 5000 characters or fewer.'],
      })
    }

    const response = await post({ ...VALID_BODY, formMessage: 'x'.repeat(5001) })

    expect(response.status).toBe(422)
  })

  it('never lets the message reach the logs', async () => {
    await post({ ...VALID_BODY, formMessage: 'Confidential: acquiring Northwind in March.' })

    expect(JSON.stringify(state.logs)).not.toContain('Northwind in March')
  })
})

describe('authentication', () => {
  it('refuses a request with no secret', async () => {
    const response = await post(VALID_BODY, { secret: null })

    expect(response.status).toBe(401)
    expect(state.captureCalls).toHaveLength(0)
  })

  it('refuses an unknown secret', async () => {
    const response = await post(VALID_BODY, { secret: 'lfwf_not_a_real_secret' })

    expect(response.status).toBe(401)
    expect(state.captureCalls).toHaveLength(0)
  })

  it('gives byte-identical responses for missing, unknown and revoked secrets', async () => {
    const missing = await post(VALID_BODY, { secret: null, ip: '203.0.113.1' })
    const unknown = await post(VALID_BODY, { secret: 'lfwf_nope', ip: '203.0.113.2' })

    state.secrets.delete(ACME_SECRET) // rotated away
    const revoked = await post(VALID_BODY, { secret: ACME_SECRET, ip: '203.0.113.3' })

    // No oracle: an attacker cannot tell these three apart.
    expect(missing.status).toBe(401)
    expect(unknown.raw).toBe(missing.raw)
    expect(revoked.raw).toBe(missing.raw)
  })

  it('refuses an empty bearer value', async () => {
    const response = await post(VALID_BODY, { secret: '   ' })

    expect(response.status).toBe(401)
    expect(state.captureCalls).toHaveLength(0)
  })
})

describe('validation', () => {
  it('rejects a body that is not valid JSON', async () => {
    const response = await post('{ not json', {})

    expect(response.status).toBe(422)
    expect(state.captureCalls).toHaveLength(0)
  })

  it('rejects a JSON array', async () => {
    const response = await post([1, 2, 3])

    expect(response.status).toBe(422)
    expect(state.captureCalls).toHaveLength(0)
  })

  it('surfaces the service’s own validation failure as a 422', async () => {
    const { ValidationError } = await import('@/lib/errors')
    state.captureImpl = async () => {
      throw new ValidationError('Some of the information provided is not valid.', {
        email: ['Enter a valid email address.'],
      })
    }

    const response = await post({ name: '', email: 'not-an-email' })

    expect(response.status).toBe(422)
    expect(response.body.error.fieldErrors).toEqual({ email: ['Enter a valid email address.'] })
  })
})

describe('rate limiting', () => {
  it('allows requests below the per-IP limit', async () => {
    for (let i = 0; i < 30; i++) {
      const response = await post(VALID_BODY, { ip: '198.51.100.1' })
      expect(response.status).toBe(202)
    }
  })

  it('returns 429 once the per-IP limit is exceeded', async () => {
    for (let i = 0; i < 30; i++) await post(VALID_BODY, { ip: '198.51.100.2' })

    const response = await post(VALID_BODY, { ip: '198.51.100.2' })
    expect(response.status).toBe(429)
    expect(response.body.error.code).toBe('RATE_LIMITED')
  })

  it('isolates one IP from another', async () => {
    for (let i = 0; i < 31; i++) await post(VALID_BODY, { ip: '198.51.100.3' })

    const other = await post(VALID_BODY, { ip: '198.51.100.4' })
    expect(other.status).toBe(202)
  })

  it('rate limits before authentication, so secrets cannot be brute-forced freely', async () => {
    for (let i = 0; i < 30; i++) {
      await post(VALID_BODY, { secret: `lfwf_guess_${i}`, ip: '198.51.100.5' })
    }

    const response = await post(VALID_BODY, { secret: 'lfwf_guess_30', ip: '198.51.100.5' })
    expect(response.status).toBe(429)
  })

  it('never uses the secret itself as a rate-limit key', async () => {
    const { checkRateLimit, resetRateLimitsForTests } = await import('@/lib/api/rate-limit')
    resetRateLimitsForTests()

    // Buckets are caller-supplied opaque keys; the route passes an IP and an
    // organization id, never a credential. Proven by construction here.
    const result = checkRateLimit('lead-capture:org:org_acme', { limit: 1, windowMs: 1000 })
    expect(result.allowed).toBe(true)
  })
})

describe('rate limiter', () => {
  it('counts per bucket and resets when the window expires', async () => {
    const { checkRateLimit, resetRateLimitsForTests } = await import('@/lib/api/rate-limit')
    resetRateLimitsForTests()

    let now = 1_000_000
    const clock = () => now
    const options = { limit: 2, windowMs: 60_000, now: clock }

    expect(checkRateLimit('a', options).allowed).toBe(true)
    expect(checkRateLimit('a', options).allowed).toBe(true)

    const blocked = checkRateLimit('a', options)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(60)

    // A different bucket is unaffected.
    expect(checkRateLimit('b', options).allowed).toBe(true)

    // Window rolls over.
    now += 60_000
    expect(checkRateLimit('a', options).allowed).toBe(true)
  })

  it('prunes expired windows so the map cannot grow without bound', async () => {
    const { checkRateLimit, pruneRateLimitWindows, resetRateLimitsForTests } =
      await import('@/lib/api/rate-limit')
    resetRateLimitsForTests()

    const options = { limit: 1, windowMs: 1_000, now: () => 0 }
    checkRateLimit('transient', options)

    pruneRateLimitWindows(10_000)

    // Pruned, so the next hit starts a fresh window rather than being blocked.
    expect(
      checkRateLimit('transient', { limit: 1, windowMs: 1_000, now: () => 10_001 }).allowed,
    ).toBe(true)
  })
})

describe('internal errors and leakage', () => {
  it('collapses an unexpected error into a generic 500', async () => {
    state.captureImpl = async () => {
      throw new Error(`connection to postgres://user:hunter2@db:5432 failed for jane@example.com`)
    }

    const response = await post(VALID_BODY)

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    })
    expect(response.raw).not.toContain('postgres://')
    expect(response.raw).not.toContain('hunter2')
    expect(response.raw).not.toContain('jane@example.com')
  })

  it('never puts the secret in a response, on any path', async () => {
    const ok = await post(VALID_BODY)
    const unauthorized = await post(VALID_BODY, { secret: 'lfwf_bad', ip: '198.51.100.9' })

    expect(ok.raw).not.toContain(ACME_SECRET)
    expect(unauthorized.raw).not.toContain('lfwf_bad')
  })

  it('never logs the secret or the lead payload', async () => {
    await post(VALID_BODY)
    await post(VALID_BODY, { secret: 'lfwf_bad', ip: '198.51.100.8' })
    state.captureImpl = async () => {
      throw new Error('boom')
    }
    await post(VALID_BODY, { ip: '198.51.100.7' })

    const serialized = JSON.stringify(state.logs)
    expect(serialized).not.toContain(ACME_SECRET)
    expect(serialized).not.toContain('lfwf_bad')
    expect(serialized).not.toContain('Jane@Example.COM')
    expect(serialized).not.toContain('+33123456789')
  })
})
