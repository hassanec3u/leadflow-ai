import 'server-only'

import { z } from 'zod'

import {
  emptyEnrichmentData,
  ProviderCallError,
  type EnrichmentProvider,
  type EnrichmentResult,
  type LeadFacts,
  type ProviderCall,
  type Seniority,
} from '@/lib/automation/providers'
import { getEnv } from '@/lib/env'

/**
 * Prospeo enrichment provider (Phase 2D-6).
 *
 * A second implementation of the existing `EnrichmentProvider` contract,
 * added alongside Apollo rather than replacing it. No Search Person, no Bulk
 * Enrich, no mobile enrichment.
 *
 * Verified against Prospeo's current published API reference:
 *   - `POST https://api.prospeo.io/enrich-person`, authenticated with an
 *     `X-KEY` header;
 *   - identifiers are nested under a `data` object;
 *   - a success is `{ error: false, person, company }`;
 *   - `seniority` lives on `person.job_history[]` entries (each with a
 *     `current` flag), NOT at the person level;
 *   - company location is `company.location.{country, country_code, ...}`;
 *   - EVERY failure except rate limiting is HTTP **400**, discriminated by
 *     `error_code` — including NO_MATCH. The body therefore has to be read on
 *     a 400 before any retry decision can be made.
 */

const PROSPEO_ENRICH_URL = 'https://api.prospeo.io/enrich-person'
const DEFAULT_TIMEOUT_MS = 10_000

/** Reason codes this provider can raise; each carries a retry decision. */
export const PROSPEO_ERROR = {
  auth: 'enrichment_provider_auth_failed',
  rateLimited: 'enrichment_provider_rate_limited',
  unavailable: 'enrichment_provider_unavailable',
  requestInvalid: 'enrichment_provider_request_invalid',
  insufficientCredits: 'enrichment_provider_insufficient_credits',
  malformed: 'enrichment_response_malformed',
} as const

/**
 * Prospeo's documented seniority enum mapped onto our closed `Seniority`
 * union. Same semantics as the Apollo mapping: "Vice President" carries
 * budget authority so it sits with the executives, "Head"/"Director" are
 * department leadership, and "Senior"/"Entry"/"Intern" are individual
 * contributors.
 *
 * Keys are lowercased at lookup time so the vendor's display casing
 * ("C-Suite", "Founder/Owner") cannot cause a miss.
 */
const SENIORITY_BY_PROSPEO_VALUE: Record<string, Seniority> = {
  'founder/owner': 'EXECUTIVE',
  'c-suite': 'EXECUTIVE',
  partner: 'EXECUTIVE',
  'vice president': 'EXECUTIVE',
  head: 'DIRECTOR',
  director: 'DIRECTOR',
  manager: 'MANAGER',
  senior: 'INDIVIDUAL_CONTRIBUTOR',
  entry: 'INDIVIDUAL_CONTRIBUTOR',
  intern: 'INDIVIDUAL_CONTRIBUTOR',
}

export function mapProspeoSeniority(value: string | null | undefined): Seniority | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return null
  // Unrecognised => OTHER ("mapped, none of the above"); absent => null
  // ("unknown"). The contract distinguishes the two.
  return SENIORITY_BY_PROSPEO_VALUE[normalized] ?? 'OTHER'
}

/**
 * Only the fields our contract needs. `person.email` and `person.mobile` are
 * deliberately NOT declared: zod strips unknown keys, so contact details
 * cannot reach `EnrichmentData` even if Prospeo returns them.
 */
const prospeoJobSchema = z.object({
  current: z.boolean().nullish(),
  seniority: z.string().nullish(),
})

const prospeoPersonSchema = z.object({
  current_job_title: z.string().nullish(),
  job_history: z.array(prospeoJobSchema).nullish(),
})

