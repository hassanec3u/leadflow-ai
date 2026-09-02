import { describe, expect, it, vi } from 'vitest'

import {
  PROSPEO_ERROR,
  ProspeoEnrichmentProvider,
  mapProspeoSeniority,
  type FetchLike,
} from '@/lib/automation/prospeo-enrichment-provider'
import {
  ProviderCallError,
  type EnrichmentProvider,
  type LeadFacts,
  type Seniority,
} from '@/lib/automation/providers'

/**
 * Phase 2D-6 — the Prospeo enrichment provider.
 *
 * `fetch` is injected in every test, so nothing leaves the process and no
 * PROSPEO_API_KEY is needed. Fixtures follow the documented shape: identifiers
 * nested under `data`, seniority on `person.job_history[]`, company location
 * under `company.location`, and every failure (NO_MATCH included) as an
 * HTTP 400 carrying an `error_code`.
 */

const API_KEY = 'test-prospeo-key-do-not-use'

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
  const provider = new ProspeoEnrichmentProvider({ apiKey: API_KEY, fetchImpl })
  return { provider, fetchImpl }
}

/** Documented failure envelope: HTTP 400 + error_code. */
const failure = (code: string, status = 400) =>
  jsonResponse({ error: true, error_code: code }, status)

const matched = {
  error: false,
  person: {
    full_name: 'Ada Lovelace',
    current_job_title: 'Head of Revenue',
    job_history: [
      { title: 'Analyst', company_name: 'Old Co', current: false, seniority: 'Entry' },
      {
        title: 'Head of Revenue',
        company_name: 'Analytical Engines',
        current: true,
        seniority: 'Head',
      },
    ],
  },
  company: {
    name: 'Analytical Engines Inc',
    website: 'https://analyticalengines.com',
    industry: 'Information Technology',
    employee_count: 120,
    location: { country: 'United Kingdom', country_code: 'GB', city: 'London' },
  },
}

describe('successful match', () => {
  it('maps the documented Prospeo shape onto the enrichment contract', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matched))
    const result = await provider.enrich({ ...call, lead })

    expect(result.provider).toBe('prospeo')
    expect(result.data).toEqual({
      company: {
        name: 'Analytical Engines Inc',
        website: 'https://analyticalengines.com',
        industry: 'Information Technology',
        employeeCount: 120,
        country: 'United Kingdom',
      },
      person: { jobTitle: 'Head of Revenue', seniority: 'DIRECTOR' },
      lead: { source: 'WEBSITE_FORM' },
    })
  })

  it('calls the documented endpoint with the X-KEY header', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matched))
    await provider.enrich({ ...call, lead })

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.prospeo.io/enrich-person')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['X-KEY']).toBe(API_KEY)
  })

  it('nests identifiers under `data`, prioritising email and adding context', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matched))
    await provider.enrich({ ...call, lead })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body.data).toEqual({
      email: 'ada@analyticalengines.com',
      full_name: 'Ada Lovelace',
      company_name: 'Analytical Engines Inc',
    })
  })

  it('sends enrich_mobile explicitly false and never only_verified_mobile', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matched))
    await provider.enrich({ ...call, lead })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body.enrich_mobile).toBe(false)
    // Setting only_verified_mobile would switch enrich_mobile back on.
    expect(body).not.toHaveProperty('only_verified_mobile')
  })

  it('takes seniority from the CURRENT job, not the first one', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matched))
    const result = await provider.enrich({ ...call, lead })

    // job_history[0] is a past "Entry" role; the current one is "Head".
    expect(result.data.person.seniority).toBe('DIRECTOR')
  })

  it('keeps the country name and ignores country_code', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matched))
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company.country).toBe('United Kingdom')
    expect(JSON.stringify(result.data)).not.toContain('GB')
  })

  it('never returns email, mobile or phone data', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        ...matched,
        person: {
          ...matched.person,
          email: 'enriched.address@analyticalengines.com',
          mobile: '+441234567890',
        },
      }),
    )
    const result = await provider.enrich({ ...call, lead })

    const serialized = JSON.stringify(result.data)
    expect(serialized).not.toContain('enriched.address')
    expect(serialized).not.toContain('+441234567890')
    expect(serialized).not.toContain('mobile')
    expect(serialized).not.toContain('phone')
  })

  it('falls back to full_name + company_name when the email is unusable', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matched))
    await provider.enrich({ ...call, lead: { ...lead, email: 'not-an-email' } })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body.data).toEqual({
      full_name: 'Ada Lovelace',
      company_name: 'Analytical Engines Inc',
    })
  })
})

