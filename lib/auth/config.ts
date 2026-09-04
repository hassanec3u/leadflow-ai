import { PrismaAdapter } from '@auth/prisma-adapter'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'

import { prisma } from '@/lib/db/prisma'
import { verifyCredentials } from '@/lib/auth/verify-credentials'
import { credentialsSignInSchema } from '@/lib/validation/auth'

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Session strategy is JWT rather than database sessions. Reason: the Next.js 16
 * `proxy` layer performs an optimistic auth check on every matched request, and
 * a JWT can be verified there without a database round trip per navigation.
 * Authoritative checks still happen server-side in the DAL (lib/auth/session.ts),
 * which is where authorization decisions are actually made.
 *
 * The JWT carries `role` as a cache for the optimistic proxy check. It is never
 * the basis of an authorization decision: lib/auth/session.ts re-reads the role
 * from the database on every request, so a token issued before a role change
 * cannot keep conferring stale privileges.
 */

// Session/JWT type augmentation lives in types/next-auth.d.ts.

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },

  /**
   * Required for any deployment that is not Vercel (which Auth.js detects
   * automatically). Without it a production server rejects every auth request
   * with `UntrustedHost`.
   *
   * The trade-off: with `trustHost`, Auth.js derives its callback URLs from the
   * incoming Host header, which a client controls. Setting AUTH_URL in
   * production pins the canonical URL so the header is not consulted — do that
   * for any internet-facing deployment (see .env.example).
   */
  trustHost: true,
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (rawCredentials) => {
        const parsed = credentialsSignInSchema.safeParse(rawCredentials)
        if (!parsed.success) {
          // Returning null (not throwing) yields a generic Auth.js failure, so
          // malformed input is indistinguishable from wrong credentials.
          return null
        }

        return verifyCredentials(parsed.data.email, parsed.data.password)
      },
    }),
  ],
  callbacks: {
    /**
     * Persist the role into the token at sign-in. On later requests it is read
     * back from the signed token rather than re-queried — but only ever as a
     * hint for the optimistic proxy check; lib/auth/session.ts is authoritative.
     */
    jwt: async ({ token, user, trigger }) => {
      if (user) {
        token.role = user.role
      }

      // Re-hydrate if the token predates the claim or the session was
      // explicitly updated (e.g. a role change).
      if ((trigger === 'update' || !token.role) && token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { role: true },
        })
        if (dbUser) {
          token.role = dbUser.role
        }
      }

      return token
    },

    session: async ({ session, token }) => {
      if (token.sub) {
        session.user.id = token.sub
      }
      if (token.role) {
        session.user.role = token.role
      }
      return session
    },
  },
})
