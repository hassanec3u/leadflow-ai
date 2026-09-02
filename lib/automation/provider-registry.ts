import 'server-only'

import { createApolloEnrichmentProvider } from '@/lib/automation/apollo-enrichment-provider'
import { createOpenAiQualificationProvider } from '@/lib/automation/openai-qualification-provider'
import { createProspeoEnrichmentProvider } from '@/lib/automation/prospeo-enrichment-provider'
import {
  getProviderRegistry,
  setProviderRegistry,
  type ProviderRegistry,
} from '@/lib/automation/providers'

/**
 * Production composition root for the provider registry (Phase 2D-2).
 *
 * Kept separate from lib/automation/providers.ts on purpose: that module
 * defines the interfaces and must stay vendor-free, and importing a vendor
 * back into it would create an import cycle. This is the one place that
 * knows which concrete provider fills which slot.
 *
 * The AI (Phase 2D-2) and enrichment (Phase 2D-4) slots are filled here, each
 * only when its own credential is configured. Email, notification and CRM
 * stay null, so the engine keeps its existing behaviour for them (SKIPPED for
 * the optional ones, BLOCKED for email on a qualified lead).
 */

let configured = false

/**
 * Idempotently installs the production providers, then returns the registry.
 *
 * Called at execution time rather than module load so that a missing or
 * invalid environment fails inside a run — where the engine records it on
 * the run row — instead of at import, which would take down unrelated code
 * paths that never touch automation.
 */
export function ensureProviderRegistry(): ProviderRegistry {
  if (!configured) {
    // Each factory returns null when its credential is absent, leaving that
    // slot null: AI_QUALIFY then BLOCKs and ENRICH is SKIPped, exactly as
    // they behave today for local development without keys.
    //
    // The registry has ONE enrichment slot and two available vendors, so the
    // precedence is fixed and decided here, at wiring time: Prospeo when its
    // key is configured, Apollo otherwise. This is deliberately NOT a runtime
    // fallback — a Prospeo failure never silently retries against Apollo,
    // because two vendors disagreeing about a lead should surface, not hide.
    setProviderRegistry({
      ai: createOpenAiQualificationProvider(),
      enrichment: createProspeoEnrichmentProvider() ?? createApolloEnrichmentProvider(),
    })
    configured = true
  }
  return getProviderRegistry()
}

/** Test-only: forces the next `ensureProviderRegistry()` to rebuild. */
export function resetProviderRegistryForTests(): void {
  configured = false
  setProviderRegistry({})
}
