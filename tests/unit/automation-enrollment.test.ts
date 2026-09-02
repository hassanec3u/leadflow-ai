import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2B — lib/services/automation-enrollment.ts.
 *
 * Mirrors tests/unit/leads-service.test.ts: `@/lib/db/prisma` is replaced
 * with a small in-memory fake that mimics just enough of Prisma + Postgres
 * RLS to prove the SERVICE's own logic — tenant scoping, eligibility,
 * idempotency, and the duplicate-lead merge rule. A row is only "visible"
 * when its `organizationId` matches whatever the last `withTenant()` call set
 * via `$executeRaw` (mirroring `SET LOCAL app.current_org_id`), exactly like
 * RLS — so a service bug that forgot tenant scoping would surface here as
 * cross-tenant leakage, the same guarantee leads-service.test.ts relies on.
 *
 * Real Postgres RLS/constraints on the automation tables are proven
 * separately in tests/integration/automation-domain.test.ts (Phase 2A) — this
 * file is about the enrollment service's own logic sitting in front of them.
 */

const state = vi.hoisted(() => {
  type FakeLead = {
    id: string
    organizationId: string
    name: string
    email: string
    company: string | null
    phone: string | null
    formMessage: string | null
    source: string
    ownerId: string | null
    deletedAt: Date | null
  }
  type FakeWorkflow = {
    id: string
    organizationId: string
    type: string
    status: 'ACTIVE' | 'PAUSED'
    version: number
  }
  type FakeEnrollment = {
    id: string
    organizationId: string
    workflowId: string
    leadId: string
    trigger: string
  }

  /** Phase 2C: capture now also creates the PENDING run for a new enrollment. */
  type FakeRun = {
    id: string
    organizationId: string
    workflowId: string
    workflowEnrollmentId: string
    leadId: string
    version: number
    trigger: string
    status: string
  }

  const leads: FakeLead[] = []
  const workflows: FakeWorkflow[] = []
  const enrollments: FakeEnrollment[] = []
  const runs: FakeRun[] = []
  let currentOrgId: string | null = null
  let nextId = 1

  function reset() {
    leads.length = 0
    workflows.length = 0
    enrollments.length = 0
    runs.length = 0
    currentOrgId = null
    nextId = 1
  }

  // Fails closed exactly like RLS: nothing is visible with no tenant context,
  // and nothing outside the current tenant is visible either.
  function visible(row: { organizationId: string }) {
    return currentOrgId !== null && row.organizationId === currentOrgId
  }

  return {
    leads,
    workflows,
    enrollments,
    runs,
    reset,
    visible,
    get nextId() {
      return `id_${nextId++}`
    },
    setOrgContext: (id: string) => {
      currentOrgId = id
    },
  }
})

/**
 * Phase 2C: the event that starts execution. Mocked so the test can assert
 * BOTH that it is emitted and — crucially — that it is emitted only after the
 * capture transaction commits.
 */
const emitRunRequestedMock = vi.fn(async (payload: unknown) => {
  void payload
})

vi.mock('@/lib/automation/events', () => ({
  AUTOMATION_RUN_REQUESTED: 'automation/run.requested',
  emitRunRequested: (payload: unknown) => emitRunRequestedMock(payload),
}))

function uniqueViolation(constraintIndex: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { constraint: { index: constraintIndex } } } },
  })
}

