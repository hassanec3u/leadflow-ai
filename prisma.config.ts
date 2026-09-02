import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * Prisma 7 configuration.
 *
 * The datasource URL lives here (not in schema.prisma, where Prisma 7 no longer
 * allows it) and is used by CLI commands: migrate, db push, introspect.
 *
 * At application runtime the URL is supplied instead through the `pg` driver
 * adapter in lib/db/prisma.ts — see docs/architecture.md §11.
 *
 * DATABASE_URL is intentionally read directly here rather than through
 * lib/env.ts: this file is loaded by the Prisma CLI outside the Next.js
 * runtime, where the app's env module (and its `server-only` guard) is not
 * appropriate. Absence is reported by the CLI itself.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
