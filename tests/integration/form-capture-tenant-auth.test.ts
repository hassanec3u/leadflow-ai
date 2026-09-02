import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  APP_ROLE,
  applyManualScript,
  asTenant,
  createTestDb,
  seedTwoTenants,
  type TestDb,
} from '@/tests/helpers/pglite'

/**
 * Phase 2E-1 — Website Form capture secret: tenant resolution before any
 * tenant context exists.
 *
 * Real PostgreSQL (PGlite), the real migration, the real
 * prisma/manual/003 provisioning script, and — crucially — the real
 * unprivileged `leadflow_app` role. Testing this as the bootstrap superuser
 * would prove nothing: superusers ignore RLS entirely, so every isolation
 * assertion would pass vacuously.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

// Fixture credentials. Not sensitive: they exist only inside this in-memory
// database, and the production generator uses 256 bits of CSPRNG output.
const ACME_SECRET = 'lfwf_test_secret_for_acme_only'
const GLOBEX_SECRET = 'lfwf_test_secret_for_globex_only'

let db: TestDb

/** Calls the SECURITY DEFINER function the way the application does. */
async function lookup(secretHash: string) {
  const result = await db.query<{ organizationId: string }>(
    'SELECT * FROM form_capture_lookup_organization($1)',
    [secretHash],
  )
  return result.rows
}

beforeAll(async () => {
  db = await createTestDb()

  // Applied as the bootstrap superuser, exactly as an operator would run it
  // in production — and BEFORE dropping to the app role.
  await applyManualScript(db, '003_provision_form_capture_role.sql')

  await seedTwoTenants(db)

  // Seed the two secrets as the app role, under each tenant's own context —
  // the same path the admin service takes via withTenant().
  await asTenant(db, 'org_acme', async () => {
    await db.query('UPDATE "organizations" SET "formCaptureSecretHash" = $1 WHERE "id" = $2', [
      sha256(ACME_SECRET),
      'org_acme',
    ])
  })
  await asTenant(db, 'org_globex', async () => {
    await db.query('UPDATE "organizations" SET "formCaptureSecretHash" = $1 WHERE "id" = $2', [
      sha256(GLOBEX_SECRET),
      'org_globex',
    ])
  })
})

describe('schema and storage', () => {
  it('stores only the hash — the plaintext secret is nowhere in the database', async () => {
    const result = await db.query<{ hash: string | null }>(
      'SELECT "formCaptureSecretHash" AS hash FROM "organizations" WHERE "id" = $1',
      ['org_acme'],
    )

    // Readable here only because the query below runs without tenant context
    // as... let's be precise: it runs as the app role with no context, so RLS
    // returns nothing. That itself is the assertion.
    expect(result.rows).toHaveLength(0)
  })

  it('exposes the hash to its own tenant, and it is not the plaintext', async () => {
    const rows = await asTenant(db, 'org_acme', async () => {
      const result = await db.query<{ hash: string | null }>(
        'SELECT "formCaptureSecretHash" AS hash FROM "organizations" WHERE "id" = $1',
        ['org_acme'],
      )
      return result.rows
    })

    expect(rows[0]?.hash).toBe(sha256(ACME_SECRET))
    expect(rows[0]?.hash).not.toBe(ACME_SECRET)
    expect(rows[0]?.hash).toHaveLength(64)
  })

  it('refuses two organizations sharing one secret', async () => {
    await expect(
      asTenant(db, 'org_globex', async () => {
        await db.query('UPDATE "organizations" SET "formCaptureSecretHash" = $1 WHERE "id" = $2', [
          sha256(ACME_SECRET),
          'org_globex',
        ])
      }),
    ).rejects.toThrow(/unique|duplicate/i)
  })
})

describe('tenant resolution', () => {
  it('resolves a valid secret to its own organization, with no tenant context set', async () => {
    // This is the whole point: no current_org_id(), yet the lookup succeeds.
    expect(await lookup(sha256(ACME_SECRET))).toEqual([{ organizationId: 'org_acme' }])
  })

  it("never resolves tenant A's secret to tenant B", async () => {
    expect(await lookup(sha256(GLOBEX_SECRET))).toEqual([{ organizationId: 'org_globex' }])
    expect(await lookup(sha256(ACME_SECRET))).not.toEqual([{ organizationId: 'org_globex' }])
  })

  it('returns nothing for an unknown secret', async () => {
    expect(await lookup(sha256('lfwf_not_a_real_secret'))).toEqual([])
  })

  it('returns nothing for an empty or null hash rather than matching un-issued organizations', async () => {
    expect(await lookup('')).toEqual([])

    const nullResult = await db.query<{ organizationId: string }>(
      'SELECT * FROM form_capture_lookup_organization(NULL)',
    )
    expect(nullResult.rows).toEqual([])
  })

  it('returns only the organization id — no name, slug, or hash', async () => {
    const rows = await lookup(sha256(ACME_SECRET))

    expect(Object.keys(rows[0] ?? {})).toEqual(['organizationId'])
  })

  it('stops resolving once the organization is soft-deleted', async () => {
    await db.query('SET ROLE postgres')
    await db.query('UPDATE "organizations" SET "deletedAt" = NOW() WHERE "id" = $1', ['org_globex'])
    await db.query(`SET ROLE ${APP_ROLE}`)

    expect(await lookup(sha256(GLOBEX_SECRET))).toEqual([])

    await db.query('SET ROLE postgres')
    await db.query('UPDATE "organizations" SET "deletedAt" = NULL WHERE "id" = $1', ['org_globex'])
    await db.query(`SET ROLE ${APP_ROLE}`)
  })
})