vi.mock('@/lib/db/prisma', () => {
  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      state.setOrgContext(values[0] as string)
      return 1
    },
    lead: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          state.leads.find(
            (l) =>
              state.visible(l) &&
              l.organizationId === where.organizationId &&
              l.email === where.email &&
              (where.deletedAt === null ? l.deletedAt === null : true),
          ) ?? null
        )
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const organizationId = data.organizationId as string
        const email = data.email as string
        if (state.leads.some((l) => l.organizationId === organizationId && l.email === email)) {
          throw uniqueViolation('leads_organizationId_email_key')
        }
        const lead = {
          id: state.nextId,
          organizationId,
          name: data.name as string,
          email,
          company: (data.company as string | undefined) ?? null,
          phone: (data.phone as string | undefined) ?? null,
          formMessage: (data.formMessage as string | null | undefined) ?? null,
          source: data.source as string,
          ownerId: (data.ownerId as string | null | undefined) ?? null,
          deletedAt: null,
        }
        state.leads.push(lead)
        return lead
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const lead = state.leads.find((l) => l.id === where.id)!
        Object.assign(lead, data)
        return lead
      },
    },
    workflow: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          state.workflows.find(
            (w) =>
              state.visible(w) &&
              w.organizationId === where.organizationId &&
              w.type === where.type,
          ) ?? null
        )
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const organizationId = data.organizationId as string
        const type = data.type as string
        if (state.workflows.some((w) => w.organizationId === organizationId && w.type === type)) {
          throw uniqueViolation('workflows_organizationId_type_key')
        }
        const workflow = {
          id: state.nextId,
          organizationId,
          type,
          status: (data.status as 'ACTIVE' | 'PAUSED') ?? 'ACTIVE',
          version: (data.version as number) ?? 1,
        }
        state.workflows.push(workflow)
        return workflow
      },
    },
    workflowRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.runs.find(
          (r) =>
            state.visible(r) &&
            r.workflowEnrollmentId === where.workflowEnrollmentId &&
            (where.trigger === undefined || r.trigger === where.trigger),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const enrollmentId = data.workflowEnrollmentId as string
        const leadId = data.leadId as string
        if (
          data.trigger === 'AUTOMATIC' &&
          state.runs.some(
            (r) => r.workflowEnrollmentId === enrollmentId && r.trigger === 'AUTOMATIC',
          )
        ) {
          throw uniqueViolation('workflow_runs_automatic_per_enrollment_key')
        }
        if (
          state.runs.some(
            (r) => r.leadId === leadId && (r.status === 'PENDING' || r.status === 'RUNNING'),
          )
        ) {
          throw uniqueViolation('workflow_runs_one_active_per_lead_key')
        }
        const run = {
          id: state.nextId,
          organizationId: data.organizationId as string,
          workflowId: data.workflowId as string,
          workflowEnrollmentId: enrollmentId,
          leadId,
          version: data.version as number,
          trigger: data.trigger as string,
          status: (data.status as string) ?? 'PENDING',
        }
        state.runs.push(run)
        return run
      },
    },
    workflowEnrollment: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          state.enrollments.find(
            (e) =>
              state.visible(e) && e.workflowId === where.workflowId && e.leadId === where.leadId,
          ) ?? null
        )
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const workflowId = data.workflowId as string
        const leadId = data.leadId as string
        if (state.enrollments.some((e) => e.workflowId === workflowId && e.leadId === leadId)) {
          throw uniqueViolation('workflow_enrollments_workflowId_leadId_key')
        }
        const enrollment = {
          id: state.nextId,
          organizationId: data.organizationId as string,
          workflowId,
          leadId,
          trigger: data.trigger as string,
        }
        state.enrollments.push(enrollment)
        return enrollment
      },
    },
  }

  return { prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } }
})

const ACME = 'org_acme'
const GLOBEX = 'org_globex'

async function importService() {
  vi.resetModules()
  return import('@/lib/services/automation-enrollment')
}

