import 'server-only'

import { Prisma } from '@prisma/client'
import type { Lead } from '@prisma/client'

export type { Lead }

import { hasCapability } from '@/lib/auth/rbac'
import { requireUser, type CurrentUser } from '@/lib/auth/session'
import { withTenant, type TenantDb } from '@/lib/db/tenant'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { logger } from '@/lib/logger'
import {
  createLeadSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  UNASSIGNED_OWNER_FILTER,
  type CreateLeadInput,
  type LeadQualificationFilter,
  type ListLeadsQuery,
  type UpdateLeadInput,
} from '@/lib/validation/leads'

/**
 * Server-side Lead service (Phase 1B).
 *
 * Business logic lives here, not in the UI or an API route — this module is
 * meant to be called from both, later. Every exported function:
 *
 *  1. Resolves the caller via `requireUser()` — the organization is ALWAYS
 *     derived from the session, never accepted as a parameter.
 *  2. Runs its queries through `withTenant()`, so Postgres RLS is the backstop
 *     even if the ownership filter below were ever wrong or bypassed.
 *  3. Applies the ownership scoping rule from docs/product-spec.md §11: a
 *     SALES_REP may only see/edit/delete Leads they own; ADMIN/MANAGER see
 *     and edit/reassign any Lead in the org. This mirrors the comment already
 *     in lib/auth/rbac.ts — "a rep's access to leads is scoped to records
 *     they own, which is an ownership filter applied at query time" — rather
 *     than inventing a new capability.
 *
 * Not implemented here (explicitly out of scope for Phase 1B): CSV import,
 * public lead capture, AI qualification, workflow enrollment. `status`,
 * `aiScore` and `qualification` are never written by this service — they are
 * derived/AI-owned per docs/product-spec.md §5.
 */

const VIEW_ALL = 'leads:view:all'
const EDIT_ALL = 'leads:edit:all'

function canViewAllLeads(user: CurrentUser) {
  return hasCapability(user.role, VIEW_ALL)
}

function canEditAllLeads(user: CurrentUser) {
  return hasCapability(user.role, EDIT_ALL)
}

function isUniqueEmailViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const meta = error.meta as Record<string, unknown> | undefined
  const target = meta?.target
  if (Array.isArray(target)) return target.includes('email')
  if (typeof target === 'string') return target.toLowerCase().includes('email')

  // With the driver adapter (@prisma/adapter-pg) against real Postgres, P2002
  // carries no `target` at all — the violated constraint name instead sits at
  // `meta.driverAdapterError.cause.constraint.index`. Verified directly
  // against the dev database during Phase 1 E2E smoke testing.
  const driverConstraint = (
    meta?.driverAdapterError as { cause?: { constraint?: { index?: unknown } } } | undefined
  )?.cause?.constraint?.index
  return typeof driverConstraint === 'string' && driverConstraint.toLowerCase().includes('email')
}

/**
 * Resolve `ownerId` for a create/update, enforcing the reassignment rule.
 *
 * `requestedOwnerId` is tri-state: `undefined` -> defaults to the caller
 * (unchanged existing behavior); explicit `null` -> "Unassigned" (Phase 1.1 —
 * a Lead may exist with no owner; no fake system owner is invented and no
 * auto-assignment to an admin happens); a string -> assign to that user.
 *
 * - Explicit `null` is honoured for any caller — leaving a lead unassigned
 *   isn't a reassignment to someone else, so it needs no elevated capability.
 * - A caller without `leads:edit:all` (SALES_REP) can never set a lead's
 *   owner to anyone but themselves. Naming someone else is a reassignment
 *   attempt, which is ADMIN/MANAGER-only — rejected, not silently overridden,
 *   so a misbehaving/compromised client is surfaced rather than hidden.
 * - A caller WITH `leads:edit:all` may name any `ownerId`, but it must
 *   resolve to a user in the same organization. The lookup runs on `tx`
 *   (already tenant-scoped), so RLS itself makes a cross-org id invisible —
 *   no separate cross-tenant check is needed.
 */
async function resolveOwnerId(
  tx: TenantDb,
  user: CurrentUser,
  requestedOwnerId: string | null | undefined,
): Promise<string | null> {
  if (requestedOwnerId === null) {
    return null
  }

  if (!canEditAllLeads(user)) {
    if (requestedOwnerId && requestedOwnerId !== user.id) {
      throw new ForbiddenError('Only an admin or manager can assign a lead to someone else.', {
        userId: user.id,
        requestedOwnerId,
      })
    }
    return user.id
  }

  const ownerId = requestedOwnerId ?? user.id
  const owner = await tx.user.findUnique({ where: { id: ownerId }, select: { id: true } })
  if (!owner) {
    throw new ValidationError('Invalid lead details.', {
      ownerId: ['Owner must be a member of your organization.'],
    })
  }
  return ownerId
}

