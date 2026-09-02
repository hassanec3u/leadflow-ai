import 'server-only'

import { randomUUID } from 'node:crypto'

import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'

import { withTenant } from '@/lib/db/tenant'
import { ConflictError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { type SignUpInput, slugifyOrganizationName } from '@/lib/validation/auth'

/**
 * Sign-up: create an Organization and its first user (an ADMIN).
 *
 * Business logic deliberately lives here rather than in the server action or a
 * component, so it can be tested without a request context (see Phase 0
 * structure rules: no business logic in UI).
 *
 * ORGANIZATION ID IS GENERATED HERE, NOT LEFT TO PRISMA'S SCHEMA DEFAULT.
 *
 * This is load-bearing, not a style choice. `organizations` carries
 * `WITH CHECK ("id" = current_org_id())` — even the very first insert into a
 * brand-new tenant must satisfy that check. Since the id is known up front, we
 * can `SET` `app.current_org_id` to it before inserting, via `withTenant()`,
 * which is otherwise reserved for queries against an org that already exists.
 * A prior version of this function ran on the unscoped `prisma` client on the
 * theory that "no tenant exists yet, so there's nothing to scope" — that
 * reasoning is wrong for an INSERT under RLS: `WITH CHECK` is evaluated
 * regardless of whether any row currently exists, and with no context set it
 * evaluates `id = NULL`, which is never true. The result was a signup flow
 * that worked in every test (PGlite seeding disables/predates RLS enforcement
 * for setup) but would fail on every real, RLS-enforced database. Caught only
 * once this ran against actual PostgreSQL — see docs/architecture.md §11.10.
 */

const BCRYPT_COST = 12
const MAX_SLUG_ATTEMPTS = 25

export type SignUpResult = {
  userId: string
  organizationId: string
}

function isUniqueConstraintViolation(
  error: unknown,
  field: string,
): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const target = error.meta?.target
  return Array.isArray(target) ? target.includes(field) : target === field
}

/**
 * Derive a candidate slug. Availability can no longer be checked with a
 * proactive SELECT (see below), so this only produces candidates — the
 * database's unique constraint is the actual source of truth.
 */
function candidateSlug(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`
}

export async function signUpNewOrganization(input: SignUpInput): Promise<SignUpResult> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST)
  const slugBase = slugifyOrganizationName(input.organizationName)

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const organizationId = randomUUID()
    const slug = candidateSlug(slugBase, attempt)

    try {
      // Organization and its first user are created atomically: a half-created
      // signup (org with no admin) would leave an unusable, unreachable tenant.
      //
      // withTenant() is normally for an org that already exists; here it is
      // used to pre-authorize writes into the org this transaction is about to
      // create, by setting the GUC to the id we generated above. See the
      // module comment for why this is required, not optional.
      const result = await withTenant(organizationId, async (tx) => {
        const organization = await tx.organization.create({
          data: { id: organizationId, name: input.organizationName, slug },
          select: { id: true },
        })

        const user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            passwordHash,
            // The person who creates the organization administers it.
            role: 'ADMIN',
            organizationId: organization.id,
          },
          select: { id: true },
        })

        return { userId: user.id, organizationId: organization.id }
      })

      logger.info('Organization created', {
        organizationId: result.organizationId,
        userId: result.userId,
      })

      return result
    } catch (error) {
      // Slugs are unique globally, so two orgs named "Acme" collide on the base
      // slug. Under RLS a tenant cannot proactively SELECT other tenants' rows
      // to check availability up front (that SELECT would just return "free"
      // every time, having seen nothing) — so availability is resolved
      // reactively, off the real constraint violation, and retried with the
      // next candidate.
      if (isUniqueConstraintViolation(error, 'slug')) {
        continue
      }

      if (isUniqueConstraintViolation(error, 'email')) {
        throw new ConflictError('An account with that email already exists.')
      }

      throw error
    }
  }

  throw new ConflictError('Could not find an available workspace address. Please try a different organization name.')
}
