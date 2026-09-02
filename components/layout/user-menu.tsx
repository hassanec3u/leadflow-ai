'use client'

import { ChevronsUpDown, LogOut } from 'lucide-react'
import { signOut } from 'next-auth/react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Sidebar account control. Client-side because sign-out is an interaction.
 * Only display values are passed in — never the session object itself.
 */
export function UserMenu({
  name,
  email,
  roleLabel,
}: {
  name: string
  email: string
  roleLabel: string
}) {
  const initials =
    name
      .split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2"
        aria-label="Account menu"
      >
        <Avatar className="size-8">
          <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="text-sidebar-accent-foreground block truncate text-sm font-medium">
            {name}
          </span>
          <span className="text-sidebar-foreground/70 block truncate text-xs">{roleLabel}</span>
        </span>
        <ChevronsUpDown className="text-sidebar-foreground/60 size-4 shrink-0" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-sm font-medium">{name}</span>
          <span className="text-muted-foreground block truncate text-xs">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: '/login' })}>
          <LogOut className="size-4" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
