import { LayoutDashboard } from 'lucide-react'

import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { requireUser } from '@/lib/auth/session'

export const metadata = { title: 'Dashboard — LeadFlow AI' }

/**
 * Phase 0 placeholder.
 *
 * The metric cards, qualification donut, leads-over-time chart, recent-leads
 * table and AI insight panel from the product reference are Phase 6 work
 * (docs/roadmap.md) and depend on data models that do not exist yet.
 */
export default async function DashboardPage() {
  const user = await requireUser()

  return (
    <>
      <PageHeader title="Dashboard" description="AI Lead Qualification & Follow-up Automation" />
      <div className="p-8">
        <EmptyState
          icon={LayoutDashboard}
          title={`Welcome, ${user.name ?? user.email}`}
          description="Your dashboard will show lead volume, qualification breakdown and follow-up performance once lead capture is live. That arrives with Phase 1."
        />
      </div>
    </>
  )
}