describe('no match', () => {
  it('treats HTTP 400 + NO_MATCH as a successful all-null result', async () => {
    const { provider } = makeProvider(async () => failure('NO_MATCH'))
    const result = await provider.enrich({ ...call, lead })

    expect(result.provider).toBe('prospeo')
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

  it('does not call Prospeo when the minimum datapoints are not available', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matched))
    const result = await provider.enrich({
      ...call,
      lead: { ...lead, email: 'nope', company: null },
    })

    // full_name alone does not satisfy the documented minimum.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.data.company.name).toBeNull()
  })
})

describe('partial data', () => {
  it('nulls each field Prospeo omits, without inventing a value', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        error: false,
        person: { current_job_title: 'Operations Manager' },
        company: { name: 'Analytical Engines Inc' },
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

  it('handles a missing company object entirely', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ error: false, person: { current_job_title: 'Founder' } }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company.name).toBeNull()
    expect(result.data.person.jobTitle).toBe('Founder')
  })

  it('handles explicit nulls throughout', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        error: false,
        person: { current_job_title: null, job_history: null },
        company: {
          name: null,
          website: null,
          industry: null,
          employee_count: null,
          location: null,
        },
      }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company.country).toBeNull()
    expect(result.data.person).toEqual({ jobTitle: null, seniority: null })
  })

  it('treats employee_count 0 as unknown, per the contract', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ error: false, company: { employee_count: 0 } }),
    )
    const result = await provider.enrich({ ...call, lead })

    // The contract forbids 0 as a stand-in: it would read to the model as
    // "a company with no employees". Same rule as the Apollo provider.
    expect(result.data.company.employeeCount).toBeNull()
  })

  it('keeps a real headcount of 1', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ error: false, company: { employee_count: 1 } }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.company.employeeCount).toBe(1)
  })

  it('returns null seniority when no job is marked current', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        error: false,
        person: { job_history: [{ current: false, seniority: 'Director' }] },
      }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.person.seniority).toBeNull()
  })

  it('treats blank strings as absent', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({
        error: false,
        person: { current_job_title: '  ' },
        company: { name: '', location: { country: '   ' } },
      }),
    )
    const result = await provider.enrich({ ...call, lead })

    expect(result.data.person.jobTitle).toBeNull()
    expect(result.data.company.name).toBeNull()
    expect(result.data.company.country).toBeNull()
  })
})

describe('seniority mapping', () => {
  const cases: [string, Seniority][] = [
    ['Founder/Owner', 'EXECUTIVE'],
    ['C-Suite', 'EXECUTIVE'],
    ['Partner', 'EXECUTIVE'],
    ['Vice President', 'EXECUTIVE'],
    ['Head', 'DIRECTOR'],
    ['Director', 'DIRECTOR'],
    ['Manager', 'MANAGER'],
    ['Senior', 'INDIVIDUAL_CONTRIBUTOR'],
    ['Entry', 'INDIVIDUAL_CONTRIBUTOR'],
    ['Intern', 'INDIVIDUAL_CONTRIBUTOR'],
  ]

  it.each(cases)('maps Prospeo "%s" to %s', (prospeo, expected) => {
    expect(mapProspeoSeniority(prospeo)).toBe(expected)
  })

  it('is case and whitespace insensitive', () => {
    expect(mapProspeoSeniority('  c-suite ')).toBe('EXECUTIVE')
    expect(mapProspeoSeniority('VICE PRESIDENT')).toBe('EXECUTIVE')
  })

  it('maps an unrecognised value to OTHER', () => {
    expect(mapProspeoSeniority('Galactic Overlord')).toBe('OTHER')
  })

  it('keeps an absent value null — unknown is not OTHER', () => {
    expect(mapProspeoSeniority(null)).toBeNull()
    expect(mapProspeoSeniority(undefined)).toBeNull()
    expect(mapProspeoSeniority('')).toBeNull()
  })
})

