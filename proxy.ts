import { NextResponse } from 'next/server'

import { auth } from '@/lib/auth/config'

/**
 * Next.js 16 renamed `middleware` to `proxy` (the named export must be `proxy`
 * too). The proxy runtime is Node.js and is not configurable.
 *
 * This performs an OPTIMISTIC auth check only: it redirects obviously
 * unauthenticated traffic away from application routes so users get a clean
 * redirect instead of a flash of protected chrome.
 *
 * It is NOT the authorization boundary. Per the Next.js App Router auth
 * guidance, authoritative checks live in the Data Access Layer
 * (lib/auth/session.ts), which every protected page and action calls. Treating
 * the proxy as the security boundary is a known anti-pattern — it does not run
 * for every data path.
 */

const PUBLIC_ROUTES = new Set(['/', '/login', '/signup'])

export default auth((request) => {
  const { pathname } = request.nextUrl
  const isAuthenticated = Boolean(request.auth?.user)

  if (PUBLIC_ROUTES.has(pathname)) {
    // Signed-in users landing on marketing/auth pages go straight to the app.
    if (isAuthenticated && pathname !== '/') {
      return NextResponse.redirect(new URL('/dashboard', request.nextUrl))
    }
    return NextResponse.next()
  }

  if (!isAuthenticated) {
    const loginUrl = new URL('/login', request.nextUrl)
    // Preserve the intended destination so login can return the user to it.
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
})

/**
 * Machine-facing routes, excluded from the matcher below.
 *
 * These are called by systems that have no application session and never
 * will: an anonymous third-party Website Form, and Inngest's own servers.
 * Left inside the matcher they receive the optimistic redirect meant for
 * pages — a 307 to /login — so the handler is never reached at all. That is
 * not a theoretical risk: it was observed end to end, and it silently
 * disabled both public lead capture and every pipeline execution.
 *
 * Excluding them here rather than adding them to PUBLIC_ROUTES is deliberate:
 * that branch redirects an AUTHENTICATED caller to /dashboard, which would
 * break the same routes in the opposite direction as soon as a request
 * happened to carry a session cookie.
 *
 * Neither route becomes unauthenticated — each keeps its own, stronger
 * mechanism:
 *   - /api/webhooks/lead-capture verifies a per-organization capture secret
 *     and resolves the tenant from it (lib/auth/form-capture-lookup.ts);
 *   - /api/inngest verifies Inngest's request signature via INNGEST_SIGNING_KEY.
 *
 * Listed one path at a time on purpose. A blanket `api` exclusion would also
 * unprotect every future application API route, which is exactly the mistake
 * this comment exists to prevent.
 *
 * The pattern below MUST stay a single static string literal: Next parses
 * `matcher` at compile time and rejects anything computed (a template literal
 * built from an array is enough to make it refuse the whole config and 500
 * every route). Hence the repetition instead of a named list.
 */
export const config = {
  /**
   * Skip machine-facing routes — `api/auth` (must stay reachable while signed
   * out), `api/inngest` and `api/webhooks/lead-capture` (see above) — plus
   * Next internals and static assets.
   */
  matcher: [
    '/((?!api/auth|api/inngest|api/webhooks/lead-capture|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
