import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, seedUsers } from '@/tests/helpers/pglite'

/**
 * Phase 2A — Automation domain model.
 *
 * Real PostgreSQL (PGlite/WASM) running the project's real migrations, so
 * these prove the constraints that will actually protect production data —
 * not a fake's imitation of them.
 *
 * Scope: schema-level constraints only. Every row here is inserted directly
 * via SQL; the services that would normally do it are covered by their own
 * unit tests.
 *
 * This file used to also assert row level security (policies, FORCE RLS,
 * cross-tenant reads failing closed). The schema is single-tenant now and has
 * no RLS, so those assertions are gone rather than rewritten — there is no
 * second tenant to isolate from.
 */
describe('Automation domain model', () => {
  let db: PGlite
  let users: Awaited<ReturnType<typeof seedUsers>>

  beforeAll(async () => {
    db = await createTestDb()
    users = await seedUsers(db)
  })

  afterAll(async () => {
    await db?.close()
  })

  function insertLeadSql({ id, ownerId, email }: { id: string; ownerId: string; email: string }) {
    return db.query(
      `INSERT INTO "leads"
         ("id", "ownerId", "name", "email", "source", "createdAt", "updatedAt", "lastActionAt")
       VALUES ($1, $2, 'Test Lead', $3, 'WEBSITE_FORM', NOW(), NOW(), NOW())
       RETURNING id`,
      [id, ownerId, email],
    )
  }

  function insertWorkflowSql({ id }: { id: string }) {
    return db.query(
      `INSERT INTO "workflows"
         ("id", "type", "status", "version", "createdAt", "updatedAt")
       VALUES ($1, 'LEAD_QUALIFICATION', 'ACTIVE', 1, NOW(), NOW())
       RETURNING id`,
      [id],
    )
  }

  function insertEnrollmentSql({
    id,
    workflowId,
    leadId,
  }: {
    id: string
    workflowId: string
    leadId: string
  }) {
    return db.query(
      `INSERT INTO "workflow_enrollments"
         ("id", "workflowId", "leadId", "trigger", "enrolledAt", "createdAt")
       VALUES ($1, $2, $3, 'AUTOMATIC', NOW(), NOW())
       RETURNING id`,
      [id, workflowId, leadId],
    )
  }

  function insertRunSql({
    id,
    workflowId,
    workflowEnrollmentId,
    leadId,
    version = 1,
    trigger = 'AUTOMATIC',
    status = 'PENDING',
  }: {
    id: string
    workflowId: string
    workflowEnrollmentId: string
    leadId: string
    version?: number
    trigger?: 'AUTOMATIC' | 'MANUAL_RERUN'
    status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  }) {
    return db.query(
      `INSERT INTO "workflow_runs"
         ("id", "workflowId", "workflowEnrollmentId", "leadId", "version", "trigger", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id`,
      [id, workflowId, workflowEnrollmentId, leadId, version, trigger, status],
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

  it('creates the fixed workflow', async () => {
    await insertWorkflowSql({ id: 'wf_1' })
    const result = await db.query<{ type: string; status: string; version: number }>(
      `SELECT type, status, version FROM workflows WHERE id = 'wf_1'`,
    )

    expect(result.rows).toEqual([{ type: 'LEAD_QUALIFICATION', status: 'ACTIVE', version: 1 }])
  })

  it('rejects a second LEAD_QUALIFICATION workflow', async () => {
    // The unique index on `type` is what makes "exactly one fixed pipeline" a
    // database fact rather than an application convention.
    await expect(insertWorkflowSql({ id: 'wf_dup' })).rejects.toThrow(
      /duplicate key value|unique constraint/i,
    )
  })

  // -------------------------------------------------------------------------
  // WorkflowEnrollment
  // -------------------------------------------------------------------------

  it('links an Enrollment to a workflow and a lead', async () => {
    await insertLeadSql({
      id: 'lead_enroll_1',
      ownerId: users.adminUserId,
      email: 'enroll-1@prospect.test',
    })
    await insertEnrollmentSql({ id: 'enr_1', workflowId: 'wf_1', leadId: 'lead_enroll_1' })

    const result = await db.query<{ workflowId: string; leadId: string; trigger: string }>(
      `SELECT "workflowId", "leadId", trigger FROM workflow_enrollments WHERE id = 'enr_1'`,
    )

    expect(result.rows).toEqual([
      { workflowId: 'wf_1', leadId: 'lead_enroll_1', trigger: 'AUTOMATIC' },
    ])
  })

  it('rejects a second automatic enrollment of the same lead into the same workflow', async () => {
    await expect(
      insertEnrollmentSql({ id: 'enr_1_dup', workflowId: 'wf_1', leadId: 'lead_enroll_1' }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  // -------------------------------------------------------------------------
  // WorkflowRun
  // -------------------------------------------------------------------------

  it('links a WorkflowRun to a workflow, a lead, and its enrollment', async () => {
    await insertRunSql({
      id: 'run_1',
      workflowId: 'wf_1',
      workflowEnrollmentId: 'enr_1',
      leadId: 'lead_enroll_1',
      // Terminal from the start: only one PENDING/RUNNING run per lead is
      // allowed, and the later cases in this file add more runs for this lead.
      status: 'SUCCEEDED',
    })

    const result = await db.query<{
      workflowId: string
      workflowEnrollmentId: string
      leadId: string
    }>(
      `SELECT "workflowId", "workflowEnrollmentId", "leadId" FROM workflow_runs WHERE id = 'run_1'`,
    )

    expect(result.rows).toEqual([
      { workflowId: 'wf_1', workflowEnrollmentId: 'enr_1', leadId: 'lead_enroll_1' },
    ])
  })

  it('rejects a second AUTOMATIC run on the same enrollment', async () => {
    // The partial unique index (trigger = 'AUTOMATIC') is what makes duplicate
    // event delivery safe — proven here against real Postgres, since Prisma
    // cannot express a filtered index.
    await expect(
      insertRunSql({
        id: 'run_auto_dup',
        workflowId: 'wf_1',
        workflowEnrollmentId: 'enr_1',
        leadId: 'lead_enroll_1',
        trigger: 'AUTOMATIC',
        status: 'SUCCEEDED',
      }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('stores trigger and status on a WorkflowRun', async () => {
    await insertRunSql({
      id: 'run_manual',
      workflowId: 'wf_1',
      // A manual re-run belongs to the SAME enrollment as the automatic run it
      // repeats (Phase 2C, D3) — the column is not nullable.
      workflowEnrollmentId: 'enr_1',
      leadId: 'lead_enroll_1',
      trigger: 'MANUAL_RERUN',
      status: 'RUNNING',
    })

    const result = await db.query<{ trigger: string; status: string }>(
      `SELECT trigger, status FROM workflow_runs WHERE id = 'run_manual'`,
    )

    expect(result.rows).toEqual([{ trigger: 'MANUAL_RERUN', status: 'RUNNING' }])
  })

  it('rejects a second in-flight run for the same lead', async () => {
    // The other partial unique index (status IN PENDING/RUNNING). `run_manual`
    // above is still RUNNING, so this must be refused — that is what makes
    // "re-run" safe against a double click.
    await expect(
      insertRunSql({
        id: 'run_second_active',
        workflowId: 'wf_1',
        workflowEnrollmentId: 'enr_1',
        leadId: 'lead_enroll_1',
        trigger: 'MANUAL_RERUN',
        status: 'PENDING',
      }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('copies the workflow version onto the WorkflowRun at creation time', async () => {
    await insertRunSql({
      id: 'run_versioned',
      workflowId: 'wf_1',
      workflowEnrollmentId: 'enr_1',
      leadId: 'lead_enroll_1',
      version: 1,
      trigger: 'MANUAL_RERUN',
      status: 'SUCCEEDED',
    })

    const result = await db.query<{ version: number }>(
      `SELECT version FROM workflow_runs WHERE id = 'run_versioned'`,
    )

    expect(result.rows).toEqual([{ version: 1 }])
  })

  // -------------------------------------------------------------------------
  // WorkflowStepRun
  // -------------------------------------------------------------------------

  it('links a WorkflowStepRun to its WorkflowRun', async () => {
    await insertStepRunSql({
      id: 'step_enrich',
      workflowRunId: 'run_1',
      step: 'ENRICH',
      status: 'SUCCEEDED',
    })

    const result = await db.query<{ workflowRunId: string; step: string }>(
      `SELECT "workflowRunId", step FROM workflow_step_runs WHERE id = 'step_enrich'`,
    )

    expect(result.rows).toEqual([{ workflowRunId: 'run_1', step: 'ENRICH' }])
  })

  it('rejects a duplicate step within the same WorkflowRun', async () => {
    await expect(
      insertStepRunSql({ id: 'step_enrich_dup', workflowRunId: 'run_1', step: 'ENRICH' }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('supports every WorkflowStepRun status: PENDING, RUNNING, SUCCEEDED, FAILED, SKIPPED', async () => {
    const statuses = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const
    const steps = ['AI_QUALIFY', 'SCORE_AND_TAG', 'ADD_TO_CRM', 'SEND_EMAIL', 'NOTIFY_TEAM'] as const

    for (let i = 0; i < statuses.length; i++) {
      await insertStepRunSql({
        id: `step_status_${i}`,
        workflowRunId: 'run_1',
        step: steps[i]!,
        status: statuses[i],
      })
    }

    const result = await db.query<{ status: string }>(
      `SELECT status FROM workflow_step_runs WHERE id LIKE 'step_status_%' ORDER BY id`,
    )

    expect(result.rows.map((row) => row.status)).toEqual(statuses)
  })

  it('stores attempts on a WorkflowStepRun (retries, no separate StepAttempt table)', async () => {
    await insertStepRunSql({
      id: 'step_retried',
      workflowRunId: 'run_manual',
      step: 'ENRICH',
      status: 'FAILED',
      attempts: 3,
    })

    const result = await db.query<{ attempts: number }>(
      `SELECT attempts FROM workflow_step_runs WHERE id = 'step_retried'`,
    )

    expect(result.rows).toEqual([{ attempts: 3 }])
  })

  it('stores JSON input/output on a WorkflowStepRun', async () => {
    await insertStepRunSql({
      id: 'step_json',
      workflowRunId: 'run_manual',
      step: 'AI_QUALIFY',
      status: 'SUCCEEDED',
      input: { leadEmail: 'enroll-1@prospect.test' },
      output: { score: 82, qualification: 'QUALIFIED' },
    })

    const result = await db.query<{ input: unknown; output: unknown }>(
      `SELECT input, output FROM workflow_step_runs WHERE id = 'step_json'`,
    )

    expect(result.rows).toEqual([
      {
        input: { leadEmail: 'enroll-1@prospect.test' },
        output: { score: 82, qualification: 'QUALIFIED' },
      },
    ])
  })

  // -------------------------------------------------------------------------
  // Lead identity
  // -------------------------------------------------------------------------

  it('rejects a second Lead with the same email', async () => {
    // Email is globally unique now: while the product was multi-tenant this
    // was scoped to (organizationId, email), so the same person could be a
    // lead at two different customers. There is one customer.
    await expect(
      insertLeadSql({
        id: 'lead_dup_email',
        ownerId: users.adminUserId,
        email: 'enroll-1@prospect.test',
      }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i)
  })
})