describe('failure classification', () => {
  it('treats INVALID_API_KEY as non-retriable', async () => {
    const { provider } = makeProvider(async () => failure('INVALID_API_KEY'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.auth,
      retriable: false,
    })
  })

  it('treats INSUFFICIENT_CREDITS as non-retriable', async () => {
    const { provider } = makeProvider(async () => failure('INSUFFICIENT_CREDITS'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.insufficientCredits,
      retriable: false,
    })
  })

  it('treats INVALID_DATAPOINTS as non-retriable', async () => {
    const { provider } = makeProvider(async () => failure('INVALID_DATAPOINTS'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.requestInvalid,
      retriable: false,
    })
  })

  it('treats INVALID_REQUEST as non-retriable', async () => {
    const { provider } = makeProvider(async () => failure('INVALID_REQUEST'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.requestInvalid,
      retriable: false,
    })
  })

  it('treats PLAN_REQUIRED as non-retriable', async () => {
    const { provider } = makeProvider(async () => failure('PLAN_REQUIRED'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.auth,
      retriable: false,
    })
  })

  it('treats INTERNAL_ERROR as retriable — documented as server-side', async () => {
    const { provider } = makeProvider(async () => failure('INTERNAL_ERROR'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.unavailable,
      retriable: true,
    })
  })

  it('treats 429 RATE_LIMITED as retriable', async () => {
    const { provider } = makeProvider(async () => failure('RATE_LIMITED', 429))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.rateLimited,
      retriable: true,
    })
  })

  it.each([500, 502, 503])('treats %d as retriable', async (status) => {
    const { provider } = makeProvider(async () => jsonResponse({}, status))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.unavailable,
      retriable: true,
    })
  })

  it('treats an unknown 400 error_code as non-retriable', async () => {
    const { provider } = makeProvider(async () => failure('SOMETHING_NEW'))
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.requestInvalid,
      retriable: false,
    })
  })

  it('treats a network fault as retriable', async () => {
    const { provider } = makeProvider(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.unavailable,
      retriable: true,
    })
  })

  it('rejects a malformed success body instead of returning partial data', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ error: false, person: { current_job_title: 42 } }),
    )
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.malformed,
    })
  })

  it('rejects a body that is not valid JSON', async () => {
    const { provider } = makeProvider(
      async () => new Response('<html>gateway</html>', { status: 200 }),
    )
    await expect(provider.enrich({ ...call, lead })).rejects.toMatchObject({
      code: PROSPEO_ERROR.malformed,
    })
  })

  it('never returns invented data on failure', async () => {
    const { provider } = makeProvider(async () => failure('INVALID_API_KEY'))
    const outcome = await provider.enrich({ ...call, lead }).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(ProviderCallError)
    expect(outcome).not.toHaveProperty('data')
  })
})

describe('secrets and leakage', () => {
  it('never logs anything, on success or failure', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]

    const ok = makeProvider(async () => jsonResponse(matched))
    await ok.provider.enrich({ ...call, lead })

    const bad = makeProvider(async () => failure('INVALID_API_KEY'))
    await bad.provider.enrich({ ...call, lead }).catch(() => {})

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })

  it('sends the API key only as a header, never in the request body', async () => {
    const { provider, fetchImpl } = makeProvider(async () => jsonResponse(matched))
    await provider.enrich({ ...call, lead })

    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(API_KEY)
  })

  it('keeps the API key out of the error surface', async () => {
    const { provider } = makeProvider(async () => failure('INVALID_API_KEY'))
    const error = (await provider
      .enrich({ ...call, lead })
      .catch((e: unknown) => e)) as ProviderCallError

    expect(error.message).not.toContain(API_KEY)
  })

  it('builds error messages from the error_code, never from the response body', async () => {
    // The engine persists `error.message` on the step row, so a body echoing
    // the submitted lead back must not reach it.
    const { provider } = makeProvider(async () =>
      jsonResponse(
        { error: true, error_code: 'INVALID_REQUEST', message: `bad email ${lead.email}` },
        400,
      ),
    )
    const error = (await provider
      .enrich({ ...call, lead })
      .catch((e: unknown) => e)) as ProviderCallError

    expect(error.message).not.toContain(lead.email)
    expect(error.message).toContain('INVALID_REQUEST')
  })
})

describe('contract compatibility', () => {
  it('is structurally an EnrichmentProvider', () => {
    const { provider } = makeProvider(async () => jsonResponse(matched))
    const typed: EnrichmentProvider = provider

    expect(typed.name).toBe('prospeo')
  })

  it('echoes the lead source, and carries no form message', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matched))
    const result = await provider.enrich({ ...call, lead: { ...lead, source: 'WEBHOOK' } })

    // The prospect's message is not part of the enrichment contract — it
    // travels on LeadFacts and reaches the model once.
    expect(result.data.lead).toEqual({ source: 'WEBHOOK' })
  })

  it('accepts the idempotencyKey from the provider call envelope', async () => {
    const { provider } = makeProvider(async () => jsonResponse(matched))

    // Honoured as part of the contract. Prospeo documents no native
    // idempotency for this endpoint, so nothing more is claimed here.
    await expect(
      provider.enrich({ idempotencyKey: 'step_42', organizationId: 'org_1', lead }),
    ).resolves.toHaveProperty('provider', 'prospeo')
  })
})
