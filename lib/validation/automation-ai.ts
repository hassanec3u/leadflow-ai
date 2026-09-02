import { z } from 'zod'

/**
 * Schema validation for AI qualification output (Phase 2C).
 *
 * The pipeline never parses free-form model text and never invents a score
 * (docs/product-spec.md §9, architecture.md §5). Output that does not match
 * this shape is a step FAILURE — `Lead.aiScore` stays null and the lead is
 * left for manual review, rather than defaulting to 0 or a guess.
 */
export const aiQualificationOutputSchema = z.object({
  /**
   * Any finite number is accepted here and then normalized (rounded, clamped
   * to 0–100) by `normalizeAiScore`. Clamping a 105 to 100 is normalization
   * of a value the model DID return; inventing a value it did not return is
   * what the "never guess" rule forbids. A missing/NaN/non-numeric score is
   * malformed and fails.
   */
  score: z.number().finite(),
  summary: z.string().trim().min(1).max(4000),
  keywords: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
  recommendedAction: z.string().trim().min(1).max(1000),
  /** Optional provider telemetry, stored for cost tracking (architecture.md §7). */
  model: z.string().max(200).optional(),
  promptVersion: z.string().max(50).optional(),
  tokenUsage: z.number().int().nonnegative().optional(),
  /**
   * Input/output split of `tokenUsage`. Added in Phase 2D-2 because the
   * OpenAI Responses API reports all three separately and they price
   * differently, so a single total cannot reconstruct cost. Optional like the
   * rest of the telemetry: a provider that cannot report usage simply omits
   * them, and nothing downstream requires them.
   *
   * These are attached by the PROVIDER from the API response — never by the
   * model itself, which is only ever asked for the four qualification fields.
   */
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})

export type AiQualificationOutput = z.infer<typeof aiQualificationOutputSchema>

export const AI_SCORE_MIN = 0
export const AI_SCORE_MAX = 100

export function normalizeAiScore(score: number): number {
  return Math.min(AI_SCORE_MAX, Math.max(AI_SCORE_MIN, Math.round(score)))
}

export type ParsedAiQualification = Omit<AiQualificationOutput, 'score'> & {
  score: number
  /** True when the raw score fell outside 0–100 and was clamped. */
  clamped: boolean
}

/** Returns null when the payload is malformed — the caller turns that into a step failure. */
export function parseAiQualificationOutput(raw: unknown): ParsedAiQualification | null {
  const parsed = aiQualificationOutputSchema.safeParse(raw)
  if (!parsed.success) return null

  const score = normalizeAiScore(parsed.data.score)
  return { ...parsed.data, score, clamped: score !== parsed.data.score }
}
