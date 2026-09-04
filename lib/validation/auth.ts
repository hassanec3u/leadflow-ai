import { z } from 'zod'

/**
 * Validation schemas for authentication input.
 *
 * Kept free of `server-only` because Auth.js configuration and (later) client
 * form validation both consume these. They contain no secrets.
 */

export const emailSchema = z
  .string()
  .min(1, 'Email is required')
  .email('Enter a valid email address')
  .max(320, 'Email is too long')
  .transform((value) => value.trim().toLowerCase())

/**
 * Password policy: length only.
 *
 * A 12-character minimum with no composition rules (no "must contain a
 * symbol") follows current NIST guidance — composition rules push users toward
 * predictable substitutions without adding real entropy.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters')

export const credentialsSignInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
})

/**
 * Shape of an operator-provisioned account (prisma/seed.ts). There is no public
 * sign-up: accounts are created deliberately, so `role` is an explicit input
 * rather than something defaulted into by whoever registers first.
 */
export const createUserSchema = z.object({
  name: z.string().min(1, 'Your name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_REP']),
})

export type CreateUserInput = z.infer<typeof createUserSchema>
export type CredentialsSignInInput = z.infer<typeof credentialsSignInSchema>
