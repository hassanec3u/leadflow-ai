import {
  ActivityIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  LoaderIcon,
  MinusIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type {
  Kpi,
  KpiTone,
  RunStatus,
  StepState,
  WorkflowStatusView,
} from '@/lib/automation/view-model'

/**
 * Shared presentational pieces for the Automation screens.
 *
 * Status colours reuse the Leads badge vocabulary (components/leads/lead-badges.tsx)
 * so a state means the same thing everywhere in the product: emerald = done,
 * violet = in progress, rose = failed, slate = neutral/skipped.
 */

/**
 * BLOCKED gets its own amber treatment, never rose: "no email provider is
 * configured" is a configuration gap an admin can fix, not a failure.
 */
const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  SUCCEEDED: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  RUNNING: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400',
  PENDING: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-400',
  FAILED: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
  BLOCKED: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
}

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  SUCCEEDED: 'Succeeded',
  RUNNING: 'Running',
  PENDING: 'Queued',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge className={cn('border-0 font-medium', RUN_STATUS_STYLES[status])}>
      {RUN_STATUS_LABELS[status]}
    </Badge>
  )
}

// Only ACTIVE and PAUSED exist in the WorkflowStatus enum — there is no DRAFT.
const WORKFLOW_STATUS_STYLES: Record<WorkflowStatusView, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  PAUSED: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
}

const WORKFLOW_STATUS_LABELS: Record<WorkflowStatusView, string> = {
  ACTIVE: 'Active',
  PAUSED: 'Paused',
}

export function WorkflowStatusBadge({ status }: { status: WorkflowStatusView }) {
  return (
    <Badge className={cn('border-0 font-medium', WORKFLOW_STATUS_STYLES[status])}>
      {WORKFLOW_STATUS_LABELS[status]}
    </Badge>
  )
}

const STEP_STATE_LABELS: Record<StepState, string> = {
  SUCCEEDED: 'Succeeded',
  RUNNING: 'In Progress',
  PENDING: 'Pending',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  BLOCKED: 'Blocked',
}

const STEP_STATE_TEXT: Record<StepState, string> = {
  SUCCEEDED: 'text-emerald-700 dark:text-emerald-400',
  RUNNING: 'text-primary',
  PENDING: 'text-muted-foreground',
  FAILED: 'text-destructive',
  SKIPPED: 'text-muted-foreground',
  BLOCKED: 'text-amber-700 dark:text-amber-400',
}

const STEP_STATE_BUBBLE: Record<StepState, string> = {
  SUCCEEDED:
    'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-400',
  RUNNING: 'border-primary/30 bg-accent text-primary',
  PENDING: 'border-border bg-muted text-muted-foreground',
  FAILED:
    'border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-400',
  SKIPPED: 'border-border bg-muted text-muted-foreground',
  BLOCKED:
    'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-400',
}

/** Circular state marker used by every step timeline. */
export function StepStateIcon({ state, className }: { state: StepState; className?: string }) {
  const Icon =
    state === 'SUCCEEDED'
      ? CheckIcon
      : state === 'RUNNING'
        ? LoaderIcon
        : state === 'FAILED'
          ? XIcon
          : state === 'SKIPPED'
            ? MinusIcon
            : CircleSlashIcon

  return (
    <span
      className={cn(
        'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border',
        STEP_STATE_BUBBLE[state],
        className,
      )}
    >
      {state === 'PENDING' ? (
        <span className="bg-muted-foreground/40 size-2 rounded-full" aria-hidden />
      ) : (
        <Icon className={cn('size-3.5', state === 'RUNNING' && 'animate-spin')} aria-hidden />
      )}
      <span className="sr-only">{STEP_STATE_LABELS[state]}</span>
    </span>
  )
}

/**
 * Inline state label. State is carried by icon + word, never colour alone —
 * SKIPPED in particular must never be mistaken for FAILED.
 */
