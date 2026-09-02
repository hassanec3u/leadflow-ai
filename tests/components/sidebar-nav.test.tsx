import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SidebarNav } from '@/components/layout/sidebar-nav'

vi.mock('next/navigation', () => ({
  usePathname: () => '/leads',
}))

describe('SidebarNav', () => {
  it('renders only the destinations the user is allowed to see', () => {
    render(<SidebarNav allowedHrefs={['/dashboard', '/leads', '/settings']} />)

    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Leads' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()

    // Filtered out for this user — note this is presentation only; the pages
    // enforce access themselves (see tests/integration/session-tenancy.test.ts).
    expect(screen.queryByRole('link', { name: 'Integrations' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Automation' })).not.toBeInTheDocument()
  })

  it('marks the active route for assistive technology', () => {
    render(<SidebarNav allowedHrefs={['/dashboard', '/leads']} />)

    expect(screen.getByRole('link', { name: 'Leads' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('renders nothing when no destinations are permitted', () => {
    render(<SidebarNav allowedHrefs={[]} />)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})
