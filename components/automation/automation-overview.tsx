'use client'

import Link from 'next/link'
import { MoreVerticalIcon, WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
import { KpiCard, WorkflowStatusBadge } from '@/components/automation/automation-ui'
import { EmptyState } from '@/components/ui/empty-state'
import type { Kpi, WorkflowSummaryView } from '@/lib/automation/view-model'

/**
 * Automation overview: headline metrics plus the organization's pipeline.
 *
 * MVP provisions exactly one workflow per organization (docs/architecture.md
 * §10), so the table lists that one pipeline and offers no create action —
 * showing placeholder workflows here would imply a builder the product does
 * not have.
 *
 * Every figure is read from PostgreSQL by
 * lib/services/automation-read.ts — no mock data, and no metric that is not
 * actually stored.
 */
export function AutomationOverview({
  workflow,
  kpis,
}: {
  workflow: WorkflowSummaryView | null
  kpis: Kpi[]
}) {
  if (!workflow) {
    return (
      <div className="p-8">
        <EmptyState
          icon={WorkflowIcon}
          title="No pipeline yet"
          description="Your lead qualification pipeline is created automatically the first time a Website Form lead is captured."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.key} kpi={kpi} />
        ))}
      </div>

      <section className="border-border bg-card overflow-hidden rounded-xl border">
        <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 className="text-foreground text-sm font-semibold">Workflows</h2>
            <p className="text-muted-foreground text-xs">
              Your organization runs one fixed lead qualification pipeline.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/automation/runs">View runs</Link>
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Runs (7d)</TableHead>
              <TableHead>Success Rate</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="whitespace-normal">
                <div className="flex items-start gap-2.5">
                  <span className="bg-accent text-accent-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                    <WorkflowIcon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <Link
                      href="/automation/pipeline"
                      className="text-foreground hover:text-primary text-sm font-medium"
                    >
                      {workflow.name}
                    </Link>
                    <p className="text-muted-foreground max-w-xs text-xs">{workflow.description}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <WorkflowStatusBadge status={workflow.status} />
              </TableCell>
              <TableCell className="text-foreground text-sm tabular-nums">
                {workflow.runsWindowLabel}
              </TableCell>
              <TableCell>
                <div className="w-28">
                  <p className="text-foreground text-sm font-medium tabular-nums">
                    {workflow.successRate}%
                  </p>
                  <div className="bg-muted mt-1 h-1 w-full overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${workflow.successRate}%` }}
                    />
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {workflow.lastRunLabel}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${workflow.name}`}
                    >
                      <MoreVerticalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href="/automation/pipeline">View workflow</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/automation/runs">View runs</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => toast.info('Pausing the pipeline arrives with Phase 2')}
                    >
                      Pause workflow
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div className="border-border border-t px-4 py-3">
          <p className="text-muted-foreground text-sm">Showing 1 to 1 of 1 workflow</p>
        </div>
      </section>
    </div>
  )
}
