import { config as loadDotenv } from 'dotenv'
import { describe, expect, it } from 'vitest'

/**
 * Phase 2D-5 — real-provider smoke test (Apollo → OpenAI).
 *
 * OPT-IN ONLY. Gated behind RUN_PROVIDER_SMOKE=1 so the normal suite never
 * makes a network call, never spends Apollo credits and never spends OpenAI
 * tokens. Run it deliberately:
 *
 *   RUN_PROVIDER_SMOKE=1 npx vitest run tests/integration/provider-smoke.test.ts --project node
 *
 * It calls the REAL providers through their existing factories, so nothing
 * here bypasses a contract. Lead fixtures are in-memory only — nothing is
 * written to PostgreSQL. Secrets are never read into the output: the test
 * asserts only on the PRESENCE of a key, never its value.
 */

// The test setup provides fake DATABASE_URL/AUTH_SECRET but not the vendor
// keys, so .env has to be loaded before any factory calls getEnv().
loadDotenv()

const ENABLED = process.env.RUN_PROVIDER_SMOKE === '1'

type SmokeLead = {
  label: string
  lead: {
    id: string
    name: string
    email: string
    company: string | null
    phone: string | null
    formMessage: string | null
    source: string
  }
  /** When false, enrichment is deliberately skipped to prove the null path. */
  enrich: boolean
}

/**
 * Controlled fixtures:
 *  1. Apollo's own publicly documented example person — expected to match.
 *  2. An address on a reserved, non-routable domain — expected NO match.
 *  3. Enrichment deliberately skipped — proves a missing enrichment does not
 *     crash qualification.
 */
const FIXTURES: SmokeLead[] = [
  {
    label: 'lead-1 (public doc example, expect match)',
    lead: {
      id: 'smoke_1',
      name: 'Tim Zheng',
      email: 'tim@apollo.io',
      company: 'Apollo.io',
      phone: null,
      formMessage: null,
      source: 'WEBSITE_FORM',
    },
    enrich: true,
  },
  {
    label: 'lead-2 (reserved domain, expect no match)',
    lead: {
      id: 'smoke_2',
      name: 'Quality Assurance',
      email: 'qa.no.such.person@example.com',
      company: 'Example Holdings',
      phone: null,
      formMessage: null,
      source: 'WEBSITE_FORM',
    },
    enrich: true,
  },
  {
    label: 'lead-3 (enrichment skipped, expect no crash)',
    lead: {
      id: 'smoke_3',
      name: 'Dana Ops',
      email: 'dana.ops@example.com',
      company: 'Northwind Logistics',
      phone: null,
      formMessage: null,
      source: 'WEBSITE_FORM',
    },
    enrich: false,
  },
]

