import { describe, expect, it, vi } from 'vitest'

import {
  APOLLO_ERROR,
  ApolloEnrichmentProvider,
  mapApolloSeniority,
  type FetchLike,
} from '@/lib/automation/apollo-enrichment-provider'
import {
  ProviderCallError,
  type EnrichmentProvider,
  type LeadFacts,
  type Seniority,
} from '@/lib/automation/providers'

/**
 * Phase 2D-4 — the Apollo enrichment provider.
 *
 * `fetch` is injected as a fake in every test, so no request ever leaves the
 * process and no APOLLO_API_KEY is required. Response fixtures follow the
 * documented People Enrichment shape: firmographics nested under
 * `person.organization`, and a no-match returned as a 200 with a null person.
 */

const API_KEY = 'test-apollo-key-do-not-use'

const lead: LeadFacts = {
  id: 'lead_1',
  name: 'Ada Lovelace',
  email: 'ada@analyticalengines.com',
  company: 'Analytical Engines Inc',
  phone: null,
  formMessage: null,
  source: 'WEBSITE_FORM',
}

const call = { idempotencyKey: 'step_1', organizationId: 'org_1' }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeProvider(impl: FetchLike) {
  const fetchImpl = vi.fn(impl)
  const provider = new ApolloEnrichmentProvider({ apiKey: API_KEY, fetchImpl })
  return { provider, fetchImpl }
}

/** A full, documented-shape match. */
const matchedPerson = {
  person: {
    name: 'Ada Lovelace',
    title: 'Head of Revenue',
    seniority: 'head',
    organization: {
      name: 'Analytical Engines Inc',
      website_url: 'http://www.analyticalengines.com',
      primary_domain: 'analyticalengines.com',
      industry: 'information technology & services',
      estimated_num_employees: 120,
      country: 'United Kingdom',
    },
  },
}

describe('successful match', () => {
  it('maps the documented Apollo shape onto the enrichment contract', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matchedPerson))
    const result = await provider.enrich({ ...call, lead })

    expect(result.provider).toBe('apollo')
    expect(result.data).toEqual({
      company: {
        name: 'Analytical Engines Inc',
        website: 'http://www.analyticalengines.com',
        industry: 'information technology & services',
        employeeCount: 120,
        country: 'United Kingdom',
      },
      person: { jobTitle: 'Head of Revenue', seniority: 'DIRECTOR' },
      lead: { source: 'WEBSITE_FORM' },
    })
  })

  it('calls the documented endpoint with the x-api-key header', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matchedPerson))
    await provider.enrich({ ...call, lead })

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.apollo.io/api/v1/people/match')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe(API_KEY)
  })

  it('prioritises the email lookup', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matchedPerson))
    await provider.enrich({ ...call, lead })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body.email).toBe('ada@analyticalengines.com')
    expect(body).not.toHaveProperty('organization_name')
  })

  it('falls back to name plus company domain when the email is unusable', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matchedPerson))
    await provider.enrich({ ...call, lead: { ...lead, email: 'not-an-email' } })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).not.toHaveProperty('email')
    expect(body.name).toBe('Ada Lovelace')
    expect(body.organization_name).toBe('Analytical Engines Inc')
  })

  it('disables phone, personal email and waterfall enrichment on every request', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matchedPerson))
    await provider.enrich({ ...call, lead })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      reveal_personal_emails: false,
      reveal_phone_number: false,
      run_waterfall_email: false,
      run_waterfall_phone: false,
    })
  })

  it('returns no phone field at all — phone enrichment is out of scope', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matchedPerson))
    const result = await provider.enrich({ ...call, lead })

    expect(JSON.stringify(result.data)).not.toContain('phone')
  })
})

describe('no match', () => {
  it('treats a 200 with a null person as a successful all-null result', async () => {
    const { provider } = makeProvider(async () => jsonResponse({ person: null }))
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company).toEqual({
      name: null,
      website: null,
      industry: null,
      employeeCount: null,
      country: null,
    })
    expect(result.data.person).toEqual({ jobTitle: null, seniority: null })
    expect(result.data.lead).toEqual({ source: 'WEBSITE_FORM' })
  })

  it('treats a body with no person key at all as no match', async () => {
    const { provider } = makeProvider(async () => jsonResponse({ request_id: 'abc' }))
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.person.jobTitle).toBeNull()
  })

  it('does not call Apollo when the lead yields no usable identifier', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matchedPerson))
    const result = await provider.enrich({
      ...call,
      lead: { ...lead, email: '', name: '', company: null },
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.data.company.name).toBeNull()
  })
})

describe('partial data', () => {
  it('nulls each field Apollo omits, without inventing a value', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        person: {
          title: 'Operations Manager',
          seniority: null,
          organization: { name: 'Analytical Engines Inc', industry: null },
        },
      }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company).toEqual({
      name: 'Analytical Engines Inc',
      website: null,
      industry: null,
      employeeCount: null,
      country: null,
    })
    expect(result.data.person).toEqual({ jobTitle: 'Operations Manager', seniority: null })
  })

  it('falls back to primary_domain when website_url is absent', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        person: { organization: { primary_domain: 'analyticalengines.com' } },
      }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company.website).toBe('analyticalengines.com')
  })

  it('treats a missing organization as unknown firmographics, not a failure', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ person: { title: 'Founder', seniority: 'founder' } }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company.name).toBeNull()
    expect(result.data.person).toEqual({ jobTitle: 'Founder', seniority: 'EXECUTIVE' })
  })

  it('rejects a zero or negative headcount as unknown rather than reporting 0', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ person: { organization: { estimated_num_employees: 0 } } }),
    )
    const result = await provider.enrich({ ...call, lead })

    // 0 would read to the model as "a company with no employees".
    expect(result.data.company.employeeCount).toBeNull()
  })

  it('treats blank strings as absent', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ person: { title: '   ', organization: { name: '' } } }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.person.jobTitle).toBeNull()
    expect(result.data.company.name).toBeNull()
  })
})

