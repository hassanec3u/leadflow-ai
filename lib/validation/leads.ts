import { z } from 'zod'

/**
 * Validation schemas for the Lead service (lib/services/leads.ts).
 *
 * Kept free of `server-only` for the same reason as lib/validation/auth.ts:
 * plain data/validation, safe to import from a future client form.
 *
 * Deliberately excluded from every schema here: `status`, `aiScore`,
 * `qualification`, `deletedAt`, `organizationId`. Per docs/product-spec.md §5
 * these are either derived (status — recomputed from WorkflowRunStep/
 * EmailEvent, never hand-set), AI-only (aiScore/qualification — Phase 3), or
 * session-derived (organizationId — never client input), or have their own
 * dedicated operation (deletedAt — see `deleteLead`).
 */

const LEAD_SOURCES = [
  'WEBSITE_FORM',
  'WEBHOOK',
  'LINKEDIN',
  'GOOGLE_ADS',
  'REFERRAL',
  'MANUAL',
  'CSV_IMPORT',
] as const

const LEAD_STATUSES = [
  'NEW',
  'ENRICHING',
  'QUALIFIED',
  'EMAILED',
  'EMAIL_OPENED',
  'REPLIED',
  'CONVERTED',
  'LOST',
] as const

/**
 * Values the Leads screen can filter qualification by.
 *
 * These are the PIPELINE's outcomes (`Lead.qualificationOutcome`), not the
 * HOT/WARM/COLD `LeadQualification` bucket the filter used to target. Nothing
 * writes that bucket — the engine persists `qualificationOutcome` — so the old
 * filter matched zero rows for every value, forever.
 *
 * `UNSCORED` is a sentinel, not a column value: it means "the pipeline has not
 * decided", which on the row is `qualificationOutcome IS NULL`. It exists
 * because without it every un-scored lead would be unreachable by this filter.
 * The Prisma `LeadQualification` enum is deliberately left untouched.
 */
const LEAD_QUALIFICATION_FILTERS = ['QUALIFIED', 'UNQUALIFIED', 'UNSCORED'] as const

export const leadSourceSchema = z.enum(LEAD_SOURCES)
export const leadStatusSchema = z.enum(LEAD_STATUSES)
export const leadQualificationFilterSchema = z.enum(LEAD_QUALIFICATION_FILTERS)
export type LeadQualificationFilter = (typeof LEAD_QUALIFICATION_FILTERS)[number]

/** Exported for the UI's filter dropdowns — the enum values are the single source of truth. */
export const LEAD_SOURCE_OPTIONS = LEAD_SOURCES
export const LEAD_STATUS_OPTIONS = LEAD_STATUSES
export const LEAD_QUALIFICATION_OPTIONS = LEAD_QUALIFICATION_FILTERS

/**
 * Owner filter sentinel for leads nobody owns.
 *
 * `Lead.ownerId` is nullable by design (Phase 1.1 — a lead may be
 * "Unassigned"), so "no owner" is a first-class state that a plain user-id
 * filter could never express. Not a valid cuid, so it cannot collide with a
 * real user id.
 */
export const UNASSIGNED_OWNER_FILTER = 'UNASSIGNED'

/**
 * `nameSchema`/`emailSchema`/`optionalTrimmed` are exported (not just used
 * locally) so other modules that accept lead-shaped input — e.g.
 * lib/validation/automation-enrollment.ts (Phase 2B) — build on the exact
 * same normalization instead of re-implementing it.
 */
export const nameSchema = z.string().min(1, 'Name is required').max(200, 'Name is too long')
/**
 * Normalized BEFORE the format/length checks run (trim, then lowercase) —
 * not after — so that " John@Example.COM " both passes `.email()` (which
 * would otherwise reject the surrounding whitespace) and normalizes to
 * exactly what the tenant-scoped `(organizationId, email)` uniqueness
 * constraint compares against. Applied uniformly to create, update, and CSV
 * import, since all three route through this same schema (Phase 1.1
 * business-rules closure). Syntactic validation only — no mailbox/domain
 * existence checks, no canonicalization beyond trim+lowercase.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(320, 'Email is too long')
  .email('Enter a valid email address')
export const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' ? undefined : value))

export const createLeadSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  company: optionalTrimmed(200),
  phone: optionalTrimmed(40),
  source: leadSourceSchema,
  /**
   * Tri-state: omitted -> defaults to the caller (existing behavior,
   * unchanged); explicit `null` -> "Unassigned" (Phase 1.1 — no fake system
   * owner, no auto-assignment to an admin); a specific id -> only honoured
   * for a caller with `leads:edit:all` (ADMIN/MANAGER) — see
   * lib/services/leads.ts. A SALES_REP always becomes the owner of a lead
   * they create unless they explicitly pass `null`.
   */
  ownerId: z.string().min(1).nullable().optional(),
})
export type CreateLeadInput = z.infer<typeof createLeadSchema>

export const updateLeadSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    company: optionalTrimmed(200),
    phone: optionalTrimmed(40),
    /**
     * Reassignment — ADMIN/MANAGER only, except `null` ("Unassigned"), which
     * any caller may set. See lib/services/leads.ts.
     */
    ownerId: z.string().min(1).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were provided.' })
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>

const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'lastActionAt', 'name'] as const

export const listLeadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  status: leadStatusSchema.optional(),
  /** Filters `qualificationOutcome`; `UNSCORED` means that column is null. */
  qualification: leadQualificationFilterSchema.optional(),
  source: leadSourceSchema.optional(),
  /**
   * Requested owner filter, or `UNASSIGNED` for leads with no owner. For a
   * SALES_REP this is ignored server-side and their own-only scope stands,
   * regardless of what is passed — see lib/services/leads.ts.
   */
  ownerId: z.string().min(1).optional(),
  sortBy: z.enum(SORTABLE_FIELDS).default('createdAt'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
})
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>

/** The page size the Leads table renders — kept in one place for the UI and its initial server fetch. */
export const LEADS_PAGE_SIZE = 8

/** The query the Leads page uses for its first, server-rendered fetch. */
export const DEFAULT_LEADS_QUERY = { page: 1, pageSize: LEADS_PAGE_SIZE } satisfies Partial<
  Record<keyof ListLeadsQuery, unknown>
>
