import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asTenant, createTestDb, seedTwoTenants } from '@/tests/helpers/pglite'

/**
 * Phase 2A — Automation domain model.
 *
 * Mirrors tests/integration/lead-rls.test.ts: real PostgreSQL (PGlite/WASM),
 * the project's real migrations, and the unprivileged `leadflow_app` role —
 * never the bootstrap superuser — so these prove the constraints and
 * policies that will actually protect production data.
 *
 * Scope: schema-level constraints and RLS only. No enrollment service, no
 * execution engine, no API exists yet (Phase 2B+) — every row here is
 * inserted directly via SQL, the same way lead-rls.test.ts does for leads.
 */
describe('Automation domain model', () => {
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

  function insertWorkflowSql({ id, organizationId }: { id: string; organizationId: string }) {
    return db.query(
      `INSERT INTO "workflows"
         ("id", "organizationId", "type", "status", "version", "createdAt", "updatedAt")
       VALUES ($1, $2, 'LEAD_QUALIFICATION', 'ACTIVE', 1, NOW(), NOW())
       RETURNING id`,
      [id, organizationId],
    )
  }

  function insertEnrollmentSql({
    id,
    organizationId,
    workflowId,
    leadId,
  }: {
    id: string
    organizationId: string
    workflowId: string
    leadId: string
  }) {
    return db.query(
      `INSERT INTO "workflow_enrollments"
         ("id", "organizationId", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
       VALUES ($1, $2, $3, $4, 'AUTOMATIC', NOW(), NOW())
       RETURNING id`,
      [id, organizationId, workflowId, leadId],
    )
  }

  function insertRunSql({
    id,
    organizationId,
    workflowId,
    workflowEnrollmentId,
    leadId,
    version = 1,
    trigger = 'AUTOMATIC',
    status = 'PENDING',
  }: {
    id: string
    organizationId: string
    workflowId: string
    workflowEnrollmentId: string | null
    leadId: string
    version?: number
    trigger?: 'AUTOMATIC' | 'MANUAL_RERUN'
    status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  }) {
    return db.query(
      `INSERT INTO "workflow_runs"
         ("id", "organizationId", "workflowId", "workflowEnrollmentId", "leadId", "version", "trigger", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING id`,
      [id, organizationId, workflowId, workflowEnrollmentId, leadId, version, trigger, status],
    )
  }

  function insertStepRunSql({
    id,
    workflowRunId,
    step,
    status = 'PENDING',
    attempts = 0,
    input = null,
    output = null,
  }: {
    id: string
    workflowRunId: string
    step: string
    status?: string
    attempts?: number
    input?: unknown
    output?: unknown
  }) {
    return db.query(
      `INSERT INTO "workflow_step_runs"
         ("id", "workflowRunId", "step", "status", "attempts", "input", "output", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id`,
      [
        id,
        workflowRunId,
        step,
        status,
        attempts,
        input ? JSON.stringify(input) : null,
        output ? JSON.stringify(output) : null,
      ],
    )
  }

  // -------------------------------------------------------------------------
  // Workflow
  // -------------------------------------------------------------------------

  it('creates a Workflow scoped to an organization', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertWorkflowSql({ id: 'wf_acme_1', organizationId: tenants.acme.organizationId })
      const result = await db.query<{ type: string; status: string; version: number }>(
        `SELECT type, status, version FROM workflows WHERE id = 'wf_acme_1'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ type: 'LEAD_QUALIFICATION', status: 'ACTIVE', version: 1 }])
  })

  it('rejects a second LEAD_QUALIFICATION workflow for the same organization', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertWorkflowSql({ id: 'wf_acme_dup', organizationId: tenants.acme.organizationId }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('allows the same workflow type in two different organizations', async () => {
    const rows = await asTenant(db, tenants.globex.organizationId, async () => {
      await insertWorkflowSql({ id: 'wf_globex_1', organizationId: tenants.globex.organizationId })
      const result = await db.query<{ id: string }>(
        `SELECT id FROM workflows WHERE id = 'wf_globex_1'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ id: 'wf_globex_1' }])
  })

  // -------------------------------------------------------------------------
  // WorkflowEnrollment
  // -------------------------------------------------------------------------

  it('links an Enrollment to a workflow and a lead', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertLeadSql({
        id: 'lead_acme_enroll_1',
        organizationId: tenants.acme.organizationId,
        ownerId: tenants.acme.adminUserId,
        email: 'enroll-1@prospect.test',
      })
      await insertEnrollmentSql({
        id: 'enr_acme_1',
        organizationId: tenants.acme.organizationId,
        workflowId: 'wf_acme_1',
        leadId: 'lead_acme_enroll_1',
      })
      const result = await db.query<{ workflowId: string; leadId: string; trigger: string }>(
        `SELECT "workflowId", "leadId", trigger FROM workflow_enrollments WHERE id = 'enr_acme_1'`,
      )
      return result.rows
    })

    expect(rows).toEqual([
      { workflowId: 'wf_acme_1', leadId: 'lead_acme_enroll_1', trigger: 'AUTOMATIC' },
    ])
  })

  it('rejects a second automatic enrollment of the same lead into the same workflow', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertEnrollmentSql({
          id: 'enr_acme_1_dup',
          organizationId: tenants.acme.organizationId,
          workflowId: 'wf_acme_1',
          leadId: 'lead_acme_enroll_1',
        }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('allows the same lead identity to be enrolled in a different workflow', async () => {
    // The schema currently defines a single WorkflowType (LEAD_QUALIFICATION),
    // and (organizationId, type) is unique, so "a different workflow" within
    // one org isn't representable yet — a future workflow type would be a
    // second Workflow row, enrollable independently of this one, because the
    // enrollment uniqueness constraint is scoped to (workflowId, leadId), not
    // to leadId alone. This test proves that scoping directly: enrolling a
    // lead in a workflow that belongs to a different workflowId (here,
    // Globex's own workflow, in a different org) succeeds with no conflict.
    const globexRows = await asTenant(db, tenants.globex.organizationId, async () => {
      await insertLeadSql({
        id: 'lead_globex_shared_enroll',
        organizationId: tenants.globex.organizationId,
        ownerId: tenants.globex.adminUserId,
        email: 'shared-enroll@prospect.test',
      })
      await insertEnrollmentSql({
        id: 'enr_globex_1',
        organizationId: tenants.globex.organizationId,
        workflowId: 'wf_globex_1',
        leadId: 'lead_globex_shared_enroll',
      })
      const result = await db.query<{ id: string }>(
        `SELECT id FROM workflow_enrollments WHERE id = 'enr_globex_1'`,
      )
      return result.rows
    })

    expect(globexRows).toEqual([{ id: 'enr_globex_1' }])
  })

  // -------------------------------------------------------------------------
  // WorkflowRun
  // -------------------------------------------------------------------------

  it('links a WorkflowRun to a workflow, a lead, and its enrollment', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertRunSql({
        id: 'run_acme_1',
        organizationId: tenants.acme.organizationId,
        workflowId: 'wf_acme_1',
        workflowEnrollmentId: 'enr_acme_1',
        leadId: 'lead_acme_enroll_1',
        // Terminal from the start: Phase 2C allows only one PENDING/RUNNING
        // run per lead, and the later cases in this file add more runs for
        // this same lead.
        status: 'SUCCEEDED',
      })
      const result = await db.query<{
        workflowId: string
        workflowEnrollmentId: string
        leadId: string
      }>(
        `SELECT "workflowId", "workflowEnrollmentId", "leadId" FROM workflow_runs WHERE id = 'run_acme_1'`,
      )
      return result.rows
    })

    expect(rows).toEqual([
      { workflowId: 'wf_acme_1', workflowEnrollmentId: 'enr_acme_1', leadId: 'lead_acme_enroll_1' },
    ])
  })

  it('stores trigger and status on a WorkflowRun', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertRunSql({
        id: 'run_acme_manual',
        organizationId: tenants.acme.organizationId,
        workflowId: 'wf_acme_1',
        // Phase 2C (D3): a manual re-run belongs to the SAME enrollment as the
        // automatic run it repeats — the column is no longer nullable.
        workflowEnrollmentId: 'enr_acme_1',
        leadId: 'lead_acme_enroll_1',
        trigger: 'MANUAL_RERUN',
        status: 'RUNNING',
      })
      const result = await db.query<{ trigger: string; status: string }>(
        `SELECT trigger, status FROM workflow_runs WHERE id = 'run_acme_manual'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ trigger: 'MANUAL_RERUN', status: 'RUNNING' }])
  })

  it('copies the workflow version onto the WorkflowRun at creation time', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertRunSql({
        id: 'run_acme_versioned',
        organizationId: tenants.acme.organizationId,
        workflowId: 'wf_acme_1',
        workflowEnrollmentId: 'enr_acme_1',
        leadId: 'lead_acme_enroll_1',
        version: 1,
        // Manual + terminal: the enrollment's one AUTOMATIC run already
        // exists (run_acme_1), and only one run per lead may be active.
        trigger: 'MANUAL_RERUN',
        status: 'SUCCEEDED',
      })
      const result = await db.query<{ version: number }>(
        `SELECT version FROM workflow_runs WHERE id = 'run_acme_versioned'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ version: 1 }])
  })

  // -------------------------------------------------------------------------
  // WorkflowStepRun
  // -------------------------------------------------------------------------

  it('links a WorkflowStepRun to its WorkflowRun', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertStepRunSql({
        id: 'step_acme_enrich',
        workflowRunId: 'run_acme_1',
        step: 'ENRICH',
        status: 'SUCCEEDED',
      })
      const result = await db.query<{ workflowRunId: string; step: string }>(
        `SELECT "workflowRunId", step FROM workflow_step_runs WHERE id = 'step_acme_enrich'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ workflowRunId: 'run_acme_1', step: 'ENRICH' }])
  })

  it('rejects a duplicate step within the same WorkflowRun', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertStepRunSql({
          id: 'step_acme_enrich_dup',
          workflowRunId: 'run_acme_1',
          step: 'ENRICH',
        }),
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('supports every WorkflowStepRun status: PENDING, RUNNING, SUCCEEDED, FAILED, SKIPPED', async () => {
    const statuses = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const
    const steps = [
      'AI_QUALIFY',
      'SCORE_AND_TAG',
      'ADD_TO_CRM',
      'SEND_EMAIL',
      'NOTIFY_TEAM',
    ] as const

    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      for (let i = 0; i < statuses.length; i++) {
        await insertStepRunSql({
          id: `step_acme_status_${i}`,
          workflowRunId: 'run_acme_1',
          step: steps[i]!,
          status: statuses[i],
        })
      }
      const result = await db.query<{ status: string }>(
        `SELECT status FROM workflow_step_runs WHERE id LIKE 'step_acme_status_%' ORDER BY id`,
      )
      return result.rows.map((row) => row.status)
    })

    expect(rows).toEqual(statuses)
  })

  it('stores attempts on a WorkflowStepRun (retries, no separate StepAttempt table)', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertStepRunSql({
        id: 'step_acme_retried',
        workflowRunId: 'run_acme_manual',
        step: 'ENRICH',
        status: 'FAILED',
        attempts: 3,
      })
      const result = await db.query<{ attempts: number }>(
        `SELECT attempts FROM workflow_step_runs WHERE id = 'step_acme_retried'`,
      )
      return result.rows
    })

    expect(rows).toEqual([{ attempts: 3 }])
  })

  it('stores JSON input/output on a WorkflowStepRun', async () => {
    const rows = await asTenant(db, tenants.acme.organizationId, async () => {
      await insertStepRunSql({
        id: 'step_acme_json',
        workflowRunId: 'run_acme_manual',
        step: 'AI_QUALIFY',
        status: 'SUCCEEDED',
        input: { leadEmail: 'enroll-1@prospect.test' },
        output: { score: 82, qualification: 'QUALIFIED' },
      })
      const result = await db.query<{ input: unknown; output: unknown }>(
        `SELECT input, output FROM workflow_step_runs WHERE id = 'step_acme_json'`,
      )
      return result.rows
    })

    expect(rows).toEqual([
      {
        input: { leadEmail: 'enroll-1@prospect.test' },
        output: { score: 82, qualification: 'QUALIFIED' },
      },
    ])
  })

  // -------------------------------------------------------------------------
  // RLS — cross-tenant isolation and fail-closed
  // -------------------------------------------------------------------------

  it('enables and forces row security on all four automation tables', async () => {
    const result = await db.query<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('workflows', 'workflow_enrollments', 'workflow_runs', 'workflow_step_runs')
       ORDER BY relname`,
    )

    expect(result.rows).toEqual([
      { relname: 'workflow_enrollments', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'workflow_runs', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'workflow_step_runs', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'workflows', relrowsecurity: true, relforcerowsecurity: true },
    ])
  })

  it("does not let tenant A read tenant B's Workflow, Enrollment, or Run", async () => {
    const stolen = await asTenant(db, tenants.acme.organizationId, async () => {
      const workflows = await db.query('SELECT * FROM workflows WHERE id = $1', ['wf_globex_1'])
      const enrollments = await db.query('SELECT * FROM workflow_enrollments WHERE id = $1', [
        'enr_globex_1',
      ])
      return { workflows: workflows.rows, enrollments: enrollments.rows }
    })

    expect(stolen.workflows).toEqual([])
    expect(stolen.enrollments).toEqual([])
  })

  it("does not let tenant A read tenant B's WorkflowStepRun via the joined-tenancy policy", async () => {
    await asTenant(db, tenants.globex.organizationId, async () => {
      await insertRunSql({
        id: 'run_globex_1',
        organizationId: tenants.globex.organizationId,
        workflowId: 'wf_globex_1',
        workflowEnrollmentId: 'enr_globex_1',
        leadId: 'lead_globex_shared_enroll',
      })
      await insertStepRunSql({
        id: 'step_globex_1',
        workflowRunId: 'run_globex_1',
        step: 'ENRICH',
        status: 'SUCCEEDED',
      })
    })

    const stolen = await asTenant(db, tenants.acme.organizationId, async () => {
      const result = await db.query('SELECT * FROM workflow_step_runs WHERE id = $1', [
        'step_globex_1',
      ])
      return result.rows
    })

    expect(stolen).toEqual([])
  })

  it('rejects an INSERT that attributes a Workflow to another tenant', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertWorkflowSql({ id: 'wf_injected', organizationId: tenants.globex.organizationId }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('rejects an INSERT that attributes a WorkflowRun to another tenant', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertRunSql({
          id: 'run_injected',
          organizationId: tenants.globex.organizationId,
          workflowId: 'wf_globex_1',
          workflowEnrollmentId: 'enr_globex_1',
          leadId: 'lead_globex_shared_enroll',
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('rejects a WorkflowStepRun INSERT under a WorkflowRun that belongs to another tenant', async () => {
    await expect(
      asTenant(db, tenants.acme.organizationId, () =>
        insertStepRunSql({
          id: 'step_injected',
          workflowRunId: 'run_globex_1',
          step: 'AI_QUALIFY',
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('returns zero rows from every automation table when no tenant context is set (fails closed)', async () => {
    const workflows = await db.query('SELECT * FROM workflows')
    const enrollments = await db.query('SELECT * FROM workflow_enrollments')
    const runs = await db.query('SELECT * FROM workflow_runs')
    const stepRuns = await db.query('SELECT * FROM workflow_step_runs')

    expect(workflows.rows).toEqual([])
    expect(enrollments.rows).toEqual([])
    expect(runs.rows).toEqual([])
    expect(stepRuns.rows).toEqual([])
  })
})
