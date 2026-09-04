import { describe, expect, it, vi } from 'vitest'

import {
  buildOutreachEmail,
  EMAIL_PROVIDER_ERROR,
  ResendEmailProvider,
  type ResendEmailClient,
} from '@/lib/automation/resend-email-provider'
import { ProviderCallError, type LeadFacts } from '@/lib/automation/providers'

/**
 * The production Resend email provider.
 *
 * The Resend client is injected as a fake, so no request ever leaves the
 * process and no RESEND_API_KEY is required. What is under test is this
 * provider's own behaviour: what it sends, what it returns, what it refuses
 * to put in the message, and how it classifies failures.
 *
 * Resend does NOT throw on an API error — it resolves with `{ data: null,
 * error }`. Half these tests exist because that is easy to get wrong.
 */

const lead: LeadFacts = {
  id: 'lead_1',
  name: 'Marc Dubois',
  email: 'marc.dubois@northwind.example',
  company: 'Northwind Software',
  phone: null,
  formMessage: 'We have budget approved for Q1 and need to replace our CRM.',
  source: 'WEBSITE_FORM',
}

const FROM = 'LeadFlow <leads@leadflow.test>'

type SendArgs = Parameters<ResendEmailClient['emails']['send']>

function makeClient(
  result: Awaited<ReturnType<ResendEmailClient['emails']['send']>>,
): ResendEmailClient & { calls: SendArgs[] } {
  const calls: SendArgs[] = []
  return {
    calls,
    emails: {
      send: vi.fn(async (...args: SendArgs) => {
        calls.push(args)
        return result
      }),
    },
  }
}

function ok() {
  return { data: { id: 'resend_msg_1' }, error: null } as const
}

function apiError(name: string, statusCode: number | null = 400) {
  return { data: null, error: { name, message: `simulated ${name}`, statusCode } } as never
}

function makeProvider(result: Awaited<ReturnType<ResendEmailClient['emails']['send']>>) {
  const client = makeClient(result)
  return { client, provider: new ResendEmailProvider({ client, from: FROM }) }
}

describe('buildOutreachEmail', () => {
  it('greets the lead by first name only', () => {
    const email = buildOutreachEmail({ lead })

    expect(email.subject).toContain('Marc')
    expect(email.subject).not.toContain('Dubois')
    expect(email.text).toContain('Bonjour Marc,')
  })

  it("quotes the prospect's own message back to them", () => {
    const email = buildOutreachEmail({ lead })

    expect(email.text).toContain('We have budget approved for Q1')
  })

  it('omits the quote block entirely when no message was written', () => {
    const email = buildOutreachEmail({ lead: { ...lead, formMessage: null } })

    // Absent, not an empty quote — an empty « » would look broken.
    expect(email.text).not.toContain('«')
    expect(email.text).toContain('Bonjour Marc,')
  })

  it('never puts the prospect message in the subject (header-injection guard)', () => {
    const email = buildOutreachEmail({
      lead: { ...lead, formMessage: 'hello\nBcc: attacker@evil.test' },
    })

    expect(email.subject).not.toContain('Bcc')
    expect(email.subject).not.toContain('\n')
  })

  it('falls back to a neutral greeting when the name is unusable', () => {
    const email = buildOutreachEmail({ lead: { ...lead, name: '   ' } })

    expect(email.text).toContain('Bonjour,')
    expect(email.subject).not.toContain('undefined')
  })
})

