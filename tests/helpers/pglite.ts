import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { PGlite } from '@electric-sql/pglite'

/**
 * An in-process PostgreSQL for tests.
 *
 * PGlite is real PostgreSQL compiled to WASM — not a mock and not SQLite — so
 * constraints, partial unique indexes and transaction semantics behave exactly
 * as they do in production. That matters: the automation invariants are
 * enforced by database constraints, and a mocked database could only ever
 * confirm our own assumptions.
 *
 * The migrations applied here are the SAME files Prisma will run against the
 * real database, so this also verifies the migration SQL is valid Postgres.
 *
 * This helper used to carry a lot of role and RLS machinery (a non-superuser
 * application role, a NOLOGIN role owning a SECURITY DEFINER function, a
 * tenant-context helper mirroring `withTenant`). All of it existed to test row
 * level security, which the single-tenant schema no longer has.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations')

export type TestDb = PGlite

/**
 * Apply every migration in prisma/migrations, in lexical (= chronological)
 * order — the same order Prisma Migrate uses.
 */
export async function applyMigrations(db: PGlite): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
  const migrationDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const applied: string[] = []

  for (const dir of migrationDirs) {
    const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql')
    const sql = await readFile(sqlPath, 'utf8')
    // exec() (not query()) runs multi-statement SQL scripts.
    await db.exec(sql)
    applied.push(dir)
  }

  return applied
}

/** Create a fresh in-memory database with all migrations applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.waitReady
  await applyMigrations(db)
  return db
}

/**
 * Seed the users the tests act as.
 *
 * There is no organization to create: accounts are provisioned directly, the
 * way prisma/seed.ts does it in a real deployment.
 */
export async function seedUsers(db: PGlite) {
  await db.exec(`
    INSERT INTO "users" ("id", "name", "email", "role", "createdAt", "updatedAt")
    VALUES
      ('user_admin', 'Acme Admin', 'admin@acme.test', 'ADMIN', NOW(), NOW()),
      ('user_rep', 'Acme Rep', 'rep@acme.test', 'SALES_REP', NOW(), NOW());
  `)

  return {
    adminUserId: 'user_admin',
    repUserId: 'user_rep',
  } as const
}
