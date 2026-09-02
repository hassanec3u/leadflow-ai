import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asTenant, createTestDb, seedTwoTenants } from '@/tests/helpers/pglite'

/**
 * tenancy-2 / tenancy-3 in tests.json.
 *
 * These run against real PostgreSQL (PGlite/WASM) with the project's real
 * migrations applied, so they test the actual policies that will protect
 * production data — not a simulation of them.
 */
describe('PostgreSQL RLS tenant isolation', () => {
  let db: PGlite
  let tenants: Awaited<ReturnType<typeof seedTwoTenants>>

  beforeAll(async () => {
    db = await createTestDb()
    tenants = await seedTwoTenants(db)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('applies all migrations cleanly, including the RLS migration', async () => {
    const result = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables
       WHERE schemaname = 'public' AND tablename IN ('organizations', 'users')
       ORDER BY tablename`,
    )

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.rowsecurity).toBe(true)
    }
  })

  it('FORCEs row security so the table owner cannot bypass policies', async () => {
    // Without relforcerowsecurity, our application role (which owns the tables)
    // would silently ignore every policy and the isolation below would be fake.
    const result = await db.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname IN ('organizations', 'users') ORDER BY relname`,
    )

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.relforcerowsecurity).toBe(true)
    }
  })

  it('shows a tenant only its own users', async () => {
    const acmeUsers = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query<{ email: string }>('SELECT email FROM users ORDER BY email')
      return result.rows.map((row) => row.email)
    })

    expect(acmeUsers).toEqual(['admin@acme.test', 'rep@acme.test'])
    expect(acmeUsers).not.toContain('admin@globex.test')
  })

  it('shows a tenant only its own organization', async () => {
    const globexOrgs = await asTenant(db, tenants.globex.organizationId, async () => {
      const result = await db.query<{ slug: string }>('SELECT slug FROM organizations')
      return result.rows.map((row) => row.slug)
    })

    expect(globexOrgs).toEqual(['globex'])
  })

  it('returns nothing for a targeted read of another tenant row, even with the exact id', async () => {
    // The attack this defends against: an id leaks or is guessed, and a query
    // fetches it by primary key without an organization filter.
    const stolen = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('SELECT * FROM users WHERE id = $1', ['user_globex_admin'])
      return result.rows
    })

    expect(stolen).toEqual([])
  })

  it('cannot UPDATE another tenant’s row', async () => {
    const updated = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING id', [
        'hijacked',
        'user_globex_admin',
      ])
      return result.rows
    })

    expect(updated).toEqual([])

    // Confirm the target really was untouched, viewed from its owning tenant.
    const globexName = await asTenant(db, tenants.globex.organizationId, async () => {
      const result = await db.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [
        'user_globex_admin',
      ])
      return result.rows[0]?.name
    })

    expect(globexName).toBe('Globex Admin')
  })

  it('cannot DELETE another tenant’s row', async () => {
    const deleted = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [
        'user_globex_admin',
      ])
      return result.rows
    })

    expect(deleted).toEqual([])
  })

  it('rejects an INSERT that attributes a row to another tenant', async () => {
    // WITH CHECK guards the write direction: a tenant must not be able to plant
    // a row inside someone else's organization.
    await expect(
      asTenant(db, tenants.acme.organizationId, async () =>
        db.query(
          `INSERT INTO users ("id", "organizationId", "email", "role", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 'ADMIN', NOW(), NOW())`,
          ['user_injected', 'org_globex', 'attacker@acme.test'],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('returns zero rows when no tenant context is set (fails closed)', async () => {
    // The critical property: forgetting to establish tenant context must not
    // expose everything. An unset GUC matches no rows.
    const users = await db.query('SELECT * FROM users')
    const orgs = await db.query('SELECT * FROM organizations')

    expect(users.rows).toEqual([])
    expect(orgs.rows).toEqual([])
  })

  it('does not leak context between transactions (SET LOCAL is transaction-scoped)', async () => {
    await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('SELECT * FROM users')
      expect(result.rows.length).toBeGreaterThan(0)
      return null
    })

    // Same connection, new transaction, no context: must be empty again.
    // This is what makes the pattern safe behind a connection pool.
    const afterwards = await db.query('SELECT * FROM users')
    expect(afterwards.rows).toEqual([])
  })
})
