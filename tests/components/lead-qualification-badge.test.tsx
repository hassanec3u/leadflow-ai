import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { QualificationBadge } from '@/components/leads/lead-badges'

/**
 * The badge reads the PIPELINE's verdict (`qualificationOutcome`), not the
 * legacy HOT/WARM/COLD `LeadQualification` bucket.
 *
 * That bucket is never written by anything — the engine persists
 * `qualificationOutcome` and nothing else — so the badge previously showed
 * "Unscored" forever, including for leads the pipeline had scored and decided
 * on. These tests exist so that regression cannot come back silently.
 */
describe('QualificationBadge', () => {
  it('shows Qualified for a lead above the threshold', () => {
    render(<QualificationBadge outcome="QUALIFIED" />)

    expect(screen.getByText('Qualified')).toBeInTheDocument()
  })

  it('shows Unqualified for a lead below the threshold', () => {
    render(<QualificationBadge outcome="UNQUALIFIED" />)

    expect(screen.getByText('Unqualified')).toBeInTheDocument()
    // Not "Unscored": the pipeline HAS decided, and the answer was no.
    expect(screen.queryByText('Unscored')).not.toBeInTheDocument()
  })

  it('shows Unscored only when the pipeline has not decided yet', () => {
    render(<QualificationBadge outcome={null} />)

    expect(screen.getByText('Unscored')).toBeInTheDocument()
  })

  it('never renders a HOT/WARM/COLD bucket label', () => {
    const { container } = render(<QualificationBadge outcome="QUALIFIED" />)

    // The old bucket is deliberately not revived by this fix.
    expect(container.textContent).not.toMatch(/hot|warm|cold/i)
  })

  it('does not paint Unqualified as an error state', () => {
    const { container } = render(<QualificationBadge outcome="UNQUALIFIED" />)

    // A lead below the threshold is not a failure — it is simply not ready
    // for outreach. Rose is reserved for things that actually went wrong.
    expect(container.querySelector('[class*="rose"]')).toBeNull()
  })
})
