import { BarChart3 } from 'lucide-react'

import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { requireCapability } from '@/lib/auth/session'

export const metadata = { title: 'Analytics — LeadFlow AI' }

/** Phase 0 placeholder. Reporting is Phase 6. */
export default async function AnalyticsPage() {
  await requireCapability('analytics:view:org')

  return (
    <>
      <PageHeader title="Analytics" description="Pipeline, campaign and team performance" />
      <div className="p-8">
        <EmptyState
          icon={BarChart3}
          title="No data to report yet"
          description="Reporting needs lead and engagement history to summarise. It becomes available in Phase 6."
        />
      </div>
    </>
  )
}