describe('seniority mapping', () => {
  const cases: [string, Seniority][] = [
    ['owner', 'EXECUTIVE'],
    ['founder', 'EXECUTIVE'],
    ['c_suite', 'EXECUTIVE'],
    ['partner', 'EXECUTIVE'],
    ['vp', 'EXECUTIVE'],
    ['head', 'DIRECTOR'],
    ['director', 'DIRECTOR'],
    ['manager', 'MANAGER'],
    ['senior', 'INDIVIDUAL_CONTRIBUTOR'],
    ['entry', 'INDIVIDUAL_CONTRIBUTOR'],
    ['intern', 'INDIVIDUAL_CONTRIBUTOR'],
  ]

  it.each(cases)('maps Apollo "%s" to %s', (apollo, expected) => {
    expect(mapApolloSeniority(apollo)).toBe(expected)
  })

  it('is case and whitespace insensitive', () => {
    expect(mapApolloSeniority('  C_Suite ')).toBe('EXECUTIVE')
  })

  it('maps an unrecognised value to OTHER', () => {
    expect(mapApolloSeniority('galactic_overlord')).toBe('OTHER')
  })

  it('keeps an absent value null — unknown is not OTHER', () => {
    expect(mapApolloSeniority(null)).toBeNull()
    expect(mapApolloSeniority(undefined)).toBeNull()
    expect(mapApolloSeniority('')).toBeNull()
  })
})

describe('failure classification', () => {
  const failsWith = (status: number) => makeProvider(async () => jsonResponse({}, status))

  it('treats 429 as retriable', async () => {
    const { provider } = failsWith(429)
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.rateLimited,
      retriable: true,
    })
  })

  it.each([500, 502, 503])('treats %d as retriable', async (status) => {
    const { provider } = failsWith(status)
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.unavailable,
      retriable: true,
    })
  })

  it.each([401, 403])('treats %d as a non-retriable configuration error', async (status) => {
    const { provider } = failsWith(status)
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.auth,
      retriable: false,
    })
  })

  it.each([404, 422])('treats %d as a non-retriable bad request', async (status) => {
    const { provider } = failsWith(status)
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.requestInvalid,
      retriable: false,
    })
  })

  it('treats a network fault as retriable', async () => {
    const { provider } = makeProvider(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.unavailable,
      retriable: true,
    })
  })

  it('rejects a malformed response instead of returning partial data', async () => {
    const { provider } = makeProvider(async () => jsonResponse({ person: { title: 42 } }))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.malformed,
    })
  })

  it('rejects a body that is not valid JSON', async () => {
    const { provider } = makeProvider(
      async () => new Response('<html>gateway error</html>', { status: 200 }),
    )
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: APOLLO_ERROR.malformed,
    })
  })

  it('never returns invented data on failure', async () => {
    const { provider } = failsWith(500)
    const outcome = await provider.enrich({ ...call, lead }).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(ProviderCallError)
    expect(outcome).not.toHaveProperty('data')
  })
})

describe('secrets and logging', () => {
  it('never logs anything, on success or failure', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]

    const ok = makeProvider(async () => jsonResponse(matchedPerson))
    await ok.provider.enrich({ ...call, lead })

    const bad = makeProvider(async () => jsonResponse({}, 401))
    await bad.provider.enrich({ ...call, lead }).catch(() => {})

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })

  it('keeps the API key out of the error surface', async () => {
    const { provider } = makeProvider(async () => jsonResponse({}, 401))
    const error = (await provider
      .enrich({ ...call, lead })
      .catch((e: unknown) => e)) as ProviderCallError

    expect(error.message).not.toContain(API_KEY)
    expect(JSON.stringify(error.message)).not.toContain(API_KEY)
  })

  it('builds error messages from the status, never from the response body', async () => {
    // The engine persists `error.message` on the step row, so a body echoing
    // the submitted lead back must not reach it.
    const { provider } = makeProvider(async () =>
      jsonResponse({ error: `invalid request for ${lead.email}` }, 422),
    )
    const error = (await provider
      .enrich({ ...call, lead })
      .catch((e: unknown) => e)) as ProviderCallError

    expect(error.message).not.toContain(lead.email)
    expect(error.message).toContain('422')
  })

  it('sends the API key only as a header, never in the request body', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matchedPerson))
    await provider.enrich({ ...call, lead })

    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(API_KEY)
  })
})

describe('contract compatibility', () => {
  it('is structurally an EnrichmentProvider', () => {
    const { provider } = makeProvider(async () => jsonResponse(matchedPerson))
    const typed: EnrichmentProvider = provider

    expect(typed.name).toBe('apollo')
  })

  it('echoes the lead source, and carries no form message', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matchedPerson))
    const result = await provider.enrich({ ...call, lead: { ...lead, source: 'WEBHOOK' } })

    // Apollo cannot know the lead's own form submission.
    // The prospect's message is not part of the enrichment contract — it
    // travels on LeadFacts and reaches the model once.
    expect(result.data.lead).toEqual({ source: 'WEBHOOK' })
  })

  it('preserves the idempotencyKey in the provider interface', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matchedPerson))

    // Accepted and honoured as part of the ProviderCall envelope; Apollo's
    // match endpoint is a read, so there is no side effect to de-duplicate.
    await expect(
      provider.enrich({ idempotencyKey: 'step_42', lead }),
    ).resolves.toHaveProperty('provider', 'apollo')
  })
})
