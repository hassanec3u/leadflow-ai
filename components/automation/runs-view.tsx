'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, WorkflowIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { LeadAvatar } from '@/components/leads/lead-avatar'
import { LeadFilterMenu } from '@/components/leads/lead-filter-menu'
import { RunStatusBadge } from '@/components/automation/automation-ui'
import {
  AUTOMATION_RUNS_PAGE_SIZE,
  type RunStatus,
  type WorkflowRunView,
} from '@/lib/automation/view-model'

/**
 * Run history for the pipeline.
 *
 * Filtering, search and pagination run on the client over the recent runs the
 * server already loaded, so the counts shown are the real counts of that set.
 */

const STATUS_OPTIONS: readonly RunStatus[] = [
  'SUCCEEDED',
  'RUNNING',
  'PENDING',
  'FAILED',
  'BLOCKED',
]

const STATUS_LABELS: Record<RunStatus, string> = {
  SUCCEEDED: 'Succeeded',
  RUNNING: 'Running',
  PENDING: 'Queued',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
}

const DATE_RANGES = [
  { key: '1', label: 'Last 24 hours' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
] as const

export function RunsView({ allRuns }: { allRuns: WorkflowRunView[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<string | null>('7')
  const [page, setPage] = useState(1)

  const query = search.trim().toLowerCase()
  const maxDays = dateRange ? Number(dateRange) : null

  const runs = allRuns.filter((run) => {
    if (status && run.status !== status) return false
    if (maxDays !== null && run.startedDaysAgo > maxDays) return false
    if (!query) return true
    return (
      run.lead.name.toLowerCase().includes(query) ||
      run.lead.email.toLowerCase().includes(query) ||
      run.reference.includes(query)
    )
  })

  const pageCount = Math.max(1, Math.ceil(runs.length / AUTOMATION_RUNS_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const start = (currentPage - 1) * AUTOMATION_RUNS_PAGE_SIZE
  const visibleRuns = runs.slice(start, start + AUTOMATION_RUNS_PAGE_SIZE)

  function resetPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value)
      setPage(1)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-8">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder="Search leads..."
            className="pl-8"
          />
        </div>

        <LeadFilterMenu
          label="Status"
          value={status}
          options={STATUS_OPTIONS}
          onChange={resetPage(setStatus)}
          formatOption={(option) => STATUS_LABELS[option as RunStatus]}
          allOptionLabel="All statuses"
        />
        <LeadFilterMenu
          label="Date"
          value={dateRange}
          options={DATE_RANGES.map((range) => range.key)}
          onChange={resetPage(setDateRange)}
          formatOption={(option) =>
            DATE_RANGES.find((range) => range.key === option)?.label ?? option
          }
          allOptionLabel="All time"
        />

        {search || status || dateRange !== '7' ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('')
              setStatus(null)
              setDateRange('7')
              setPage(1)
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      <div className="border-border bg-card overflow-hidden rounded-xl border">
        {visibleRuns.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={WorkflowIcon}
              title="No runs match your filters"
              description="Try a different search term, status or date range to see more runs."
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Current Step</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRuns.map((run) => (
                  <TableRow
                    key={run.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/automation/runs/${run.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <LeadAvatar name={run.lead.name} />
                        <div className="min-w-0">
                          <Link
                            href={`/automation/runs/${run.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-foreground hover:text-primary truncate text-sm font-medium"
                          >
                            {run.lead.name}
                          </Link>
                          <p className="text-muted-foreground truncate text-xs">{run.lead.email}</p>
                        </div>
                      </div>
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
                    <TableCell className="text-foreground text-sm">
                      {run.currentStepLabel}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
              <p className="text-muted-foreground text-sm">
                Showing {start + 1} to {start + visibleRuns.length} of {runs.length} runs
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={currentPage === 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeftIcon />
                </Button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <Button
                    key={n}
                    variant={n === currentPage ? 'default' : 'outline'}
                    size="icon-sm"
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={currentPage === pageCount}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
