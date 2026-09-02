import { describe, expect, it } from 'vitest'

import {
  AppError,
  ForbiddenError,
  GENERIC_ERROR_MESSAGE,
  UnauthenticatedError,
  ValidationError,
  toClientError,
} from '@/lib/errors'

/**
 * The security-relevant property here: internal detail must never reach a
 * client response. Phase 0 requirement — "do not expose internal stack traces
 * or secrets to users".
 */
describe('error serialisation', () => {
  it('maps error types to the right HTTP status', () => {
    expect(toClientError(new UnauthenticatedError()).status).toBe(401)
    expect(toClientError(new ForbiddenError()).status).toBe(403)
    expect(toClientError(new ValidationError()).status).toBe(422)
  })

  it('never leaks the message of an unknown error', () => {
    const leaky = new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.5:5432')
    const { status, body } = toClientError(leaky)

    expect(status).toBe(500)
    expect(body.error.message).toBe(GENERIC_ERROR_MESSAGE)
    expect(JSON.stringify(body)).not.toContain('hunter2')
    expect(JSON.stringify(body)).not.toContain('10.0.0.5')
  })

  it('never serialises the server-side logContext of an AppError', () => {
    const error = new ForbiddenError('You do not have permission to do that.', {
      internalReason: 'role=SALES_REP required ADMIN',
      userId: 'user_123',
    })

    const serialised = JSON.stringify(toClientError(error).body)

    expect(serialised).not.toContain('internalReason')
    expect(serialised).not.toContain('user_123')
  })

  it('passes through field errors so forms can show them', () => {
    const error = new ValidationError('Check the details below.', {
      email: ['Enter a valid email address'],
    })

    const { body } = toClientError(error)
    expect(body.error.fieldErrors?.email).toEqual(['Enter a valid email address'])
  })

  it('exposes a safe message for a deliberate AppError', () => {
    const { body } = toClientError(new AppError('CONFLICT', 'That email is already registered.'))
    expect(body.error.message).toBe('That email is already registered.')
    expect(body.error.code).toBe('CONFLICT')
  })
})
