/**
 * Deterministic mock providers (Phase 2D-1).
 *
 * These implement the interfaces in lib/automation/providers.ts with no
 * vendor SDK, no API key, and no network call. Each mock records calls in
 * memory and returns configurable, deterministic output so tests can drive
 * every branch of the engine (score bands, malformed output, provider
 * failure) without a real integration. Real vendor implementations are a
 * later phase — nothing here names one (docs/architecture.md §8).
 *
 * Every mock only ever receives `LeadFacts` plus the minimum step-specific
 * input already defined by the provider interfaces; nothing new is added.
 * Lead-supplied fields are stored as opaque DATA in the call log, never
 * interpreted, logged sensitively, or echoed into instructions.
 */

import type {
  AiBudgetGuard,
  AiQualificationProvider,
  EmailProvider,
  EnrichmentCompany,
  EnrichmentLeadContext,
  EnrichmentPerson,
  EnrichmentProvider,
  EnrichmentResult,
  LeadFacts,
  NotificationKind,
  NotificationProvider,
  ProviderCall,
  QualificationConfig,
} from '@/lib/automation/providers'
import { emptyEnrichmentData, ProviderCallError } from '@/lib/automation/providers'

/** Recorded call, common shape across every mock's in-memory log. */
export type RecordedCall<TInput> = { idempotencyKey: string; organizationId: string; input: TInput }

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

export type MockEnrichmentMode = 'success' | 'failure' | 'not_found' | 'not_configured'

export type MockEnrichmentProviderOptions = {
  mode?: MockEnrichmentMode
  /**
   * Partial override of the deterministic default payload, merged group-wise
   * so a test can vary one field without restating the whole shape.
   */
  data?: {
    company?: Partial<EnrichmentCompany>
    person?: Partial<EnrichmentPerson>
    lead?: Partial<EnrichmentLeadContext>
  }
}

/**
 * `mode: 'not_configured'` is not represented by returning null from
 * `enrich` — the engine already treats a null `providers.enrichment` slot as
 * "not configured" (see EMPTY_PROVIDER_REGISTRY). This mock's own
 * `notConfigured()` helper returns that null slot directly, so tests can
 * still configure the *scenario* through the same options shape used by the
 * other modes.
 *
 * `mode: 'not_found'` is the distinct third case the Phase 2D-3 contract
 * requires: the provider ran successfully and resolved nothing, so it returns
 * an all-null payload instead of throwing.
 */
export class MockEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'mock-enrichment'
  readonly calls: RecordedCall<{ lead: LeadFacts }>[] = []
  private readonly mode: MockEnrichmentMode
  private readonly overrides: MockEnrichmentProviderOptions['data']

  constructor(options: MockEnrichmentProviderOptions = {}) {
    this.mode = options.mode ?? 'success'
    this.overrides = options.data
  }

  async enrich(input: ProviderCall & { lead: LeadFacts }): Promise<EnrichmentResult> {
    this.calls.push({
      idempotencyKey: input.idempotencyKey,
      organizationId: input.organizationId,
      input: { lead: input.lead },
    })

    if (this.mode === 'failure') {
      throw new ProviderCallError('mock_enrichment_failed', 'Mock enrichment provider failure')
    }

    // A successful lookup that resolved nothing — nulls, never an error.
    if (this.mode === 'not_found') {
      return { provider: this.name, data: emptyEnrichmentData(input.lead) }
    }

    // 'not_configured' is modeled by omitting this provider from the
    // registry (providers.enrichment = null); this mock has nothing to do
    // for that case if it is still constructed and called directly.
    const base = emptyEnrichmentData(input.lead)
    return {
      provider: this.name,
      data: {
        company: {
          ...base.company,
          name: input.lead.company,
          website: 'https://example.com',
          industry: 'saas',
          employeeCount: 50,
          country: 'US',
          ...this.overrides?.company,
        },
        person: {
          ...base.person,
          jobTitle: 'Head of Revenue',
          seniority: 'DIRECTOR',
          ...this.overrides?.person,
        },
        lead: { ...base.lead, ...this.overrides?.lead },
      },
    }
  }
}

// ---------------------------------------------------------------------------
// AI qualification
// ---------------------------------------------------------------------------

export type MockAiOutcome = 'score' | 'malformed' | 'failure'

export type MockAiQualificationProviderOptions = {
  /** Deterministic score to return, e.g. 42 / 70 / 91. Ignored unless outcome is 'score'. */
  score?: number
  outcome?: MockAiOutcome
  summary?: string
  recommendedAction?: string
  keywords?: string[]
}

/**
 * Returns raw, unvalidated output on purpose — validation is the engine's
 * job (lib/validation/automation-ai.ts), and `'malformed'` exists precisely
 * to exercise that boundary.
 */
