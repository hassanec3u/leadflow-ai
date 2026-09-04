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
const notifyAction = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh, replace: vi.fn() }),
}))

vi.mock('@/app/(app)/automation/actions', () => ({
  pauseWorkflowAction: pauseAction,
  resumeWorkflowAction: resumeAction,
  setNotifyTeamEnabledAction: notifyAction,
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
  notifyTeamEnabled: true,
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

describe('WorkflowDetail — Notify Team switch', () => {
  const DISABLED_WORKFLOW: WorkflowSummaryView = { ...ACTIVE_WORKFLOW, notifyTeamEnabled: false }

  it('reflects the persisted state on first render', async () => {
    await renderWorkflowDetail(DISABLED_WORKFLOW)

    expect(screen.getByRole('switch', { name: /notify team/i })).not.toBeChecked()
  })

  it('switches the step off and reports it', async () => {
    notifyAction.mockResolvedValue({ ok: true, data: { id: 'wf_1', notifyTeamEnabled: false } })
    const user = userEvent.setup()
    await renderWorkflowDetail()

    await user.click(screen.getByRole('switch', { name: /notify team/i }))

    await waitFor(() => expect(notifyAction).toHaveBeenCalledWith('wf_1', false))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Team notifications off'))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('switches the step back on', async () => {
    notifyAction.mockResolvedValue({ ok: true, data: { id: 'wf_1', notifyTeamEnabled: true } })
    const user = userEvent.setup()
    await renderWorkflowDetail(DISABLED_WORKFLOW)

    await user.click(screen.getByRole('switch', { name: /notify team/i }))

    await waitFor(() => expect(notifyAction).toHaveBeenCalledWith('wf_1', true))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Team notifications on'))
  })

  it('reverts the switch when the server refuses', async () => {
    notifyAction.mockResolvedValue({
      ok: false,
      message: 'You do not have permission to do that.',
    })
    const user = userEvent.setup()
    await renderWorkflowDetail()

    const toggle = screen.getByRole('switch', { name: /notify team/i })
    await user.click(toggle)

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('You do not have permission to do that.'),
    )
    // Optimistic move undone — the control must not claim a state the server
    // rejected.
    await waitFor(() => expect(toggle).toBeChecked())
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('adopts the value the server reports, not the one requested', async () => {
    // A concurrent toggle elsewhere already turned it back on.
    notifyAction.mockResolvedValue({ ok: true, data: { id: 'wf_1', notifyTeamEnabled: true } })
    const user = userEvent.setup()
    await renderWorkflowDetail()

    const toggle = screen.getByRole('switch', { name: /notify team/i })
    await user.click(toggle)

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Team notifications on'))
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('shows no switch on any other step', async () => {
    await renderWorkflowDetail()

    // Exactly one switch on the screen: only NOTIFY_TEAM is switchable.
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })
})
