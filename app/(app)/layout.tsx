import { redirect } from 'next/navigation'

import { AppSidebar } from '@/components/layout/app-sidebar'
import { getCurrentOrganization, getCurrentUser } from '@/lib/auth/session'
import { ROLE_LABELS, hasCapability } from '@/lib/auth/rbac'
import { NAV_ITEMS } from '@/lib/navigation'

/**
 * Authenticated application shell.
 *
 * This layout performs a real auth check rather than relying on `proxy.ts`,
 * which is only an optimistic redirect. Every page beneath it therefore renders
 * for an authenticated user with a live organization.
 *
 * Note that a layout auth check does not, on its own, protect the pages
 * beneath it (layouts do not re-render on every navigation), which is why
 * privileged pages call requireCapability/requireRole themselves as well.
 */
export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const user = await getCurrentUser()
  if (!user) {
    redirect('/login')
  }

  const organization = await getCurrentOrganization()
  if (!organization) {
    redirect('/login')
  }

  // Capability filtering happens on the server; the client only learns which
  // hrefs to show, not the whole permission matrix.
  const allowedHrefs = NAV_ITEMS.filter(
    (item) => !item.requiredCapability || hasCapability(user.role, item.requiredCapability),
  ).map((item) => item.href)

  return (
    <div className="bg-background flex h-dvh overflow-hidden">
      <AppSidebar
        allowedHrefs={allowedHrefs}
        userName={user.name ?? user.email}
        userEmail={user.email}
        roleLabel={ROLE_LABELS[user.role]}
        organizationName={organization.name}
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  )
}