export function StepStateLabel({ state, note }: { state: StepState; note?: string }) {
  const Icon =
    state === 'SUCCEEDED'
      ? CircleCheckIcon
      : state === 'RUNNING'
        ? LoaderIcon
        : state === 'FAILED'
          ? TriangleAlertIcon
          : state === 'SKIPPED'
            ? MinusIcon
            : CircleSlashIcon

  return (
    <span className="flex items-center gap-3 text-sm">
      <span className={cn('inline-flex items-center gap-1.5 font-medium', STEP_STATE_TEXT[state])}>
        <Icon className={cn('size-3.5', state === 'RUNNING' && 'animate-spin')} aria-hidden />
        {STEP_STATE_LABELS[state]}
      </span>
      {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
    </span>
  )
}

const KPI_TONE_STYLES: Record<KpiTone, string> = {
  primary: 'bg-accent text-accent-foreground',
  success: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  running: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  failed: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
}

const KPI_TONE_ICONS: Record<KpiTone, typeof ActivityIcon> = {
  primary: ActivityIcon,
  success: CircleCheckIcon,
  running: LoaderIcon,
  failed: TriangleAlertIcon,
}

/** Headline metric tile for the Automation overview. */
export function KpiCard({ kpi }: { kpi: Kpi }) {
  const Icon = KPI_TONE_ICONS[kpi.tone]
  // A trend is only rendered when one was actually computed. Phase 2G shows
  // real counts; a period-over-period delta is not stored, so the line is
  // omitted rather than filled with an invented percentage.
  const TrendIcon = kpi.trend?.direction === 'up' ? ArrowUpRightIcon : ArrowDownRightIcon

  return (
    <Card>
      <CardContent className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            KPI_TONE_STYLES[kpi.tone],
          )}
        >
          <Icon className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-2xl font-semibold tracking-tight tabular-nums">
            {kpi.value}
          </p>
          <p className="text-muted-foreground text-sm">{kpi.label}</p>
          {kpi.trend ? (
            <p
              className={cn(
                'mt-2 inline-flex items-center gap-1 text-xs font-medium',
                kpi.trend.positive
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-rose-700 dark:text-rose-400',
              )}
            >
              <TrendIcon className="size-3.5" aria-hidden />
              {kpi.trend.label}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Seven-day success-rate trend.
 *
 * One series, so the card title names it and no legend is needed; the headline
 * number carries the value and the line only carries the shape. Axis ink stays
 * in text tokens — the violet stroke is the only coloured mark.
 */
export function SuccessRateSparkline({
  points,
  className,
}: {
  points: ReadonlyArray<{ label: string; value: number }>
  className?: string
}) {
  const width = 240
  const height = 72
  const last = points.at(-1)
  const coordinates = points.map((point, index) => ({
    x: (index / (points.length - 1)) * width,
    y: height - (point.value / 100) * height,
  }))
  const polyline = coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const end = coordinates.at(-1)

  return (
    <div className={cn('flex gap-2', className)}>
      <div className="text-muted-foreground flex flex-col justify-between text-[10px] tabular-nums">
        <span>100%</span>
        <span>50%</span>
        <span>0%</span>
      </div>
      <div className="min-w-0 flex-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[72px] w-full overflow-visible"
          role="img"
          aria-label={`Success rate over the last 7 days, ending at ${last?.value ?? 0} percent`}
        >
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              x1={0}
              x2={width}
              y1={height * fraction}
              y2={height * fraction}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polyline
            points={polyline}
            fill="none"
            className="stroke-primary"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {end ? <circle cx={end.x} cy={end.y} r={4} className="fill-primary" /> : null}
        </svg>
        <div className="text-muted-foreground mt-1 flex justify-between text-[10px]">
          <span>{points[0]?.label}</span>
          <span>{points[Math.floor(points.length / 2)]?.label}</span>
          <span>{last?.label}</span>
        </div>
      </div>
    </div>
  )
}
