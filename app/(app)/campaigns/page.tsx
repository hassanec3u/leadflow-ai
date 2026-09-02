import { Send } from 'lucide-react'

import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { requireCapability } from '@/lib/auth/session'

export const metadata = { title: 'Campaigns — LeadFlow AI' }

/**
 * Phase 0 placeholder. Campaign sequences are Phase 4.
 *
 * The capability check runs here, not only in the sidebar: a SALES_REP who
 * types this URL directly must be refused, and hiding the nav item does not
 * do that.
 */
export default async function CampaignsPage() {
  await requireCapability('campaigns:manage')

  return (
    <>
      <PageHeader title="Campaigns" description="Outreach sequences and their performance" />
      <div className="p-8">
        <EmptyState
          icon={Send}
          title="No campaigns yet"
          description="Campaigns let you follow up with qualified leads automatically. Building them arrives with Phase 4."
        />
      </div>
    </>
  )
}
