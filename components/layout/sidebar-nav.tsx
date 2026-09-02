'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { NAV_ITEMS } from '@/lib/navigation'
import { cn } from '@/lib/utils'

/**
 * Client component so the active route can be highlighted.
 *
 * It receives only the set of hrefs the current user may see — the capability
 * decision is made on the server (app/(app)/layout.tsx). Icons stay here
 * because Lucide components are functions and cannot cross the server/client
 * boundary as props.
 *
 * Filtering here is presentation. Each destination enforces access itself.
 */
export function SidebarNav({ allowedHrefs }: { allowedHrefs: readonly string[] }) {
  const pathname = usePathname()
  const allowed = new Set(allowedHrefs)

  return (
    <nav className="flex flex-col gap-1 px-3" aria-label="Main">
      {NAV_ITEMS.filter((item) => allowed.has(item.href)).map((item) => {
        // A nested route (/leads/123) should still light up its section.
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
        const Icon = item.icon

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              'focus-visible:ring-sidebar-ring focus-visible:ring-offset-sidebar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
              isActive
                ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            )}
          >
            <Icon className="size-[18px] shrink-0" aria-hidden />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
