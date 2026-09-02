import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { PGlite } from '@electric-sql/pglite'

/**
 * An in-process PostgreSQL for tests.
 *
 * PGlite is real PostgreSQL compiled to WASM — not a mock and not SQLite — so
 * Row Level Security, policies, roles and `current_setting()` behave exactly as
 * they do in production. That matters: RLS is the security control we most need
 * to verify, and a mocked database could only ever confirm our own assumptions.
 *
 * The migrations applied here are the SAME files Prisma will run against the
 * real database, so this also verifies the migration SQL is valid Postgres.
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

/**
 * The non-superuser role tests run as.
 *
 * This is essential, not incidental. PGlite connects as `postgres`, which is a
 * SUPERUSER with BYPASSRLS — and PostgreSQL superusers ignore RLS entirely,
 * even with FORCE ROW LEVEL SECURITY. Testing as `postgres` would make every
 * isolation assertion below pass vacuously while proving nothing.
 *
 * The same constraint applies in production: the application's database role
 * must be a plain role, never a superuser and never BYPASSRLS. See
 * docs/architecture.md §4.
 */
export const APP_ROLE = 'leadflow_app'

/**
 * The dedicated, NOLOGIN role that owns the `auth_lookup_user_by_email`
 * SECURITY DEFINER function (migration 20260901000200_...). Mirrors
 * prisma/manual/001_provision_auth_lookup_role.sql, which does this against a
 * real database. Nothing in the test suite ever connects as this role —
 * it exists solely so that migration's `ALTER FUNCTION ... OWNER TO` and
 * `CREATE POLICY ... TO` clauses have a role to reference.
 */
export const AUTH_LOOKUP_ROLE = 'leadflow_auth_lookup'

/**
 * Create both roles before any migration runs.
 *
 * This must happen BEFORE `applyMigrations()`: migration
 * 20260901000200_auth_lookup_security_definer references both role names in
 * a `CREATE POLICY ... TO leadflow_auth_lookup` and an
 * `ALTER FUNCTION ... OWNER TO leadflow_auth_lookup` clause, both of which
 * require the roles to already exist. Table/column-level grants are done
 * separately, after migrations (see createAppRole and
 * grantAuthLookupColumnAccess below), since they need the tables to exist.
 */
async function provisionRolesBeforeMigrations(db: PGlite): Promise<void> {
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${AUTH_LOOKUP_ROLE}') THEN
        CREATE ROLE ${AUTH_LOOKUP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END
    $$;
    GRANT ${AUTH_LOOKUP_ROLE} TO ${APP_ROLE};

    -- Required for the migration's "ALTER FUNCTION ... OWNER TO
    -- ${AUTH_LOOKUP_ROLE}" to succeed: PostgreSQL requires a role to hold
    -- CREATE on an object's schema before it can become that object's owner.
    -- This does not depend on any table existing, so it belongs here
    -- (pre-migration), not alongside the column-level grant below (which
    -- does depend on "users" existing). NOLOGIN means this is never
    -- exercised at runtime — only during this one-time ownership transfer.
    GRANT USAGE, CREATE ON SCHEMA public TO ${AUTH_LOOKUP_ROLE};
  `)
}

/**
 * Grant the auth-lookup role exactly the columns it needs on `users`.
 * Mirrors prisma/manual/001_provision_auth_lookup_role.sql. Must run after
 * migrations, since `users` does not exist beforehand.
 */
async function grantAuthLookupColumnAccess(db: PGlite): Promise<void> {
  await db.exec(`
    GRANT SELECT (id, email, name, image, "passwordHash", "organizationId", role)
      ON users TO ${AUTH_LOOKUP_ROLE};
  `)
}

const MANUAL_DIR = path.join(process.cwd(), 'prisma', 'manual')

/**
 * Apply one of the privileged, ops-run scripts in prisma/manual/.
 *
 * Those scripts need privileges the application role deliberately lacks
 * (CREATEROLE, `SET ROLE`), which is exactly why they are not Prisma
 * migrations. PGlite's default connection is the bootstrap superuser, so a
 * test can apply one here the same way an operator would in production —
 * before {@link seedTwoTenants} drops to the unprivileged role.
 */
export async function applyManualScript(db: PGlite, fileName: string): Promise<void> {
  const sql = await readFile(path.join(MANUAL_DIR, fileName), 'utf8')
  await db.exec(sql)
}

/** Create a fresh in-memory database with all migrations applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.waitReady
  await provisionRolesBeforeMigrations(db)
  await applyMigrations(db)
  await grantAuthLookupColumnAccess(db)
  return db
}

/**
 * Grant the unprivileged application role exactly the table access the app
 * needs — mirroring a correctly provisioned production role. The role itself
 * already exists (created in createTestDb, before migrations ran).
 */
export async function createAppRole(db: PGlite): Promise<void> {
  await db.exec(`
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
  `)
}

/**
 * Switch the connection to the unprivileged app role for the remainder of the
 * session. Call after seeding (seeding legitimately needs elevated rights).
 *
 * Named `switchToAppRole` rather than `useAppRole` so it is not mistaken for a
 * React hook — by lint rules or by readers.
 */
export async function switchToAppRole(db: PGlite): Promise<void> {
  await db.exec(`SET ROLE ${APP_ROLE}`)
}

/**
 * Run `work` with tenant context set, mirroring lib/db/tenant.ts.
 *
 * This is the test-side equivalent of the production `withTenant()` helper:
 * same GUC, same set_config, same transaction scoping — so what these tests
 * prove about RLS is what the application will actually experience.
 */
export async function asTenant<T>(
  db: PGlite,
  organizationId: string,
  work: () => Promise<T>,
): Promise<T> {
  await db.query('BEGIN')
  try {
    await db.query('SELECT set_config($1, $2, true)', ['app.current_org_id', organizationId])
    const result = await work()
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

/**
 * Seed two organizations with users, then drop to the unprivileged app role.
 *
 * Seeding runs as the bootstrap superuser (which bypasses RLS) — that is the
 * legitimate equivalent of a migration/admin task. Every assertion afterwards
 * runs as {@link APP_ROLE}, where policies are actually enforced.
 */
export async function seedTwoTenants(db: PGlite) {
  await db.exec(`
    INSERT INTO "organizations" ("id", "name", "slug", "createdAt", "updatedAt")
    VALUES
      ('org_acme', 'Acme Inc', 'acme', NOW(), NOW()),
      ('org_globex', 'Globex Corp', 'globex', NOW(), NOW());

    INSERT INTO "users" ("id", "organizationId", "name", "email", "role", "createdAt", "updatedAt")
    VALUES
      ('user_acme_admin', 'org_acme', 'Acme Admin', 'admin@acme.test', 'ADMIN', NOW(), NOW()),
      ('user_acme_rep', 'org_acme', 'Acme Rep', 'rep@acme.test', 'SALES_REP', NOW(), NOW()),
      ('user_globex_admin', 'org_globex', 'Globex Admin', 'admin@globex.test', 'ADMIN', NOW(), NOW());
  `)

  await createAppRole(db)
  await switchToAppRole(db)

  return {
    acme: { organizationId: 'org_acme', adminUserId: 'user_acme_admin' },
    globex: { organizationId: 'org_globex', adminUserId: 'user_globex_admin' },
  } as const
}
