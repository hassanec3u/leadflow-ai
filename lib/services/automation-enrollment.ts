import 'server-only'

import type { Lead, LeadSource, Workflow, WorkflowEnrollment, WorkflowRun } from '@prisma/client'

import { withTenant, type TenantDb } from '@/lib/db/tenant'
import { isUniqueConstraintViolation, UNIQUE_CONSTRAINTS } from '@/lib/db/prisma-errors'
import { AppError, ConflictError, ValidationError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { emitRunRequested } from '@/lib/automation/events'
import {
  automaticLeadCaptureSchema,
  type AutomaticLeadCaptureInput,
} from '@/lib/validation/automation-enrollment'

/**
 * Server-side Automatic Workflow Enrollment service (Phase 2B).
 *
 * Scope, deliberately narrow (docs/roadmap.md Phase 2B): decide whether a
 * Lead is eligible for automatic enrollment into the organization's single
 * fixed `LEAD_QUALIFICATION` workflow (docs/architecture.md §10) and, if so,
 * create the `WorkflowEnrollment` row. This module does NOT execute the
 * pipeline: it never creates a `WorkflowRun`, never calls a provider, and
 * never sends anything. Execution is Phase 2C+ (Inngest).
 *
 * Tenancy: every exported function takes `organizationId` as an explicit
 * parameter rather than resolving it via `requireUser()`. Automatic
 * enrollment is triggered by an automatic capture source (a Website Form
 * submission, docs/product-spec.md §8) — there is no signed-in LeadFlow user
 * in that request. The caller is trusted to have already resolved
 * `organizationId` through its own mechanism (the current caller in this
 * codebase is a test; a future public capture endpoint would resolve it from
 * a per-org webhook/API-key secret, never from the request body — see
 * docs/architecture.md §6). `organizationId` is NEVER read out of the raw
 * incoming payload (`rawInput` below) — only validated lead fields are.
 * Every query still runs through `withTenant()`, so Postgres RLS remains the
 * backstop exactly as it is for every other tenant-owned table.
 */

const AUTOMATIC_ENROLLMENT_SOURCES: ReadonlySet<LeadSource> = new Set<LeadSource>(['WEBSITE_FORM'])

/**
 * The single source of truth for "is this Lead source allowed to
 * auto-enroll?" (docs/product-spec.md §8). Deliberately a set lookup, not a
 * switch/if scattered across call sites, so a future eligible source (e.g. a
 * webhook or ad-platform source, once ingestion for it exists) is a one-line
 * change here rather than a hunt through the codebase.
 */
export function isEligibleForAutomaticEnrollment(source: LeadSource): boolean {
  return AUTOMATIC_ENROLLMENT_SOURCES.has(source)
}

// Constraint-violation detection is shared (lib/db/prisma-errors.ts) rather
// than re-implemented per service: the Prisma/driver-adapter error shapes are
// fiddly enough that one tested implementation is the only safe number.
const isUniqueWorkflowViolation = (error: unknown) =>
  isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.workflowPerOrg)

const isUniqueEnrollmentViolation = (error: unknown) =>
  isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.enrollmentPerWorkflowLead)

const isUniqueLeadEmailViolation = (error: unknown) =>
  isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.leadEmail)

/**
 * Find the organization's single `LEAD_QUALIFICATION` workflow, creating it
 * if it does not exist yet.
 *
 * Nothing currently provisions this row at organization creation
 * (docs/architecture.md §10 describes that as the eventual behavior, but it
 * is not built — see lib/services/signup.ts). Enrollment is the first thing
 * that needs the row to exist, so it lazily creates it here — find-then-create,
 * with a race caught by the `(organizationId, type)` unique constraint and
 * resolved by re-reading, so concurrent first-enrollments for the same org
 * can never create two workflow rows (rule: "do not create multiple
 * LEAD_QUALIFICATION workflows for one organization").
 */
async function getOrCreateLeadQualificationWorkflow(
  tx: TenantDb,
  organizationId: string,
): Promise<Workflow> {
  const existing = await tx.workflow.findFirst({
    where: { organizationId, type: 'LEAD_QUALIFICATION' },
  })
  if (existing) return existing

  try {
    return await tx.workflow.create({
      data: { organizationId, type: 'LEAD_QUALIFICATION', status: 'ACTIVE', version: 1 },
    })
  } catch (error) {
    if (isUniqueWorkflowViolation(error)) {
      const workflow = await tx.workflow.findFirst({
        where: { organizationId, type: 'LEAD_QUALIFICATION' },
      })
      if (workflow) return workflow
    }
    throw error
  }
}