export class MockAiQualificationProvider implements AiQualificationProvider {
  readonly name = 'mock-ai'
  readonly calls: RecordedCall<{
    lead: LeadFacts
    enrichment: EnrichmentResult | null
    config?: QualificationConfig
  }>[] = []
  private readonly score: number
  private readonly outcome: MockAiOutcome
  private readonly summary: string
  private readonly recommendedAction: string
  private readonly keywords: string[]

  constructor(options: MockAiQualificationProviderOptions = {}) {
    this.score = options.score ?? 70
    this.outcome = options.outcome ?? 'score'
    this.summary = options.summary ?? 'Deterministic mock qualification summary.'
    this.recommendedAction = options.recommendedAction ?? 'follow_up'
    this.keywords = options.keywords ?? ['mock']
  }

  async qualify(
    input: ProviderCall & {
      lead: LeadFacts
      enrichment: EnrichmentResult | null
      config?: QualificationConfig
    },
  ): Promise<unknown> {
    this.calls.push({
      idempotencyKey: input.idempotencyKey,
      organizationId: input.organizationId,
      input: { lead: input.lead, enrichment: input.enrichment, config: input.config },
    })

    if (this.outcome === 'failure') {
      throw new ProviderCallError('mock_ai_failed', 'Mock AI provider failure')
    }
    if (this.outcome === 'malformed') {
      // Deliberately missing required fields (no `summary`, wrong `score`
      // type) so parseAiQualificationOutput rejects it.
      return { score: 'not-a-number', keywords: 'not-an-array' }
    }
    return {
      score: this.score,
      summary: this.summary,
      keywords: this.keywords,
      recommendedAction: this.recommendedAction,
      model: this.name,
    }
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export type MockEmailProviderOptions = { shouldFail?: boolean }

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock-email'
  readonly calls: RecordedCall<{ lead: LeadFacts; summary: string | null }>[] = []
  private readonly shouldFail: boolean

  constructor(options: MockEmailProviderOptions = {}) {
    this.shouldFail = options.shouldFail ?? false
  }

  async send(
    input: ProviderCall & { lead: LeadFacts; summary: string | null },
  ): Promise<{ providerMessageId: string }> {
    // Recorded BEFORE the failure branch: idempotency-key preservation must
    // hold even when the call ultimately fails, since a retry reuses it.
    this.calls.push({
      idempotencyKey: input.idempotencyKey,
      organizationId: input.organizationId,
      input: { lead: input.lead, summary: input.summary },
    })

    if (this.shouldFail) {
      throw new ProviderCallError('mock_email_failed', 'Mock email provider failure')
    }
    // Never a real send — this only ever returns a synthetic id derived from
    // the idempotency key, so a retried step is verifiably the same send.
    return { providerMessageId: `mock-email-${input.idempotencyKey}` }
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

export type MockNotificationProviderOptions = { shouldFail?: boolean }

export class MockNotificationProvider implements NotificationProvider {
  readonly name = 'mock-notification'
  readonly calls: RecordedCall<{
    lead: LeadFacts
    runId: string
    kind: NotificationKind
    detail: string | null
  }>[] = []
  private readonly shouldFail: boolean

  constructor(options: MockNotificationProviderOptions = {}) {
    this.shouldFail = options.shouldFail ?? false
  }

  async notify(
    input: ProviderCall & {
      lead: LeadFacts
      runId: string
      kind: NotificationKind
      detail: string | null
    },
  ): Promise<{ ref: string | null }> {
    this.calls.push({
      idempotencyKey: input.idempotencyKey,
      organizationId: input.organizationId,
      input: { lead: input.lead, runId: input.runId, kind: input.kind, detail: input.detail },
    })

    if (this.shouldFail) {
      throw new ProviderCallError('mock_notification_failed', 'Mock notification provider failure')
    }
    return { ref: `mock-notification-${input.idempotencyKey}` }
  }
}

// ---------------------------------------------------------------------------
// AI budget guard
// ---------------------------------------------------------------------------

export type MockAiBudgetGuardOptions = { exceeded?: boolean }

/** Exceeding budget is not retriable — see AiBudgetGuard's contract. */
export class MockAiBudgetGuard implements AiBudgetGuard {
  readonly calls: { organizationId: string }[] = []
  private readonly exceeded: boolean

  constructor(options: MockAiBudgetGuardOptions = {}) {
    this.exceeded = options.exceeded ?? false
  }

  async assertWithinBudget(organizationId: string): Promise<void> {
    this.calls.push({ organizationId })
    if (this.exceeded) {
      throw new ProviderCallError('mock_ai_budget_exceeded', 'Mock AI budget exceeded', {
        retriable: false,
      })
    }
  }
}