describe('ResendEmailProvider.send', () => {
  it('sends to the lead, from the configured address, and returns the message id', async () => {
    const { client, provider } = makeProvider(ok())

    const result = await provider.send({ idempotencyKey: 'step_1', lead, summary: null })

    expect(result).toEqual({ providerMessageId: 'resend_msg_1' })
    const [payload] = client.calls[0]!
    expect(payload.to).toBe('marc.dubois@northwind.example')
    expect(payload.from).toBe(FROM)
  })

  it('passes the step id as the idempotency key so a retry cannot double-send', async () => {
    const { client, provider } = makeProvider(ok())

    await provider.send({ idempotencyKey: 'step_42', lead, summary: null })

    const [, options] = client.calls[0]!
    expect(options?.idempotencyKey).toBe('step_42')
  })

  it('sends plain text only — no HTML body to inject into', async () => {
    const { client, provider } = makeProvider(ok())

    await provider.send({ idempotencyKey: 'step_1', lead, summary: null })

    const [payload] = client.calls[0]!
    expect(payload.text).toBeTruthy()
    expect(payload).not.toHaveProperty('html')
  })

  it('NEVER includes the internal AI summary in the message', async () => {
    // The summary explains the SCORE to the sales team ("company unverified,
    // authority doubtful"). Mailing that to the prospect would leak internal
    // scoring rationale — the whole reason this provider ignores the field.
    const summary = 'Company details not verified; authority in doubt. Score 66.'
    const { client, provider } = makeProvider(ok())

    await provider.send({ idempotencyKey: 'step_1', lead, summary })

    const [payload] = client.calls[0]!
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('not verified')
    expect(serialized).not.toContain('authority in doubt')
    expect(serialized).not.toContain('Score 66')
  })

  it.each([
    ['rate_limit_exceeded', EMAIL_PROVIDER_ERROR.rateLimited],
    ['internal_server_error', EMAIL_PROVIDER_ERROR.unavailable],
    ['application_error', EMAIL_PROVIDER_ERROR.unavailable],
    ['concurrent_idempotent_requests', EMAIL_PROVIDER_ERROR.unavailable],
  ])('treats %s as retriable', async (name, expectedCode) => {
    const { provider } = makeProvider(apiError(name, 429))

    const error = await provider
      .send({ idempotencyKey: 'step_1', lead, summary: null })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderCallError)
    expect((error as ProviderCallError).retriable).toBe(true)
    expect((error as ProviderCallError).code).toBe(expectedCode)
  })

  it.each([
    ['invalid_api_key', EMAIL_PROVIDER_ERROR.auth],
    ['missing_api_key', EMAIL_PROVIDER_ERROR.auth],
    ['restricted_api_key', EMAIL_PROVIDER_ERROR.auth],
    ['validation_error', EMAIL_PROVIDER_ERROR.requestInvalid],
    ['invalid_from_address', EMAIL_PROVIDER_ERROR.requestInvalid],
    ['missing_required_field', EMAIL_PROVIDER_ERROR.requestInvalid],
    ['daily_quota_exceeded', EMAIL_PROVIDER_ERROR.quotaExceeded],
    ['monthly_quota_exceeded', EMAIL_PROVIDER_ERROR.quotaExceeded],
  ])('treats %s as NON-retriable', async (name, expectedCode) => {
    const { provider } = makeProvider(apiError(name, 401))

    const error = await provider
      .send({ idempotencyKey: 'step_1', lead, summary: null })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderCallError)
    expect((error as ProviderCallError).retriable).toBe(false)
    expect((error as ProviderCallError).code).toBe(expectedCode)
  })

  it('never leaks the prospect message or address into the thrown error', async () => {
    const { provider } = makeProvider(apiError('validation_error', 422))

    const error = (await provider
      .send({ idempotencyKey: 'step_1', lead, summary: null })
      .catch((caught: unknown) => caught)) as ProviderCallError

    // The error text reaches WorkflowStepRun.errorMessage, which is displayed
    // in the app and logged — it must stay free of lead PII.
    expect(error.message).not.toContain('marc.dubois@northwind.example')
    expect(error.message).not.toContain('budget approved')
  })

  it('treats a success response with no id as malformed rather than guessing', async () => {
    const { provider } = makeProvider({ data: null, error: null } as never)

    const error = await provider
      .send({ idempotencyKey: 'step_1', lead, summary: null })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderCallError)
    expect((error as ProviderCallError).code).toBe(EMAIL_PROVIDER_ERROR.malformed)
  })
})
