import Link from 'next/link'

import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { RunsView } from '@/components/automation/runs-view'
import { listWorkflowRuns } from '@/lib/services/automation-read'

export const metadata = { title: 'Workflow Runs — LeadFlow AI' }

/** Run history (Phase 2G — real WorkflowRun rows). */
export default async function AutomationRunsPage() {
  const runs = await listWorkflowRuns()

  return (
    <>
      <PageHeader
        title="Workflow Runs"
        description="All runs for the AI Lead Qualification Pipeline"
        actions={
          <Button variant="outline" asChild>
            <Link href="/automation/pipeline">View workflow</Link>
          </Button>
        }
      />
      <RunsView allRuns={runs} />
    </>
  )
}