/**
 * Enroll `lead` into the organization's workflow if — and only if — it is
 * eligible. Returns the (possibly pre-existing) enrollment, or `null` when no
 * enrollment was made.
 *
 * Idempotent and concurrency-safe: a lead already enrolled in this workflow
 * returns that same enrollment rather than erroring or duplicating, whether
 * this is called twice sequentially (findFirst short-circuits) or twice at
 * once (the `(workflowId, leadId)` unique constraint rejects the loser, which
 * is caught and resolved by re-reading — never surfaced as a failure to the
 * caller).
 *
 * A `PAUSED` workflow never gets a new enrollment. There is no queue or
 * backfill: reactivating a paused workflow later does not retroactively
 * enroll leads that arrived while it was paused (rule 11) — this function
 * is only ever called at capture time, so a lead skipped while paused is
 * simply never revisited.
 */
async function enrollLeadIfEligible(
  tx: TenantDb,
  organizationId: string,
  lead: Lead,
): Promise<{ enrollment: WorkflowEnrollment; workflow: Workflow } | null> {
  if (!isEligibleForAutomaticEnrollment(lead.source)) {
    return null
  }

  const workflow = await getOrCreateLeadQualificationWorkflow(tx, organizationId)
  if (workflow.status !== 'ACTIVE') {
    return null
  }

  const existingEnrollment = await tx.workflowEnrollment.findFirst({
    where: { workflowId: workflow.id, leadId: lead.id },
  })
  if (existingEnrollment) {
    return { enrollment: existingEnrollment, workflow }
  }

  try {
    const enrollment = await tx.workflowEnrollment.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        leadId: lead.id,
        trigger: 'AUTOMATIC',
      },
    })
    return { enrollment, workflow }
  } catch (error) {
    if (isUniqueEnrollmentViolation(error)) {
      const enrollment = await tx.workflowEnrollment.findFirst({
        where: { workflowId: workflow.id, leadId: lead.id },
      })
      if (enrollment) return { enrollment, workflow }
    }
    throw error
  }
}

/**
 * Create the PENDING WorkflowRun for a fresh automatic enrollment (Phase 2C).
 *
 * Runs INSIDE the enrolling transaction so the row is durable before anything
 * is scheduled — but performs no side effect of its own: creating a PENDING
 * run is not executing the workflow (invariant 3). The event that starts
 * execution is emitted by the caller, after commit.
 *
 * Returns null when no new run was created, which is the normal path for a
 * duplicate capture: the enrollment already has its one automatic run
 * (`workflow_runs_automatic_per_enrollment_key`), so a repeat submission
 * updates the Lead and starts nothing.
 */
async function createPendingRunForEnrollment(
  tx: TenantDb,
  organizationId: string,
  lead: Lead,
  enrollment: WorkflowEnrollment,
  workflow: Workflow,
): Promise<WorkflowRun | null> {
  const existingRun = await tx.workflowRun.findFirst({
    where: { workflowEnrollmentId: enrollment.id, trigger: 'AUTOMATIC' },
  })
  if (existingRun) return null

  try {
    return await tx.workflowRun.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        workflowEnrollmentId: enrollment.id,
        leadId: lead.id,
        // Copied at creation time: this run records the workflow definition it
        // actually executed, even if the workflow is versioned later.
        version: workflow.version,
        trigger: 'AUTOMATIC',
        status: 'PENDING',
      },
    })
  } catch (error) {
    // Either another capture won the race for this enrollment's automatic run,
    // or the lead already has an in-flight run (a manual re-run). Both mean
    // "a run already exists" — not a capture failure.
    if (
      isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.automaticRunPerEnrollment) ||
      isUniqueConstraintViolation(error, UNIQUE_CONSTRAINTS.activeRunPerLead)
    ) {
      return null
    }
    throw error
  }
}

/**
 * Merge incoming automatic-capture data onto an existing Lead
 * non-destructively: an incoming value is applied when present, but an
 * absent/blank incoming value never blanks out data the Lead already has
 * (docs/product-spec.md §8 "update the existing lead ... treated as
 * re-engagement"). `name` is required on every capture, so it always applies.
 */
function nonDestructiveUpdate(existing: Lead, incoming: AutomaticLeadCaptureInput) {
  return {
    name: incoming.name,
    company: incoming.company ?? existing.company,
    phone: incoming.phone ?? existing.phone,
    // Latest message wins, but an absent one never erases what the prospect
    // wrote before. Note this does NOT re-qualify: a duplicate capture still
    // creates no second run (the automatic-run-per-enrollment index is
    // untouched), so a newly stated intention waits for a manual re-run.
    formMessage: incoming.formMessage ?? existing.formMessage,
  }
}

export type CaptureAutomaticLeadResult = {
  lead: Lead
  /** false when an existing Lead (by normalized, org-scoped email) was updated instead of created. */
  leadWasCreated: boolean
  /** null when the lead's source is not eligible, or the workflow is paused. */
  enrollment: WorkflowEnrollment | null
  /**
   * The PENDING run created for a fresh enrollment, or null when none was
   * created (ineligible source, paused workflow, or a duplicate capture whose
   * enrollment already owns its one automatic run).
   */
  run: WorkflowRun | null
}

