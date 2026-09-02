import 'server-only'

import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { ValidationError, isAppError, toClientError } from '@/lib/errors'
import { logger } from '@/lib/logger'

/**
 * Uniform error handling for Route Handlers.
 *
 * Wrapping handlers here means every API route returns the same client-safe
 * error envelope and logs the same way, instead of each route inventing its
 * own — which is how internal detail leaks into responses.
 */
export function apiError(error: unknown): NextResponse {
  // A Zod error escaping to the boundary is a validation failure; convert it so
  // the caller gets field-level messages rather than an opaque 500.
  const normalised =
    error instanceof ZodError
      ? new ValidationError(
          'Some of the information provided is not valid.',
          error.flatten().fieldErrors as Record<string, string[]>,
        )
      : error

  const { status, body } = toClientError(normalised)

  if (isAppError(normalised)) {
    // Expected, handled conditions: log at warn with their safe context.
    logger.warn('Request failed', {
      code: normalised.code,
      status,
      ...(normalised.logContext ?? {}),
    })
  } else {
    // Unexpected: log the real error server-side, return a generic body.
    logger.error('Unhandled request error', { error: normalised })
  }

  return NextResponse.json(body, { status })
}

/** Wrap a Route Handler so thrown errors become safe responses. */
export function withApiErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse> | NextResponse,
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args)
    } catch (error) {
      return apiError(error)
    }
  }
}
