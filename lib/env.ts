import 'server-only'

import { z } from 'zod'

/**
 * Typed, validated server environment.
 *
 * Phase 0 contract (see docs/architecture.md §11):
 *   - REQUIRED vars fail fast and loudly at startup. A misconfigured deployment
 *     should refuse to boot rather than fail later at an unpredictable point.
 *   - OPTIONAL integration credentials (OpenAI, Airtable, Slack, email) are
 *     declared here so the configuration architecture exists now, but the
 *     application MUST start without them. Those integrations belong to
 *     Phase 3-5; requiring them in Phase 0 would make the app unbootable for
 *     no benefit.
 *
 * `server-only` makes importing this from a Client Component a build error, so
 * secrets cannot be pulled into the browser bundle by accident.
 */
const serverEnvSchema = z.object({
  // --- Required -----------------------------------------------------------
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string',
    ),

  /**
   * Auth.js signing/encryption secret. Auth.js reads AUTH_SECRET from the
   * environment itself; we validate it here so a missing value is reported at
   * startup with a clear message instead of surfacing as an opaque auth error.
   */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),

  // --- Environment --------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Canonical application URL. Optional in development (Auth.js infers it) and
   * on Vercel (derived from VERCEL_URL), which is why this is not required.
   */
  AUTH_URL: z.string().url().optional(),

  /**
   * Inngest (Phase 2C workflow engine). Both are optional: the local dev
   * server needs neither, and the app must still boot without them — an
   * unconfigured deployment simply cannot dispatch runs, which the pending-run
   * reconciler surfaces rather than hiding. INNGEST_SIGNING_KEY is what makes
   * `/api/inngest` safe in production: it verifies requests really come from
   * Inngest.
   */
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),

  /**
   * Shared secret authenticating the public Website Form capture endpoint
   * (`POST /api/webhooks/lead-capture`).
   *
   * Optional so the app boots without it, but the consequence is deliberate and
   * safe: with no secret configured the endpoint can authenticate nobody and
   * rejects every request. That mirrors the behaviour this replaced, where an
   * organization that had never been issued a capture secret simply could not
   * be resolved by a submission.
   *
   * Minimum 32 characters because the intended value is CSPRNG output, not a
   * chosen password — generate with `openssl rand -hex 32`.
   */
  FORM_CAPTURE_SECRET: z
    .string()
    .min(32, 'FORM_CAPTURE_SECRET must be at least 32 characters')
    .optional(),

  // --- Optional integrations (Phase 3-5). Absent => feature simply off. ----
  OPENAI_API_KEY: z.string().min(1).optional(),
  /**
   * Qualification model. Optional with a default so a configured deployment
   * needs only the API key, while the model can still be rolled forward
   * without a code change (docs/architecture.md §7).
   */
  OPENAI_QUALIFICATION_MODEL: z.string().min(1).default('gpt-5'),
  /** Apollo.io enrichment (Phase 2D-4). Absent => enrichment step is skipped. */
  APOLLO_API_KEY: z.string().min(1).optional(),
  /**
   * Prospeo enrichment (Phase 2D-6). An alternative to Apollo, not a
   * replacement: both may be configured, and the registry documents which one
   * fills the single enrichment slot.
   */
  PROSPEO_API_KEY: z.string().min(1).optional(),
  AIRTABLE_API_KEY: z.string().min(1).optional(),
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  EMAIL_PROVIDER_API_KEY: z.string().min(1).optional(),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

function formatIssues(error: z.ZodError<unknown>): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

function loadEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env)

  if (!parsed.success) {
    // Only variable NAMES and messages are printed — never values, so a
    // malformed secret cannot be leaked into logs by the validator itself.
    throw new Error(
      `Invalid server environment configuration:\n${formatIssues(parsed.error)}\n\n` +
        'See .env.example for the expected variables.',
    )
  }

  return parsed.data
}

let cached: ServerEnv | undefined

/**
 * Validated environment accessor.
 *
 * Lazy + cached rather than validated at module load, so that importing a
 * module which transitively touches env (a test helper, a script) does not
 * explode before the caller has had a chance to arrange configuration.
 */
export function getEnv(): ServerEnv {
  cached ??= loadEnv()
  return cached
}

/** Which optional integrations are currently configured. */
export function getIntegrationAvailability() {
  const env = getEnv()
  return {
    openai: Boolean(env.OPENAI_API_KEY),
    airtable: Boolean(env.AIRTABLE_API_KEY),
    slack: Boolean(env.SLACK_BOT_TOKEN),
    email: Boolean(env.EMAIL_PROVIDER_API_KEY),
  } as const
}

/** Test-only: clears the memoised env so a test can re-validate. */
export function resetEnvCacheForTests(): void {
  cached = undefined
}

/** Exported for unit tests that validate the schema without touching process.env. */
export const __serverEnvSchema = serverEnvSchema