/**
 * Capture a Lead from an automatic source and enroll it if eligible.
 *
 * This is the one entry point that implements the full "duplicate incoming
 * lead" rule end to end:
 *  - a normalized-email match against an existing (non-deleted) Lead in the
 *    same organization updates that Lead non-destructively — it never
 *    creates a second Lead, and (because enrollment is looked up by
 *    `(workflowId, leadId)`, which is stable across repeat calls for the
 *    same Lead) never creates a second enrollment or a second workflow run.
 *  - no match creates a new Lead.
 *
 * Phase 2C: a fresh enrollment also gets a PENDING `WorkflowRun` created in
 * the SAME transaction, and the `automation/run.requested` event is emitted
 * only AFTER that transaction commits. The ordering matters in both
 * directions — an event emitted first could be executed before (or without)
 * the row it names, while a row created without an event would simply never
 * run, which is why an emit failure is logged and left to the reconciler
 * (lib/services/workflow-recovery.ts) rather than failing the capture.
 *
 * `organizationId` is a trusted parameter, never read from `rawInput` — see
 * the module doc comment above.
 */
export async function captureAutomaticLead(
  organizationId: string,
  rawInput: unknown,
): Promise<CaptureAutomaticLeadResult> {
  if (!organizationId) {
    throw new Error('captureAutomaticLead requires a non-empty organizationId')
  }

  const parsed = automaticLeadCaptureSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationError(
      'Some of the information provided is not valid.',
      parsed.error.flatten().fieldErrors,
    )
  }
  const input = parsed.data

  let result: CaptureAutomaticLeadResult

  try {
    result = await withTenant(organizationId, async (tx) => {
      // Not filtered to eligible sources here: capture itself accepts any
      // LeadSource (e.g. a future webhook source), and eligibility is
      // decided once, in enrollLeadIfEligible, via
      // isEligibleForAutomaticEnrollment — the single source of truth, not
      // duplicated into this lookup.
      const existing = await tx.lead.findFirst({
        where: { organizationId, email: input.email, deletedAt: null },
      })

      let lead: Lead
      let leadWasCreated: boolean

      if (existing) {
        lead = await tx.lead.update({
          where: { id: existing.id },
          data: nonDestructiveUpdate(existing, input),
        })
        leadWasCreated = false
      } else {
        lead = await tx.lead.create({
          data: {
            organizationId,
            name: input.name,
            email: input.email,
            company: input.company,
            phone: input.phone,
            formMessage: input.formMessage,
            source: input.source,
            // ownerId omitted: automatic capture never assigns an owner —
            // the Lead is created Unassigned (docs/product-spec.md §8/§5;
            // Lead.ownerId is nullable — Phase 1.1). Enrollment does not
            // require one either (rule 12).
          },
        })
        leadWasCreated = true
      }

      const enrolled = await enrollLeadIfEligible(tx, organizationId, lead)
      if (!enrolled) {
        return { lead, leadWasCreated, enrollment: null, run: null }
      }

      const run = await createPendingRunForEnrollment(
        tx,
        organizationId,
        lead,
        enrolled.enrollment,
        enrolled.workflow,
      )

      return { lead, leadWasCreated, enrollment: enrolled.enrollment, run }
    })
  } catch (error) {
    if (isUniqueLeadEmailViolation(error)) {
      // The only way to reach this despite the findFirst above: the sole
      // existing row with this email is soft-deleted (deletedAt excluded it
      // from the lookup), and the DB's (organizationId, email) uniqueness is
      // NOT deletedAt-filtered (Phase 1.1) — so a soft-deleted Lead still
      // blocks a new insert with the same email, same as manual creation.
      throw new ConflictError('A lead with that email already exists in your organization.')
    }
    if (error instanceof AppError) throw error

    logger.error('Failed to capture automatic lead', { organizationId, cause: error })
    throw error
  }

  // AFTER COMMIT. Nothing above this line performs a side effect, so a
  // rolled-back capture can never have scheduled an execution.
  if (result.run) {
    try {
      await emitRunRequested({
        runId: result.run.id,
        organizationId,
        leadId: result.lead.id,
        trigger: 'AUTOMATIC',
      })
    } catch (error) {
      // The run row is durable; the reconciler re-emits orphaned PENDING runs
      // (lib/services/workflow-recovery.ts), so a failed emit delays execution
      // rather than losing it. Failing the capture here would be worse: the
      // lead is already saved and the caller has nothing useful to retry.
      logger.error('Failed to emit automation run event after capture', {
        orgId: organizationId,
        runId: result.run.id,
        leadId: result.lead.id,
        cause: error,
      })
    }
  }

  return result
}
