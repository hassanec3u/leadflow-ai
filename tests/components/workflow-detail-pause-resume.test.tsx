import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowSummaryView } from '@/lib/automation/view-model'

/**
 * Pause/Resume — Workflow Detail wiring.
 *
 * The placeholder toast ("Workflow controls arrive with the Phase 2 backend")
 * is gone for Pause/Resume specifically; these pin the real behaviour:
 * confirm, call the right server action for the current status, loading
 * state, error handling, and router.refresh() after success. Duplicate/Export
 * remain placeholders — out of scope for this micro-phase, untouched here.
 */

const routerRefresh = vi.hoisted(() => vi.fn())
const pauseAction = vi.hoisted(() => vi.fn())
const resumeAction = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh, replace: vi.fn() }),
}))

vi.mock('@/app/(app)/automation/actions', () => ({
  pauseWorkflowAction: pauseAction,
  resumeWorkflowAction: resumeAction,
}))

vi.mock('sonner', () => ({ toast: toastMock }))

const ACTIVE_WORKFLOW: WorkflowSummaryView = {
  id: 'wf_1',
  name: 'AI Lead Qualification Pipeline',
  description: 'Automatically qualify new leads and engage sales.',
  status: 'ACTIVE',
  trigger: 'Website Form',
  version: 'v1',
  runsWindowLabel: '12',
  successRate: 80,
  lastRunLabel: '2 hours ago',
  lastRunStatus: 'SUCCEEDED',
  stats: [],
}

async function renderWorkflowDetail(workflow: WorkflowSummaryView = ACTIVE_WORKFLOW) {
  const { WorkflowDetail } = await import('@/components/automation/workflow-detail')
  return render(<WorkflowDetail workflow={workflow} recentRuns={[]} />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WorkflowDetail — Pause/Resume', () => {
  it('asks for confirmation before pausing an ACTIVE workflow', async () => {
    const user = userEvent.setup()
    await renderWorkflowDetail()

    await user.click(screen.getByRole('button', { name: 'Pause' }))

    expect(await screen.findByText('Pause this workflow?')).toBeInTheDocument()
    expect(pauseAction).not.toHaveBeenCalled()
  })

  it('cancelling does nothing', async () => {
    const user = userEvent.setup()
    await renderWorkflowDetail()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await screen.findByText('Pause this workflow?')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(pauseAction).not.toHaveBeenCalled()
    expect(screen.queryByText('Pause this workflow?')).not.toBeInTheDocument()
  })

  it('confirms pause: calls pauseWorkflowAction with the workflow id, toasts, and refreshes', async () => {
    pauseAction.mockResolvedValue({ ok: true, data: { id: 'wf_1', status: 'PAUSED' } })
    const user = userEvent.setup()
    await renderWorkflowDetail()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await screen.findByText('Pause this workflow?')
    await user.click(screen.getByRole('button', { name: 'Pause Workflow' }))

    await waitFor(() => expect(pauseAction).toHaveBeenCalledWith('wf_1'))
    expect(resumeAction).not.toHaveBeenCalled()
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled())
    expect(toastMock.success).toHaveBeenCalledWith('Workflow paused')
  })

  it('a PAUSED workflow shows Resume and calls resumeWorkflowAction, never pauseWorkflowAction', async () => {
    resumeAction.mockResolvedValue({ ok: true, data: { id: 'wf_1', status: 'ACTIVE' } })
    const user = userEvent.setup()
    await renderWorkflowDetail({ ...ACTIVE_WORKFLOW, status: 'PAUSED' })

    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    await screen.findByText('Resume this workflow?')
    await user.click(screen.getByRole('button', { name: 'Resume Workflow' }))

    await waitFor(() => expect(resumeAction).toHaveBeenCalledWith('wf_1'))
    expect(pauseAction).not.toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledWith('Workflow resumed')
  })

  it('shows a loading state and blocks a second click while in flight', async () => {
    let resolveAction: (value: {
      ok: true
      data: { id: string; status: string }
    }) => void = () => {}
    pauseAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve
      }),
    )
    const user = userEvent.setup()
    await renderWorkflowDetail()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await screen.findByText('Pause this workflow?')
    const confirmButton = screen.getByRole('button', { name: 'Pause Workflow' })
    await user.click(confirmButton)

    const pendingButton = await screen.findByRole('button', { name: 'Saving…' })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(pauseAction).toHaveBeenCalledTimes(1)

    resolveAction({ ok: true, data: { id: 'wf_1', status: 'PAUSED' } })
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled())
  })

  it('surfaces a server error via toast and does not refresh', async () => {
    pauseAction.mockResolvedValue({ ok: false, message: 'You do not have permission to do that.' })
    const user = userEvent.setup()
    await renderWorkflowDetail()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await screen.findByText('Pause this workflow?')
    await user.click(screen.getByRole('button', { name: 'Pause Workflow' }))

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('You do not have permission to do that.'),
    )
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
