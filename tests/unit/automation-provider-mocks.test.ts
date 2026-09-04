import { describe, expect, it } from 'vitest'

import {
  emptyEnrichmentData,
  getProviderRegistry,
  ProviderCallError,
  setProviderRegistry,
  type LeadFacts,
} from '@/lib/automation/providers'
import {
  MockAiBudgetGuard,
  MockAiQualificationProvider,
  MockEmailProvider,
  MockEnrichmentProvider,
  MockNotificationProvider,
} from '@/lib/automation/provider-mocks'

/**
 * Phase 2D-1 — deterministic mock providers.
 *
 * These tests exercise the mocks directly (structured output, configurable
 * outcomes, idempotency-key propagation, call recording, registry
 * injection). They do not touch the engine or the database — that coverage
 * already exists in tests/unit/automation-engine.test.ts and
 * tests/integration/automation-execution.test.ts.
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

const call = (idempotencyKey: string) => ({ idempotencyKey, organizationId: 'org_1' })

describe('MockEnrichmentProvider', () => {
  it('returns a deterministic structured result on success', async () => {
    const provider = new MockEnrichmentProvider()
    const result = await provider.enrich({ ...call('step_1'), lead })

    expect(result.provider).toBe('mock-enrichment')
    expect(result.data).toEqual({
      company: {
        name: lead.company,
        website: 'https://example.com',
        industry: 'saas',
        employeeCount: 50,
        country: 'US',
      },
      person: { jobTitle: 'Head of Revenue', seniority: 'DIRECTOR' },
      lead: { source: lead.source },
    })
  })

  it('honors a custom deterministic payload, merged group-wise', async () => {
    const provider = new MockEnrichmentProvider({ data: { company: { industry: 'fintech' } } })
    const result = await provider.enrich({ ...call('step_1'), lead })

    expect(result.data.company.industry).toBe('fintech')
    // Unmentioned fields keep the deterministic default.
    expect(result.data.company.employeeCount).toBe(50)
  })

  it('simulates a provider failure as a typed ProviderCallError', async () => {
    const provider = new MockEnrichmentProvider({ mode: 'failure' })
    await expect(provider.enrich({ ...call('step_1'), lead })).rejects.toBeInstanceOf(
      ProviderCallError,
    )
  })

  it('represents "data not found" as a successful all-null result, not a failure', async () => {
    const provider = new MockEnrichmentProvider({ mode: 'not_found' })
    const result = await provider.enrich({ ...call('step_1'), lead })

    expect(result.data.company).toEqual({
      name: null,
      website: null,
      industry: null,
      employeeCount: null,
      country: null,
    })
    expect(result.data.person).toEqual({ jobTitle: null, seniority: null })
    // `source` is always known — it comes from the Lead, not the provider.
    expect(result.data.lead).toEqual({ source: lead.source })
  })

  it('records every call in memory, without mutating the lead', async () => {
    const provider = new MockEnrichmentProvider()
    await provider.enrich({ ...call('step_1'), lead })
    await provider.enrich({ ...call('step_2'), lead })

    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0]).toMatchObject({ idempotencyKey: 'step_1', organizationId: 'org_1' })
    expect(provider.calls[1]?.idempotencyKey).toBe('step_2')
  })
})

describe('MockAiQualificationProvider', () => {
  it.each([42, 70, 91])('returns a deterministic configurable score of %d', async (score) => {
    const provider = new MockAiQualificationProvider({ score })
    const raw = await provider.qualify({ ...call('step_1'), lead, enrichment: null })

    expect(raw).toMatchObject({
      score,
      summary: expect.any(String),
      keywords: expect.any(Array),
      recommendedAction: expect.any(String),
    })
  })

  it('can simulate malformed output that fails schema validation', async () => {
    const provider = new MockAiQualificationProvider({ outcome: 'malformed' })
    const raw = await provider.qualify({ ...call('step_1'), lead, enrichment: null })

    // Not asserting the engine's parser here (covered by
    // automation-engine.test.ts) — only that the shape is actually broken.
    expect(raw).not.toMatchObject({ summary: expect.any(String) })
  })

  it('can simulate a provider failure', async () => {
    const provider = new MockAiQualificationProvider({ outcome: 'failure' })
    await expect(
      provider.qualify({ ...call('step_1'), lead, enrichment: null }),
    ).rejects.toBeInstanceOf(ProviderCallError)
  })

  it('records the enrichment context it was called with', async () => {
    const provider = new MockAiQualificationProvider()
    const enrichment = {
      provider: 'mock-enrichment',
      data: emptyEnrichmentData(lead),
    }
    await provider.qualify({ ...call('step_1'), lead, enrichment })

    expect(provider.calls[0]?.input.enrichment).toEqual(enrichment)
  })
})

describe('MockEmailProvider', () => {
  it('returns a deterministic providerMessageId and preserves the idempotency key', async () => {
    const provider = new MockEmailProvider()
    const result = await provider.send({ ...call('step_42'), lead, summary: 'Strong fit.' })

    expect(result.providerMessageId).toBe('mock-email-step_42')
    expect(provider.calls[0]?.idempotencyKey).toBe('step_42')
  })

  it('never performs a real network send (in-memory only)', async () => {
    const provider = new MockEmailProvider()
    await provider.send({ ...call('step_1'), lead, summary: null })
    // No fetch/network client exists anywhere in this module; the only
    // observable effect is the in-memory call log.
    expect(provider.calls).toHaveLength(1)
  })

  it('still records the call — and preserves the idempotency key — on a configured failure', async () => {
    const provider = new MockEmailProvider({ shouldFail: true })
    await expect(provider.send({ ...call('step_9'), lead, summary: null })).rejects.toBeInstanceOf(
      ProviderCallError,
    )
    expect(provider.calls[0]?.idempotencyKey).toBe('step_9')
  })
})

describe('MockNotificationProvider', () => {
  it('returns a deterministic notification reference', async () => {
    const provider = new MockNotificationProvider()
    const result = await provider.notify({
      ...call('step_1'),
      lead,
      runId: 'run_1',
      kind: 'run_succeeded',
      detail: null,
    })
    expect(result.ref).toBe('mock-notification-step_1')
  })

  it('records calls with their kind and detail', async () => {
    const provider = new MockNotificationProvider()
    await provider.notify({
      ...call('step_1'),
      lead,
      runId: 'run_1',
      kind: 'run_blocked',
      detail: 'email_provider_not_configured',
    })
    expect(provider.calls[0]?.input).toMatchObject({
      runId: 'run_1',
      kind: 'run_blocked',
      detail: 'email_provider_not_configured',
    })
  })

  it('can simulate a provider failure', async () => {
    const provider = new MockNotificationProvider({ shouldFail: true })
    await expect(
      provider.notify({
        ...call('step_1'),
        lead,
        runId: 'run_1',
        kind: 'run_succeeded',
        detail: null,
      }),
    ).rejects.toBeInstanceOf(ProviderCallError)
  })
})

describe('MockAiBudgetGuard', () => {
  it('resolves when not exceeded', async () => {
    const guard = new MockAiBudgetGuard()
    await expect(guard.assertWithinBudget('org_1')).resolves.toBeUndefined()
    expect(guard.calls).toEqual([{ organizationId: 'org_1' }])
  })

  it('throws a non-retriable ProviderCallError when exceeded', async () => {
    const guard = new MockAiBudgetGuard({ exceeded: true })
    const promise = guard.assertWithinBudget('org_1')
    await expect(promise).rejects.toBeInstanceOf(ProviderCallError)
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProviderCallError)
      expect((error as ProviderCallError).retriable).toBe(false)
    })
  })
})

describe('provider registry injection', () => {
  it('lets a test inject every mock at once', () => {
    setProviderRegistry({
      enrichment: new MockEnrichmentProvider(),
      ai: new MockAiQualificationProvider({ score: 91 }),
      email: new MockEmailProvider(),
      notification: new MockNotificationProvider(),
      aiBudget: new MockAiBudgetGuard(),
    })

    const registry = getProviderRegistry()
    expect(registry.enrichment).toBeInstanceOf(MockEnrichmentProvider)
    expect(registry.ai).toBeInstanceOf(MockAiQualificationProvider)
    expect(registry.email).toBeInstanceOf(MockEmailProvider)
    expect(registry.notification).toBeInstanceOf(MockNotificationProvider)
    expect(registry.aiBudget).toBeInstanceOf(MockAiBudgetGuard)

    // Reset so this test doesn't leak global registry state into others.
    setProviderRegistry({})
  })

  it('defaults every slot to null when nothing is injected', () => {
    setProviderRegistry({})
    const registry = getProviderRegistry()
    expect(registry).toEqual({
      enrichment: null,
      ai: null,
      email: null,
      notification: null,
      aiBudget: null,
    })
  })
})