describe('Automatic workflow enrollment service', () => {
  beforeEach(() => {
    state.reset()
    emitRunRequestedMock.mockClear()
    emitRunRequestedMock.mockResolvedValue(undefined)
  })

  it('1. is eligible: Website Form', async () => {
    const { isEligibleForAutomaticEnrollment } = await importService()
    expect(isEligibleForAutomaticEnrollment('WEBSITE_FORM')).toBe(true)
  })

  it('1b. is not eligible: Manual or CSV Import', async () => {
    const { isEligibleForAutomaticEnrollment } = await importService()
    expect(isEligibleForAutomaticEnrollment('MANUAL')).toBe(false)
    expect(isEligibleForAutomaticEnrollment('CSV_IMPORT')).toBe(false)
  })

  it('2. a Website Form lead is captured and an enrollment is created', async () => {
    const { captureAutomaticLead } = await importService()

    const result = await captureAutomaticLead(ACME, {
      name: 'Jane Prospect',
      email: 'jane@prospect.test',
      source: 'WEBSITE_FORM',
    })

    expect(result.leadWasCreated).toBe(true)
    expect(result.lead.organizationId).toBe(ACME)
    expect(result.enrollment).not.toBeNull()
    expect(result.enrollment?.workflowId).toBeDefined()
    expect(state.enrollments).toHaveLength(1)
    expect(state.enrollments[0]?.trigger).toBe('AUTOMATIC')
  })

  it('3. a Manual lead is captured but never enrolled', async () => {
    const { captureAutomaticLead } = await importService()

    const result = await captureAutomaticLead(ACME, {
      name: 'Manual Entry',
      email: 'manual@prospect.test',
      source: 'MANUAL',
    })

    expect(result.enrollment).toBeNull()
    expect(state.enrollments).toHaveLength(0)
  })

  it('4. a CSV Import lead is captured but never enrolled', async () => {
    const { captureAutomaticLead } = await importService()

    const result = await captureAutomaticLead(ACME, {
      name: 'CSV Entry',
      email: 'csv@prospect.test',
      source: 'CSV_IMPORT',
    })

    expect(result.enrollment).toBeNull()
    expect(state.enrollments).toHaveLength(0)
  })

  it('5. a paused workflow gets no new enrollment', async () => {
    const { captureAutomaticLead } = await importService()

    // Pre-provision the org's workflow, paused, exactly as it would exist
    // once provisioning (or an earlier enrollment) has created it.
    state.workflows.push({
      id: 'wf_acme_1',
      organizationId: ACME,
      type: 'LEAD_QUALIFICATION',
      status: 'PAUSED',
      version: 1,
    })

    const result = await captureAutomaticLead(ACME, {
      name: 'Paused Org Lead',
      email: 'paused@prospect.test',
      source: 'WEBSITE_FORM',
    })

    expect(result.lead).toBeDefined()
    expect(result.enrollment).toBeNull()
    expect(state.enrollments).toHaveLength(0)
  })

  it('6. reactivating the workflow does not retroactively enroll a previously skipped lead', async () => {
    const { captureAutomaticLead } = await importService()

    state.workflows.push({
      id: 'wf_acme_1',
      organizationId: ACME,
      type: 'LEAD_QUALIFICATION',
      status: 'PAUSED',
      version: 1,
    })

    const firstAttempt = await captureAutomaticLead(ACME, {
      name: 'Skipped While Paused',
      email: 'skipped@prospect.test',
      source: 'WEBSITE_FORM',
    })
    expect(firstAttempt.enrollment).toBeNull()

    // Reactivate the workflow. Nothing in this service re-scans leads that
    // arrived while paused — enrollment only ever happens at capture time.
    const workflow = state.workflows.find((w) => w.id === 'wf_acme_1')!
    workflow.status = 'ACTIVE'

    expect(state.enrollments).toHaveLength(0)

    // A brand new capture for a DIFFERENT lead after reactivation does
    // enroll normally, proving the workflow itself still works — it's only
    // the earlier, already-captured lead that is never revisited.
    const secondLead = await captureAutomaticLead(ACME, {
      name: 'Arrives After Reactivation',
      email: 'after-reactivation@prospect.test',
      source: 'WEBSITE_FORM',
    })
    expect(secondLead.enrollment).not.toBeNull()
    expect(state.enrollments).toHaveLength(1)
    expect(state.enrollments[0]?.leadId).toBe(secondLead.lead.id)
  })

  describe('form message', () => {
    it('persists the message the prospect wrote', async () => {
      const { captureAutomaticLead } = await importService()

      const result = await captureAutomaticLead(ACME, {
        name: 'Intent Prospect',
        email: 'intent@prospect.test',
        formMessage: '  We need this before Q1. Budget approved.  ',
        source: 'WEBSITE_FORM',
      })

      expect(result.lead.formMessage).toBe('We need this before Q1. Budget approved.')
    })

    it('stores an empty message as null, not as a blank string', async () => {
      const { captureAutomaticLead } = await importService()

      const result = await captureAutomaticLead(ACME, {
        name: 'Blank Prospect',
        email: 'blank@prospect.test',
        formMessage: '   ',
        source: 'WEBSITE_FORM',
      })

      // The model has to see "stated nothing", not a blank it might read as
      // an answer.
      expect(result.lead.formMessage).toBeNull()
    })

    it('stores null when the form collected no message field at all', async () => {
      const { captureAutomaticLead } = await importService()

      const result = await captureAutomaticLead(ACME, {
        name: 'Silent Prospect',
        email: 'silent@prospect.test',
        source: 'WEBSITE_FORM',
      })

      expect(result.lead.formMessage).toBeNull()
    })

    it('rejects a message beyond the 5000-character cap', async () => {
      const { captureAutomaticLead } = await importService()

      await expect(
        captureAutomaticLead(ACME, {
          name: 'Verbose Prospect',
          email: 'verbose@prospect.test',
          formMessage: 'x'.repeat(5001),
          source: 'WEBSITE_FORM',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })

    it('accepts a message exactly at the cap', async () => {
      const { captureAutomaticLead } = await importService()

      const result = await captureAutomaticLead(ACME, {
        name: 'Exact Prospect',
        email: 'exact@prospect.test',
        formMessage: 'x'.repeat(5000),
        source: 'WEBSITE_FORM',
      })

      expect(result.lead.formMessage).toHaveLength(5000)
    })

    it('lets the latest message win on a re-submission', async () => {
      const { captureAutomaticLead } = await importService()

      await captureAutomaticLead(ACME, {
        name: 'Returning Prospect',
        email: 'returning@prospect.test',
        formMessage: 'Just browsing for now.',
        source: 'WEBSITE_FORM',
      })
      const second = await captureAutomaticLead(ACME, {
        name: 'Returning Prospect',
        email: 'returning@prospect.test',
        formMessage: 'Budget approved, we need this in Q1.',
        source: 'WEBSITE_FORM',
      })

      expect(second.lead.formMessage).toBe('Budget approved, we need this in Q1.')
    })

    it('never erases an existing message when the new payload omits one', async () => {
      const { captureAutomaticLead } = await importService()

      await captureAutomaticLead(ACME, {
        name: 'Kept Prospect',
        email: 'kept@prospect.test',
        formMessage: 'Please send pricing.',
        source: 'WEBSITE_FORM',
      })
      const second = await captureAutomaticLead(ACME, {
        name: 'Kept Prospect',
        email: 'kept@prospect.test',
        source: 'WEBSITE_FORM',
      })

      expect(second.lead.formMessage).toBe('Please send pricing.')
    })

    it('creates no second run when a re-submission brings a new message', async () => {
      const { captureAutomaticLead } = await importService()

      const first = await captureAutomaticLead(ACME, {
        name: 'Rescore Prospect',
        email: 'rescore@prospect.test',
        formMessage: 'Curious.',
        source: 'WEBSITE_FORM',
      })
      const second = await captureAutomaticLead(ACME, {
        name: 'Rescore Prospect',
        email: 'rescore@prospect.test',
        formMessage: 'Budget approved.',
        source: 'WEBSITE_FORM',
      })

      // The duplicate invariant is unchanged: a newly stated intention updates
      // the Lead but does NOT re-qualify it. Requalification waits for a
      // manual re-run.
      expect(first.run).not.toBeNull()
      expect(second.run).toBeNull()
    })
  })

  it('7. a duplicate Website Form submission updates the existing lead — no second lead, no second enrollment', async () => {
    const { captureAutomaticLead } = await importService()

    const first = await captureAutomaticLead(ACME, {
      name: 'Jane Prospect',
      email: 'dup@prospect.test',
      company: 'Acme Corp',
      source: 'WEBSITE_FORM',
    })
    expect(first.leadWasCreated).toBe(true)

    const second = await captureAutomaticLead(ACME, {
      name: 'Jane Q. Prospect',
      email: 'DUP@Prospect.test ', // same person, different case/whitespace
      phone: '+1-555-0100',
      source: 'WEBSITE_FORM',
    })

    expect(second.leadWasCreated).toBe(false)
    expect(second.lead.id).toBe(first.lead.id)
    expect(second.lead.name).toBe('Jane Q. Prospect')
    // Non-destructive: company from the first submission is preserved even
    // though the second submission didn't repeat it.
    expect(second.lead.company).toBe('Acme Corp')
    expect(second.lead.phone).toBe('+1-555-0100')

    expect(state.leads.filter((l) => l.email === 'dup@prospect.test')).toHaveLength(1)
    expect(state.enrollments).toHaveLength(1)
  })

  it('8. calling capture again for the same lead still results in exactly one enrollment', async () => {
    const { captureAutomaticLead } = await importService()

    const input = {
      name: 'Repeat Caller',
      email: 'repeat@prospect.test',
      source: 'WEBSITE_FORM' as const,
    }
    const first = await captureAutomaticLead(ACME, input)
    const second = await captureAutomaticLead(ACME, input)
    const third = await captureAutomaticLead(ACME, input)

    expect(state.enrollments).toHaveLength(1)
    expect(first.enrollment?.id).toBe(second.enrollment?.id)
    expect(second.enrollment?.id).toBe(third.enrollment?.id)
  })

  it('9. a lead with no owner still enrolls successfully', async () => {
    const { captureAutomaticLead } = await importService()

    const result = await captureAutomaticLead(ACME, {
      name: 'No Owner',
      email: 'no-owner@prospect.test',
      source: 'WEBSITE_FORM',
    })

    expect(result.lead.ownerId).toBeNull()
    expect(result.enrollment).not.toBeNull()
  })

  it('10. two organizations independently capture and enroll the same email — no cross-tenant leakage', async () => {
    const { captureAutomaticLead } = await importService()

    const acmeResult = await captureAutomaticLead(ACME, {
      name: 'Shared Email Acme',
      email: 'shared@prospect.test',
      source: 'WEBSITE_FORM',
    })
    const globexResult = await captureAutomaticLead(GLOBEX, {
      name: 'Shared Email Globex',
      email: 'shared@prospect.test',
      source: 'WEBSITE_FORM',
    })

    // Each org got its own Lead and its own enrollment — the Globex capture
    // never found (and so never "duplicate-updated") Acme's lead.
    expect(acmeResult.lead.id).not.toBe(globexResult.lead.id)
    expect(acmeResult.leadWasCreated).toBe(true)
    expect(globexResult.leadWasCreated).toBe(true)
    expect(acmeResult.enrollment?.organizationId).toBe(ACME)
    expect(globexResult.enrollment?.organizationId).toBe(GLOBEX)
    expect(acmeResult.enrollment?.workflowId).not.toBe(globexResult.enrollment?.workflowId)
    expect(state.leads).toHaveLength(2)
    expect(state.enrollments).toHaveLength(2)
  })

  it('11. fails closed with an empty organizationId (no tenant context)', async () => {
    const { captureAutomaticLead } = await importService()

    await expect(
      captureAutomaticLead('', {
        name: 'No Org',
        email: 'no-org@prospect.test',
        source: 'WEBSITE_FORM',
      }),
    ).rejects.toThrow()

    expect(state.leads).toHaveLength(0)
    expect(state.enrollments).toHaveLength(0)
  })

  it('rejects invalid capture input (validation)', async () => {
    const { captureAutomaticLead } = await importService()

    await expect(
      captureAutomaticLead(ACME, { name: '', email: 'not-an-email', source: 'WEBSITE_FORM' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('does not create multiple LEAD_QUALIFICATION workflows for one organization across two captures', async () => {
    const { captureAutomaticLead } = await importService()

    await captureAutomaticLead(ACME, {
      name: 'One',
      email: 'one@prospect.test',
      source: 'WEBSITE_FORM',
    })
    await captureAutomaticLead(ACME, {
      name: 'Two',
      email: 'two@prospect.test',
      source: 'WEBSITE_FORM',
    })

    expect(
      state.workflows.filter((w) => w.organizationId === ACME && w.type === 'LEAD_QUALIFICATION'),
    ).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Phase 2C — enrollment now also creates the PENDING run and emits the event
  // -------------------------------------------------------------------------

  describe('run creation and event emission (Phase 2C)', () => {
    it('creates a PENDING run copying the workflow version, then emits after commit', async () => {
      const { captureAutomaticLead } = await importService()

      const result = await captureAutomaticLead(ACME, {
        name: 'Jane Prospect',
        email: 'run@prospect.test',
        source: 'WEBSITE_FORM',
      })

      expect(result.run).not.toBeNull()
      expect(result.run?.status).toBe('PENDING')
      expect(result.run?.trigger).toBe('AUTOMATIC')
      expect(result.run?.workflowEnrollmentId).toBe(result.enrollment?.id)
      expect(result.run?.version).toBe(1)
      expect(state.runs).toHaveLength(1)

      expect(emitRunRequestedMock).toHaveBeenCalledTimes(1)
      expect(emitRunRequestedMock).toHaveBeenCalledWith({
        runId: result.run?.id,
        organizationId: ACME,
        leadId: result.lead.id,
        trigger: 'AUTOMATIC',
      })
    })

    it('emits nothing when the capture transaction fails — no event before commit', async () => {
      const { captureAutomaticLead } = await importService()

      // A pre-existing soft-deleted lead makes the insert violate the email
      // uniqueness constraint, so the whole transaction rolls back.
      state.leads.push({
        id: 'lead_soft_deleted',
        organizationId: ACME,
        name: 'Gone',
        email: 'rollback@prospect.test',
        company: null,
        phone: null,
        formMessage: null,
        source: 'WEBSITE_FORM',
        ownerId: null,
        deletedAt: new Date(),
      })

      await expect(
        captureAutomaticLead(ACME, {
          name: 'Jane',
          email: 'rollback@prospect.test',
          source: 'WEBSITE_FORM',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      expect(emitRunRequestedMock).not.toHaveBeenCalled()
      expect(state.runs).toHaveLength(0)
    })

    it('a duplicate capture creates no second run and emits no second event', async () => {
      const { captureAutomaticLead } = await importService()
      const input = {
        name: 'Jane Prospect',
        email: 'dup-run@prospect.test',
        source: 'WEBSITE_FORM' as const,
      }

      const first = await captureAutomaticLead(ACME, input)
      const second = await captureAutomaticLead(ACME, { ...input, name: 'Jane Q. Prospect' })

      expect(first.run).not.toBeNull()
      expect(second.run).toBeNull()
      expect(state.runs).toHaveLength(1)
      expect(emitRunRequestedMock).toHaveBeenCalledTimes(1)
    })

    it('creates no run for an ineligible source', async () => {
      const { captureAutomaticLead } = await importService()

      const result = await captureAutomaticLead(ACME, {
        name: 'Manual Entry',
        email: 'manual-run@prospect.test',
        source: 'MANUAL',
      })

      expect(result.run).toBeNull()
      expect(state.runs).toHaveLength(0)
      expect(emitRunRequestedMock).not.toHaveBeenCalled()
    })

    it('creates no run when the workflow is paused', async () => {
      const { captureAutomaticLead } = await importService()
      state.workflows.push({
        id: 'wf_paused',
        organizationId: ACME,
        type: 'LEAD_QUALIFICATION',
        status: 'PAUSED',
        version: 1,
      })

      const result = await captureAutomaticLead(ACME, {
        name: 'Paused',
        email: 'paused-run@prospect.test',
        source: 'WEBSITE_FORM',
      })

      expect(result.run).toBeNull()
      expect(state.runs).toHaveLength(0)
      expect(emitRunRequestedMock).not.toHaveBeenCalled()
    })

    it('a failed emit does not fail the capture — the run is left for the reconciler', async () => {
      const { captureAutomaticLead } = await importService()
      emitRunRequestedMock.mockRejectedValueOnce(new Error('inngest unreachable'))

      const result = await captureAutomaticLead(ACME, {
        name: 'Orphan',
        email: 'orphan@prospect.test',
        source: 'WEBSITE_FORM',
      })

      // Lead and run are durable; only the scheduling was lost, which the
      // pending-run sweep recovers.
      expect(result.lead.id).toBeDefined()
      expect(result.run?.status).toBe('PENDING')
      expect(state.runs).toHaveLength(1)
    })
  })
})
