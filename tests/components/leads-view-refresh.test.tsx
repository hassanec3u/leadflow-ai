import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Freshness after a mutation.
 *
 * `fetchLeads()` alone updates only this component's own state. The list is
 * seeded from `initialResult`, a SERVER-rendered snapshot held in `useState`
 * — new props never replace it — so without `router.refresh()` navigating
 * away and back re-hydrates stale rows. These tests pin that both happen.
 */

const routerRefresh = vi.hoisted(() => vi.fn())
const actions = vi.hoisted(() => ({
  listLeads: vi.fn(),
  deleteLead: vi.fn(),
  updateLead: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/leads',
}))

vi.mock('@/app/(app)/leads/actions', () => ({
  listLeadsAction: actions.listLeads,
  deleteLeadAction: actions.deleteLead,
  updateLeadAction: actions.updateLead,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const lead = {
  id: 'lead_1',
  organizationId: 'org_1',
  ownerId: null,
  owner: null,
  name: 'Marie Duval',
  email: 'marie@northwind.test',
  company: 'Northwind Logistics',
  phone: null,
  formMessage: null,
  source: 'WEBSITE_FORM',
  aiScore: 65,
  qualification: null,
  qualificationOutcome: 'UNQUALIFIED',
  qualificationSource: 'AI',
  qualificationUpdatedAt: new Date('2026-09-02T10:00:00Z'),
  status: 'NEW',
  deletedAt: null,
  createdAt: new Date('2026-09-02T10:00:00Z'),
  updatedAt: new Date('2026-09-02T10:00:00Z'),
  lastActionAt: new Date('2026-09-02T10:00:00Z'),
}

const initialResult = { leads: [lead], total: 1, page: 1, pageSize: 25 }

async function renderView() {
  const { LeadsView } = await import('@/components/leads/leads-view')
  return render(
    <LeadsView
      initialResult={initialResult as unknown as Parameters<typeof LeadsView>[0]['initialResult']}
      initialError={null}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  actions.listLeads.mockResolvedValue({ ok: true, data: initialResult })
  actions.deleteLead.mockResolvedValue({ ok: true })
  actions.updateLead.mockResolvedValue({ ok: true, data: lead })
})

describe('LeadsView freshness', () => {
  it('shows the pipeline verdict rather than the never-written bucket', async () => {
    await renderView()

    // aiScore 65 with qualificationOutcome UNQUALIFIED: the badge must read
    // the outcome, not `lead.qualification` (null forever).
    await waitFor(() => expect(screen.getAllByText('Unqualified').length).toBeGreaterThan(0))
    expect(screen.queryByText('Unscored')).not.toBeInTheDocument()
  })

  it('refreshes the server payload after a delete, not just local state', async () => {
    const user = userEvent.setup()
    await renderView()

    await user.click(await screen.findByRole('button', { name: /Actions for Marie Duval/i }))
    await user.click(await screen.findByText('Delete lead'))

    await waitFor(() => expect(actions.deleteLead).toHaveBeenCalledWith('lead_1'))
    // Both caches: local refetch AND the server-rendered snapshot.
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled())
    expect(actions.listLeads).toHaveBeenCalled()
  })

  it('does not refresh when a mutation failed', async () => {
    actions.deleteLead.mockResolvedValue({ ok: false, message: 'Nope' })
    const user = userEvent.setup()
    await renderView()

    await user.click(await screen.findByRole('button', { name: /Actions for Marie Duval/i }))
    await user.click(await screen.findByText('Delete lead'))

    await waitFor(() => expect(actions.deleteLead).toHaveBeenCalled())
    // Nothing changed server-side, so there is nothing to re-read.
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
