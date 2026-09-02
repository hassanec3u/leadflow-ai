import { WorkflowDetail } from '@/components/automation/workflow-detail'
import { EmptyState } from '@/components/ui/empty-state'
import { WorkflowIcon } from 'lucide-react'
import { getAutomationOverview, listWorkflowRuns } from '@/lib/services/automation-read'

export const metadata = { title: 'AI Lead Qualification Pipeline — LeadFlow AI' }

/**
 * Workflow detail (Phase 2G — real data).
 *
 * `/automation/pipeline` rather than `/automation/[workflowId]`: there is
 * exactly one pipeline per organization and no way to create another
 * (docs/architecture.md §10), so the route carries no workflow id.
 */
export default async function AutomationPipelinePage() {
  const [{ workflow }, runs] = await Promise.all([getAutomationOverview(), listWorkflowRuns()])

  if (!workflow) {
    return (
      <div className="p-8">
        <EmptyState
          icon={WorkflowIcon}
          title="No pipeline yet"
          description="Your lead qualification pipeline is created automatically the first time a Website Form lead is captured."
        />
      </div>
    )
  }

  return <WorkflowDetail workflow={workflow} recentRuns={runs.slice(0, 5)} />
}