const prospeoCompanySchema = z.object({
  name: z.string().nullish(),
  website: z.string().nullish(),
  industry: z.string().nullish(),
  employee_count: z.number().nullish(),
  location: z
    .object({
      country: z.string().nullish(),
    })
    .nullish(),
})

const prospeoSuccessSchema = z.object({
  person: prospeoPersonSchema.nullish(),
  company: prospeoCompanySchema.nullish(),
})

/** Failure bodies carry a fixed enum code — never lead data. */
const prospeoErrorSchema = z.object({
  error_code: z.string().nullish(),
})

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type ProspeoEnrichmentProviderOptions = {
  apiKey: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export class ProspeoEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'prospeo'
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: ProspeoEnrichmentProviderOptions) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async enrich(input: ProviderCall & { lead: LeadFacts }): Promise<EnrichmentResult> {
    const empty = emptyEnrichmentData(input.lead)
    const data = buildMatchData(input.lead)

    // Not enough to satisfy Prospeo's minimum matching requirements: a
    // successful "no match" rather than a request that would be rejected.
    if (!data) return { provider: this.name, data: empty }

    const body = await this.postEnrich(data)

    // Documented NO_MATCH — enrichment succeeded and resolved nothing.
    if (body === 'NO_MATCH') return { provider: this.name, data: empty }

    const company = body.company ?? null
    const person = body.person ?? null

    return {
      provider: this.name,
      data: {
        company: {
          name: nullableString(company?.name),
          website: nullableString(company?.website),
          industry: nullableString(company?.industry),
          employeeCount: positiveInteger(company?.employee_count),
          // The country NAME, per our contract. `country_code` is
          // deliberately ignored — it is a different representation, and
          // swapping it in would change the field's meaning.
          country: nullableString(company?.location?.country),
        },
        person: {
          jobTitle: nullableString(person?.current_job_title),
          seniority: mapProspeoSeniority(currentSeniority(person?.job_history)),
        },
        // Prospeo has no visibility of the lead's own form submission.
        lead: empty.lead,
      },
    }
  }

  private async postEnrich(
    data: ProspeoMatchData,
  ): Promise<z.infer<typeof prospeoSuccessSchema> | 'NO_MATCH'> {
    let response: Response

    try {
      response = await this.fetchImpl(PROSPEO_ENRICH_URL, {
        method: 'POST',
        headers: {
          'X-KEY': this.apiKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          data,
          // Explicitly OFF: mobile enrichment is out of scope and costs 10
          // credits per hit. `only_verified_mobile` is never sent, because
          // setting it would turn `enrich_mobile` back on.
          enrich_mobile: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new ProviderCallError(PROSPEO_ERROR.unavailable, 'Could not reach Prospeo', {
        retriable: true,
        cause: error,
      })
    }

    if (response.status === 429) {
      throw new ProviderCallError(PROSPEO_ERROR.rateLimited, 'Prospeo rate limit reached', {
        retriable: true,
      })
    }
    if (response.status >= 500) {
      throw new ProviderCallError(
        PROSPEO_ERROR.unavailable,
        `Prospeo returned a server error (${response.status})`,
        { retriable: true },
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ProviderCallError(
        PROSPEO_ERROR.malformed,
        'Prospeo returned a response that was not valid JSON',
        { retriable: true, cause: error },
      )
    }

    // Every Prospeo failure — NO_MATCH included — is a 400, so the body has
    // to be inspected before anything can be decided.
    if (!response.ok) {
      const failure = prospeoErrorSchema.safeParse(payload)
      const code = failure.success ? (failure.data.error_code ?? '') : ''
      if (code === 'NO_MATCH') return 'NO_MATCH'
      throw errorCodeToProviderError(code, response.status)
    }

    const parsed = prospeoSuccessSchema.safeParse(payload)
    if (!parsed.success) {
      throw new ProviderCallError(
        PROSPEO_ERROR.malformed,
        'Prospeo response did not match the expected structure',
      )
    }
    return parsed.data
  }
}

/**
 * Maps Prospeo's `error_code` enum onto the retry decision.
 *
 * Only the CODE (a fixed vocabulary) and the HTTP status reach the message —
 * never the response body, which echoes the submitted identifiers back. The
 * engine persists `error.message` on the step row, so lead data must not
 * reach it.
 */
function errorCodeToProviderError(code: string, status: number): ProviderCallError {
  switch (code) {
    case 'INVALID_API_KEY':
      return new ProviderCallError(PROSPEO_ERROR.auth, 'Prospeo rejected the API key', {
        retriable: false,
      })
    case 'INSUFFICIENT_CREDITS':
      return new ProviderCallError(
        PROSPEO_ERROR.insufficientCredits,
        'Prospeo account has insufficient credits',
        { retriable: false },
      )
    case 'PLAN_REQUIRED':
      return new ProviderCallError(PROSPEO_ERROR.auth, 'Prospeo plan does not allow this request', {
        retriable: false,
      })
    case 'INVALID_DATAPOINTS':
    case 'INVALID_REQUEST':
      return new ProviderCallError(
        PROSPEO_ERROR.requestInvalid,
        `Prospeo rejected the request (${code})`,
        { retriable: false },
      )
    case 'INTERNAL_ERROR':
      // Documented as server-side, so retrying is meaningful here.
      return new ProviderCallError(
        PROSPEO_ERROR.unavailable,
        'Prospeo reported an internal error',
        {
          retriable: true,
        },
      )
    default:
      // An unrecognised 4xx code is a request problem: repeating it verbatim
      // would only repeat the rejection.
      return new ProviderCallError(
        PROSPEO_ERROR.requestInvalid,
        `Prospeo rejected the request (status ${status}${code ? `, ${code}` : ''})`,
        { retriable: false },
      )
  }
}

type ProspeoMatchData = {
  email?: string
  full_name?: string
  company_name?: string
}

/**
 * Identifiers sent to Prospeo, from the lead facts we actually hold.
 *
 * Email first — it alone satisfies Prospeo's minimum matching requirement and
 * is the strongest identifier. Name and company are included alongside it
 * when known, since Prospeo matches better with more context.
 *
 * `linkedin_url`, `company_website`, `company_linkedin_url` and `person_id`
 * are never sent: the Lead model holds none of them, and inventing them is
 * not an option.
 */
function buildMatchData(lead: LeadFacts): ProspeoMatchData | null {
  const data: ProspeoMatchData = {}

  const email = lead.email?.trim() ?? ''
  if (isUsableEmail(email)) data.email = email

  const name = lead.name?.trim() ?? ''
  if (name !== '') data.full_name = name

  const company = lead.company?.trim() ?? ''
  if (company !== '') data.company_name = company

  // Prospeo's documented minimum: an email on its own, or a full name plus a
  // company identifier.
  if (data.email) return data
  if (data.full_name && data.company_name) return data
  return null
}

/** The seniority of the CURRENT role, which is where Prospeo reports it. */
function currentSeniority(
  history: z.infer<typeof prospeoPersonSchema>['job_history'],
): string | null {
  if (!Array.isArray(history)) return null
  const current = history.find((job) => job.current === true)
  return current?.seniority ?? null
}

function isUsableEmail(value: string): boolean {
  const at = value.indexOf('@')
  return at > 0 && value.indexOf('.', at) > at + 1 && !value.endsWith('.')
}

function nullableString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Headcount must be a real positive number — 0 or negative means "unknown". */
function positiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

/**
 * Builds the provider from validated environment, or null when Prospeo is not
 * configured — which leaves the slot unfilled, exactly like Apollo.
 */
export function createProspeoEnrichmentProvider(): ProspeoEnrichmentProvider | null {
  const env = getEnv()
  if (!env.PROSPEO_API_KEY) return null
  return new ProspeoEnrichmentProvider({ apiKey: env.PROSPEO_API_KEY })
}
