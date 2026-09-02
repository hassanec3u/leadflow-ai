import type { ReactNode } from 'react'

/**
 * Consistent page heading: title, optional supporting line, optional actions.
 * Mirrors the reference layout's "title + subtitle left, actions right".
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="border-border bg-card flex flex-wrap items-start justify-between gap-4 border-b px-8 py-6">
      <div className="min-w-0">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground mt-1 text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}
