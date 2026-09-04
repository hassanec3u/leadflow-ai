'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeftIcon, MailXIcon, RotateCcwIcon, TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LeadAvatar } from '@/components/leads/lead-avatar'
import { RunStatusBadge } from '@/components/automation/automation-ui'
import { RunSteps } from '@/components/automation/run-steps'
import { QUALIFICATION_THRESHOLD, type WorkflowRunView } from '@/lib/automation/view-model'
import { requestManualRerunAction } from '@/app/(app)/automation/runs/actions'

/**
 * Detail of a single run: per-step outcome, metadata, trigger payload and logs.
 *
 * Every state a reviewer needs to distinguish is represented here — running,
 * completed, completed-with-email-skipped and failed. Re-run triggers the
 * real Manual Rerun action; the log view remains visual only in this phase.
 */
export function RunDetail({ run, workflowName }: { run: WorkflowRunView; workflowName: string }) {
  const router = useRouter()
  const [tab, setTab] = useState('steps')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  /**
   * One shared handler behind both "Re-run Workflow" buttons (the failed
   * callout and the summary card): a single `rerunning` flag disables both at
   * once, so a double click — either on the same button or across the two —
   * can never fire two requests. The server-side conflict guard
   * (`workflow_runs_one_active_per_lead_key`, surfaced as a ConflictError) is
   * the real backstop; this only avoids an avoidable extra round trip.
   */
  async function handleConfirmRerun() {
    setRerunning(true)
    const result = await requestManualRerunAction(run.id)
    setRerunning(false)
    setConfirmOpen(false)

    if (!result.ok) {
      toast.error(result.message)
      return
    }

    toast.success('Workflow re-run started')
    // The rerun is a NEW WorkflowRun — navigate to it, then refresh so the
    // server-rendered detail (and every cache router.refresh() invalidates,
    // e.g. the lead's Automation tab) reflects it immediately rather than on
    // the next natural navigation.
    router.push(`/automation/runs/${result.runId}`)
    router.refresh()
  }

  const isFailed = run.status === 'FAILED'
  const isEmailSkipped =
    run.status === 'SUCCEEDED' && run.aiScore !== null && run.aiScore < QUALIFICATION_THRESHOLD
  const failedStep = run.steps.find((step) => step.state === 'FAILED')
  const timeLabel =
    run.status === 'RUNNING'
      ? `Started ${run.startedLabel}`
      : run.status === 'FAILED'
        ? `Failed ${run.startedLabel}`
        : run.status === 'BLOCKED'
          ? `Blocked ${run.startedLabel}`
          : run.status === 'PENDING'
            ? `Queued ${run.startedLabel}`
            : `Completed ${run.startedLabel}`

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <Link
          href="/automation/runs"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeftIcon className="size-4" aria-hidden />
          Back to Runs
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <LeadAvatar name={run.lead.name} size="lg" />
            <div className="min-w-0">
              <h1 className="text-foreground text-xl font-semibold tracking-tight">
                {run.lead.name}
              </h1>
              <p className="text-muted-foreground text-sm">{run.lead.email}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <RunStatusBadge status={run.status} />
                {isEmailSkipped ? (
                  <Badge variant="outline" className="font-medium">
                    Email skipped
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge variant="secondary" className="font-mono">
              Run {run.reference}
            </Badge>
            <span className="text-muted-foreground text-sm">{timeLabel}</span>
          </div>
        </div>
      </div>

      {isFailed ? (
        <Callout tone="failed">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex gap-3">
              <TriangleAlertIcon className="text-destructive mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <p className="text-foreground text-sm font-semibold">
                  Workflow failed — manual review required
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {failedStep?.error?.message ?? 'A step failed'} — failed after{' '}
                  {failedStep?.error?.attempts ?? 3} attempts. No outreach email was sent and no
                  team notification was posted.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setTab('logs')}>
                View Logs
              </Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={rerunning}>
                <RotateCcwIcon data-icon="inline-start" />
                Re-run Workflow
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}

      {isEmailSkipped ? (
        <Callout tone="skipped">
          <div className="flex gap-3">
            <MailXIcon
              className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            <div>
              <p className="text-foreground text-sm font-semibold">
                Completed successfully — outreach email skipped
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                AI score {run.aiScore} is below the qualification threshold (
                {QUALIFICATION_THRESHOLD}), so Send Email and Notify Team were skipped. The run
                itself succeeded — skipped is not a failure.
              </p>
            </div>
          </div>
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Tabs value={tab} onValueChange={setTab} className="gap-4">
            <TabsList>
              <TabsTrigger value="steps">Steps</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="input">Input</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>

            <TabsContent value="steps">
              <Card>
                <CardContent>
                  <RunSteps steps={run.steps} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="details">
              <Card>
                <CardHeader>
                  <CardTitle>Run details</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                    <SummaryRow label="Lead" value={run.lead.name} />
                    <SummaryRow label="Company" value={run.lead.company} />
                    <SummaryRow label="Email" value={run.lead.email} />
                    <SummaryRow label="Trigger" value={run.trigger} />
                    <SummaryRow label="Enrolled At" value={run.enrolledAtLabel} />
                    <SummaryRow label="Completed At" value={run.completedAtLabel ?? '—'} />
                    <SummaryRow label="Duration" value={run.durationLabel} />
                    <SummaryRow
                      label="AI Score"
                      value={run.aiScore === null ? '—' : `${run.aiScore} / 100`}
                    />
                    {/* Attribution and cost: which prompt and model produced this
                        score, and what it cost. Operator information — it is
                        deliberately absent from the sales-facing lead panel. */}
                    {run.aiTelemetry ? (
                      <>
                        <SummaryRow label="AI Model" value={run.aiTelemetry.model ?? '—'} />
                        <SummaryRow
                          label="Prompt Version"
                          value={run.aiTelemetry.promptVersion ?? '—'}
                        />
                        <SummaryRow
                          label="Tokens"
                          value={
                            run.aiTelemetry.totalTokens === null
                              ? '—'
                              : `${run.aiTelemetry.totalTokens} (${run.aiTelemetry.inputTokens ?? '?'} in / ${run.aiTelemetry.outputTokens ?? '?'} out)`
                          }
                        />
                      </>
                    ) : null}
                  </dl>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="input">
              <Card>
                <CardHeader>
                  <CardTitle>Trigger payload</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {/* Full width and wrapping: this is arbitrary-length free
                      text from a stranger, not a summary value. */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-muted-foreground text-sm">Form message</p>
                    {run.formMessage ? (
                      <p className="border-border bg-muted/40 text-foreground rounded-lg border p-3 text-sm break-words whitespace-pre-wrap">
                        {run.formMessage}
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-sm italic">
                        The form collected no message — the lead stated no intent.
                      </p>
                    )}
                  </div>

                  <dl className="flex flex-col gap-2 text-sm">
                    {run.input.map((entry) => (
                      <div
                        key={entry.label}
                        className="flex flex-wrap items-start justify-between gap-4"
                      >
                        <dt className="text-muted-foreground">{entry.label}</dt>
                        <dd className="text-foreground max-w-md text-right">{entry.value}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="logs">
              <Card>
                <CardHeader>
                  <CardTitle>Execution log</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col gap-1.5 font-mono text-xs">
                    {run.logs.map((entry, index) => (
                      <li key={index} className="flex flex-wrap gap-2">
                        <span className="text-muted-foreground shrink-0">{entry.time}</span>
                        <span
                          className={cn(
                            'w-12 shrink-0 font-semibold uppercase',
                            entry.level === 'error'
                              ? 'text-destructive'
                              : entry.level === 'warn'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-muted-foreground',
                          )}
                        >
                          {entry.level}
                        </span>
                        <span className="text-foreground min-w-0">{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Run Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-2.5 text-sm">
              <SummaryRow label="Workflow" value={workflowName} />
              <SummaryRow label="Trigger" value={run.trigger} />
              <SummaryRow label="Enrolled At" value={run.enrolledAtLabel} />
              <SummaryRow label="Version" value={run.version} />
              <SummaryRow
                label={run.status === 'RUNNING' ? 'Current Step' : 'Last Step'}
                value={run.currentStepLabel}
              />
              <SummaryRow
                label={run.status === 'RUNNING' ? 'Elapsed' : 'Duration'}
                value={run.durationLabel}
              />
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">Result</dt>
                <dd
                  className={cn(
                    'text-right font-medium',
                    isFailed
                      ? 'text-destructive'
                      : isEmailSkipped
                        ? 'text-amber-700 dark:text-amber-400'
                        : run.status === 'RUNNING'
                          ? 'text-primary'
                          : 'text-emerald-700 dark:text-emerald-400',
                  )}
                >
                  {run.outcomeLabel}
                </dd>
              </div>
            </dl>

            {isFailed ? (
              <Button
                className="mt-4 w-full"
                onClick={() => setConfirmOpen(true)}
                disabled={rerunning}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Re-run Workflow
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(next) => !rerunning && setConfirmOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-run this workflow?</DialogTitle>
            <DialogDescription>
              This starts a new run for {run.lead.name} from the beginning — Enrich Lead through
              Notify Team. The failed run stays in history; nothing about it is retried in place.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={rerunning}>
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmRerun()} disabled={rerunning}>
              {rerunning ? 'Re-running…' : 'Re-run Workflow'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Callout({ tone, children }: { tone: 'failed' | 'skipped'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        tone === 'failed'
          ? 'border-destructive/25 bg-destructive/5'
          : 'border-amber-200 bg-amber-50/60 dark:border-amber-500/25 dark:bg-amber-500/10',
      )}
    >
      {children}
    </div>
  )
}

/** One label/value line in a definition list. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground text-right font-medium">{value}</dd>
    </div>
  )
}
