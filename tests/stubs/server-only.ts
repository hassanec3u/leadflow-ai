/**
 * Test stub for the `server-only` package.
 *
 * The real package throws when imported outside a React Server Component,
 * which is exactly the guard we want in the application build — but it makes
 * server modules untestable in a plain Node test runner. vitest.config.ts
 * aliases the package here so tests can import server modules directly.
 *
 * This does NOT weaken the production guard: the alias applies only under Vitest.
 */
export {}
