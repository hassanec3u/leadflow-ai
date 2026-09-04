import 'server-only'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { getEnv } from '@/lib/env'

/**
 * The Prisma client. Single-tenant: there is no tenant context to establish,
 * so services use this directly.
 *
 * Use `prisma.$transaction()` explicitly wherever a sequence of statements has
 * to see one snapshot — in particular every read-then-conditional-write pair
 * (lib/services/workflow-runs.ts, lib/services/leads.ts). Those used to
 * inherit a transaction from the tenant helper that wrapped them; now they
 * must ask for one.
 *
 * Access control is enforced in application code, not by the database:
 * role/capability checks in lib/auth/session.ts, and the Lead ownership scope
 * in lib/services/leads.ts.
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
