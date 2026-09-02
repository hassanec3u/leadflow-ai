import type { LeadQualificationOutcome, LeadStatus } from '@prisma/client'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { formatEnumLabel } from '@/components/leads/lead-format'

const STATUS_STYLES: Record<LeadStatus, string> = {
  NEW: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
  ENRICHING: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-400',
  QUALIFIED: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  EMAILED: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400',
  EMAIL_OPENED: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400',
  REPLIED: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-400',
  CONVERTED: 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  LOST: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
}

/**
 * The pipeline's binary verdict (Phase 2C, decision D1).
 *
 * NOT the HOT/WARM/COLD `LeadQualification` bucket this badge used to read:
 * nothing writes that column, so the badge showed "Unscored" forever — even
 * for a lead the pipeline had scored and decided on. The outcome below is what
 * the engine actually persists.
 */
const OUTCOME_STYLES: Record<LeadQualificationOutcome, string> = {
  QUALIFIED: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  UNQUALIFIED: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-400',
}

const OUTCOME_LABELS: Record<LeadQualificationOutcome, string> = {
  QUALIFIED: 'Qualified',
  UNQUALIFIED: 'Unqualified',
}

export function StatusBadge({ status }: { status: LeadStatus }) {
  return (
    <Badge className={cn('border-0 font-medium', STATUS_STYLES[status])}>
      {formatEnumLabel(status)}
    </Badge>
  )
}

/**
 * Null means the pipeline has not decided yet — shown as "Unscored", never as
 * a default verdict. UNQUALIFIED is deliberately neutral slate rather than
 * red: a lead below the threshold is not an error, it is simply not ready for
 * outreach yet.
 */
export function QualificationBadge({ outcome }: { outcome: LeadQualificationOutcome | null }) {
  if (!outcome) {
    return <Badge variant="outline">Unscored</Badge>
  }
  return (
    <Badge className={cn('border-0 font-medium', OUTCOME_STYLES[outcome])}>
      {OUTCOME_LABELS[outcome]}
    </Badge>
  )
}

/**
 * Numeric AI score (0–100). Distinct from the qualification badge — this is
 * the model's raw number; the badge is the backend's verdict after applying
 * the threshold. Null before AI qualification has run — never defaulted to 0.
 */
export function AiScoreBadge({ score }: { score: number | null }) {
  if (score === null) {
    return <Badge variant="outline">—</Badge>
  }
  const style =
    score >= 80
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
      : score >= 50
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
        : 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-400'

  return (
    <Badge className={cn('border-0 font-mono font-semibold tabular-nums', style)}>{score}</Badge>
  )
}
