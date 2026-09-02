import { cn } from '@/lib/utils'
import { StepStateIcon, StepStateLabel } from '@/components/automation/automation-ui'
import type { RunStepView as RunStep } from '@/lib/automation/view-model'

/**
 * Vertical step timeline for a single run.
 *
 * Shared by the run detail screens and the Lead detail Automation tab so a run
 * reads identically wherever it is inspected. `compact` drops the secondary
 * lines for the narrow lead panel.
 */
export function RunSteps({
  steps,
  compact = false,
  className,
}: {
  steps: readonly RunStep[]
  compact?: boolean
  className?: string
}) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1

        return (
          <li key={step.key} className={cn('relative flex gap-3', isLast ? 'pb-0' : 'pb-5')}>
            {isLast ? null : (
              <span className="bg-border absolute top-7 bottom-0 left-[13px] w-px" aria-hidden />
            )}
            <StepStateIcon state={step.state} />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">
                    {step.order}. {step.name}
                  </p>
                  {compact ? null : <p className="text-muted-foreground text-xs">{step.detail}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StepStateLabel state={step.state} note={compact ? undefined : step.note} />
                  <span className="text-muted-foreground w-14 text-right text-xs tabular-nums">
                    {step.duration ?? ''}
                  </span>
                </div>
              </div>

              {step.score ? <ScoreCallout score={step.score} compact={compact} /> : null}
              {step.aiResult ? <AiResultCallout result={step.aiResult} compact={compact} /> : null}
              {step.error ? <ErrorCallout error={step.error} /> : null}
              {step.reason ? (
                <p className="border-border bg-muted/60 text-muted-foreground mt-2 rounded-lg border border-dashed px-3 py-2 text-xs">
                  {step.reason}
                </p>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function ScoreCallout({
  score,
  compact,
}: {
  score: NonNullable<RunStep['score']>
  compact: boolean
}) {
  return (
    <div
      className={cn(
        'mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2',
        score.qualified
          ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/25 dark:bg-emerald-500/10'
          : 'border-amber-200 bg-amber-50/60 dark:border-amber-500/25 dark:bg-amber-500/10',
      )}
    >
      <div className="text-sm">
        <p className="text-foreground font-medium tabular-nums">Score: {score.value} / 100</p>
        {compact ? null : (
          <p className="text-muted-foreground text-xs">
            Qualification:{' '}
            <span className="text-foreground font-semibold">
              {score.qualified ? 'QUALIFIED' : 'UNQUALIFIED'}
            </span>
          </p>
        )}
      </div>
      <span
        className={cn(
          'text-xs font-medium',
          score.qualified
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400',
        )}
      >
        {score.qualified
          ? `At or above threshold (${score.threshold})`
          : `Below threshold (${score.threshold})`}
      </span>
    </div>
  )
}

/**
 * The model's own explanation of the score.
 *
 * Framed as "the AI assessed", never as fact: this is LLM prose derived from
 * text an anonymous stranger typed. Rendered as text — React escapes it — and
 * the model's own hedging ("contact claims to be VP") is preserved verbatim
 * rather than summarised away.
 */
function AiResultCallout({
  result,
  compact,
}: {
  result: NonNullable<RunStep['aiResult']>
  compact: boolean
}) {
  return (
    <div className="border-border bg-muted/40 mt-2 flex flex-col gap-2 rounded-lg border px-3 py-2">
      <div>
        <p className="text-muted-foreground text-xs font-medium">AI assessment</p>
        <p className="text-foreground mt-0.5 text-sm break-words whitespace-pre-wrap">
          {result.summary}
        </p>
      </div>

      {/* Shown even in the compact lead panel: this is the one line written
          for the sales rep, and the panel is where they decide what to do. */}
      <div>
        <p className="text-muted-foreground text-xs font-medium">Recommended next step</p>
        <p className="text-foreground mt-0.5 text-sm break-words whitespace-pre-wrap">
          {result.recommendedAction}
        </p>
      </div>

      {/* Tags are scanning aid, not decision input — dropped in the narrow panel. */}
      {!compact && result.keywords.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {result.keywords.map((keyword) => (
            <li
              key={keyword}
              className="border-border bg-background text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
            >
              {keyword}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ErrorCallout({ error }: { error: NonNullable<RunStep['error']> }) {
  return (
    <div className="border-destructive/25 bg-destructive/5 mt-2 rounded-lg border px-3 py-2">
      <p className="text-destructive text-sm font-medium">Error: {error.message}</p>
      <p className="text-muted-foreground text-xs">Failed after {error.attempts} attempts</p>
    </div>
  )
}
