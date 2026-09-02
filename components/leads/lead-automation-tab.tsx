'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { WorkflowIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { RunStatusBadge } from '@/components/automation/automation-ui'
import { RunSteps } from '@/components/automation/run-steps'
import { getLeadAutomationAction } from '@/app/(app)/leads/actions'
import type { LeadAutomationStatus } from '@/lib/services/automation-read'

/**
 * Automation history for a lead, shown inside the existing Lead detail panel
 * (Phase 2G — real WorkflowRun / WorkflowStepRun rows).
 *
 * Fetched when this tab mounts rather than with the leads list: the detail
 * panel is closed by default — behaviour this component does not change — so
 * loading a run for every row would be wasted work.
 */
export function LeadAutomationTab({ leadId }: { leadId: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; data: LeadAutomationStatus }
  >({ status: 'loading' })

  useEffect(() => {
    let active = true

    // No synchronous setState here: the panel remounts this component via a
    //  when the selected lead changes, so the initial 'loading' state is
    // always correct and resetting it would only trigger a cascading render.
    getLeadAutomationAction(leadId).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { status: 'ready', data: result.data }
          : { status: 'error', message: result.message },
      )
    })

    return () => {
      active = false
    }
  }, [leadId])

  if (state.status === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading automation history…</p>
  }

  if (state.status === 'error') {
    return <p className="text-destructive text-sm">{state.message}</p>
  }

  const run = state.data?.latestRun ?? null

  // "Never enrolled" is a different fact from "ran and failed" — say so
  // plainly rather than rendering an empty run.
  if (!run) {
    return (
      <EmptyState
        icon={WorkflowIcon}
        title="No automation runs"
        description="This lead has not been through the qualification pipeline. Only Website Form leads enroll automatically."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5">
        <span className="bg-accent text-accent-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
          <WorkflowIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-foreground text-sm font-medium">AI Lead Qualification Pipeline</p>
            <RunStatusBadge status={run.status} />
          </div>
          <p className="text-muted-foreground text-xs">
            {run.currentStepLabel} · {run.startedLabel}
          </p>
        </div>
      </div>

      <RunSteps steps={run.steps} compact />

      <dl className="border-border flex flex-col gap-2 border-t pt-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted-foreground">Started</dt>
          <dd className="text-foreground text-right">{run.enrolledAtLabel}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted-foreground">Completed</dt>
          <dd className="text-foreground text-right">{run.completedAtLabel ?? '—'}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted-foreground">AI score</dt>
          <dd className="text-foreground text-right tabular-nums">
            {state.data?.qualification.aiScore ?? '—'}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted-foreground">Qualification</dt>
          <dd className="text-foreground text-right">
            {state.data?.qualification.outcome ?? '—'}
            {state.data?.qualification.source ? ` (${state.data.qualification.source})` : null}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted-foreground">Workflow version</dt>
          <dd className="text-foreground text-right tabular-nums">{run.version}</dd>
        </div>
      </dl>

      <Button variant="outline" className="w-full" asChild>
        <Link href={`/automation/runs/${run.id}`}>View Run Details</Link>
      </Button>
    </div>
  )
}
