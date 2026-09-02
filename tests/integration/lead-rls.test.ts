import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asTenant, createTestDb, seedTwoTenants } from '@/tests/helpers/pglite'

/**
 * Phase 1A — Lead database foundation.
 *
 * Mirrors tests/integration/rls-tenant-isolation.test.ts: real PostgreSQL
 * (PGlite/WASM), the project's real migrations, and the unprivileged
 * `leadflow_app` role — never the bootstrap superuser — so these prove the
 * policies that will actually protect production data.
 *
 * Scope: the Lead table/RLS/dedup/soft-delete columns only. No CRUD/API/query
 * layer exists yet (Phase 1B+), so leads are inserted directly via SQL here,
 * the same way seedTwoTenants seeds organizations/users.
 */
describe('Lead database foundation', () => {
  let db: PGlite
  let tenants: Awaited<ReturnType<typeof seedTwoTenants>>

  beforeAll(async () => {
    db = await createTestDb()
    tenants = await seedTwoTenants(db)
  })

  afterAll(async () => {
    await db?.close()
  })

  function insertLeadSql({
    id,
    organizationId,
    ownerId,
    email,
  }: {
    id: string
    organizationId: string
    ownerId: string
    email: string
  }) {
    return db.query(
      `INSERT INTO "leads"
         ("id", "organizationId", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
       VALUES ($1, $2, $3, 'Test Lead', $4, 'WEBSITE_FORM', NOW(), NOW(), NOW())
       RETURNING id`,
      [id, organizationId, ownerId, email],
    )
  }

  it('enables and forces row security on leads', async () => {
    const result = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'leads'`,
    )

    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
  })

  it('creates a Lead inside the current tenant', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertLeadSql({
        id: 'lead_acme_1',
        organizationId: tenants.acme.organizationId,
        ownerId: tenants.acme.adminUserId,
        email: 'acme-lead-1@prospect.test',
      })
      const result = await db.query<{ email: string; status: string }>(
        `SELECT email, status FROM leads WHERE id = 'lead_acme_1'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ email: 'acme-lead-1@prospect.test', status: 'NEW' }])
  })

  it("does not let tenant A read tenant B's Lead", async () => {
    await asTenant(db, tenants.globex.organizationId, () =>
      insertLeadSql({
        id: 'lead_globex_1',
        organizationId: tenants.globex.organizationId,
        ownerId: tenants.globex.adminUserId,
        email: 'globex-lead-1@prospect.test',
      }),
    )

    const stolen = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('SELECT * FROM leads WHERE id = $1', ['lead_globex_1'])
      return result.rows
    })

    expect(stolen).toEqual([])
  })

  it('rejects an INSERT that attributes a Lead to another tenant', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertLeadSql({
          id: 'lead_injected',
          organizationId: tenants.globex.organizationId,
          ownerId: tenants.globex.adminUserId,
          email: 'attacker@prospect.test',
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('returns zero Leads when no tenant context is set (fails closed)', async () => {
    const result = await db.query('SELECT * FROM leads')
    expect(result.rows).toEqual([])
  })

  it('rejects a duplicate email within the same organization', async () => {
    await asTenant(db, tenants.acme.organizationId, () =>
      insertLeadSql({
        id: 'lead_acme_dup_1',
        organizationId: tenants.acme.organizationId,
        ownerId: tenants.acme.adminUserId,
        email: 'dup@prospect.test',
      }),
    )

    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertLeadSql({
          id: 'lead_acme_dup_2',
          organizationId: tenants.acme.organizationId,
          ownerId: tenants.acme.adminUserId,
          email: 'dup@prospect.test',
        }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('allows the same email in two different organizations', async () => {
    await asTenant(db, tenants.acme.organizationId, () =>
      insertLeadSql({
        id: 'lead_acme_shared',
        organizationId: tenants.acme.organizationId,
        ownerId: tenants.acme.adminUserId,
        email: 'shared@prospect.test',
      }),
    )

    // Would throw (and fail the test) if uniqueness were global rather than
    // tenant-scoped.
    const globexRows = await asTenant(db, tenants.globex.organizationId, async () => {
      await insertLeadSql({
        id: 'lead_globex_shared',
        organizationId: tenants.globex.organizationId,
        ownerId: tenants.globex.adminUserId,
        email: 'shared@prospect.test',
      })
      const result = await db.query<{ email: string }>(
        `SELECT email FROM leads WHERE id = 'lead_globex_shared'`,
      )
      return result.rows
    })

    expect(globexRows).toEqual([{ email: 'shared@prospect.test' }])
  })

  it('allows a Lead with no owner (Unassigned) — Phase 1.1 business rules closure', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await db.query(
        `INSERT INTO "leads"
           ("id", "organizationId", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
         VALUES ('lead_acme_unassigned', $1, NULL, 'Test Lead', 'unassigned@prospect.test', 'MANUAL', NOW(), NOW(), NOW())`,
        [tenants.acme.organizationId],
      )
      const result = await db.query<{ ownerId: string | null }>(
        `SELECT "ownerId" FROM leads WHERE id = 'lead_acme_unassigned'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ ownerId: null }])
  })

  it('a soft-deleted Lead keeps its email identity: the same org cannot create a second Lead with that email', async () => {
    await asTenant(db, tenants.acme.organizationId, async () => {
      await insertLeadSql({
        id: 'lead_acme_identity',
        organizationId: tenants.acme.organizationId,
        ownerId: tenants.acme.adminUserId,
        email: 'identity@prospect.test',
      })
      await db.query(`UPDATE leads SET "deletedAt" = NOW() WHERE id = 'lead_acme_identity'`)
    })

    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertLeadSql({
          id: 'lead_acme_identity_2',
          organizationId: tenants.acme.organizationId,
          ownerId: tenants.acme.adminUserId,
          email: 'identity@prospect.test',
        }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('represents a soft-deleted Lead without physically removing the row', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertLeadSql({
        id: 'lead_acme_softdeleted',
        organizationId: tenants.acme.organizationId,
        ownerId: tenants.acme.adminUserId,
        email: 'softdeleted@prospect.test',
      })
      await db.query(`UPDATE leads SET "deletedAt" = NOW() WHERE id = 'lead_acme_softdeleted'`)
      const result = await db.query<{ id: string; deletedAt: string | null }>(
        `SELECT id, "deletedAt" FROM leads WHERE id = 'lead_acme_softdeleted'`,
      )
      return result.rows
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.deletedAt).not.toBeNull()
  })
})
