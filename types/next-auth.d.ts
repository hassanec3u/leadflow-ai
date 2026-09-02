import type { DefaultSession } from 'next-auth'

import type { Role } from '@/lib/auth/rbac'

/**
 * Auth.js type augmentation.
 *
 * Kept in a dedicated declaration file (rather than inline in lib/auth/config.ts)
 * because `declare module 'next-auth/jwt'` only resolves when the module is
 * imported in the same file — and importing it purely to satisfy the augmenter
 * inside application code is noise.
 *
 * These claims are what carry tenant identity through the session. They are
 * still verified against the database on every request (lib/auth/session.ts);
 * the token is a cache, not the source of truth.
 */

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      organizationId: string
      role: Role
    } & DefaultSession['user']
  }

  interface User {
    organizationId?: string
    role?: Role
  }
}

/**
 * Augment `@auth/core/jwt`, not `next-auth/jwt`.
 *
 * `next-auth/jwt` is only `export * from "@auth/core/jwt"`, and augmenting a
 * re-exporting module does not merge into the original interface — the
 * callback's `token` would stay untyped (`{}`). The core module is where the
 * JWT interface actually lives.
 */
declare module '@auth/core/jwt' {
  interface JWT {
    organizationId?: string
    role?: Role
  }
}

export {}
