import 'server-only'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { getEnv } from '@/lib/env'

/**
 * Base Prisma client.
 *
 * IMPORTANT: this client carries NO tenant context. Using it directly for
 * tenant-owned data will, under RLS, match zero rows (see the RLS migration:
 * an unset `app.current_org_id` fails every policy). That is intentional —
 * forgetting tenant scoping fails closed and loudly rather than leaking data.
 *
 * For tenant data use `withTenant()` from lib/db/tenant.ts instead.
 *
 * Legitimate direct uses: authentication lookups that happen before an
 * organization is known (Auth.js adapter, credential sign-in), and migrations.
 */

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Reuse across hot reloads in development; a new client per reload exhausts
// database connections quickly.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
