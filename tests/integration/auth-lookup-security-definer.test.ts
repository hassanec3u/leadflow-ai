import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AUTH_LOOKUP_ROLE,
  APP_ROLE,
  asTenant,
  createTestDb,
  seedTwoTenants,
} from '@/tests/helpers/pglite'

/**
 * Verifies the `auth_lookup_user_by_email` SECURITY DEFINER exception
 * (prisma/migrations/20260901000200_auth_lookup_security_definer) against
 * real PostgreSQL RLS enforcement — the exact mechanism described in
 * lib/auth/auth-lookup.ts and docs/architecture.md §11.11.
 *
 * Runs against real PostgreSQL (PGlite/WASM) as the actual application role
 * (leadflow_app, non-superuser), same as rls-tenant-isolation.test.ts.
 *
 * Test numbering matches the 9 scenarios requested for this fix. Scenarios
 * 2-4 (valid/invalid credentials, unknown email) are covered separately in
 * tests/unit/verify-credentials.test.ts, since they exercise application
 * logic (bcrypt comparison, uniform failure) rather than database behavior.
 */
describe('auth_lookup_user_by_email SECURITY DEFINER exception', () => {
  let db: PGlite
  let tenants: Awaited<ReturnType<typeof seedTwoTenants>>

  beforeAll(async () => {
    db = await createTestDb()
    tenants = await seedTwoTenants(db) // also switches the session to leadflow_app
  })

  afterAll(async () => {
    await db?.close()
  })

  // --- 1. Existing user can be found during pre-authentication lookup -----
  it('finds an existing user by exact email during pre-authentication lookup', async () => {
    const result = await db.query<{
      id: string
      email: string
      organizationId: string
      role: string
      passwordHash: string | null
    }>('SELECT * FROM auth_lookup_user_by_email($1)', ['admin@acme.test'])

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      email: 'admin@acme.test',
      organizationId: 'org_acme',
      role: 'ADMIN',
    })
  })

  it('normalizes email the same way the application does (trim + lowercase)', async () => {
    const result = await db.query('SELECT * FROM auth_lookup_user_by_email($1)', [
      '  ADMIN@Acme.Test  ',
    ])
    expect(result.rows).toHaveLength(1)
  })

  // --- 5. The lookup cannot be used to enumerate arbitrary user data ------
  it('performs an exact match only — a wildcard/pattern input matches nothing', async () => {
    const wildcard = await db.query('SELECT * FROM auth_lookup_user_by_email($1)', ['%'])
    expect(wildcard.rows).toEqual([])

    const underscore = await db.query('SELECT * FROM auth_lookup_user_by_email($1)', ['_'])
    expect(underscore.rows).toEqual([])
  })

  it('is immune to SQL-injection-shaped input — treated as a literal, not syntax', async () => {
    const payloads = [
      "' OR '1'='1",
      "admin@acme.test' OR '1'='1",
      "'; DROP TABLE users; --",
      "admin@acme.test'; SELECT * FROM users; --",
    ]

    for (const payload of payloads) {
      const result = await db.query('SELECT * FROM auth_lookup_user_by_email($1)', [payload])
      expect(result.rows).toEqual([])
    }

    // Prove the table (and its rows) still exist — an injected DROP/dump did
    // not silently succeed.
    const stillThere = await db.query('SELECT * FROM auth_lookup_user_by_email($1)', [
      'admin@acme.test',
    ])
    expect(stillThere.rows).toHaveLength(1)
  })

  it('is granted to the application role only — not to PUBLIC or any other role', async () => {
    const grantees = await db.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.routine_privileges
       WHERE routine_name = 'auth_lookup_user_by_email' AND privilege_type = 'EXECUTE'`,
    )
    const grantedTo = grantees.rows.map((row) => row.grantee)

    expect(grantedTo).toContain(APP_ROLE)
    expect(grantedTo).not.toContain('PUBLIC')
    expect(grantedTo).toHaveLength(1)
  })

  it('the new policy is scoped to the auth-lookup role only, not to the app role generally', async () => {
    const policies = await db.query<{ policyname: string; roles: string[] }>(
      `SELECT policyname, roles FROM pg_policies WHERE tablename = 'users' ORDER BY policyname`,
    )

    const authLookupPolicy = policies.rows.find((p) => p.policyname === 'users_auth_lookup')
    expect(authLookupPolicy?.roles).toEqual([AUTH_LOOKUP_ROLE])

    // The original tenant-isolation policy is untouched.
    const tenantPolicy = policies.rows.find((p) => p.policyname === 'users_tenant_isolation')
    expect(tenantPolicy).toBeDefined()
  })

  // --- 6. Normal authenticated queries still require tenant context -------
  it('a plain SELECT on users (not via the function) still returns nothing with no tenant context', async () => {
    const result = await db.query('SELECT * FROM users')
    expect(result.rows).toEqual([])
  })

  // --- 7. Tenant A cannot access Tenant B after authentication ------------
  it('after "authentication" (organization now known), ordinary tenant-scoped access stays isolated', async () => {
    const acmeVisibleIds = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query<{ id: string }>('SELECT id FROM users')
      return result.rows.map((row) => row.id)
    })
    expect(acmeVisibleIds).not.toContain(tenants.globex.adminUserId)

    const stolen = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('SELECT * FROM users WHERE id = $1', [
        tenants.globex.adminUserId,
      ])
      return result.rows
    })
    expect(stolen).toEqual([])
  })

  // --- 8. RLS remains enabled and enforced ---------------------------------
  it('RLS remains ENABLEd and FORCEd on users and organizations', async () => {
    const result = await db.query<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('users', 'organizations') ORDER BY relname`,
    )

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.relrowsecurity).toBe(true)
      expect(row.relforcerowsecurity).toBe(true)
    }
  })

  // --- 9. The application database role remains NONSUPERUSER/NOBYPASSRLS --
  it('neither the application role nor the auth-lookup role is superuser or BYPASSRLS', async () => {
    const result = await db.query<{
      rolname: string
      rolsuper: boolean
      rolbypassrls: boolean
      rolcanlogin: boolean
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
       WHERE rolname IN ('${APP_ROLE}', '${AUTH_LOOKUP_ROLE}') ORDER BY rolname`,
    )

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.rolsuper).toBe(false)
      expect(row.rolbypassrls).toBe(false)
    }

    // The auth-lookup role specifically must be NOLOGIN — its elevated
    // visibility is reachable only through the SECURITY DEFINER function,
    // never by connecting to the database as this role.
    const authLookupRow = result.rows.find((row) => row.rolname === AUTH_LOOKUP_ROLE)
    expect(authLookupRow?.rolcanlogin).toBe(false)
  })
})