/** WHERE clause enforcing the ownership scope for read/write. Never trusts client input for this. */
function ownershipFilter(user: CurrentUser, capable: boolean): Prisma.LeadWhereInput {
  return capable ? {} : { ownerId: user.id }
}

/**
 * "Not decided yet" is a NULL column, not a value, so the sentinel has to be
 * translated here rather than passed through to Prisma.
 */
function qualificationFilter(filter: LeadQualificationFilter | undefined): Prisma.LeadWhereInput {
  if (!filter) return {}
  return filter === 'UNSCORED' ? { qualificationOutcome: null } : { qualificationOutcome: filter }
}

/** Same shape of problem for an unowned lead: `ownerId` is null, not a value. */
function ownerFilter(ownerId: string): Prisma.LeadWhereInput {
  return ownerId === UNASSIGNED_OWNER_FILTER ? { ownerId: null } : { ownerId }
}

export async function createLead(rawInput: unknown): Promise<Lead> {
  const user = await requireUser()
  const parsed = createLeadSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationError(
      'Some of the information provided is not valid.',
      parsed.error.flatten().fieldErrors,
    )
  }
  const input: CreateLeadInput = parsed.data

  try {
    return await withTenant(user.organizationId, async (tx) => {
      const ownerId = await resolveOwnerId(tx, user, input.ownerId)

      return tx.lead.create({
        data: {
          organizationId: user.organizationId,
          ownerId,
          name: input.name,
          email: input.email,
          company: input.company,
          phone: input.phone,
          source: input.source,
        },
      })
    })
  } catch (error) {
    if (isUniqueEmailViolation(error)) {
      throw new ConflictError('A lead with that email already exists in your organization.')
    }
    if (error instanceof AppError) throw error

    logger.error('Failed to create lead', { organizationId: user.organizationId, cause: error })
    throw error
  }
}

export async function getLead(id: string): Promise<Lead> {
  const user = await requireUser()
  const capable = canViewAllLeads(user)

  const lead = await withTenant(user.organizationId, (tx) =>
    tx.lead.findFirst({
      where: { id, deletedAt: null, ...ownershipFilter(user, capable) },
    }),
  )

  // A rep naming a real lead they don't own gets the same NotFoundError as a
  // nonexistent id — existence of another rep's lead is not disclosed.
  if (!lead) {
    throw new NotFoundError('Lead not found.')
  }
  return lead
}

/**
 * A Lead with just enough owner data (name/email) for display — see
 * listLeads. `owner` is null when the Lead is Unassigned (Phase 1.1).
 */
export type LeadWithOwner = Lead & {
  owner: { id: string; name: string | null; email: string } | null
}

export type ListLeadsResult = {
  leads: LeadWithOwner[]
  total: number
  page: number
  pageSize: number
}

export async function listLeads(rawQuery: unknown): Promise<ListLeadsResult> {
  const user = await requireUser()
  const parsed = listLeadsQuerySchema.safeParse(rawQuery)
  if (!parsed.success) {
    throw new ValidationError('Invalid list parameters.', parsed.error.flatten().fieldErrors)
  }
  const query: ListLeadsQuery = parsed.data
  const capable = canViewAllLeads(user)

  const where: Prisma.LeadWhereInput = {
    deletedAt: null,
    ...ownershipFilter(user, capable),
    ...(query.status ? { status: query.status } : {}),
    // Targets the pipeline's verdict, not the never-written HOT/WARM/COLD
    // bucket. UNSCORED is a sentinel meaning "not decided yet", which on the
    // row is a NULL — expressible only as an explicit null, never by passing
    // the sentinel through as a value.
    ...qualificationFilter(query.qualification),
    ...(query.source ? { source: query.source } : {}),
    // A rep's own-only scope always wins: an owner filter they request cannot
    // widen their access to someone else's leads — including a request for
    // Unassigned, which would otherwise expose leads they do not own.
    ...(query.ownerId && capable ? ownerFilter(query.ownerId) : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } },
            { company: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [leads, total] = await withTenant(user.organizationId, (tx) =>
    Promise.all([
      tx.lead.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortDirection },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        // The UI displays the owner's name (docs/product-spec.md §5 "Lead N—1
        // User (owner)") — included here rather than looked up separately by
        // the UI, which would duplicate tenant-scoped access logic.
        include: { owner: { select: { id: true, name: true, email: true } } },
      }),
      tx.lead.count({ where }),
    ]),
  )

  return { leads, total, page: query.page, pageSize: query.pageSize }
}

