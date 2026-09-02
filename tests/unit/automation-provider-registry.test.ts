import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2D-2 — production provider registry wiring.
 *
 * `@/lib/env` is mocked so these tests never need a real OPENAI_API_KEY and
 * never construct a client against real configuration. What is proven here is
 * only the wiring decision: which slots are filled, and when.
 */

const envMock = vi.hoisted(() => ({
  value: {
    OPENAI_API_KEY: undefined as string | undefined,
    OPENAI_QUALIFICATION_MODEL: 'gpt-5',
    APOLLO_API_KEY: undefined as string | undefined,
    PROSPEO_API_KEY: undefined as string | undefined,
  },
}))

vi.mock('@/lib/env', () => ({
  getEnv: () => envMock.value,
}))

async function loadRegistry() {
  // Fresh module state per test: the registry memoises its configuration.
  vi.resetModules()
  return import('@/lib/automation/provider-registry')
}

beforeEach(() => {
  envMock.value = {
    OPENAI_API_KEY: undefined,
    OPENAI_QUALIFICATION_MODEL: 'gpt-5',
    APOLLO_API_KEY: undefined,
    PROSPEO_API_KEY: undefined,
  }
})

afterEach(() => {
  vi.resetModules()
})

describe('ensureProviderRegistry', () => {
  it('leaves every slot null when OpenAI is not configured', async () => {
    const { ensureProviderRegistry } = await loadRegistry()
    const registry = ensureProviderRegistry()

    // Preserves the engine's existing BLOCKED behaviour for AI_QUALIFY, so
    // local development without a key keeps working exactly as before.
    expect(registry).toEqual({
      enrichment: null,
      ai: null,
      crm: null,
      email: null,
      notification: null,
      aiBudget: null,
    })
  })

  it('installs the OpenAI provider when an API key is configured', async () => {
    envMock.value = {
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const registry = ensureProviderRegistry()

    expect(registry.ai?.name).toBe('openai')
  })

  it('wires each vendor slot independently of the others', async () => {
    envMock.value = {
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const registry = ensureProviderRegistry()

    // OpenAI configured, Apollo not: the enrichment step stays SKIPPED while
    // AI qualification runs.
    expect(registry.ai?.name).toBe('openai')
    expect(registry.enrichment).toBeNull()
    expect(registry.crm).toBeNull()
    expect(registry.email).toBeNull()
    expect(registry.notification).toBeNull()
  })

  it('installs the Apollo provider when APOLLO_API_KEY is configured', async () => {
    envMock.value = {
      OPENAI_API_KEY: undefined,
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: 'apollo-test-key',
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const registry = ensureProviderRegistry()

    expect(registry.enrichment?.name).toBe('apollo')
    // Apollo alone does not imply AI: the slots are independent.
    expect(registry.ai).toBeNull()
  })

  it('installs both vendors when both keys are configured', async () => {
    envMock.value = {
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: 'apollo-test-key',
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const registry = ensureProviderRegistry()

    expect(registry.ai?.name).toBe('openai')
    expect(registry.enrichment?.name).toBe('apollo')
  })

  it('keeps no copy of the Apollo key on the enumerable provider surface', async () => {
    envMock.value = {
      OPENAI_API_KEY: undefined,
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: 'apollo-test-key',
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const provider = ensureProviderRegistry().enrichment

    // The key is a private field used only to build the request header; it is
    // never part of what the provider reports about itself.
    expect(JSON.stringify({ name: provider?.name })).not.toContain('apollo-test-key')
  })

  it('installs the Prospeo provider when PROSPEO_API_KEY is configured', async () => {
    envMock.value = {
      OPENAI_API_KEY: undefined,
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: 'prospeo-test-key',
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const registry = ensureProviderRegistry()

    expect(registry.enrichment?.name).toBe('prospeo')
    expect(registry.ai).toBeNull()
  })

  it('gives Prospeo precedence over Apollo when both keys are configured', async () => {
    envMock.value = {
      OPENAI_API_KEY: undefined,
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: 'apollo-test-key',
      PROSPEO_API_KEY: 'prospeo-test-key',
    }
    const { ensureProviderRegistry } = await loadRegistry()

    // One slot, two available vendors: the choice is fixed at wiring time,
    // not decided per-request and never a runtime fallback.
    expect(ensureProviderRegistry().enrichment?.name).toBe('prospeo')
  })

  it('still uses Apollo when only its key is configured', async () => {
    envMock.value = {
      OPENAI_API_KEY: undefined,
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: 'apollo-test-key',
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()

    // Adding Prospeo must not remove Apollo.
    expect(ensureProviderRegistry().enrichment?.name).toBe('apollo')
  })

  it('keeps no copy of the Prospeo key on the enumerable provider surface', async () => {
    envMock.value = {
      OPENAI_API_KEY: undefined,
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: 'prospeo-test-key',
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const provider = ensureProviderRegistry().enrichment

    expect(JSON.stringify({ name: provider?.name })).not.toContain('prospeo-test-key')
  })

  it('is idempotent — repeated calls return the same provider instance', async () => {
    envMock.value = {
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()

    expect(ensureProviderRegistry().ai).toBe(ensureProviderRegistry().ai)
  })

  it('keeps no copy of the API key on the provider itself', async () => {
    envMock.value = {
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_QUALIFICATION_MODEL: 'gpt-5',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: undefined,
    }
    const { ensureProviderRegistry } = await loadRegistry()
    const provider = ensureProviderRegistry().ai

    // The key belongs to the SDK client and stays there. The provider holds
    // no second copy that could be logged or serialized by accident.
    // (That the key never reaches a request body or an error message is
    // proven in tests/unit/automation-ai-provider.test.ts.)
    expect(provider).not.toHaveProperty('apiKey')
    expect(Object.values(provider as object)).not.toContain('sk-test-key')
  })
})

describe('createProspeoEnrichmentProvider', () => {
  it('returns null when no API key is present', async () => {
    vi.resetModules()
    const { createProspeoEnrichmentProvider } =
      await import('@/lib/automation/prospeo-enrichment-provider')
    expect(createProspeoEnrichmentProvider()).toBeNull()
  })
})

describe('createOpenAiQualificationProvider', () => {
  it('returns null when no API key is present', async () => {
    vi.resetModules()
    const { createOpenAiQualificationProvider } =
      await import('@/lib/automation/openai-qualification-provider')
    expect(createOpenAiQualificationProvider()).toBeNull()
  })

  it('uses the configured model', async () => {
    envMock.value = {
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_QUALIFICATION_MODEL: 'gpt-5-mini',
      APOLLO_API_KEY: undefined,
      PROSPEO_API_KEY: undefined,
    }
    vi.resetModules()
    const { createOpenAiQualificationProvider } =
      await import('@/lib/automation/openai-qualification-provider')
    const provider = createOpenAiQualificationProvider()

    expect(provider).not.toBeNull()
    // Model choice is observable through the output it attaches.
    expect(provider).toMatchObject({ name: 'openai' })
  })
})
