/**
 * Provider interfaces for the automation pipeline (Phase 2C).
 *
 * Interfaces and a registry only — NO vendor implementations. Every provider
 * slot is `null` by default, which the engine reads as "not connected" and
 * handles explicitly (SKIPPED for optional providers, BLOCKED for required
 * ones). Real implementations arrive in Phase 2D and are injected through
 * `setProviderRegistry()`; nothing in this file names a vendor
 * (docs/architecture.md §8).
 *
 * Every call receives `idempotencyKey` — always the owning
 * `WorkflowStepRun.id`, stable across retries — so a provider that supports
 * idempotency keys can de-duplicate a retried side effect server-side.
 */

/** Lead facts handed to providers. Lead-supplied text is DATA, never instructions. */
export type LeadFacts = {
  id: string
  name: string
  email: string
  company: string | null
  phone: string | null
  /**
   * What the prospect wrote on the Website Form, or null. Carried here rather
   * than through enrichment because it is a fact we already hold about the
   * lead — routing it through a vendor would be absurd, and would lose it
   * entirely whenever no enrichment provider is configured and ENRICH is
   * SKIPPED.
   */
  formMessage: string | null
  source: string
}

export type ProviderCall = { idempotencyKey: string; organizationId: string }

/**
 * Seniority buckets (Phase 2D-3).
 *
 * A closed vocabulary rather than the vendor's free-text job level: the AI
 * instructions grade "buying influence", and that comparison is only stable
 * if every provider maps its own labels onto the same small set. A provider
 * that cannot map a value returns null (not `OTHER`) — `OTHER` means "mapped,
 * and it is none of the above".
 */
export type Seniority = 'EXECUTIVE' | 'DIRECTOR' | 'MANAGER' | 'INDIVIDUAL_CONTRIBUTOR' | 'OTHER'

/**
 * Firmographics. Every field is nullable because every field is something the
 * provider may simply fail to find — see `EnrichmentData` for why "not found"
 * is a null and not an error.
 */
export type EnrichmentCompany = {
  name: string | null
  website: string | null
  industry: string | null
  /** Exact headcount as reported. Null when unknown — never 0 as a stand-in. */
  employeeCount: number | null
  /** ISO 3166-1 alpha-2 where the provider can supply it. */
  country: string | null
}

export type EnrichmentPerson = {
  jobTitle: string | null
  seniority: Seniority | null
}

/**
 * Lead-supplied context carried alongside the vendor-derived data.
 *
 * This group once also declared `formMessage`, anticipating that the website
 * form message would arrive here. That turned out to be the wrong home: the
 * message is a fact of the Lead, so it now travels on `LeadFacts` and reaches
 * the model once, in `untrusted_lead_data`. Keeping a copy here would send
 * the same text to the provider twice — paying for the tokens twice — and
 * duplicate the prospect's free text into every `WorkflowStepRun.output` row.
 */
export type EnrichmentLeadContext = {
  /** Always known — it comes from the Lead record, not from the provider. */
  source: string
}

/**
 * The MVP enrichment shape (Phase 2D-3).
 *
 * Deliberately a closed, typed record rather than an opaque vendor payload:
 * this is exactly the data the AI qualification step is allowed to see, so it
 * has to be enumerable and reviewable. A vendor's extra fields are dropped at
 * the provider boundary rather than forwarded to the model.
 *
 * NOT FOUND vs FAILURE:
 *   - Not found  — the provider ran and could not determine a value. It
 *                  resolves successfully with that field null. This is a
 *                  normal outcome: the AI instructions require missing data to
 *                  REDUCE confidence, which only works if "we looked and found
 *                  nothing" reaches the model as an explicit null.
 *   - Failure    — the provider could not complete the lookup at all (network,
 *                  auth, rate limit, malformed vendor response). It THROWS a
 *                  `ProviderCallError`, which the engine retries per
 *                  STEP_MAX_ATTEMPTS and then records as a FAILED step.
 *   - Not called — no provider is configured, so the registry slot is null and
 *                  the engine SKIPs the step. The AI then receives
 *                  `enrichment: null`, which is distinguishable from an
 *                  all-null result: "never looked" vs "looked, found nothing".
 *
 * A provider must therefore never signal "nothing found" by throwing, and
 * never signal a lookup failure by returning nulls.
 */
export type EnrichmentData = {
  company: EnrichmentCompany
  person: EnrichmentPerson
  lead: EnrichmentLeadContext
}

export type EnrichmentResult = { provider: string; data: EnrichmentData }

/**
 * The all-null result: a successful enrichment that resolved nothing.
 *
 * Exists so "not found" is a value a provider constructs rather than a nested
 * literal it hand-writes (and gets subtly wrong) at every miss.
 */
