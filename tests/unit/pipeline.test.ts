import { describe, expect, it } from 'vitest'

import { isCriticalStep, PIPELINE_STEPS } from '@/lib/automation/pipeline'

/**
 * The pipeline definition itself (lib/automation/pipeline.ts) — pure data, no
 * I/O, so it is worth pinning directly rather than only indirectly through
 * tests/unit/automation-engine.test.ts.
 *
 * ADD_TO_CRM was removed: LeadFlow's own `Lead` row is already the system of
 * record (docs/product-spec.md §1/§10), so a mid-pipeline CRM sync was
 * redundant business logic. It stays a member of the `WorkflowStepKind` DB
 * enum for historical `WorkflowStepRun` rows — see
 * tests/unit/automation-read.test.ts and tests/integration/automation-domain.test.ts
 * for that side of the guarantee — but is never scheduled again.
 */
describe('PIPELINE_STEPS', () => {
  it('is exactly the five current steps, in order', () => {
    expect(PIPELINE_STEPS).toEqual([
      'ENRICH',
      'AI_QUALIFY',
      'SCORE_AND_TAG',
      'SEND_EMAIL',
      'NOTIFY_TEAM',
    ])
  })

  it('no longer contains ADD_TO_CRM', () => {
    expect(PIPELINE_STEPS).not.toContain('ADD_TO_CRM')
  })
})

describe('isCriticalStep', () => {
  it('has never depended on ADD_TO_CRM — the critical set is unchanged', () => {
    expect(isCriticalStep('ENRICH')).toBe(true)
    expect(isCriticalStep('AI_QUALIFY')).toBe(true)
    expect(isCriticalStep('SCORE_AND_TAG')).toBe(true)
    expect(isCriticalStep('SEND_EMAIL')).toBe(true)
    expect(isCriticalStep('NOTIFY_TEAM')).toBe(false)
  })
})
