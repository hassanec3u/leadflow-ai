import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Shared empty state.
 *
 * Phase 0 ships this as a real primitive rather than ad-hoc copy per page,
 * because docs/product-spec.md §15 specifies an empty state for every major
 * view — having one component means those stay visually consistent as each
 * phase fills its page in.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="border-border bg-card flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
      <span className="bg-accent text-accent-foreground mb-4 flex size-12 items-center justify-center rounded-full">
        <Icon className="size-6" aria-hidden />
      </span>
      <h2 className="text-foreground text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-md text-sm">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
