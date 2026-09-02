import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  applyManualScript,
  asTenant,
  createTestDb,
  seedTwoTenants,
  type TestDb,
} from '@/tests/helpers/pglite'

/**
 * Phase 2E-2 — the capture chain, end to end, in real PostgreSQL.
 *
 * Proves the composition the public endpoint relies on:
 *
 *   secret(org A) -> resolution -> org A -> withTenant(org A)
 *     -> Lead + WorkflowEnrollment + PENDING WorkflowRun in A
 *     -> nothing whatsoever in B
 *
 * The route's own logic is covered in tests/unit/lead-capture-route.test.ts;
 * what is proven here is that a tenant resolved from a capture secret confines
 * every subsequent write, with RLS as the enforcing barrier rather than
 * application care. Runs as the unprivileged `leadflow_app` role — as
 * PGlite's superuser this would pass vacuously.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const ACME_SECRET = 'lfwf_chain_fixture_acme'
const GLOBEX_SECRET = 'lfwf_chain_fixture_globex'

let db: TestDb

/** The SECURITY DEFINER lookup, called exactly as the route calls it. */
async function resolveOrganizationId(secret: string): Promise<string | null> {
  const result = await db.query<{ organizationId: string }>(
    'SELECT * FROM form_capture_lookup_organization($1)',
    [sha256(secret)],
  )
  return result.rows[0]?.organizationId ?? null
}

/** What captureAutomaticLead() writes, inside one tenant context. */
async function captureUnder(organizationId: string, suffix: string) {
  return asTenant(db, organizationId, async () => {
    await db.query(
      `INSERT INTO "leads"
         ("id", "organizationId", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
       VALUES ($1, $2, NULL, 'Captured Lead', $3, 'WEBSITE_FORM', NOW(), NOW(), NOW())`,
      [`lead_${suffix}`, organizationId, `captured-${suffix}@prospect.test`],
    )
    await db.query(
      `INSERT INTO "workflows"
         ("id", "organizationId", "type", "status", "version", "createdAt", "updatedAt")
       VALUES ($1, $2, 'LEAD_QUALIFICATION', 'ACTIVE', 1, NOW(), NOW())`,
      [`wf_${suffix}`, organizationId],
    )
    await db.query(
      `INSERT INTO "workflow_enrollments"
         ("id", "organizationId", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
       VALUES ($1, $2, $3, $4, 'AUTOMATIC', NOW(), NOW())`,
      [`enr_${suffix}`, organizationId, `wf_${suffix}`, `lead_${suffix}`],
    )
    await db.query(
      `INSERT INTO "workflow_runs"
         ("id", "organizationId", "workflowId", "workflowEnrollmentId", "leadId", "version", "trigger", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 1, 'AUTOMATIC', 'PENDING', NOW(), NOW())`,
      [`run_${suffix}`, organizationId, `wf_${suffix}`, `enr_${suffix}`, `lead_${suffix}`],
    )
  })
}

beforeAll(async () => {
  db = await createTestDb()
  await applyManualScript(db, '003_provision_form_capture_role.sql')
  await seedTwoTenants(db)

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

describe('secret -> tenant -> capture', () => {
  it('confines every row written after resolution to the resolved organization', async () => {
    const organizationId = await resolveOrganizationId(ACME_SECRET)
    expect(organizationId).toBe('org_acme')

    await captureUnder(organizationId!, 'acme')

    // Visible to its own tenant...
    const own = await asTenant(db, 'org_acme', async () => ({
      leads: (await db.query('SELECT "id" FROM "leads" WHERE "id" = $1', ['lead_acme'])).rows,
      enrollments: (
        await db.query('SELECT "id" FROM "workflow_enrollments" WHERE "id" = $1', ['enr_acme'])
      ).rows,
      runs: (
        await db.query<{ id: string; status: string }>(
          'SELECT "id", "status" FROM "workflow_runs" WHERE "id" = $1',
          ['run_acme'],
        )
      ).rows,
    }))

    expect(own.leads).toHaveLength(1)
    expect(own.enrollments).toHaveLength(1)
    expect(own.runs[0]).toEqual({ id: 'run_acme', status: 'PENDING' })
  })

  it('leaves the other tenant unable to see any of it', async () => {
    const other = await asTenant(db, 'org_globex', async () => ({
      leads: (await db.query('SELECT "id" FROM "leads"')).rows,
      enrollments: (await db.query('SELECT "id" FROM "workflow_enrollments"')).rows,
      runs: (await db.query('SELECT "id" FROM "workflow_runs"')).rows,
    }))

    expect(other.leads).toEqual([])
    expect(other.enrollments).toEqual([])
    expect(other.runs).toEqual([])
  })

  it("resolves each organization's own secret to itself, never to the other", async () => {
    expect(await resolveOrganizationId(GLOBEX_SECRET)).toBe('org_globex')
    expect(await resolveOrganizationId(ACME_SECRET)).toBe('org_acme')
  })

  it('writes under the OTHER secret land in the other organization only', async () => {
    const organizationId = await resolveOrganizationId(GLOBEX_SECRET)
    await captureUnder(organizationId!, 'globex')

    const acmeView = await asTenant(
      db,
      'org_acme',
      async () => (await db.query<{ id: string }>('SELECT "id" FROM "leads" ORDER BY "id"')).rows,
    )
    const globexView = await asTenant(
      db,
      'org_globex',
      async () => (await db.query<{ id: string }>('SELECT "id" FROM "leads" ORDER BY "id"')).rows,
    )

    expect(acmeView).toEqual([{ id: 'lead_acme' }])
    expect(globexView).toEqual([{ id: 'lead_globex' }])
  })

  it('yields no tenant for an unknown secret, so nothing can be written at all', async () => {
    expect(await resolveOrganizationId('lfwf_not_issued_to_anyone')).toBeNull()
  })

  it('sees nothing without a tenant context — RLS is the second barrier', async () => {
    const leads = await db.query('SELECT "id" FROM "leads"')
    const runs = await db.query('SELECT "id" FROM "workflow_runs"')

    expect(leads.rows).toEqual([])
    expect(runs.rows).toEqual([])
  })
})
