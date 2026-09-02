import { describe, expect, it } from 'vitest'

import { sanitizeContext } from '@/lib/logger'

/**
 * Logging must not become a data-leak channel. These tests pin the redaction
 * rules from the Phase 0 requirement "do not log passwords, secrets, API keys
 * or unnecessary PII".
 */
describe('log context sanitisation', () => {
  it('redacts secret-bearing keys', () => {
    const result = sanitizeContext({
      password: 'hunter2',
      passwordHash: '$2a$12$abc',
      AUTH_SECRET: 'super-secret',
      apiKey: 'sk-live-123',
      access_token: 'at-123',
      authorization: 'Bearer abc',
      cookie: 'session=abc',
    }) as Record<string, unknown>

    for (const value of Object.values(result)) {
      expect(value).toBe('[redacted]')
    }
  })

  it('reduces PII to a presence marker instead of a value', () => {
    const result = sanitizeContext({
      email: 'someone@example.com',
      phone: '+15551234567',
      slackUserId: 'U12345',
    }) as Record<string, unknown>

    expect(result.email).toBe('[pii:present]')
    expect(result.phone).toBe('[pii:present]')
    expect(result.slackUserId).toBe('[pii:present]')
    expect(JSON.stringify(result)).not.toContain('someone@example.com')
  })

  it('keeps non-sensitive diagnostic values intact', () => {
    const result = sanitizeContext({
      organizationId: 'org_123',
      status: 500,
      durationMs: 42,
    }) as Record<string, unknown>

    expect(result).toEqual({ organizationId: 'org_123', status: 500, durationMs: 42 })
  })

  it('redacts inside nested objects and arrays', () => {
    const result = sanitizeContext({
      user: { email: 'a@b.com', token: 'abc' },
      items: [{ apiKey: 'k1' }],
    }) as { user: Record<string, unknown>; items: Array<Record<string, unknown>> }

    expect(result.user.email).toBe('[pii:present]')
    expect(result.user.token).toBe('[redacted]')
    expect(result.items[0]?.apiKey).toBe('[redacted]')
  })

  it('matches keys regardless of case or separator style', () => {
    const result = sanitizeContext({
      API_KEY: 'x',
      'api-key': 'y',
      PassWord: 'z',
    }) as Record<string, unknown>

    expect(Object.values(result)).toEqual(['[redacted]', '[redacted]', '[redacted]'])
  })

  it('truncates deeply nested structures rather than recursing without bound', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } }
    expect(JSON.stringify(sanitizeContext(deep))).toContain('[truncated]')
  })

  it('preserves error name and message', () => {
    const result = sanitizeContext(new Error('boom')) as Record<string, unknown>
    expect(result.name).toBe('Error')
    expect(result.message).toBe('boom')
  })
})
