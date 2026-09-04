import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, seedUsers } from '@/tests/helpers/pglite'

/**
 * Phase 2C — the database guarantees the execution engine depends on.
 *
 * Real PostgreSQL (PGlite/WASM) running the project's real migrations. The
 * engine's own logic is proven in tests/unit/automation-engine.test.ts; what is
 * proven HERE is the part no amount of application code can enforce on its
 * own: the two PARTIAL unique indexes that make execution idempotent. Prisma
 * cannot express a filtered index, so they are hand-written in the migration —
 * which makes testing them against real Postgres the only way to know they
 * exist and work.
 *
 * This file used to be much larger. It also covered tenant isolation on the
 * execution tables and the two SECURITY DEFINER recovery roles (their column
 * grants, their read-only-ness, their fail-closed behaviour across tenants).
 * All of that existed because of row level security, which the single-tenant
 * schema no longer has: the recovery sweeps are ordinary queries on the
 * application's own role now, so there is no privileged exception left to
 * audit.
 */
describe('Automation execution — database guarantees', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await createTestDb()
    await seedUsers(db)

    // One lead + workflow + enrollment to hang runs off.
    await db.query(
      `INSERT INTO "leads" ("id", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
       VALUES ('lead_1', NULL, 'Run Lead', 'run@prospect.test', 'WEBSITE_FORM', NOW(), NOW(), NOW())`,
    )
    await db.query(
      `INSERT INTO "workflows" ("id", "type", "status", "version", "createdAt", "updatedAt")
       VALUES ('wf_1', 'LEAD_QUALIFICATION', 'ACTIVE', 1, NOW(), NOW())`,
    )
    await db.query(
      `INSERT INTO "workflow_enrollments" ("id", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
       VALUES ('enr_1', 'wf_1', 'lead_1', 'AUTOMATIC', NOW(), NOW())`,
    )
  })

  afterAll(async () => {
    await db?.close()
  })

  function insertRun({
    id,
    trigger = 'AUTOMATIC',
    status = 'PENDING',
    createdAt = 'NOW()',
  }: {
    id: string
    trigger?: 'AUTOMATIC' | 'MANUAL_RERUN'
    status?: string
    createdAt?: string
  }) {
    return db.query(
      `INSERT INTO "workflow_runs"
         ("id", "workflowId", "workflowEnrollmentId", "leadId", "version", "trigger", "status", "createdAt", "updatedAt")
       VALUES ($1, 'wf_1', 'enr_1', 'lead_1', 1, $2, $3, ${createdAt}, NOW())`,
      [id, trigger, status],
    )
  }

  // -------------------------------------------------------------------------
  // 20 / 21 — the partial unique indexes
  // -------------------------------------------------------------------------

  it('20. rejects a second AUTOMATIC run for the same enrollment', async () => {
    await insertRun({ id: 'run_auto_1', status: 'SUCCEEDED' })

    await expect(insertRun({ id: 'run_auto_2', status: 'SUCCEEDED' })).rejects.toThrow(
      /duplicate key value|unique constraint/i,
    )
  })

  it('20b. allows several MANUAL_RERUN runs on that same enrollment (D3)', async () => {
    await insertRun({ id: 'run_manual_1', trigger: 'MANUAL_RERUN', status: 'SUCCEEDED' })
    await insertRun({ id: 'run_manual_2', trigger: 'MANUAL_RERUN', status: 'FAILED' })

    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM workflow_runs WHERE "workflowEnrollmentId" = 'enr_1'`,
    )

    expect(result.rows).toEqual([{ count: '3' }])
  })

  it('21. rejects a second active (PENDING/RUNNING) run for the same lead', async () => {
    await insertRun({ id: 'run_active_1', trigger: 'MANUAL_RERUN', status: 'RUNNING' })

    await expect(
      insertRun({ id: 'run_active_2', trigger: 'MANUAL_RERUN', status: 'PENDING' }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('21b. allows a new run once the previous one reaches a terminal state', async () => {
    await db.query(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = 'run_active_1'`)
    await insertRun({ id: 'run_active_3', trigger: 'MANUAL_RERUN', status: 'PENDING' })

    const result = await db.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = 'run_active_3'`,
    )

    expect(result.rows).toEqual([{ status: 'PENDING' }])
  })

  it('finalizing FAILED releases the one-active-run-per-lead index so a new run can be created', async () => {
    // This is what recovery relies on when it gives up on a stuck run: the
    // partial index only counts PENDING/RUNNING, so failing the stuck run is
    // what makes the lead runnable again.
    await db.query(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = 'run_active_3'`)
    await insertRun({ id: 'run_after_failure', trigger: 'MANUAL_RERUN', status: 'PENDING' })

    const result = await db.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = 'run_after_failure'`,
    )

    expect(result.rows).toEqual([{ status: 'PENDING' }])
  })

  // -------------------------------------------------------------------------
  // Phase 2C columns
  // -------------------------------------------------------------------------

  it('stores the BLOCKED run and step states added in Phase 2C', async () => {
    await db.query(`UPDATE workflow_runs SET status = 'BLOCKED' WHERE id = 'run_after_failure'`)
    await db.query(
      `INSERT INTO "workflow_step_runs" ("id", "workflowRunId", "step", "status", "attempts", "errorCode", "createdAt", "updatedAt")
       VALUES ('step_blocked', 'run_after_failure', 'SEND_EMAIL', 'BLOCKED', 1, 'email_provider_not_configured', NOW(), NOW())`,
    )

    const result = await db.query<{ runStatus: string; stepStatus: string; errorCode: string }>(
      `SELECT r.status AS "runStatus", s.status AS "stepStatus", s."errorCode"
       FROM workflow_runs r JOIN workflow_step_runs s ON s."workflowRunId" = r.id
       WHERE r.id = 'run_after_failure'`,
    )

    expect(result.rows).toEqual([
      {
        runStatus: 'BLOCKED',
        stepStatus: 'BLOCKED',
        errorCode: 'email_provider_not_configured',
      },
    ])
  })

  it('stores the qualification outcome/source columns added in Phase 2C', async () => {
    await db.query(
      `UPDATE leads SET "qualificationOutcome" = 'UNQUALIFIED', "qualificationSource" = 'HUMAN',
         "qualificationUpdatedAt" = NOW(), "aiScore" = 42
       WHERE id = 'lead_1'`,
    )

    const result = await db.query<{
      qualificationOutcome: string
      qualificationSource: string
      aiScore: number
      status: string
    }>(
      `SELECT "qualificationOutcome", "qualificationSource", "aiScore", status FROM leads WHERE id = 'lead_1'`,
    )

    // status stays independent of the qualification outcome (decision D1).
    expect(result.rows).toEqual([
      {
        qualificationOutcome: 'UNQUALIFIED',
        qualificationSource: 'HUMAN',
        aiScore: 42,
        status: 'NEW',
      },
    ])
  })

  // -------------------------------------------------------------------------
  // Recovery sweep reads
  // -------------------------------------------------------------------------

  describe('the RUNNING-orphan staleness query', () => {
    /**
     * Mirrors the query in lib/services/workflow-recovery.ts.
     *
     * Kept as an integration test because the staleness signal —
     * GREATEST(run.updatedAt, MAX(RUNNING step updatedAt)) — is real SQL that
     * Prisma's query API cannot express, so a fake cannot prove it behaves.
     * The unit tests stub this read out entirely; this is the only place its
     * semantics are actually exercised against Postgres.
     */
    function staleRunningRuns(olderThanSeconds: number) {
      return db.query<{ id: string }>(
        `SELECT r."id"
         FROM "workflow_runs" r
         LEFT JOIN LATERAL (
           SELECT MAX(s."updatedAt") AS last_running_step_at
           FROM "workflow_step_runs" s
           WHERE s."workflowRunId" = r."id" AND s."status" = 'RUNNING'
         ) steps ON TRUE
         WHERE r."status" = 'RUNNING'
           AND GREATEST(r."updatedAt", COALESCE(steps.last_running_step_at, r."updatedAt"))
               < NOW() - ($1 * INTERVAL '1 second')
         ORDER BY r."updatedAt" ASC`,
        [olderThanSeconds],
      )
    }

    beforeAll(async () => {
      // A second lead/enrollment, so these runs do not collide with the
      // one-active-run-per-lead index used above.
      await db.query(
        `INSERT INTO "leads" ("id", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
         VALUES ('lead_stale', NULL, 'Stale Lead', 'stale@prospect.test', 'WEBSITE_FORM', NOW(), NOW(), NOW())`,
      )
      await db.query(
        `INSERT INTO "workflow_enrollments" ("id", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
         VALUES ('enr_stale', 'wf_1', 'lead_stale', 'AUTOMATIC', NOW(), NOW())`,
      )
      await db.query(
        `INSERT INTO "workflow_runs"
           ("id", "workflowId", "workflowEnrollmentId", "leadId", "version", "trigger", "status", "createdAt", "updatedAt")
         VALUES ('run_stale', 'wf_1', 'enr_stale', 'lead_stale', 1, 'AUTOMATIC', 'RUNNING',
                 NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')`,
      )
    })

    it('returns a genuinely stale RUNNING run (crash between steps)', async () => {
      const result = await staleRunningRuns(600)
      expect(result.rows.map((r) => r.id)).toContain('run_stale')
    })

    it('never returns a run whose own updatedAt is recent', async () => {
      await db.query(`UPDATE workflow_runs SET "updatedAt" = NOW() WHERE id = 'run_stale'`)

      const result = await staleRunningRuns(600)
      expect(result.rows.map((r) => r.id)).not.toContain('run_stale')
    })

    it('treats a still-RUNNING step as liveness even when the run row itself is old', async () => {
      await db.query(
        `UPDATE workflow_runs SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE id = 'run_stale'`,
      )
      // A step claimed moments ago: the run is mid-provider-call, not dead.
      await db.query(
        `INSERT INTO "workflow_step_runs" ("id", "workflowRunId", "step", "status", "attempts", "createdAt", "updatedAt")
         VALUES ('step_live', 'run_stale', 'ENRICH', 'RUNNING', 1, NOW(), NOW())`,
      )

      const result = await staleRunningRuns(600)
      expect(result.rows.map((r) => r.id)).not.toContain('run_stale')
    })

    it('ignores a terminal step: its updatedAt is history, not liveness', async () => {
      await db.query(
        `UPDATE workflow_step_runs SET status = 'SUCCEEDED', "updatedAt" = NOW() WHERE id = 'step_live'`,
      )

      // The run row is still an hour old and no step is RUNNING any more, so
      // the run is stale again despite a freshly-updated step row.
      const result = await staleRunningRuns(600)
      expect(result.rows.map((r) => r.id)).toContain('run_stale')
    })

    it('never returns a run that is not RUNNING', async () => {
      await db.query(`UPDATE workflow_runs SET status = 'SUCCEEDED' WHERE id = 'run_stale'`)

      const result = await staleRunningRuns(600)
      expect(result.rows.map((r) => r.id)).not.toContain('run_stale')
    })
  })
})
