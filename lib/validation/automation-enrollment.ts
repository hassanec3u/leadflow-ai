import { z } from 'zod'

import { emailSchema, leadSourceSchema, nameSchema, optionalTrimmed } from '@/lib/validation/leads'

/**
 * Validation for automatic lead capture (Phase 2B —
 * lib/services/automation-enrollment.ts).
 *
 * Deliberately excludes `ownerId`: automatic capture (e.g. a Website Form
 * submission) never comes with an owner — see docs/product-spec.md §8 and
 * the "automation does not require an owner" rule. Reuses the exact same
 * name/email normalization as manual/CSV lead creation
 * (lib/validation/leads.ts) so a duplicate is detected the same way
 * everywhere: trim + lowercase, before comparison.
 */
/**
 * Upper bound on the Website Form message.
 *
 * Generous on purpose: every character is re-sent to the AI provider on each
 * run, so an unbounded field is a direct, repeating cost. At 5000 characters
 * a submission is far past any genuine "how can we help?" answer, so refusing
 * it rejects abuse rather than a prospect. Refusing beats truncating: a
 * silent cut could remove the very sentence stating the intent and change the
 * score with nobody able to see why.
 */
export const FORM_MESSAGE_MAX_LENGTH = 5000

/**
 * Deliberately not `optionalTrimmed`: that helper leaves an empty string as
 * an empty string, and here "" and "did not fill it in" must be the same
 * fact — the model has to see `null`, not a blank it might read as an answer.
 * Changing the shared helper instead would silently alter `company`/`phone`
 * everywhere, which this change has no business doing.
 */
export const formMessageSchema = z
  .string()
  .trim()
  .max(FORM_MESSAGE_MAX_LENGTH, `Message must be ${FORM_MESSAGE_MAX_LENGTH} characters or fewer.`)
  .nullish()
  .transform((value) => (value == null || value === '' ? null : value))

export const automaticLeadCaptureSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  company: optionalTrimmed(200),
  phone: optionalTrimmed(40),
  /**
   * Website Form only in practice: manual and CSV leads never reach this
   * schema (they go through lib/validation/leads.ts), and never auto-enroll.
   */
  formMessage: formMessageSchema,
  source: leadSourceSchema,
})
export type AutomaticLeadCaptureInput = z.infer<typeof automaticLeadCaptureSchema>
