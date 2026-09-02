import { describe, expect, it, vi } from 'vitest'

/**
 * proxy.ts pulls in next-auth and `next/server`, neither of which resolves in
 * the node test environment. Both are stubbed purely to make the module
 * loadable — the assertions below read `config.matcher`, a plain exported
 * constant that neither stub touches, so the pattern under test is the one
 * that actually ships.
 */
vi.mock('next/server', () => ({ NextResponse: { next: () => null, redirect: () => null } }))
vi.mock('@/lib/auth/config', () => ({
  auth: (handler: unknown) => handler,
}))

const { config } = await import('@/proxy')

/**
 * Phase 2E-3 — which paths the auth proxy runs on.
 *
 * This asserts against the REAL `config.matcher` exported by proxy.ts, not a
 * copy: the machine routes are excluded there rather than inside the handler,
 * so the matcher is where the behaviour actually lives and a test that
 * re-declared the pattern would prove nothing.
 *
 * A path the matcher does NOT match is a path the proxy never runs for — so
 * it can never receive the optimistic 307 to /login. Each such route keeps
 * its own authentication: the capture secret for lead-capture, Inngest's
 * request signature for /api/inngest, Auth.js itself for /api/auth.
 *
 * LIMITATION, stated rather than papered over: Next.js compiles the matcher
 * string itself, and this test evaluates the same pattern with `RegExp`. That
 * matches for the plain pathname shapes asserted below, but it is a faithful
 * re-evaluation, not Next's own compiler. The authoritative proof is the live
 * HTTP probe recorded in the phase report (anonymous request -> 401 from the
 * handler, not 307 to /login). Standing up a Next server inside Vitest to get
 * closer would be a whole test infrastructure for one config line.
 */

const pattern = config.matcher[0]

/** True when the proxy WOULD run for this path. */
function proxyRunsFor(pathname: string): boolean {
  return new RegExp(`^${pattern}$`).test(pathname)
}

describe('machine routes bypass the auth proxy', () => {
  it.each(['/api/webhooks/lead-capture', '/api/inngest'])(
    'does not run the proxy for %s',
    (pathname) => {
      // If this ever flips to true, anonymous callers get 307 -> /login and
      // both public capture and pipeline execution stop working.
      expect(proxyRunsFor(pathname)).toBe(false)
    },
  )

  it('still excludes the Auth.js routes, which must work while signed out', () => {
    expect(proxyRunsFor('/api/auth/session')).toBe(false)
    expect(proxyRunsFor('/api/auth/callback/credentials')).toBe(false)
  })
})

describe('application routes stay protected', () => {
  it.each(['/dashboard', '/leads', '/automation', '/automation/runs', '/settings'])(
    'still runs the proxy for %s',
    (pathname) => {
      expect(proxyRunsFor(pathname)).toBe(true)
    },
  )

  it('does not blanket-exclude /api — a future API route is protected by default', () => {
    // The fix lists one path at a time precisely so this stays true.
    expect(proxyRunsFor('/api/other')).toBe(true)
    expect(proxyRunsFor('/api/webhooks/something-else')).toBe(true)
  })

  it('excludes only the exact capture path, not its parent segment', () => {
    expect(proxyRunsFor('/api/webhooks')).toBe(true)
  })
})
