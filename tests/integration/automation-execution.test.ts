import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applyManualScript,
  asTenant,
  APP_ROLE,
  createTestDb,
  seedTwoTenants,
} from '@/tests/helpers/pglite'

/**
 * Phase 2C — the database guarantees the execution engine depends on.
 *
 * Real PostgreSQL (PGlite/WASM), the project's real migrations, and the
 * unprivileged `leadflow_app` role. The engine's own logic is proven in
 * tests/unit/automation-engine.test.ts; what is proven HERE is the part no
 * amount of application code can be trusted to enforce on its own: the two
 * partial unique indexes that make execution idempotent, tenant isolation on
 * the execution tables, and the narrowly-scoped recovery read.
 */
describe('Automation execution — database guarantees', () => {
  let db: PGlite
  let tenants: Awaited<ReturnType<typeof seedTwoTenants>>

  beforeAll(async () => {
    db = await createTestDb()
    // The privileged, ops-run provisioning for the recovery sweep — applied
    // as the bootstrap superuser, exactly as an operator would.
    await applyManualScript(db, '002_provision_automation_recovery_role.sql')
    await applyManualScript(db, '004_provision_running_recovery_role.sql')
    tenants = await seedTwoTenants(db)

    // One lead + workflow + enrollment per tenant to hang runs off.
    for (const [key, tenant] of Object.entries(tenants)) {
      await asTenant(db, tenant.organizationId, async () => {
        await db.query(
          `INSERT INTO "leads" ("id", "organizationId", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
           VALUES ($1, $2, NULL, 'Run Lead', $3, 'WEBSITE_FORM', NOW(), NOW(), NOW())`,
          [`lead_${key}`, tenant.organizationId, `${key}-run@prospect.test`],
        )
        await db.query(
          `INSERT INTO "workflows" ("id", "organizationId", "type", "status", "version", "createdAt", "updatedAt")
           VALUES ($1, $2, 'LEAD_QUALIFICATION', 'ACTIVE', 1, NOW(), NOW())`,
          [`wf_${key}`, tenant.organizationId],
        )
        await db.query(
          `INSERT INTO "workflow_enrollments" ("id", "organizationId", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
           VALUES ($1, $2, $3, $4, 'AUTOMATIC', NOW(), NOW())`,
          [`enr_${key}`, tenant.organizationId, `wf_${key}`, `lead_${key}`],
        )
      })
    }
  })

  afterAll(async () => {
    await db?.close()
  })

  function insertRun({
    id,
    tenantKey,
    trigger = 'AUTOMATIC',
    status = 'PENDING',
    createdAt = 'NOW()',
  }: {
    id: string
    tenantKey: 'acme' | 'globex'
    trigger?: 'AUTOMATIC' | 'MANUAL_RERUN'
    status?: string
    createdAt?: string
  }) {
    return db.query(
      `INSERT INTO "workflow_runs"
         ("id", "organizationId", "workflowId", "workflowEnrollmentId", "leadId", "version", "trigger", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, ${createdAt}, NOW())`,
      [
        id,
        tenants[tenantKey].organizationId,
        `wf_${tenantKey}`,
        `enr_${tenantKey}`,
        `lead_${tenantKey}`,
        trigger,
        status,
      ],
    )
  }

  // -------------------------------------------------------------------------
  // 20 / 21 — the partial unique indexes
  // -------------------------------------------------------------------------

  it('20. rejects a second AUTOMATIC run for the same enrollment', async () => {
    await asTenant(db, tenants.acme.organizationId, () =>
      insertRun({ id: 'run_auto_1', tenantKey: 'acme', status: 'SUCCEEDED' }),
    )

    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertRun({ id: 'run_auto_2', tenantKey: 'acme', status: 'SUCCEEDED' }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('20b. allows several MANUAL_RERUN runs on that same enrollment (D3)', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertRun({
        id: 'run_manual_1',
        tenantKey: 'acme',
        trigger: 'MANUAL_RERUN',
        status: 'SUCCEEDED',
      })
      await insertRun({
        id: 'run_manual_2',
        tenantKey: 'acme',
        trigger: 'MANUAL_RERUN',
        status: 'FAILED',
      })
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::text FROM workflow_runs WHERE "workflowEnrollmentId" = 'enr_acme'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ count: '3' }])
  })

  it('21. rejects a second active (PENDING/RUNNING) run for the same lead', async () => {
    await asTenant(db, tenants.acme.organizationId, () =>
      insertRun({
        id: 'run_active_1',
        tenantKey: 'acme',
        trigger: 'MANUAL_RERUN',
        status: 'RUNNING',
      }),
    )

    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertRun({
          id: 'run_active_2',
          tenantKey: 'acme',
          trigger: 'MANUAL_RERUN',
          status: 'PENDING',
        }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('21b. allows a new run once the previous one reaches a terminal state', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await db.query(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = 'run_active_1'`)
      await insertRun({
        id: 'run_active_3',
        tenantKey: 'acme',
        trigger: 'MANUAL_RERUN',
        status: 'PENDING',
      })
      const result = await db.query<{ status: string }>(
        `SELECT status FROM workflow_runs WHERE id = 'run_active_3'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ status: 'PENDING' }])
  })

  it('stores the BLOCKED run and step states added in Phase 2C', async () => {
    const rows = await asTenant(db, tenants.globex.organizationId, async () => {
      await insertRun({ id: 'run_blocked', tenantKey: 'globex', status: 'BLOCKED' })
      await db.query(
        `INSERT INTO "workflow_step_runs" ("id", "workflowRunId", "step", "status", "attempts", "errorCode", "createdAt", "updatedAt")
         VALUES ('step_blocked', 'run_blocked', 'SEND_EMAIL', 'BLOCKED', 1, 'email_provider_not_configured', NOW(), NOW())`,
      )
      const result = await db.query<{ runStatus: string; stepStatus: string; errorCode: string }>(
        `SELECT r.status AS "runStatus", s.status AS "stepStatus", s."errorCode"
         FROM workflow_runs r JOIN workflow_step_runs s ON s."workflowRunId" = r.id
         WHERE r.id = 'run_blocked'`,
      )
      return result.rows
    })

    expect(rows).toEqual([
      {
        runStatus: 'BLOCKED',
        stepStatus: 'BLOCKED',
        errorCode: 'email_provider_not_configured',
      },
    ])
  })

  it('stores the qualification outcome/source columns added in Phase 2C', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await db.query(
        `UPDATE leads SET "qualificationOutcome" = 'UNQUALIFIED', "qualificationSource" = 'HUMAN',
           "qualificationUpdatedAt" = NOW(), "aiScore" = 42
         WHERE id = 'lead_acme'`,
      )
      const result = await db.query<{
        qualificationOutcome: string
        qualificationSource: string
        aiScore: number
        status: string
      }>(
        `SELECT "qualificationOutcome", "qualificationSource", "aiScore", status FROM leads WHERE id = 'lead_acme'`,
      )
      return result.rows
    })

    // status stays independent of the qualification outcome (decision D1).
    expect(rows).toEqual([
      {
        qualificationOutcome: 'UNQUALIFIED',
        qualificationSource: 'HUMAN',
        aiScore: 42,
        status: 'NEW',
      },
    ])
  })

  // -------------------------------------------------------------------------
  // 22 / 23 — tenant isolation on the execution tables
  // -------------------------------------------------------------------------

  it("22. does not let one tenant read another tenant's run or step run", async () => {
    const stolen = await asTenant(db, tenants.acme.organizationId, async () => {
      const runs = await db.query('SELECT * FROM workflow_runs WHERE id = $1', ['run_blocked'])
      const steps = await db.query('SELECT * FROM workflow_step_runs WHERE id = $1', [
        'step_blocked',
      ])
      return { runs: runs.rows, steps: steps.rows }
    })

    expect(stolen.runs).toEqual([])
    expect(stolen.steps).toEqual([])
  })

  it("22b. does not let one tenant transition another tenant's run", async () => {
    const affected = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query(
        `UPDATE workflow_runs SET status = 'SUCCEEDED' WHERE id = 'run_blocked'`,
      )
      return result.affectedRows ?? 0
    })

    expect(affected).toBe(0)

    const stillBlocked = await asTenant(db, tenants.globex.organizationId, async () => {
      const result = await db.query<{ status: string }>(
        `SELECT status FROM workflow_runs WHERE id = 'run_blocked'`,
      )
      return result.rows
    })
    expect(stillBlocked).toEqual([{ status: 'BLOCKED' }])
  })

  it('23. returns zero runs and step runs with no tenant context (fails closed)', async () => {
    const runs = await db.query('SELECT * FROM workflow_runs')
    const steps = await db.query('SELECT * FROM workflow_step_runs')

    expect(runs.rows).toEqual([])
    expect(steps.rows).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 26 — the recovery read (prisma/manual/002)
  // -------------------------------------------------------------------------

  describe('orphaned PENDING run recovery', () => {
    it('returns old PENDING runs across tenants without any tenant context', async () => {
      // An orphan: created, never scheduled, older than the safety threshold.
      await asTenant(db, tenants.globex.organizationId, () =>
        insertRun({
          id: 'run_orphan',
          tenantKey: 'globex',
          trigger: 'MANUAL_RERUN',
          status: 'PENDING',
          createdAt: `NOW() - INTERVAL '10 minutes'`,
        }),
      )

      // No tenant context at all — the ordinary path sees nothing here (see
      // test 23), which is exactly why the sweep needs its own narrow read.
      const result = await db.query<{ id: string; organizationId: string }>(
        `SELECT id, "organizationId" FROM automation_pending_runs_for_recovery(60, 50)`,
      )

      const ids = result.rows.map((row) => row.id)
      expect(ids).toContain('run_orphan')
      expect(result.rows.find((row) => row.id === 'run_orphan')?.organizationId).toBe(
        tenants.globex.organizationId,
      )
    })

    it('ignores runs younger than the threshold (they may just be mid-emit)', async () => {
      const result = await db.query<{ id: string }>(
        `SELECT id FROM automation_pending_runs_for_recovery(3600, 50)`,
      )
      expect(result.rows.map((row) => row.id)).not.toContain('run_orphan')
    })

    it('never returns a run that is not PENDING', async () => {
      const result = await db.query<{ id: string }>(
        `SELECT id FROM automation_pending_runs_for_recovery(0, 50)`,
      )
      const ids = result.rows.map((row) => row.id)

      expect(ids).not.toContain('run_blocked') // BLOCKED
      expect(ids).not.toContain('run_auto_1') // SUCCEEDED
      expect(ids).not.toContain('run_active_1') // FAILED
    })

    it('is repeatable: the same sweep twice yields the same rows and changes nothing', async () => {
      const first = await db.query<{ id: string }>(
        `SELECT id FROM automation_pending_runs_for_recovery(0, 50)`,
      )
      const second = await db.query<{ id: string }>(
        `SELECT id FROM automation_pending_runs_for_recovery(0, 50)`,
      )

      expect(second.rows).toEqual(first.rows)

      // Read-only: the swept run is untouched, so a duplicate sweep can only
      // ever re-emit an event, never mutate state.
      const orphan = await asTenant(db, tenants.globex.organizationId, async () => {
        const result = await db.query<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE id = 'run_orphan'`,
        )
        return result.rows
      })
      expect(orphan).toEqual([{ status: 'PENDING' }])
    })

    it('the recovery role can only SELECT PENDING rows — it cannot write', async () => {
      const policies = await db.query<{ cmd: string; qual: string | null; roles: string }>(
        `SELECT cmd, qual, roles::text AS roles FROM pg_policies
         WHERE tablename = 'workflow_runs' AND policyname = 'workflow_runs_recovery_read'`,
      )

      expect(policies.rows).toHaveLength(1)
      expect(policies.rows[0]?.cmd).toBe('SELECT')
      expect(policies.rows[0]?.qual).toContain('PENDING')
      expect(policies.rows[0]?.roles).toContain('leadflow_automation_recovery')
    })
  })

  // -------------------------------------------------------------------------
  // Recovery — WorkflowRun rows stuck RUNNING (prisma/manual/004)
  // -------------------------------------------------------------------------

  describe('stuck RUNNING run recovery', () => {
    // Every test below gets its OWN lead + enrollment, minted here on demand.
    // By this point in the file the shared acme/globex leads already carry an
    // active (PENDING/RUNNING) run of their own (run_active_3, run_orphan),
    // and workflow_runs_one_active_per_lead_key allows only one RUNNING row
    // per lead at a time — sharing a lead across these tests would collide.
    // The workflow itself is reused: organizations are limited to one
    // LEAD_QUALIFICATION workflow each.
    let seq = 0

    /**
     * Seeds a lead + enrollment + RUNNING run, all in ONE transaction (one
     * `asTenant` call) — nesting a second `asTenant` inside an already-open
     * one would COMMIT early on the inner call's return, leaving the
     * subsequent statement to run with no tenant context at all.
     */
    async function insertStuckRun({
      id,
      tenantKey,
      updatedAt,
      recoveryAttempts = 0,
      runningStep,
    }: {
      id: string
      tenantKey: 'acme' | 'globex'
      updatedAt: string
      recoveryAttempts?: number
      runningStep?: { id: string; updatedAt: string }
    }) {
      seq += 1
      const leadId = `lead_recovery_${tenantKey}_${seq}`
      const enrollmentId = `enr_recovery_${tenantKey}_${seq}`
      const tenant = tenants[tenantKey]

      await asTenant(db, tenant.organizationId, async () => {
        await db.query(
          `INSERT INTO "leads" ("id", "organizationId", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
           VALUES ($1, $2, NULL, 'Recovery Lead', $3, 'WEBSITE_FORM', NOW(), NOW(), NOW())`,
          [leadId, tenant.organizationId, `${tenantKey}-recovery-${seq}@prospect.test`],
        )
        await db.query(
          `INSERT INTO "workflow_enrollments" ("id", "organizationId", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
           VALUES ($1, $2, $3, $4, 'AUTOMATIC', NOW(), NOW())`,
          [enrollmentId, tenant.organizationId, `wf_${tenantKey}`, leadId],
        )
        await db.query(
          `INSERT INTO "workflow_runs"
             ("id", "organizationId", "workflowId", "workflowEnrollmentId", "leadId", "version",
              "trigger", "status", "recoveryAttempts", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 1, 'AUTOMATIC', 'RUNNING', $6,
                   NOW() - INTERVAL '1 hour', ${updatedAt})`,
          [id, tenant.organizationId, `wf_${tenantKey}`, enrollmentId, leadId, recoveryAttempts],
        )
        if (runningStep) {
          await db.query(
            `INSERT INTO "workflow_step_runs"
               ("id", "workflowRunId", "step", "status", "attempts", "createdAt", "updatedAt")
             VALUES ($1, $2, 'ENRICH', 'RUNNING', 1, NOW() - INTERVAL '1 hour', ${runningStep.updatedAt})`,
            [runningStep.id, id],
          )
        }
      })

      return { leadId, enrollmentId }
    }

    it('never returns a fresh RUNNING run (its own updatedAt is recent)', async () => {
      await insertStuckRun({ id: 'run_running_fresh', tenantKey: 'acme', updatedAt: 'NOW()' })

      const result = await db.query<{ id: string }>(
        `SELECT id FROM automation_running_runs_for_recovery(600, 50)`,
      )

      expect(result.rows.map((r) => r.id)).not.toContain('run_running_fresh')
    })

    it('returns a genuinely stale RUNNING run with no RUNNING step (crash between steps)', async () => {
      await insertStuckRun({
        id: 'run_running_stale',
        tenantKey: 'acme',
        updatedAt: `NOW() - INTERVAL '20 minutes'`,
      })

      // No tenant context — this is the cross-tenant sweep read, mirroring
      // how the PENDING sweep is exercised above.
      const result = await db.query<{
        id: string
        organizationId: string
        recoveryAttempts: number
      }>(
        `SELECT id, "organizationId", "recoveryAttempts" FROM automation_running_runs_for_recovery(600, 50)`,
      )

      const row = result.rows.find((r) => r.id === 'run_running_stale')
      expect(row).toBeDefined()
      expect(row?.organizationId).toBe(tenants.acme.organizationId)
      expect(row?.recoveryAttempts).toBe(0)
    })

    it('treats a still-RUNNING step as a liveness signal even when the run row itself is old', async () => {
      await insertStuckRun({
        id: 'run_running_old_but_alive',
        tenantKey: 'acme',
        updatedAt: `NOW() - INTERVAL '20 minutes'`,
        // The step was touched moments ago — a provider call genuinely in
        // flight — even though the run row itself has not been touched since.
        runningStep: { id: 'step_running_alive', updatedAt: 'NOW()' },
      })

      const result = await db.query<{ id: string }>(
        `SELECT id FROM automation_running_runs_for_recovery(600, 50)`,
      )

      expect(result.rows.map((r) => r.id)).not.toContain('run_running_old_but_alive')
    })

    it('never returns a run that is not RUNNING', async () => {
      const result = await db.query<{ id: string }>(
        `SELECT id FROM automation_running_runs_for_recovery(0, 50)`,
      )
      const ids = result.rows.map((r) => r.id)

      expect(ids).not.toContain('run_blocked') // BLOCKED
      expect(ids).not.toContain('run_auto_1') // SUCCEEDED
    })

    it('the recovery role can only SELECT RUNNING rows on both tables — it cannot write', async () => {
      const runPolicy = await db.query<{ cmd: string; qual: string | null; roles: string }>(
        `SELECT cmd, qual, roles::text AS roles FROM pg_policies
         WHERE tablename = 'workflow_runs' AND policyname = 'workflow_runs_running_recovery_read'`,
      )
      const stepPolicy = await db.query<{ cmd: string; qual: string | null; roles: string }>(
        `SELECT cmd, qual, roles::text AS roles FROM pg_policies
         WHERE tablename = 'workflow_step_runs' AND policyname = 'workflow_step_runs_running_recovery_read'`,
      )

      for (const policy of [runPolicy, stepPolicy]) {
        expect(policy.rows).toHaveLength(1)
        expect(policy.rows[0]?.cmd).toBe('SELECT')
        expect(policy.rows[0]?.qual).toContain('RUNNING')
        expect(policy.rows[0]?.roles).toContain('leadflow_running_recovery')
      }
    })

    it('grants leadflow_running_recovery exactly the specified columns — nothing else', async () => {
      // information_schema.column_privileges only shows grants visible to the
      // querying role (grantor, grantee, or a member of either) — leadflow_app
      // is deliberately NOT a member of leadflow_running_recovery, so this
      // check must run as the bootstrap superuser, the same way an operator
      // auditing the grant would.
      await db.query('RESET ROLE')
      try {
        const runCols = await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.column_privileges
           WHERE table_name = 'workflow_runs' AND grantee = 'leadflow_running_recovery'
           ORDER BY column_name`,
        )
        const stepCols = await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.column_privileges
           WHERE table_name = 'workflow_step_runs' AND grantee = 'leadflow_running_recovery'
           ORDER BY column_name`,
        )

        expect(runCols.rows.map((r) => r.column_name).sort()).toEqual(
          [
            'id',
            'organizationId',
            'leadId',
            'trigger',
            'status',
            'updatedAt',
            'recoveryAttempts',
          ].sort(),
        )
        expect(stepCols.rows.map((r) => r.column_name).sort()).toEqual(
          ['workflowRunId', 'status', 'updatedAt'].sort(),
        )
      } finally {
        await db.query(`SET ROLE ${APP_ROLE}`)
      }
    })

    it('leadflow_app is never a member of leadflow_running_recovery', async () => {
      const membership = await db.query(
        `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles member ON member.oid = m.member
         WHERE r.rolname = 'leadflow_running_recovery' AND member.rolname = 'leadflow_app'`,
      )
      expect(membership.rows).toEqual([])
    })

    it('is repeatable: the same sweep twice yields the same rows and changes nothing', async () => {
      const first = await db.query<{ id: string }>(
        `SELECT id FROM automation_running_runs_for_recovery(600, 50)`,
      )
      const second = await db.query<{ id: string }>(
        `SELECT id FROM automation_running_runs_for_recovery(600, 50)`,
      )
      expect(second.rows).toEqual(first.rows)
    })

    it("recovering (the write path) never leaks another tenant's run and stays fail-closed", async () => {
      await insertStuckRun({
        id: 'run_running_globex_stale',
        tenantKey: 'globex',
        updatedAt: `NOW() - INTERVAL '20 minutes'`,
      })

      // The write path a real caller uses is the ordinary, RLS-enforced
      // leadflow_app path (claimRunForRecovery/withTenant) — not this
      // SECURITY DEFINER function. Attempting to claim a Globex run while
      // scoped to Acme must affect nothing.
      const affected = await asTenant(db, tenants.acme.organizationId, async () => {
        const result = await db.query(
          `UPDATE workflow_runs SET "recoveryAttempts" = "recoveryAttempts" + 1
           WHERE id = 'run_running_globex_stale' AND status = 'RUNNING' AND "recoveryAttempts" = 0`,
        )
        return result.affectedRows ?? 0
      })
      expect(affected).toBe(0)

      const untouched = await asTenant(db, tenants.globex.organizationId, async () => {
        const result = await db.query<{ recoveryAttempts: number }>(
          `SELECT "recoveryAttempts" FROM workflow_runs WHERE id = 'run_running_globex_stale'`,
        )
        return result.rows
      })
      expect(untouched).toEqual([{ recoveryAttempts: 0 }])
    })

    it('finalizing FAILED releases the one-active-run-per-lead index so a new run can be created', async () => {
      const { leadId, enrollmentId } = await insertStuckRun({
        id: 'run_at_recovery_cap',
        tenantKey: 'acme',
        updatedAt: `NOW() - INTERVAL '20 minutes'`,
        recoveryAttempts: 3, // already at MAX_RECOVERY_ATTEMPTS
      })

      await asTenant(db, tenants.acme.organizationId, async () => {
        // Claim it, as claimRunForRecovery would, then abandon it at the cap —
        // exactly the sequence recoverStuckRunningRuns follows.
        await db.query(
          `UPDATE workflow_runs SET status = 'FAILED', "completedAt" = NOW()
           WHERE id = 'run_at_recovery_cap' AND status = 'RUNNING'`,
        )

        // The index only blocks a second PENDING/RUNNING row for the same
        // lead — this insert must now succeed. Trigger is MANUAL_RERUN: the
        // enrollment's one AUTOMATIC slot was already spent by
        // run_at_recovery_cap itself (workflow_runs_automatic_per_enrollment_key).
        await db.query(
          `INSERT INTO "workflow_runs"
             ("id", "organizationId", "workflowId", "workflowEnrollmentId", "leadId", "version",
              "trigger", "status", "createdAt", "updatedAt")
           VALUES ('run_after_recovery_failed', $1, 'wf_acme', $2, $3, 1, 'MANUAL_RERUN', 'PENDING', NOW(), NOW())`,
          [tenants.acme.organizationId, enrollmentId, leadId],
        )

        const result = await db.query<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE id = 'run_after_recovery_failed'`,
        )
        expect(result.rows).toEqual([{ status: 'PENDING' }])
      })
    })
  })
})
