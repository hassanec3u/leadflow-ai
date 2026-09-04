import { describe, expect, it } from 'vitest'

import { createUserSchema } from '@/lib/validation/auth'

/**
 * Account-creation validation.
 *
 * This used to cover a public sign-up schema and the organization-slug
 * derivation that went with it. There is no public sign-up and no organization
 * any more: accounts are provisioned by an operator (prisma/seed.ts), so what
 * is left to pin down is the shape that seeding accepts.
 */
describe('account creation validation', () => {
  const valid = {
    name: 'Jane Doe',
    email: 'Jane@Example.COM',
    password: 'correct-horse-battery',
    role: 'ADMIN' as const,
  }

  it('accepts valid input and normalises the email', () => {
    const result = createUserSchema.safeParse(valid)
    expect(result.success).toBe(true)
    // Normalising to lowercase matters: the email column is unique, so
    // "Jane@x.com" and "jane@x.com" must not become two accounts.
    expect(result.success && result.data.email).toBe('jane@example.com')
  })

  it('rejects a password below the length floor', () => {
    expect(createUserSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false)
  })

  it('rejects a malformed email', () => {
    expect(createUserSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
  })

  it('requires a name', () => {
    expect(createUserSchema.safeParse({ ...valid, name: '' }).success).toBe(false)
  })

  it('requires a role, and only a known one', () => {
    // The role is explicit precisely because nobody self-registers into it.
    expect(createUserSchema.safeParse({ ...valid, role: undefined }).success).toBe(false)
    expect(createUserSchema.safeParse({ ...valid, role: 'OWNER' }).success).toBe(false)
    expect(createUserSchema.safeParse({ ...valid, role: 'SALES_REP' }).success).toBe(true)
  })
})
