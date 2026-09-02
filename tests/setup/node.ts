/**
 * Node test environment setup.
 *
 * Provides the environment variables lib/env.ts requires, so importing a
 * server module in a test does not fail validation. These are obviously fake
 * values — no test connects to a real database with them (database tests use
 * PGlite, see tests/helpers/pglite.ts).
 */
// NODE_ENV is typed readonly by @types/node; Vitest already sets it to "test".
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/leadflow_test?schema=public'
process.env.AUTH_SECRET ??= 'test-secret-value-at-least-32-characters-long'
