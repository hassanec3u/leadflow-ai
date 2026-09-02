'use client'

import Link from 'next/link'
import { ArrowLeftIcon, MoreHorizontalIcon, PauseIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RunStatusBadge, WorkflowStatusBadge } from '@/components/automation/automation-ui'
import {
  PIPELINE_STEP_VIEWS,
  QUALIFICATION_THRESHOLD,
  type WorkflowRunView,
  type WorkflowSummaryView,
} from '@/lib/automation/view-model'

/**
 * Detail view of the single fixed pipeline.
 *
 * The step list is the fixed MVP pipeline — there is no builder, no reordering
 * and no step creation (docs/architecture.md §10). Pause and the overflow
 * actions are visual only in this phase.
 */

/** Live state of each pipeline step, mirroring the workflow's current run. */
/**
 * The pipeline screen shows the workflow DEFINITION. A step has no state of
 * its own outside a run — per-step states live on WorkflowStepRun and are
 * shown on the run detail screen. Painting states here would mean inventing
 * them.
 */
export function WorkflowDetail({
  workflow,
  recentRuns,
}: {
  workflow: WorkflowSummaryView
  recentRuns: WorkflowRunView[]
}) {
  function notImplemented() {
    toast.info('Workflow controls arrive with the Phase 2 backend')
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <Link
          href="/automation"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeftIcon className="size-4" aria-hidden />
          Back to Automation
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight">
                {workflow.name}
              </h1>
              <WorkflowStatusBadge status={workflow.status} />
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{workflow.description}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={notImplemented}>
              <PauseIcon data-icon="inline-start" />
              Pause
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More workflow actions">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/automation/runs">View runs</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={notImplemented}>Duplicate</DropdownMenuItem>
                <DropdownMenuItem onClick={notImplemented}>Export configuration</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview" className="gap-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Pipeline Steps</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col">
                  {PIPELINE_STEP_VIEWS.map((step, index) => {
                    const isLast = index === PIPELINE_STEP_VIEWS.length - 1

                    return (
                      <li key={step.key} className={`relative flex gap-3 ${isLast ? '' : 'pb-5'}`}>
                        {isLast ? null : (
                          <span
                            className="bg-border absolute top-7 bottom-0 left-[13px] w-px"
                            aria-hidden
                          />
                        )}
                        <span
                          className="border-border bg-muted text-muted-foreground relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums"
                          aria-hidden
                        >
                          {step.order}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                          <div className="min-w-0">
                            <p className="text-foreground text-sm font-medium">{step.name}</p>
                            <p className="text-muted-foreground text-xs">{step.detail}</p>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </CardContent>
            </Card>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Success Rate (7d)</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div>
                    <p className="text-foreground text-3xl font-semibold tracking-tight tabular-nums">
                      {workflow.successRate}%
                    </p>
                    {/* No period-over-period delta and no sparkline: neither a
                        trend nor a daily series is stored, and inventing one
                        would misrepresent the pipeline's health. */}
                    <p className="text-muted-foreground text-xs">
                      Share of finished runs that succeeded.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Workflow Stats</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="flex flex-col gap-2 text-sm">
                    {workflow.stats.map((stat) => (
                      <div key={stat.label} className="flex items-center justify-between gap-4">
                        <dt className="text-muted-foreground">{stat.label}</dt>
                        <dd className="text-foreground font-medium tabular-nums">{stat.value}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-foreground text-sm font-medium">Last Run</span>
                {workflow.lastRunStatus ? <RunStatusBadge status={workflow.lastRunStatus} /> : null}
                <span className="text-muted-foreground text-sm">{workflow.lastRunLabel}</span>
              </div>
              <Button variant="outline" asChild>
                <Link href="/automation/runs">View Runs</Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs" className="flex flex-col gap-4">
          <section className="border-border bg-card overflow-hidden rounded-xl border">
            <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-foreground text-sm font-semibold">Recent runs</h2>
              <Button variant="outline" size="sm" asChild>
                <Link href="/automation/runs">View all runs</Link>
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link
                        href={`/automation/runs/${run.id}`}
                        className="text-foreground hover:text-primary text-sm font-medium"
                      >
                        {run.lead.name}
                      </Link>
                      <p className="text-muted-foreground text-xs">{run.lead.email}</p>
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {run.startedLabel}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {run.durationLabel}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </TabsContent>

        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Trigger source</dt>
                  <dd className="text-foreground font-medium">{workflow.trigger}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Qualification threshold</dt>
                  <dd className="text-foreground font-medium tabular-nums">
                    {QUALIFICATION_THRESHOLD}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Automatic enrollment</dt>
                  <dd className="text-foreground font-medium">Website Form only</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Duplicate leads</dt>
                  <dd className="text-foreground font-medium">Update existing, no new run</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Workflow version</dt>
                  <dd className="text-foreground font-medium tabular-nums">{workflow.version}</dd>
                </div>
              </dl>
              <p className="text-muted-foreground text-xs">
                The pipeline is fixed: its steps and order are not editable.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
