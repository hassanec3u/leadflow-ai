import { describe, expect, it } from 'vitest'

import { signUpSchema, slugifyOrganizationName } from '@/lib/validation/auth'

describe('sign-up validation', () => {
  const valid = {
    name: 'Jane Doe',
    email: 'Jane@Example.COM',
    password: 'correct-horse-battery',
    organizationName: 'Acme Inc.',
  }

  it('accepts valid input and normalises the email', () => {
    const result = signUpSchema.safeParse(valid)
    expect(result.success).toBe(true)
    // Normalising to lowercase matters: the email column is unique, so
    // "Jane@x.com" and "jane@x.com" must not become two accounts.
    expect(result.success && result.data.email).toBe('jane@example.com')
  })

  it('rejects a password below the length floor', () => {
    const result = signUpSchema.safeParse({ ...valid, password: 'short' })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed email', () => {
    const result = signUpSchema.safeParse({ ...valid, email: 'not-an-email' })
    expect(result.success).toBe(false)
  })

  it('requires an organization name', () => {
    const result = signUpSchema.safeParse({ ...valid, organizationName: '' })
    expect(result.success).toBe(false)
  })
})

describe('organization slug derivation', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyOrganizationName('Acme Inc.')).toBe('acme-inc')
    expect(slugifyOrganizationName('  Spaced   Out  ')).toBe('spaced-out')
  })

  it('strips diacritics so similar names produce a readable slug', () => {
    expect(slugifyOrganizationName('Café Zoë')).toBe('cafe-zoe')
  })

  it('never returns an empty slug', () => {
    // The column is unique and NOT NULL; an empty slug would collide for every
    // organization whose name is entirely non-latin.
    expect(slugifyOrganizationName('日本語')).toBe('org')
    expect(slugifyOrganizationName('!!!')).toBe('org')
  })

  it('bounds slug length', () => {
    expect(slugifyOrganizationName('a'.repeat(200)).length).toBeLessThanOrEqual(48)
  })

  it('produces URL-safe output only', () => {
    expect(slugifyOrganizationName("O'Brien & Sons, Ltd.")).toMatch(/^[a-z0-9-]+$/)
  })
})