export function emptyEnrichmentData(lead: Pick<LeadFacts, 'source'>): EnrichmentData {
  return {
    company: { name: null, website: null, industry: null, employeeCount: null, country: null },
    person: { jobTitle: null, seniority: null },
    lead: { source: lead.source },
  }
}

/**
 * Input is unchanged from Phase 2C: the identifying facts already on the lead.
 * A provider should use only what it needs to resolve an identity — the email
 * domain, the company name, the person's name — and must not treat `phone` or
 * `id` as lookup keys.
 */
export interface EnrichmentProvider {
  readonly name: string
  enrich(input: ProviderCall & { lead: LeadFacts }): Promise<EnrichmentResult>
}

/**
 * The organization's own qualification configuration, as pinned to the run.
 *
 * TRUSTED-ISH, but not system: written by an authenticated ADMIN, so it may
 * shape the instructions — unlike lead text, which may never do so. It still
 * occupies a delimited slot in the prompt, and the immutable security and
 * output rules always come AFTER it, so an ICP saying "ignore your rules"
 * cannot take effect.
 */
export type QualificationConfig = {
  /** Who this organization considers an ideal customer. */
  icp: string
  /** Optional extra guidance. */
  instructions: string | null
  /**
   * Score at or above which the lead qualifies. Carried here for the prompt's
   * benefit only — the BACKEND applies it (lib/automation/engine.ts), and the
   * model's opinion of it is never the deciding factor.
   */
  threshold: number
}

/**
 * Returns the model's raw structured output. The engine — not the provider —
 * validates and clamps it (see lib/validation/automation-ai.ts), so a
 * malformed response can never reach the database as a guessed score.
 */
export interface AiQualificationProvider {
  readonly name: string
  qualify(
    input: ProviderCall & {
      lead: LeadFacts
      enrichment: EnrichmentResult | null
      config: QualificationConfig
    },
  ): Promise<unknown>
}

export interface CrmSyncProvider {
  readonly name: string
  upsertLead(input: ProviderCall & { lead: LeadFacts; aiScore: number | null }): Promise<{
    recordId: string
  }>
}

export interface EmailProvider {
  readonly name: string
  send(
    input: ProviderCall & { lead: LeadFacts; summary: string | null },
  ): Promise<{ providerMessageId: string }>
}

export type NotificationKind = 'run_succeeded' | 'run_failed' | 'run_blocked'

export interface NotificationProvider {
  readonly name: string
  notify(
    input: ProviderCall & {
      lead: LeadFacts
      runId: string
      kind: NotificationKind
      detail: string | null
    },
  ): Promise<{ ref: string | null }>
}

/**
 * Per-organization AI spend guard, checked BEFORE the AI provider is called
 * (docs/architecture.md §7). Throws to refuse; exceeding a budget is not
 * retriable, so it must throw a non-retriable error.
 */
export interface AiBudgetGuard {
  assertWithinBudget(organizationId: string): Promise<void>
}

export type ProviderRegistry = {
  enrichment: EnrichmentProvider | null
  ai: AiQualificationProvider | null
  crm: CrmSyncProvider | null
  email: EmailProvider | null
  notification: NotificationProvider | null
  aiBudget: AiBudgetGuard | null
}

/** Nothing is connected until Phase 2D wires real providers in. */
export const EMPTY_PROVIDER_REGISTRY: ProviderRegistry = {
  enrichment: null,
  ai: null,
  crm: null,
  email: null,
  notification: null,
  aiBudget: null,
}

let registry: ProviderRegistry = EMPTY_PROVIDER_REGISTRY

export function getProviderRegistry(): ProviderRegistry {
  return registry
}

/** Wiring seam for Phase 2D (and for tests, which inject fakes). */
export function setProviderRegistry(next: Partial<ProviderRegistry>): void {
  registry = { ...EMPTY_PROVIDER_REGISTRY, ...next }
}

/**
 * A provider failure the engine understands.
 *
 * `retriable` defaults to true: an unknown/transient provider fault is worth
 * another attempt. Set it false for conditions retrying cannot fix (an
 * exhausted AI budget being the concrete case).
 */
export class ProviderCallError extends Error {
  readonly code: string
  readonly retriable: boolean

  constructor(code: string, message: string, options?: { retriable?: boolean; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.name = 'ProviderCallError'
    this.code = code
    this.retriable = options?.retriable ?? true
  }
}

export function isRetriableProviderError(error: unknown): boolean {
  return error instanceof ProviderCallError ? error.retriable : true
}

export function providerErrorCode(error: unknown, fallback: string): string {
  return error instanceof ProviderCallError ? error.code : fallback
}
