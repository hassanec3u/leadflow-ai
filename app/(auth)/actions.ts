'use server'

import { AuthError } from 'next-auth'
import { unstable_rethrow } from 'next/navigation'

import { signIn } from '@/lib/auth/config'
import { GENERIC_ERROR_MESSAGE } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { credentialsSignInSchema } from '@/lib/validation/auth'

/**
 * Server actions for authentication.
 *
 * These are thin: parse input, delegate to a service, map failures to a
 * user-safe message. Business logic lives in lib/services.
 */

export type AuthActionState = {
  message?: string
  fieldErrors?: Record<string, string[]>
}

/**
 * `redirect()` (and Auth.js's own redirect on success) works by throwing.
 * `unstable_rethrow` re-throws those Next.js control-flow signals so a generic
 * catch block cannot swallow them and turn a successful sign-in into an error
 * message. It is the supported API for this despite the name.
 */

export async function signInAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = credentialsSignInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return {
      message: 'Check the details below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    }
  }

  const rawCallback = formData.get('callbackUrl')
  // Only same-site relative paths are accepted, so a crafted callbackUrl cannot
  // turn the login form into an open redirect to an attacker's domain.
  const callbackUrl =
    typeof rawCallback === 'string' && rawCallback.startsWith('/') && !rawCallback.startsWith('//')
      ? rawCallback
      : '/dashboard'

  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: callbackUrl,
    })
  } catch (error) {
    unstable_rethrow(error)

    if (error instanceof AuthError) {
      // Deliberately uniform: never reveal whether the email exists.
      return { message: 'Incorrect email or password.' }
    }

    logger.error('Unexpected sign-in failure', { error })
    return { message: GENERIC_ERROR_MESSAGE }
  }

  return {}
}