export async function updateLead(id: string, rawInput: unknown): Promise<Lead> {
  const user = await requireUser()
  const parsed = updateLeadSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationError(
      'Some of the information provided is not valid.',
      parsed.error.flatten().fieldErrors,
    )
  }
  const input: UpdateLeadInput = parsed.data
  const capable = canEditAllLeads(user)

  try {
    return await withTenant(user.organizationId, async (tx) => {
      const existing = await tx.lead.findFirst({
        where: { id, deletedAt: null, ...ownershipFilter(user, capable) },
        select: { id: true },
      })
      if (!existing) {
        throw new NotFoundError('Lead not found.')
      }

      const ownerId =
        input.ownerId !== undefined ? await resolveOwnerId(tx, user, input.ownerId) : undefined

      return tx.lead.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.company !== undefined ? { company: input.company } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(ownerId !== undefined ? { ownerId } : {}),
        },
      })
    })
  } catch (error) {
    if (isUniqueEmailViolation(error)) {
      throw new ConflictError('A lead with that email already exists in your organization.')
    }
    if (error instanceof AppError) throw error

    logger.error('Failed to update lead', {
      organizationId: user.organizationId,
      leadId: id,
      cause: error,
    })
    throw error
  }
}

export type ImportRowResult =
  | { row: number; ok: true; leadId: string; email: string }
  | {
      row: number
      ok: false
      email: string | undefined
      message: string
      fieldErrors?: Record<string, string[]>
    }

export type ImportLeadsResult = {
  created: number
  failed: number
  results: ImportRowResult[]
}

/**
 * Imports Leads from already-parsed CSV rows (see lib/csv.ts for parsing).
 *
 * Each row is validated and created independently through `createLead()` —
 * the exact same schema, tenancy, and uniqueness rules a manually-created
 * Lead goes through. Nothing here talks to the database directly: reusing
 * `createLead()` is what guarantees a CSV row can't take a shortcut around
 * validation, RLS, or the organizationId-from-session rule.
 *
 * A row's failure (validation error, duplicate email) never aborts the
 * batch — it's recorded and the next row is attempted, so one bad row
 * can't block the rest of an otherwise-valid file. Every write that does
 * happen is a normal, fully-validated `createLead()` call, so there is no
 * partial/corrupt state: each created Lead is independently valid.
 *
 * `source` defaults to `CSV_IMPORT` when the column is blank; per
 * docs/product-spec.md §8, CSV/manually-created leads never auto-enroll in
 * the automation pipeline — nothing in this function (or `createLead`)
 * triggers any workflow/outbound side effect.
 */
export async function importLeads(rows: Record<string, string>[]): Promise<ImportLeadsResult> {
  // Fail fast on an auth problem (e.g. an expired session) rather than
  // reporting the same "not signed in" failure once per row.
  await requireUser()

  const results: ImportRowResult[] = []
  let created = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const email = row.email || undefined
    try {
      const lead = await createLead({
        name: row.name,
        email: row.email,
        company: row.company || undefined,
        phone: row.phone || undefined,
        source: row.source ? row.source.trim().toUpperCase() : 'CSV_IMPORT',
      })
      results.push({ row: i + 1, ok: true, leadId: lead.id, email: lead.email })
      created++
    } catch (error) {
      if (error instanceof AppError) {
        results.push({
          row: i + 1,
          ok: false,
          email,
          message: error.message,
          fieldErrors: error.fieldErrors,
        })
      } else {
        logger.error('Unexpected failure importing a lead row', { row: i + 1, cause: error })
        results.push({
          row: i + 1,
          ok: false,
          email,
          message: 'Something went wrong importing this row.',
        })
      }
    }
  }

  return { created, failed: results.length - created, results }
}

/** Soft-delete: sets `deletedAt`. Never physically deletes a Lead row. */
export async function deleteLead(id: string): Promise<void> {
  const user = await requireUser()
  const capable = canEditAllLeads(user)

  await withTenant(user.organizationId, async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id, deletedAt: null, ...ownershipFilter(user, capable) },
      select: { id: true },
    })
    if (!existing) {
      throw new NotFoundError('Lead not found.')
    }

    await tx.lead.update({ where: { id }, data: { deletedAt: new Date() } })
  })
}
