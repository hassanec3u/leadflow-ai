/**
 * Application error taxonomy.
 *
 * The central rule: an AppError carries a message that is SAFE to show a user.
 * Anything sensitive (query text, stack, upstream provider detail) goes in
 * `logContext`, which is logged server-side and never serialised to a client.
 * That split is what keeps internal detail out of HTTP responses by
 * construction rather than by remembering to sanitise at each call site.
 */

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  /** Server-side only. Never included in a client response. */
  readonly logContext: Record<string, unknown> | undefined
  /** Field-level messages for form/API validation failures. */
  readonly fieldErrors: Record<string, string[]> | undefined

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      logContext?: Record<string, unknown>
      fieldErrors?: Record<string, string[]>
      cause?: unknown
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.logContext = options?.logContext
    this.fieldErrors = options?.fieldErrors
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You must be signed in to do that.', logContext?: Record<string, unknown>) {
    super('UNAUTHENTICATED', message, { logContext })
    this.name = 'UnauthenticatedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to do that.',
    logContext?: Record<string, unknown>,
  ) {
    super('FORBIDDEN', message, { logContext })
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.', logContext?: Record<string, unknown>) {
    super('NOT_FOUND', message, { logContext })
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends AppError {
  constructor(
    message = 'Some of the information provided is not valid.',
    fieldErrors?: Record<string, string[]>,
    logContext?: Record<string, unknown>,
  ) {
    super('VALIDATION_FAILED', message, { fieldErrors, logContext })
    this.name = 'ValidationError'
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something that already exists.') {
    super('CONFLICT', message)
    this.name = 'ConflictError'
  }
}

/**
 * The generic message shown for any non-AppError. Unknown failures are never
 * described to the user, because their messages routinely contain connection
 * strings, SQL, and upstream provider detail.
 */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

/** The client-safe shape returned by API routes and surfaced in the UI. */
export type ClientErrorBody = {
  error: {
    code: ErrorCode
    message: string
    fieldErrors?: Record<string, string[]>
  }
}

/**
 * Convert any thrown value into a client-safe body plus an HTTP status.
 * Unknown errors collapse to a generic 500 — deliberately losing detail.
 */
export function toClientError(error: unknown): { status: number; body: ClientErrorBody } {
  if (isAppError(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
      },
    }
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: GENERIC_ERROR_MESSAGE } },
  }
}
