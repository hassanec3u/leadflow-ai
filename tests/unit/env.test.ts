import { describe, expect, it } from 'vitest'

import { __serverEnvSchema } from '@/lib/env'

/**
 * Environment validation.
 *
 * The behaviour that matters most: REQUIRED vars are enforced, and OPTIONAL
 * integration credentials are genuinely optional — the app must start without
 * them (Phase 0 requirement).
 */
describe('server environment validation', () => {
  const validBase = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/leadflow',
    AUTH_SECRET: 'a-secret-that-is-at-least-32-characters',
  }

  it('accepts a minimal valid configuration', () => {
    const result = __serverEnvSchema.safeParse(validBase)
    expect(result.success).toBe(true)
  })

  it('starts without any optional integration credentials', () => {
    const result = __serverEnvSchema.safeParse(validBase)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.OPENAI_API_KEY).toBeUndefined()
      expect(result.data.AIRTABLE_API_KEY).toBeUndefined()
      expect(result.data.SLACK_BOT_TOKEN).toBeUndefined()
      expect(result.data.EMAIL_PROVIDER_API_KEY).toBeUndefined()
    }
  })

  it('rejects a missing DATABASE_URL', () => {
    const result = __serverEnvSchema.safeParse({ AUTH_SECRET: validBase.AUTH_SECRET })
    expect(result.success).toBe(false)
  })

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    // Catches the classic misconfiguration of pointing at MySQL or a bare host.
    const result = __serverEnvSchema.safeParse({
      ...validBase,
      DATABASE_URL: 'mysql://user:pass@localhost:3306/leadflow',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a short AUTH_SECRET', () => {
    const result = __serverEnvSchema.safeParse({ ...validBase, AUTH_SECRET: 'too-short' })
    expect(result.success).toBe(false)
  })

  it('defaults NODE_ENV to development', () => {
    const result = __serverEnvSchema.safeParse(validBase)
    expect(result.success && result.data.NODE_ENV).toBe('development')
  })
})
