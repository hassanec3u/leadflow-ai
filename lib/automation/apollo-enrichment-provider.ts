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
 * Apollo.io enrichment provider (Phase 2D-4).
 *
 * Fills the Phase 2D-3 `EnrichmentResult` contract and nothing more: company
 * firmographics and the person's role. No phone enrichment, no waterfall, no
 * prospect search, no CRM/sequence writes — those are deliberately disabled
 * on every request below rather than merely left unused.
 *
 * Verified against Apollo's current published API reference rather than
 * assumed:
 *   - People Enrichment is `POST https://api.apollo.io/api/v1/people/match`,
 *     authenticated with an `x-api-key` request header;
 *   - a match returns `person`, with firmographics nested under
 *     `person.organization` (`name`, `website_url`, `primary_domain`,
 *     `industry`, `estimated_num_employees`, `country`) and the role on the
 *     person (`title`, `seniority`);
 *   - NO match is a 200 with a null/empty `person` — not an error status;
 *   - documented status codes: 401 invalid/inactive key, 403 plan lacks API
 *     access, 404 not found, 422 validation error, 429 rate limited,
 *     500 server error ("Retry the request").
 */

const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match'
const DEFAULT_TIMEOUT_MS = 10_000

/** Reason codes this provider can raise; each carries a retry decision. */
export const APOLLO_ERROR = {
  auth: 'enrichment_provider_auth_failed',
  rateLimited: 'enrichment_provider_rate_limited',
  unavailable: 'enrichment_provider_unavailable',
  requestInvalid: 'enrichment_provider_request_invalid',
  malformed: 'enrichment_response_malformed',
} as const

/**
 * Apollo's seniority vocabulary mapped onto our closed `Seniority` union.
 *
 * `vp` sits with the executives deliberately: in B2B SaaS a VP normally
 * carries budget authority, which is exactly what the qualification
 * instructions grade. `head` and `director` are department leadership;
 * `senior`/`entry`/`intern` are individual contributors.
 *
 * A value Apollo returns that is not listed here maps to OTHER ("mapped, none
 * of the above"), and an absent value stays null ("unknown") — the contract
 * distinguishes the two.
 */
const SENIORITY_BY_APOLLO_VALUE: Record<string, Seniority> = {
  owner: 'EXECUTIVE',
  founder: 'EXECUTIVE',
  c_suite: 'EXECUTIVE',
  partner: 'EXECUTIVE',
  vp: 'EXECUTIVE',
  head: 'DIRECTOR',
  director: 'DIRECTOR',
  manager: 'MANAGER',
  senior: 'INDIVIDUAL_CONTRIBUTOR',
  entry: 'INDIVIDUAL_CONTRIBUTOR',
  intern: 'INDIVIDUAL_CONTRIBUTOR',
}

export function mapApolloSeniority(value: string | null | undefined): Seniority | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return null
  return SENIORITY_BY_APOLLO_VALUE[normalized] ?? 'OTHER'
}

/**
 * Only the fields the contract needs. Unknown keys are stripped by zod, so a
 * vendor field we never asked for cannot leak downstream to the model.
 */
const apolloOrganizationSchema = z.object({
  name: z.string().nullish(),
  website_url: z.string().nullish(),
  primary_domain: z.string().nullish(),
  industry: z.string().nullish(),
  estimated_num_employees: z.number().nullish(),
  country: z.string().nullish(),
})

const apolloPersonSchema = z.object({
  title: z.string().nullish(),
  seniority: z.string().nullish(),
  organization: apolloOrganizationSchema.nullish(),
})

