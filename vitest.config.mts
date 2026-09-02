import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Two projects, because they need different environments:
 *
 *  - `node`  — logic, security and database/RLS tests. Runs in Node so it can
 *              use PGlite (real PostgreSQL compiled to WASM) for the tenant
 *              isolation proofs.
 *  - `jsdom` — component tests.
 *
 * `server-only` is aliased to an empty module: it exists to make Next.js fail
 * the build if server code is imported client-side, and it throws when loaded
 * by a plain test runner. Aliasing it lets us unit test server modules while
 * keeping the real guard in the application build.
 *
 * This file is `.mts` so Vite's native config loader reads it as ESM.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Native replacement for the vite-tsconfig-paths plugin; resolves "@/*".
    tsconfigPaths: true,
    alias: {
      'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/{unit,integration}/**/*.test.ts'],
          setupFiles: ['./tests/setup/node.ts'],
          // PGlite boots a Postgres instance per suite; the default 5s timeout
          // is not enough for first boot plus migrations.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/components/**/*.test.tsx'],
          setupFiles: ['./tests/setup/jsdom.ts'],
        },
      },
    ],
  },
})
