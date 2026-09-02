import { notFound } from 'next/navigation'

import { RunDetail } from '@/components/automation/run-detail'
import { getWorkflowRunDetail } from '@/lib/services/automation-read'

export const metadata = { title: 'Workflow Run — LeadFlow AI' }

/**
 * Run detail (Phase 2G — real WorkflowRun + WorkflowStepRun rows).
 *
 * A run belonging to another organization is invisible under RLS, so it
 * reaches the same not-found path as an id that never existed — the page
 * cannot be used to probe which run ids exist elsewhere.
 */
export default async function AutomationRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId } = await params
  const run = await getWorkflowRunDetail(runId)

  if (!run) {
    notFound()
  }

  return <RunDetail run={run} workflowName="AI Lead Qualification Pipeline" />
}
