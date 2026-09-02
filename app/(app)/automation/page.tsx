import { PageHeader } from '@/components/layout/page-header'
import { AutomationOverview } from '@/components/automation/automation-overview'
import { getAutomationOverview } from '@/lib/services/automation-read'

export const metadata = { title: 'Automation — LeadFlow AI' }

/**
 * Automation overview (Phase 2G — real data).
 *
 * Figures are read from PostgreSQL by the service, which resolves the tenant
 * from the session and enforces `automation:manage` itself — the page passes
 * no organization id, because there is none to pass. The route stays
 * `/automation` (singular) because MVP provisions one fixed pipeline per
 * organization (docs/architecture.md §10).
 */
export default async function AutomationPage() {
  const { workflow, kpis } = await getAutomationOverview()

  return (
    <>
      <PageHeader title="Automation" description="Manage and monitor your automation workflows" />
      <AutomationOverview workflow={workflow} kpis={kpis} />
    </>
  )
}
