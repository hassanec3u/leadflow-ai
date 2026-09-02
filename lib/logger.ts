import 'server-only'

/**
 * Minimal structured server-side logger.
 *
 * Deliberately small (Phase 0 asks for a logging foundation, not an
 * observability platform). It emits one JSON object per line, which is what
 * every log aggregator ingests without configuration, and it redacts sensitive
 * keys before they can reach a log sink.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

/**
 * Keys whose values are never logged. Matched case-insensitively as a
 * substring, so `passwordHash`, `user_password`, and `AUTH_SECRET` all match.
 *
 * Redaction is applied structurally rather than by scanning message text: a
 * blanket regex over free text produces both false negatives and unreadable
 * logs, whereas callers pass structured context we can reliably clean.
 */
const REDACTED_KEY_PATTERNS = [
  'password',
  'passwordhash',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'sessiontoken',
  'accesstoken',
  'refreshtoken',
]

/**
 * Keys carrying personal data. Logged only as a presence marker, never a value
 * — enough to debug ("an email was supplied") without writing PII to logs.
 * See docs/product-spec.md §12.1 for the surrounding data-handling stance.
 */
const PII_KEY_PATTERNS = ['email', 'phone', 'slackuserid']

const REDACTED = '[redacted]'
const PII_PRESENT = '[pii:present]'

function classifyKey(key: string): 'redact' | 'pii' | 'keep' {
  const normalised = key.toLowerCase().replace(/[-_]/g, '')
  if (REDACTED_KEY_PATTERNS.some((pattern) => normalised.includes(pattern.replace(/[-_]/g, '')))) {
    return 'redact'
  }
  if (PII_KEY_PATTERNS.some((pattern) => normalised.includes(pattern))) {
    return 'pii'
  }
  return 'keep'
}

const MAX_DEPTH = 4

export function sanitizeContext(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (depth >= MAX_DEPTH) return '[truncated]'

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // Stack is kept for server-side logs (it never reaches the user; see
      // lib/errors.ts for what is returned to clients) but only in non-production
      // to limit the blast radius of a log leak.
      ...(process.env.NODE_ENV === 'production' ? {} : { stack: value.stack }),
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeContext(item, depth + 1))
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      switch (classifyKey(key)) {
        case 'redact':
          result[key] = REDACTED
          break
        case 'pii':
          result[key] = entryValue === null || entryValue === undefined ? entryValue : PII_PRESENT
          break
        default:
          result[key] = sanitizeContext(entryValue, depth + 1)
      }
    }
    return result
  }

  return value
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context ? { context: sanitizeContext(context) } : {}),
  }

  const line = JSON.stringify(entry)

  // Route through the matching console method so platform log collectors
  // (Vercel, Docker) classify severity correctly.
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export const logger = {
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
}
