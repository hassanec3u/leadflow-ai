import 'server-only'

/**
 * Minimal fixed-window rate limiter (Phase 2E-2).
 *
 * Required by docs/architecture.md §132: the public lead-capture endpoint is
 * "rate-limited per API key/source IP", because every accepted lead can
 * trigger a paid enrichment call and a paid OpenAI call — sustained abuse is a
 * direct cost vector, not only a security one.
 *
 * =============================================================================
 * KNOWN LIMITATION — READ BEFORE RELYING ON THIS
 * =============================================================================
 * State lives in this process's memory. That means:
 *
 *  - **Multi-instance deployments do not share counters.** With N instances
 *    behind a load balancer the effective limit is up to N x the configured
 *    limit, since each instance counts only what it sees.
 *  - Counters reset on deploy/restart.
 *  - Serverless environments may hold several warm instances per region, with
 *    the same consequence.
 *
 * This is deliberate: the project has no Redis and no shared cache, and
 * introducing that infrastructure was explicitly out of scope for this phase.
 * A single-instance deployment is fully protected; a multi-instance one gets
 * proportional — not exact — protection, which is still the difference between
 * "bounded" and "unbounded" cost exposure. Replacing the store below with a
 * shared one is a contained change: nothing outside this file knows how the
 * counters are kept.
 */

type Window = { count: number; resetAt: number }

const windows = new Map<string, Window>()

export type RateLimitOptions = {
  limit: number
  windowMs: number
  /** Injectable clock so tests never depend on wall time. */
  now?: () => number
}

export type RateLimitResult = {
  allowed: boolean
  /** Seconds until the window resets — suitable for a Retry-After header. */
  retryAfterSeconds: number
}

/**
 * Count one hit against `bucket`.
 *
 * `bucket` must never be a raw credential: callers pass an opaque key (a
 * resolved organization id, or a hashed/derived client identifier), so a
 * secret can never end up in this map, in a heap dump, or in a log line.
 */
export function checkRateLimit(bucket: string, options: RateLimitOptions): RateLimitResult {
  const now = options.now?.() ?? Date.now()
  const existing = windows.get(bucket)

  if (!existing || now >= existing.resetAt) {
    windows.set(bucket, { count: 1, resetAt: now + options.windowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  existing.count += 1

  if (existing.count > options.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    }
  }

  return { allowed: true, retryAfterSeconds: 0 }
}

/**
 * Drop expired windows. Called opportunistically so the map cannot grow
 * without bound under a spray of distinct keys.
 */
export function pruneRateLimitWindows(now = Date.now()): void {
  for (const [bucket, window] of windows) {
    if (now >= window.resetAt) windows.delete(bucket)
  }
}

/** Test-only: clears all counters. */
export function resetRateLimitsForTests(): void {
  windows.clear()
}