const apolloMatchResponseSchema = z.object({
  person: apolloPersonSchema.nullish(),
})

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type ApolloEnrichmentProviderOptions = {
  apiKey: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export class ApolloEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'apollo'
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: ApolloEnrichmentProviderOptions) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async enrich(input: ProviderCall & { lead: LeadFacts }): Promise<EnrichmentResult> {
    const empty = emptyEnrichmentData(input.lead)
    const identifiers = buildIdentifiers(input.lead)

    // Nothing to look up with. A successful "no match" rather than a wasted
    // request (and a wasted Apollo credit).
    if (!identifiers) return { provider: this.name, data: empty }

    const body = await this.postMatch(identifiers)
    const person = body.person

    // Documented no-match: 200 with a null/empty person. Not an error, and
    // never fabricated data — every field simply stays null.
    if (!person) return { provider: this.name, data: empty }

    const organization = person.organization ?? null

    return {
      provider: this.name,
      data: {
        company: {
          name: nullableString(organization?.name),
          // `website_url` is the canonical field; `primary_domain` is the same
          // semantic value in bare-domain form. Neither is synthesized.
          website: nullableString(organization?.website_url ?? organization?.primary_domain),
          industry: nullableString(organization?.industry),
          employeeCount: positiveInteger(organization?.estimated_num_employees),
          // Apollo reports a country NAME ("United States"), not an ISO
          // alpha-2 code. Passed through verbatim: translating it here would
          // be inventing a value Apollo did not return.
          country: nullableString(organization?.country),
        },
        person: {
          jobTitle: nullableString(person.title),
          seniority: mapApolloSeniority(person.seniority),
        },
        // Apollo has no visibility of the lead's own form submission, so this
        // group stays exactly as the contract defines it.
        lead: empty.lead,
      },
    }
  }

  private async postMatch(identifiers: ApolloIdentifiers): Promise<{
    person?: z.infer<typeof apolloPersonSchema> | null
  }> {
    let response: Response

    try {
      response = await this.fetchImpl(APOLLO_MATCH_URL, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          ...identifiers,
          // Explicitly OFF: out of scope for this phase, and each of these
          // costs extra credits or requires a webhook.
          reveal_personal_emails: false,
          reveal_phone_number: false,
          run_waterfall_email: false,
          run_waterfall_phone: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      // Network fault, DNS failure or timeout — transient by definition.
      throw new ProviderCallError(APOLLO_ERROR.unavailable, 'Could not reach Apollo', {
        retriable: true,
        cause: error,
      })
    }

    if (!response.ok) throw statusError(response.status)

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ProviderCallError(
        APOLLO_ERROR.malformed,
        'Apollo returned a response that was not valid JSON',
        { retriable: true, cause: error },
      )
    }

    const parsed = apolloMatchResponseSchema.safeParse(payload)
    if (!parsed.success) {
      // Never a partially-guessed lead: a body we cannot read is a failure,
      // not an empty enrichment.
      throw new ProviderCallError(
        APOLLO_ERROR.malformed,
        'Apollo response did not match the expected structure',
      )
    }

    return parsed.data
  }
}

/**
 * Maps Apollo's documented status codes onto the retry decision.
 *
 * Messages are built from the status alone — never from the response body,
 * which can echo the submitted lead back. The engine persists
 * `error.message` on the step row, so lead data must not reach it.
 */
function statusError(status: number): ProviderCallError {
  // 401 invalid/inactive key, 403 plan lacks API access. Configuration
  // faults: retrying cannot fix either.
  if (status === 401 || status === 403) {
    return new ProviderCallError(APOLLO_ERROR.auth, `Apollo rejected the credentials (${status})`, {
      retriable: false,
    })
  }

  if (status === 429) {
    return new ProviderCallError(APOLLO_ERROR.rateLimited, 'Apollo rate limit reached', {
      retriable: true,
    })
  }

  if (status >= 500) {
    return new ProviderCallError(
      APOLLO_ERROR.unavailable,
      `Apollo returned a server error (${status})`,
      { retriable: true },
    )
  }

  // 404 / 422 and any other 4xx: the request itself is wrong, so repeating it
  // verbatim only repeats the rejection.
  return new ProviderCallError(
    APOLLO_ERROR.requestInvalid,
    `Apollo rejected the request (${status})`,
    { retriable: false },
  )
}

type ApolloIdentifiers =
  { email: string } | { name: string; domain: string } | { name: string; organization_name: string }

/**
 * Lookup priority: the person's email first, because it is the strongest
 * single identifier Apollo accepts. Only when the email is unusable do we
 * fall back to name plus a company identifier.
 *
 * Note the Lead model carries a company NAME but no company domain, so the
 * fallback uses the email's domain when one can be extracted and Apollo's
 * `organization_name` otherwise.
 */
function buildIdentifiers(lead: LeadFacts): ApolloIdentifiers | null {
  const email = lead.email?.trim() ?? ''
  if (isUsableEmail(email)) return { email }

  const name = lead.name?.trim() ?? ''
  if (name === '') return null

  const domain = domainFromEmail(email)
  if (domain) return { name, domain }

  const company = lead.company?.trim() ?? ''
  if (company !== '') return { name, organization_name: company }

  return null
}

function isUsableEmail(value: string): boolean {
  const at = value.indexOf('@')
  return at > 0 && value.indexOf('.', at) > at + 1 && !value.endsWith('.')
}

function domainFromEmail(value: string): string | null {
  const domain = value.slice(value.indexOf('@') + 1).trim()
  return domain.includes('.') ? domain : null
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
 * Builds the provider from validated environment, or null when Apollo is not
 * configured — which leaves the registry slot null, so the engine SKIPs the
 * enrichment step exactly as it does today.
 */
export function createApolloEnrichmentProvider(): ApolloEnrichmentProvider | null {
  const env = getEnv()
  if (!env.APOLLO_API_KEY) return null
  return new ApolloEnrichmentProvider({ apiKey: env.APOLLO_API_KEY })
}
