import { Sparkles } from 'lucide-react'

import { SidebarNav } from '@/components/layout/sidebar-nav'
import { UserMenu } from '@/components/layout/user-menu'

/**
 * Dark application sidebar: brand, navigation, account control.
 * Server component — it receives already-authorized data from the layout.
 */
export function AppSidebar({
  allowedHrefs,
  userName,
  userEmail,
  roleLabel,
}: {
  allowedHrefs: readonly string[]
  userName: string
  userEmail: string
  roleLabel: string
}) {
  return (
    <aside className="bg-sidebar border-sidebar-border flex w-64 shrink-0 flex-col border-r">
      <div className="flex items-center gap-3 px-6 py-6">
        <span className="bg-sidebar-primary flex size-9 items-center justify-center rounded-xl">
          <Sparkles className="text-sidebar-primary-foreground size-5" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="text-sidebar-accent-foreground block truncate text-[15px] font-semibold">
            LeadFlow AI
          </span>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        <SidebarNav allowedHrefs={allowedHrefs} />
      </div>

      <div className="border-sidebar-border border-t p-3">
        <UserMenu name={userName} email={userEmail} roleLabel={roleLabel} />
      </div>
    </aside>
  )
}