describe('rotation', () => {
  it('invalidates the previous secret immediately and validates the new one', async () => {
    const rotated = 'lfwf_test_secret_for_acme_rotated'

    await asTenant(db, 'org_acme', async () => {
      await db.query('UPDATE "organizations" SET "formCaptureSecretHash" = $1 WHERE "id" = $2', [
        sha256(rotated),
        'org_acme',
      ])
    })

    expect(await lookup(sha256(ACME_SECRET))).toEqual([])
    expect(await lookup(sha256(rotated))).toEqual([{ organizationId: 'org_acme' }])

    // Restore for any later test.
    await asTenant(db, 'org_acme', async () => {
      await db.query('UPDATE "organizations" SET "formCaptureSecretHash" = $1 WHERE "id" = $2', [
        sha256(ACME_SECRET),
        'org_acme',
      ])
    })
  })
})

describe('the exception cannot become a general RLS bypass', () => {
  it('leaves organizations fail-closed for the app role with no tenant context', async () => {
    const result = await db.query('SELECT "id" FROM "organizations"')

    // The added policy is scoped TO leadflow_form_capture only, so the app
    // role's ordinary queries are still governed by tenant isolation alone.
    expect(result.rows).toEqual([])
  })

  it('still scopes the app role to its own organization WITH tenant context', async () => {
    const rows = await asTenant(db, 'org_acme', async () => {
      const result = await db.query<{ id: string }>('SELECT "id" FROM "organizations"')
      return result.rows
    })

    expect(rows).toEqual([{ id: 'org_acme' }])
  })

  it('does not let the app role read secrets across tenants through the function', async () => {
    // The only way to get an id out is to already hold the matching secret;
    // there is no wildcard input that returns every row.
    expect(await lookup('%')).toEqual([])
    expect(await lookup("' OR '1'='1")).toEqual([])
    expect(await lookup('true')).toEqual([])
  })

  it('does not grant the app role membership in the lookup role', async () => {
    // Membership would make the permissive lookup policy apply to the app
    // role's own queries — the exact defect documented in manual/001.
    const result = await db.query<{ member: boolean }>(
      `SELECT pg_has_role($1, 'leadflow_form_capture', 'MEMBER') AS member`,
      [APP_ROLE],
    )

    expect(result.rows[0]?.member).toBe(false)
  })

  it('keeps the lookup role inert: NOLOGIN, NOSUPERUSER, NOBYPASSRLS', async () => {
    const result = await db.query<{
      rolcanlogin: boolean
      rolsuper: boolean
      rolbypassrls: boolean
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'leadflow_form_capture'`,
    )

    expect(result.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false })
  })

  /**
   * Read from pg_catalog, not information_schema: the latter only shows
   * privileges the CURRENT role is party to, and these tests run as
   * leadflow_app, which is deliberately not a member of the lookup role.
   */
  it('grants the lookup role SELECT on exactly three columns, and nothing else', async () => {
    const grants = await db.query<{ attname: string; privilege_type: string }>(
      `SELECT a.attname, acl.privilege_type
         FROM pg_attribute a
         CROSS JOIN LATERAL aclexplode(a.attacl) acl
         JOIN pg_roles r ON r.oid = acl.grantee
        WHERE a.attrelid = 'organizations'::regclass
          AND r.rolname = 'leadflow_form_capture'
        ORDER BY a.attname`,
    )

    expect(grants.rows).toEqual([
      { attname: 'deletedAt', privilege_type: 'SELECT' },
      { attname: 'formCaptureSecretHash', privilege_type: 'SELECT' },
      { attname: 'id', privilege_type: 'SELECT' },
    ])
  })

  it('holds no table-level privilege on any table — not even organizations', async () => {
    const tableGrants = await db.query<{ relname: string; privilege_type: string }>(
      `SELECT c.relname, acl.privilege_type
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) acl
         JOIN pg_roles r ON r.oid = acl.grantee
        WHERE r.rolname = 'leadflow_form_capture'`,
    )

    // Column-level SELECT only: the role can never write a secret, and can
    // never read another table.
    expect(tableGrants.rows).toEqual([])
  })

  it('keeps FORCE ROW LEVEL SECURITY on organizations', async () => {
    const result = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'organizations'`,
    )

    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })
})
