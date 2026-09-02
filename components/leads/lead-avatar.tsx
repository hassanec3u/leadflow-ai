import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getLeadInitials } from '@/components/leads/lead-format'

const PALETTE = [
  'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
]

function colorFor(name: string) {
  const hash = name.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return PALETTE[hash % PALETTE.length]
}

/** Initials-only avatar for mock people — no image assets in this phase. */
export function LeadAvatar({ name, size = 'default' }: { name: string; size?: 'default' | 'lg' }) {
  return (
    <Avatar size={size}>
      <AvatarFallback className={cn('font-medium', colorFor(name))}>
        {getLeadInitials(name)}
      </AvatarFallback>
    </Avatar>
  )
}
