import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowRunView } from '@/lib/automation/view-model'

/**
 * Manual Rerun — Run Detail wiring.
 *
 * The placeholder toast ("Re-running a workflow arrives with the Phase 2
 * backend") is gone; these pin the real behaviour: confirm, call the server
 * action, loading state, error handling, and — on success — navigate to the
 * new run and refresh so it (and every cache router.refresh() invalidates)
 * reflects it immediately.
 */

const routerPush = vi.hoisted(() => vi.fn())
const routerRefresh = vi.hoisted(() => vi.fn())
const rerunAction = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh, replace: vi.fn() }),
}))

vi.mock('@/app/(app)/automation/runs/actions', () => ({
  requestManualRerunAction: rerunAction,
}))

vi.mock('sonner', () => ({ toast: toastMock }))

const FAILED_RUN: WorkflowRunView = {
  id: 'run_failed_1',
  reference: 'RUN-1',
  lead: { id: 'lead_1', name: 'Ada Lovelace', email: 'ada@acme.test', company: 'Acme' },
  status: 'FAILED',
  outcomeLabel: 'Failed at Enrich Lead',
  trigger: 'AUTOMATIC',
  version: '1',
  enrolledAtLabel: 'Sep 2, 2026',
  startedLabel: '2 hours ago',
  startedDaysAgo: 0,
  durationLabel: '12s',
  currentStepLabel: 'Enrich Lead (failed)',
  completedAtLabel: null,
  aiScore: null,
  formMessage: null,
  aiTelemetry: null,
  steps: [
    {
      key: 'ENRICH',
      order: 1,
      name: 'Enrich Lead',
      detail: 'Enrichment',
      state: 'FAILED',
      duration: '3s',
      attempts: 3,
      error: { message: 'Could not reach Prospeo', attempts: 3 },
    },
  ],
  input: [],
  logs: [],
}

async function renderRunDetail(run: WorkflowRunView = FAILED_RUN) {
  const { RunDetail } = await import('@/components/automation/run-detail')
  return render(<RunDetail run={run} workflowName="AI Lead Qualification Pipeline" />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RunDetail — Manual Rerun', () => {
  it('asks for confirmation before starting a rerun', async () => {
    const user = userEvent.setup()
    await renderRunDetail()

    await user.click(screen.getAllByRole('button', { name: 'Re-run Workflow' })[0]!)

    expect(await screen.findByText('Re-run this workflow?')).toBeInTheDocument()
    expect(rerunAction).not.toHaveBeenCalled()
  })

  it('does nothing further when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    await renderRunDetail()

    await user.click(screen.getAllByRole('button', { name: 'Re-run Workflow' })[0]!)
    await screen.findByText('Re-run this workflow?')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(rerunAction).not.toHaveBeenCalled()
    expect(screen.queryByText('Re-run this workflow?')).not.toBeInTheDocument()
  })

  it('calls the server action with this run id on confirm, then navigates and refreshes', async () => {
    rerunAction.mockResolvedValue({ ok: true, runId: 'run_new_1' })
    const user = userEvent.setup()
    await renderRunDetail()

    await user.click(screen.getAllByRole('button', { name: 'Re-run Workflow' })[0]!)
    await screen.findByText('Re-run this workflow?')
    await user.click(screen.getByRole('button', { name: 'Re-run Workflow' }))

    await waitFor(() => expect(rerunAction).toHaveBeenCalledWith('run_failed_1'))
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/automation/runs/run_new_1'))
    expect(routerRefresh).toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalled()
  })

  it('shows the loading state and blocks a second click while the request is in flight', async () => {
    let resolveAction: (value: { ok: true; runId: string }) => void = () => {}
    rerunAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve
      }),
    )
    const user = userEvent.setup()
    await renderRunDetail()

    await user.click(screen.getAllByRole('button', { name: 'Re-run Workflow' })[0]!)
    await screen.findByText('Re-run this workflow?')
    const confirmButton = screen.getByRole('button', { name: 'Re-run Workflow' })
    await user.click(confirmButton)

    // In flight: the confirm button now reads "Re-running…" and is disabled —
    // a second click (double-click protection) cannot fire a second call.
    const pendingButton = await screen.findByRole('button', { name: 'Re-running…' })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(rerunAction).toHaveBeenCalledTimes(1)

    resolveAction({ ok: true, runId: 'run_new_1' })
    await waitFor(() => expect(routerPush).toHaveBeenCalled())
  })

  it('surfaces a conflict (or any) error via toast and does not navigate', async () => {
    rerunAction.mockResolvedValue({
      ok: false,
      message: 'A workflow run is already in progress for this lead.',
    })
    const user = userEvent.setup()
    await renderRunDetail()

    await user.click(screen.getAllByRole('button', { name: 'Re-run Workflow' })[0]!)
    await screen.findByText('Re-run this workflow?')
    await user.click(screen.getByRole('button', { name: 'Re-run Workflow' }))

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'A workflow run is already in progress for this lead.',
      ),
    )
    expect(routerPush).not.toHaveBeenCalled()
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('does not offer a rerun button for a run that is not FAILED', async () => {
    await renderRunDetail({ ...FAILED_RUN, status: 'SUCCEEDED', outcomeLabel: 'Success' })

    expect(screen.queryByRole('button', { name: 'Re-run Workflow' })).not.toBeInTheDocument()
  })
})
