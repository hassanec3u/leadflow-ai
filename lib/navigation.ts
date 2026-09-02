import { BarChart3, LayoutDashboard, Plug, Settings, Send, Users, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { Capability } from '@/lib/auth/rbac'

/**
 * Primary navigation.
 *
 * Order and labels follow the product reference. `/automation` (singular) is
 * deliberate: docs/architecture.md §10 scopes MVP to one auto-provisioned
 * pipeline per organization rather than a multi-workflow builder.
 *
 * `requiredCapability` drives whether the item is RENDERED. It is presentation
 * only — each destination independently enforces access server-side.
 */
export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  requiredCapability?: Capability
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/leads', label: 'Leads', icon: Users },
  { href: '/campaigns', label: 'Campaigns', icon: Send, requiredCapability: 'campaigns:manage' },
  {
    href: '/automation',
    label: 'Automation',
    icon: Workflow,
    requiredCapability: 'automation:manage',
  },
  {
    href: '/analytics',
    label: 'Analytics',
    icon: BarChart3,
    requiredCapability: 'analytics:view:org',
  },
  {
    href: '/integrations',
    label: 'Integrations',
    icon: Plug,
    requiredCapability: 'integrations:manage',
  },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const
