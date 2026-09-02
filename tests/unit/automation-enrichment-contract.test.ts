import { describe, expect, it } from 'vitest'

import { MockEnrichmentProvider } from '@/lib/automation/provider-mocks'
import {
  emptyEnrichmentData,
  ProviderCallError,
  type EnrichmentData,
  type EnrichmentProvider,
  type LeadFacts,
  type Seniority,
} from '@/lib/automation/providers'

/**
 * Phase 2D-3 — the enrichment contract itself.
 *
 * No vendor exists yet, so what is under test is the shape and the
 * failure/not-found semantics every future provider must honour. The mock
 * stands in as a conforming implementation.
 */

const lead: LeadFacts = {
  id: 'lead_1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Inc',
  phone: null,
  formMessage: null,
  source: 'WEBSITE_FORM',
}

const call = { idempotencyKey: 'step_1', organizationId: 'org_1' }

describe('EnrichmentData shape', () => {
  it('carries exactly the three MVP groups', () => {
    expect(Object.keys(emptyEnrichmentData(lead)).sort()).toEqual(['company', 'lead', 'person'])
  })

  it('declares every MVP company, person and lead field', () => {
    const data = emptyEnrichmentData(lead)

    expect(Object.keys(data.company).sort()).toEqual([
      'country',
      'employeeCount',
      'industry',
      'name',
      'website',
    ])
    expect(Object.keys(data.person).sort()).toEqual(['jobTitle', 'seniority'])
    expect(Object.keys(data.lead).sort()).toEqual(['source'])
  })

  it('makes every discoverable field null by default, and never 0 or ""', () => {
    const data = emptyEnrichmentData(lead)

    // employeeCount in particular: a missing headcount is null, because 0
    // would read to the model as "a company with no employees".
    expect(data.company.employeeCount).toBeNull()
    for (const value of Object.values(data.company)) expect(value).toBeNull()
    for (const value of Object.values(data.person)) expect(value).toBeNull()
    // The lead's own message is NOT part of the enrichment contract: it is a
    // fact of the Lead and travels on LeadFacts, so it reaches the model once
    // rather than being paid for twice in tokens.
    expect(data.lead).not.toHaveProperty('formMessage')
  })

  it('keeps `source` non-null — it comes from the Lead, not the provider', () => {
    expect(emptyEnrichmentData(lead).lead.source).toBe('WEBSITE_FORM')
    expect(emptyEnrichmentData({ source: 'WEBHOOK' }).lead.source).toBe('WEBHOOK')
  })

  it('accepts the closed seniority vocabulary', () => {
    const all: Seniority[] = ['EXECUTIVE', 'DIRECTOR', 'MANAGER', 'INDIVIDUAL_CONTRIBUTOR', 'OTHER']
    const data: EnrichmentData = emptyEnrichmentData(lead)

    for (const seniority of all) {
      expect({ ...data.person, seniority }.seniority).toBe(seniority)
    }
  })
})

describe('failure vs data-not-found', () => {
  it('represents "not found" as a resolved promise, never a rejection', async () => {
    const provider = new MockEnrichmentProvider({ mode: 'not_found' })
    const result = await provider.enrich({ ...call, lead })

    expect(result.provider).toBe('mock-enrichment')
    expect(result.data).toEqual(emptyEnrichmentData(lead))
  })

  it('represents a lookup failure as a thrown ProviderCallError', async () => {
    const provider = new MockEnrichmentProvider({ mode: 'failure' })

    await expect(provider.enrich({ ...call, lead })).rejects.toBeInstanceOf(ProviderCallError)
  })

  it('distinguishes the two: not-found still returns a provider name and payload', async () => {
    const notFound = await new MockEnrichmentProvider({ mode: 'not_found' }).enrich({
      ...call,
      lead,
    })
    const failure = await new MockEnrichmentProvider({ mode: 'failure' })
      .enrich({ ...call, lead })
      .catch((error: unknown) => error)

    expect(notFound).toHaveProperty('data')
    expect(failure).toBeInstanceOf(ProviderCallError)
  })

  it('treats an unknown provider fault as retriable by default', async () => {
    const failure = (await new MockEnrichmentProvider({ mode: 'failure' })
      .enrich({ ...call, lead })
      .catch((error: unknown) => error)) as ProviderCallError

    // The engine retries per STEP_MAX_ATTEMPTS before failing the step.
    expect(failure.retriable).toBe(true)
  })
})

describe('provider input contract', () => {
  it('receives only the lead facts plus the call envelope', async () => {
    const provider = new MockEnrichmentProvider()
    await provider.enrich({ ...call, lead })

    const recorded = provider.calls[0]
    expect(Object.keys(recorded ?? {}).sort()).toEqual([
      'idempotencyKey',
      'input',
      'organizationId',
    ])
    expect(Object.keys(recorded?.input ?? {})).toEqual(['lead'])
  })

  it('carries a stable idempotency key for the owning step run', async () => {
    const provider = new MockEnrichmentProvider()
    await provider.enrich({ ...call, lead })
    await provider.enrich({ ...call, lead })

    // Same step, same key across attempts — the engine passes the
    // WorkflowStepRun id, which does not change on retry.
    expect(provider.calls.map((entry) => entry.idempotencyKey)).toEqual(['step_1', 'step_1'])
  })

  it('is structurally an EnrichmentProvider', () => {
    const provider: EnrichmentProvider = new MockEnrichmentProvider()

    expect(provider.name).toBe('mock-enrichment')
    expect(typeof provider.enrich).toBe('function')
  })
})
