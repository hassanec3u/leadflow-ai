import 'server-only'

import type { Prisma, PrismaClient } from '@prisma/client'

import { prisma } from '@/lib/db/prisma'

/**
 * Tenant-scoped database access.
 *
 * Every tenant query runs inside a transaction that first sets the Postgres
 * session variable `app.current_org_id`. The RLS policies installed by
 * prisma/migrations/*_rls read that variable, so the database itself filters
 * rows to the tenant — the application cannot forget a WHERE clause and leak
 * across tenants.
 *
 * Why SET LOCAL inside a transaction, rather than SET on the connection:
 * SET LOCAL is scoped to the transaction and is discarded on commit/rollback.
 * With a pooled connection (PgBouncer, Neon's pooled endpoint) a plain SET
 * would persist on the physical connection and could bleed into a later
 * request from a different tenant. SET LOCAL cannot.
 *
 * Parameterisation note: the org id is passed as a bound parameter via
 * `$executeRaw` (tagged template), not interpolated into SQL text, so a
 * hostile organization id cannot break out into injected SQL. `set_config` is
 * used because SET LOCAL does not accept bind parameters.
 */

/** The subset of PrismaClient usable inside a transaction. */
export type TenantDb = Prisma.TransactionClient

/**
 * Run `work` with tenant context established for `organizationId`.
 *
 * The organizationId MUST come from the authenticated session
 * (see lib/auth/session.ts) — never from request input.
 */
export async function withTenant<T>(
  organizationId: string,
  work: (db: TenantDb) => Promise<T>,
  client: PrismaClient = prisma,
): Promise<T> {
  if (!organizationId) {
    // Fail loudly rather than running with empty context, which would silently
    // match zero rows and look like "no data" instead of a bug.
    throw new Error('withTenant requires a non-empty organizationId')
  }

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`
    return work(tx)
  })
}
