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

export const signUpSchema = z.object({
  name: z.string().min(1, 'Your name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z
    .string()
    .min(1, 'Organization name is required')
    .max(120, 'Organization name is too long'),
})

export type SignUpInput = z.infer<typeof signUpSchema>
export type CredentialsSignInInput = z.infer<typeof credentialsSignInSchema>

/**
 * Derive a URL-safe organization slug.
 *
 * Exported (and unit-tested) rather than inlined because slug collisions are a
 * real failure mode at signup and the rules deserve to be pinned by tests.
 */
export function slugifyOrganizationName(name: string): string {
  const base = name
    .normalize('NFKD')
    // Strip diacritics so "Café" and "Cafe" produce the same readable slug.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  // A name consisting entirely of non-latin characters can slugify to empty;
  // fall back so the unique constraint is never asked to store "".
  return base || 'org'
}
