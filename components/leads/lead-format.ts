/**
 * Small display-only helpers shared by the Leads UI components.
 *
 * Formatting is presentation, not business logic — the values themselves
 * (status/qualification/source enums, dates) come from the real Lead service.
 */

export function getLeadInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

/** "WEBSITE_FORM" -> "Website Form", "EMAIL_OPENED" -> "Email Opened". */
export function formatEnumLabel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const minutes = Math.round(diffMs / (60 * 1000))
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
