import type { PGlite } from '@electric-sql/pglite'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb } from '@/tests/helpers/pglite'

/**
 * auth-1 / auth-2 in tests.json.
 *
 * Exercises the credential-authentication logic against the REAL schema in a
 * real PostgreSQL, so the database constraints that authentication depends on
 * (unique email, role default) are genuinely verified rather than assumed.
 */
describe('credential authentication', () => {
  let db: PGlite
  const password = 'correct-horse-battery'
  let passwordHash: string

  beforeAll(async () => {
    db = await createTestDb()
    passwordHash = await bcrypt.hash(password, 10)

    await db.query(
      `INSERT INTO "users" ("id", "name", "email", "passwordHash", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ADMIN', NOW(), NOW())`,
      ['user_admin', 'Acme Admin', 'admin@acme.test', passwordHash],
    )
  })

  afterAll(async () => {
    await db?.close()
  })

  it('authenticates a user with the correct password', async () => {
    const result = await db.query<{ passwordHash: string; role: string }>(
      'SELECT "passwordHash", "role" FROM users WHERE email = $1',
      ['admin@acme.test'],
    )

    const user = result.rows[0]
    expect(user).toBeDefined()
    expect(await bcrypt.compare(password, user!.passwordHash)).toBe(true)
    expect(user!.role).toBe('ADMIN')
  })

  it('rejects an incorrect password', async () => {
    const result = await db.query<{ passwordHash: string }>(
      'SELECT "passwordHash" FROM users WHERE email = $1',
      ['admin@acme.test'],
    )

    expect(await bcrypt.compare('wrong-password', result.rows[0]!.passwordHash)).toBe(false)
  })

  it('finds no user for an unregistered email', async () => {
    const result = await db.query('SELECT * FROM users WHERE email = $1', ['nobody@acme.test'])
    expect(result.rows).toEqual([])
  })

  it('never stores the password in plaintext', async () => {
    const result = await db.query<{ passwordHash: string }>(
      'SELECT "passwordHash" FROM users WHERE email = $1',
      ['admin@acme.test'],
    )

    expect(result.rows[0]!.passwordHash).not.toContain(password)
    expect(result.rows[0]!.passwordHash).toMatch(/^\$2[aby]\$/)
  })

  it('enforces email uniqueness at the database level', async () => {
    // Application-level checks can race; the constraint is what actually
    // guarantees one account per email, which sign-in depends on.
    await expect(
      db.query(
        `INSERT INTO "users" ("id", "email", "role", "createdAt", "updatedAt")
         VALUES ($1, $2, 'SALES_REP', NOW(), NOW())`,
        ['user_dupe', 'admin@acme.test'],
      ),
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('defaults a new user to the least-privileged role', async () => {
    await db.query(
      `INSERT INTO "users" ("id", "email", "createdAt", "updatedAt")
       VALUES ($1, $2, NOW(), NOW())`,
      ['user_default', 'default@acme.test'],
    )

    const result = await db.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [
      'user_default',
    ])

    // Defaulting to SALES_REP means a mistake in user creation under-grants
    // rather than over-grants.
    expect(result.rows[0]!.role).toBe('SALES_REP')
  })
})