describe.skipIf(!ENABLED)('real provider smoke test', () => {
  it('runs Apollo enrichment then OpenAI qualification for each fixture', async () => {
    const { ensureProviderRegistry } = await import('@/lib/automation/provider-registry')
    const { parseAiQualificationOutput } = await import('@/lib/validation/automation-ai')
    const { isQualifyingScore, QUALIFICATION_THRESHOLD } = await import('@/lib/automation/pipeline')
    const { ProviderCallError } = await import('@/lib/automation/providers')

    // Goes through the PRODUCTION wiring rather than naming a vendor, so the
    // smoke test exercises whichever enrichment provider the registry
    // actually selects (Prospeo when its key is set, Apollo otherwise).
    const registry = ensureProviderRegistry()
    const enricher = registry.enrichment
    const openai = registry.ai

    // Presence only — the values are never read into the test output.
    expect(enricher, 'an enrichment provider must be configured').not.toBeNull()
    expect(openai, 'OPENAI_API_KEY must be configured').not.toBeNull()
    if (!enricher || !openai) return

    const report: string[] = []
    report.push(`threshold = ${QUALIFICATION_THRESHOLD}`)
    report.push(`enrichment provider = ${enricher.name} | ai provider = ${openai.name}`)

    for (const fixture of FIXTURES) {
      report.push(`\n=== ${fixture.label} ===`)

      // --- Apollo -------------------------------------------------------
      let enrichment = null as Awaited<ReturnType<typeof enricher.enrich>> | null
      let enrichOutcome: string

      if (!fixture.enrich) {
        enrichOutcome = 'SKIPPED (enrichment provider not used for this fixture)'
      } else {
        try {
          enrichment = await enricher.enrich({
            idempotencyKey: `smoke_step_${fixture.lead.id}`,
            organizationId: 'smoke_org',
            lead: fixture.lead,
          })
          const c = enrichment.data.company
          const p = enrichment.data.person
          const matched = Boolean(c.name ?? p.jobTitle ?? c.industry)
          enrichOutcome = matched ? 'MATCH' : 'NO MATCH (all-null, success)'
          report.push(`enrichment    : ${enrichOutcome}`)
          report.push(
            `  company     : name=${c.name} industry=${c.industry} employees=${c.employeeCount} country=${c.country}`,
          )
          report.push(`  website     : ${c.website}`)
          report.push(`  person      : title=${p.jobTitle} seniority=${p.seniority}`)
          report.push(`  lead        : source=${enrichment.data.lead.source}`)
        } catch (error) {
          const code = error instanceof ProviderCallError ? error.code : 'unknown'
          const retriable = error instanceof ProviderCallError ? error.retriable : 'n/a'
          enrichOutcome = `ERROR code=${code} retriable=${retriable}`
          report.push(`enrichment    : ${enrichOutcome}`)
          // Message is built from the HTTP status alone (no response body,
          // no lead data) — safe to surface for diagnosis.
          report.push(`  detail      : ${error instanceof Error ? error.message : 'n/a'}`)
        }
      }
      if (!fixture.enrich) report.push(`enrichment    : ${enrichOutcome}`)

      // --- OpenAI -------------------------------------------------------
      try {
        const raw = await openai.qualify({
          idempotencyKey: `smoke_step_${fixture.lead.id}_ai`,
          organizationId: 'smoke_org',
          lead: fixture.lead,
          enrichment,
          // The smoke test uses the defaults; an organization ICP is exercised
          // by tests/unit/automation-ai-provider.test.ts.
          config: {
            icp: 'A business that plausibly buys B2B software.',
            instructions: null,
            threshold: QUALIFICATION_THRESHOLD,
          },
        })

        const parsed = parseAiQualificationOutput(raw)
        if (!parsed) {
          report.push('openai        : MALFORMED (validation boundary rejected the output)')
          report.push('  score       : none — no score invented')
          continue
        }

        const outcome = isQualifyingScore(parsed.score) ? 'QUALIFIED' : 'UNQUALIFIED'
        report.push('openai        : SUCCESS')
        report.push(`  score       : ${parsed.score}  -> ${outcome}`)
        report.push(`  summary     : ${parsed.summary}`)
        report.push(`  action      : ${parsed.recommendedAction}`)
        report.push(`  keywords    : ${parsed.keywords.join(', ')}`)
        report.push(`  model       : ${parsed.model}  promptVersion=${parsed.promptVersion}`)
        report.push(
          `  tokens      : in=${parsed.inputTokens} out=${parsed.outputTokens} total=${parsed.tokenUsage}`,
        )

        // Backend threshold, not the model's opinion.
        expect(parsed.score).toBeGreaterThanOrEqual(0)
        expect(parsed.score).toBeLessThanOrEqual(100)
        expect(outcome).toBe(parsed.score >= QUALIFICATION_THRESHOLD ? 'QUALIFIED' : 'UNQUALIFIED')
      } catch (error) {
        const code = error instanceof ProviderCallError ? error.code : 'unknown'
        const retriable = error instanceof ProviderCallError ? error.retriable : 'n/a'
        report.push(`openai        : ERROR code=${code} retriable=${retriable}`)
        // Vendor status/code only — never the response body.
        const cause = error instanceof Error ? (error.cause as Record<string, unknown>) : null
        if (cause) {
          report.push(
            `  vendor      : status=${String(cause.status)} code=${String(cause.code)} type=${String(cause.type)}`,
          )
        }
        report.push('  score       : none — no score invented')
      }
    }

    const text = report.join('\n')
    console.log(text)

    // The runner swallows console output in some reporters; the report is
    // the whole point of this test, so it is also written out. Path is
    // caller-supplied and defaults to a scratch file.
    const target = process.env.SMOKE_REPORT_PATH
    if (target) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(target, text, 'utf8')
    }
  }, 300_000) // Real network calls to two vendors for three fixtures.
})
