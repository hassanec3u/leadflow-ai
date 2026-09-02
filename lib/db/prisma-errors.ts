import { Prisma } from '@prisma/client'

/**
 * Unique-constraint detection across both shapes Prisma reports.
 *
 * Classic Prisma puts the violated columns in `meta.target`. With the driver
 * adapter (`@prisma/adapter-pg`) against real Postgres there is no `target`
 * at all — the violated index name sits at
 * `meta.driverAdapterError.cause.constraint.index` (verified against the dev
 * database during Phase 1 E2E testing; see lib/services/leads.ts, which
 * documents the same finding).
 *
 * Constraint identity matters here: the automation tables carry several
 * unique constraints, and "duplicate row" means something different for each
 * one, so callers must say WHICH constraint they are handling.
 */
export function isUniqueConstraintViolation(
  error: unknown,
  { columns, indexName }: { columns: readonly string[]; indexName: string },
): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }

  const meta = error.meta as Record<string, unknown> | undefined
  const target = meta?.target

  if (Array.isArray(target)) {
    return columns.every((column) => target.includes(column))
  }
  if (typeof target === 'string') {
    const lowered = target.toLowerCase()
    // A raw index name (partial indexes report this way) or a column list.
    if (lowered === indexName.toLowerCase()) return true
    return columns.every((column) => lowered.includes(column.toLowerCase()))
  }

  const driverConstraint = (
    meta?.driverAdapterError as { cause?: { constraint?: { index?: unknown } } } | undefined
  )?.cause?.constraint?.index

  return (
    typeof driverConstraint === 'string' &&
    driverConstraint.toLowerCase() === indexName.toLowerCase()
  )
}

/** The unique constraints the automation code handles by name. */
export const UNIQUE_CONSTRAINTS = {
  leadEmail: { columns: ['email'], indexName: 'leads_organizationId_email_key' },
  workflowPerOrg: {
    columns: ['organizationId', 'type'],
    indexName: 'workflows_organizationId_type_key',
  },
  enrollmentPerWorkflowLead: {
    columns: ['workflowId', 'leadId'],
    indexName: 'workflow_enrollments_workflowId_leadId_key',
  },
  automaticRunPerEnrollment: {
    columns: ['workflowEnrollmentId'],
    indexName: 'workflow_runs_automatic_per_enrollment_key',
  },
  activeRunPerLead: { columns: ['leadId'], indexName: 'workflow_runs_one_active_per_lead_key' },
  stepPerRun: {
    columns: ['workflowRunId', 'step'],
    indexName: 'workflow_step_runs_workflowRunId_step_key',
  },
} as const
