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
 * The JWT carries organizationId and role so that tenant context is derived
 * from the signed session and never from client input.
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

        // The pre-authentication lookup inside verifyCredentials() is the one
        // deliberate, narrowly-scoped exception to users' tenant RLS policy —
        // see lib/auth/auth-lookup.ts for the full security rationale.
        return verifyCredentials(parsed.data.email, parsed.data.password)
      },
    }),
  ],
  callbacks: {
    /**
     * Persist tenant identity into the token at sign-in. On later requests the
     * values are read back from the signed token rather than re-queried.
     */
    jwt: async ({ token, user, trigger }) => {
      if (user) {
        token.organizationId = user.organizationId
        token.role = user.role
      }

      // Re-hydrate from the database if the token predates these claims or the
      // session was explicitly updated (e.g. a role change).
      //
      // KNOWN GAP (out of scope for the auth-lookup fix in lib/auth/auth-lookup.ts,
      // left as-is deliberately): this read also uses the unscoped `prisma`
      // client with no tenant context, so under RLS it likewise returns
      // nothing. In practice this branch only runs when `!token.organizationId`
      // (a token that predates this field, or was somehow issued without it)
      // or on an explicit `session.update()` call — neither happens in Phase 0's
      // normal sign-in flow, where `token.organizationId` is always set at
      // initial sign-in from the already-tenant-known `user` object above. If
      // this ever needs to be load-bearing, it should get its own narrow fix
      // (e.g. `withTenant` once organizationId is already on the token) rather
      // than widening the SECURITY DEFINER exception designed for the email
      // lookup, which must stay scoped to exactly that one query.
      if ((trigger === 'update' || !token.organizationId) && token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { organizationId: true, role: true },
        })
        if (dbUser) {
          token.organizationId = dbUser.organizationId
          token.role = dbUser.role
        }
      }

      return token
    },

    session: async ({ session, token }) => {
      if (token.sub) {
        session.user.id = token.sub
      }
      if (token.organizationId) {
        session.user.organizationId = token.organizationId
      }
      if (token.role) {
        session.user.role = token.role
      }
      return session
    },
  },
})
