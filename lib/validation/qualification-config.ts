import { z } from 'zod'

/**
 * Validation for an organization's qualification configuration.
 *
 * What an admin may set is deliberately narrow: WHO they sell to (`icp`), some
 * extra guidance (`instructions`), and WHERE the bar sits (`threshold`). The
 * system prompt — the scoring rules, the output contract, and above all the
 * security rules — is not editable and is not represented here. Letting an
 * admin rewrite those would let them delete the prompt-injection defence, or
 * break the strict output schema and send every lead to manual review.
 */

/** Both caps bound what is re-sent to the AI provider on every single run. */
export const ICP_MAX_LENGTH = 5000
export const INSTRUCTIONS_MAX_LENGTH = 3000

/** The default bar, unchanged from the constant the pipeline shipped with. */
export const DEFAULT_QUALIFICATION_THRESHOLD = 70

export const qualificationConfigSchema = z.object({
  icp: z
    .string()
    .trim()
    .min(1, 'Describe your ideal customer profile.')
    .max(ICP_MAX_LENGTH, `The ICP must be ${ICP_MAX_LENGTH} characters or fewer.`),
  /** Optional: an organization may have nothing to add beyond its ICP. */
  instructions: z
    .string()
    .trim()
    .max(
      INSTRUCTIONS_MAX_LENGTH,
      `Instructions must be ${INSTRUCTIONS_MAX_LENGTH} characters or fewer.`,
    )
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value)),
  threshold: z.coerce
    .number()
    .int('The threshold must be a whole number.')
    .min(0, 'The threshold must be between 0 and 100.')
    .max(100, 'The threshold must be between 0 and 100.'),
})

export type QualificationConfigInput = z.infer<typeof qualificationConfigSchema>

/**
 * The seed configuration for an organization that has never saved one.
 *
 * Deliberately generic: it must not describe a business LeadFlow knows
 * nothing about. It states only what the product itself assumes — a B2B buyer
 * — and leaves the specifics for an admin to write.
 *
 * Lives here, with the other pure constants, so both the admin service and the
 * session-free run path can read it without either importing the other.
 */
export const DEFAULT_ICP =
  'A business that plausibly buys B2B software: a real company (not a personal ' +
  'address, student or job seeker), of a size and industry where our product is ' +
  'useful, with a contact who has some influence over buying decisions.'
