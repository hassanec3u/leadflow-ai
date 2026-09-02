import { describe, expect, it } from 'vitest'

import { ROLES, type Role, capabilitiesFor, hasCapability } from '@/lib/auth/rbac'

/**
 * perm-1 / perm-2 / perm-3 groundwork in tests.json.
 *
 * These pin the capability matrix from docs/product-spec.md §11 so a future
 * edit to the matrix cannot silently widen access.
 */
describe('RBAC capability matrix', () => {
  it('grants ADMIN every capability', () => {
    expect(hasCapability('ADMIN', 'users:manage')).toBe(true)
    expect(hasCapability('ADMIN', 'billing:manage')).toBe(true)
    expect(hasCapability('ADMIN', 'integrations:manage')).toBe(true)
    expect(hasCapability('ADMIN', 'leads:view:all')).toBe(true)
    expect(hasCapability('ADMIN', 'analytics:view:org')).toBe(true)
  })

  it('lets MANAGER run the pipeline but not administer the account', () => {
    expect(hasCapability('MANAGER', 'leads:view:all')).toBe(true)
    expect(hasCapability('MANAGER', 'campaigns:manage')).toBe(true)
    expect(hasCapability('MANAGER', 'automation:manage')).toBe(true)
    expect(hasCapability('MANAGER', 'analytics:view:org')).toBe(true)

    // The documented boundary: managers do not touch integrations, users or billing.
    expect(hasCapability('MANAGER', 'integrations:manage')).toBe(false)
    expect(hasCapability('MANAGER', 'users:manage')).toBe(false)
    expect(hasCapability('MANAGER', 'billing:manage')).toBe(false)
  })

  it('grants SALES_REP no org-wide capability', () => {
    // A rep's lead access is an ownership filter applied at query time, not a
    // capability — so the rep holds none of these.
    expect(capabilitiesFor('SALES_REP')).toEqual([])
    expect(hasCapability('SALES_REP', 'leads:view:all')).toBe(false)
    expect(hasCapability('SALES_REP', 'analytics:view:org')).toBe(false)
    expect(hasCapability('SALES_REP', 'integrations:manage')).toBe(false)
  })

  it('denies unknown capabilities by omission rather than by allow-listing', () => {
    for (const role of ROLES) {
      const granted = capabilitiesFor(role as Role)
      // @ts-expect-error — deliberately probing a capability outside the union.
      expect(granted.includes('nonexistent:capability')).toBe(false)
    }
  })

  it('never grants a lower role something its superior lacks', () => {
    // Guards against a matrix edit that accidentally makes SALES_REP > MANAGER.
    for (const capability of capabilitiesFor('MANAGER')) {
      expect(hasCapability('ADMIN', capability)).toBe(true)
    }
    for (const capability of capabilitiesFor('SALES_REP')) {
      expect(hasCapability('MANAGER', capability)).toBe(true)
    }
  })
})
