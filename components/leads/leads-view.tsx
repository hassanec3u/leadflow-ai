'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  Loader2Icon,
  LayoutGridIcon,
  ListIcon,
  MoreVerticalIcon,
  SearchIcon,
  TriangleAlertIcon,
  UsersIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { AddLeadDialog } from '@/components/leads/add-lead-dialog'
import { ImportCsvDialog } from '@/components/leads/import-csv-dialog'
import { LeadAvatar } from '@/components/leads/lead-avatar'
import { AiScoreBadge, QualificationBadge, StatusBadge } from '@/components/leads/lead-badges'
import { LeadDetailPanel } from '@/components/leads/lead-detail-panel'
import { LeadFilterMenu } from '@/components/leads/lead-filter-menu'
import { formatEnumLabel, formatRelativeTime } from '@/components/leads/lead-format'
import {
  LEAD_QUALIFICATION_OPTIONS,
  LEAD_SOURCE_OPTIONS,
  LEAD_STATUS_OPTIONS,
  LEADS_PAGE_SIZE,
  UNASSIGNED_OWNER_FILTER,
} from '@/lib/validation/leads'
import type { LeadWithOwner, ListLeadsResult } from '@/lib/services/leads'
import { deleteLeadAction, listLeadsAction, updateLeadAction } from '@/app/(app)/leads/actions'

type SortField = 'name' | 'createdAt'
type UiState = 'idle' | 'loading' | 'error'

/**
 * The filter menu shows the pipeline's verdict. "Unscored" is not a stored
 * value — it means the pipeline has not decided yet — so it needs its own
 * label rather than `formatEnumLabel`.
 */
const QUALIFICATION_FILTER_LABELS: Record<string, string> = {
  QUALIFIED: 'Qualified',
  UNQUALIFIED: 'Unqualified',
  UNSCORED: 'Unscored',
}

function formatQualificationFilter(value: string) {
  return QUALIFICATION_FILTER_LABELS[value] ?? value
}

export function LeadsView({
  initialResult,
  initialError,
}: {
  initialResult: ListLeadsResult | null
  initialError: string | null
}) {
  const [leads, setLeads] = useState<LeadWithOwner[]>(initialResult?.leads ?? [])
  const [total, setTotal] = useState(initialResult?.total ?? 0)
  const [uiState, setUiState] = useState<UiState>(initialError ? 'error' : 'idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(initialError)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [qualification, setQualification] = useState<string | null>(null)
  const router = useRouter()
  const [source, setSource] = useState<string | null>(null)
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortField>('createdAt')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [page, setPage] = useState(1)
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null)
  const [ownerOptions, setOwnerOptions] = useState<Array<{ id: string; label: string }>>([])

  const hasActiveFilters = Boolean(search || status || qualification || source || ownerId)
  const pageCount = Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE))
  const selectedLead = leads.find((lead) => lead.id === selectedLeadId) ?? null

  // Debounce the search box so every keystroke doesn't trigger a server round trip.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timeout)
  }, [search])

  const fetchLeads = useCallback(async () => {
    setUiState('loading')
    setErrorMessage(null)

    const result = await listLeadsAction({
      page,
      pageSize: LEADS_PAGE_SIZE,
      search: debouncedSearch || undefined,
      status: status ?? undefined,
      qualification: qualification ?? undefined,
      source: source ?? undefined,
      ownerId: ownerId ?? undefined,
      sortBy,
      sortDirection,
    })

    if (!result.ok) {
      setUiState('error')
      setErrorMessage(result.message)
      return
    }

    setLeads(result.data.leads)
    setTotal(result.data.total)
    setUiState('idle')
  }, [page, debouncedSearch, status, qualification, source, ownerId, sortBy, sortDirection])

  /**
   * Re-read BOTH caches after a mutation.
   *
   * `fetchLeads()` updates this component's own state, which is what the user
   * sees immediately. `router.refresh()` invalidates the SERVER-rendered
   * payload that app/(app)/leads/page.tsx passes in as `initialResult` — a
   * snapshot held in `useState`, so new props alone would never replace it.
   * Without it, navigating away and back re-hydrates from stale data: an old
   * AI score for a lead the pipeline has since scored, for instance.
   *
   * Deliberately not polling: a run finishes once, and interrogating the
   * database on a timer to catch that moment costs far more than it returns.
   */
  const refreshLeads = useCallback(() => {
    void fetchLeads()
    router.refresh()
  }, [fetchLeads, router])

  // Skip the fetch on first mount when the server already supplied the
  // (default-query) first page — avoids a redundant round trip and loading
  // flash right after the page renders.
  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (initialResult) return
    }
    void fetchLeads()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, status, qualification, source, ownerId, sortBy, sortDirection])

  // Owner filter options: derived once from a broader, unfiltered fetch — the
  // service exposes no separate "list org members" operation, and adding one
  // is out of scope for this task, so options are limited to owners who have
  // at least one lead (a reasonable limitation, not an invented capability).
  useEffect(() => {
    void (async () => {
      const result = await listLeadsAction({ page: 1, pageSize: 100 })
      if (!result.ok) return
      const byId = new Map<string, string>()
      for (const lead of result.data.leads) {
        if (!lead.owner) continue // Unassigned — not an owner to offer as a filter option.
        byId.set(lead.owner.id, lead.owner.name ?? lead.owner.email)
      }
      setOwnerOptions([...byId.entries()].map(([id, label]) => ({ id, label })))
    })()
  }, [])

  function updateFilterAndResetPage(setter: (value: string | null) => void) {
    return (value: string | null) => {
      setter(value)
      setPage(1)
    }
  }

  function clearFilters() {
    setSearch('')
    setDebouncedSearch('')
    setStatus(null)
    setQualification(null)
    setSource(null)
    setOwnerId(null)
    setPage(1)
  }

  function toggleSort(field: SortField) {
    if (sortBy === field) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(field)
      setSortDirection(field === 'createdAt' ? 'desc' : 'asc')
    }
    setPage(1)
  }

  function sortIndicator(field: SortField) {
    if (sortBy !== field) return null
    return sortDirection === 'asc' ? (
      <ArrowUpIcon className="size-3.5" aria-hidden />
    ) : (
      <ArrowDownIcon className="size-3.5" aria-hidden />
    )
  }

  /** A lead was created via the real service (see AddLeadDialog) — reload the current page to reflect it. */
  function handleLeadCreated() {
    refreshLeads()
  }

  async function handleDeleteLead(id: string) {
    const result = await deleteLeadAction(id)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    if (selectedLeadId === id) setSelectedLeadId(null)
    toast.success('Lead deleted')
    refreshLeads()
  }

  /** Persists an edit from the detail panel via the real service, then refreshes the list. */
  async function handleSaveLead(
    id: string,
    changes: Partial<{ name: string; email: string; company: string; phone: string }>,
  ) {
    const result = await updateLeadAction(id, changes)
    if (result.ok) {
      refreshLeads()
    }
    return result
  }

  return (
    <>
      <PageHeader
        title="Leads"
        description="Manage and track your leads"
        actions={
          <>
            <ImportCsvDialog onImported={refreshLeads} />
            <Button variant="outline" onClick={() => toast.info('Export arrives in a later phase')}>
              <DownloadIcon data-icon="inline-start" />
              Export
            </Button>
            <AddLeadDialog onCreated={handleLeadCreated} />
          </>
        }
      />

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
            options={LEAD_STATUS_OPTIONS}
            onChange={updateFilterAndResetPage(setStatus)}
            formatOption={formatEnumLabel}
          />
          <LeadFilterMenu
            label="Qualification"
            value={qualification}
            options={LEAD_QUALIFICATION_OPTIONS}
            onChange={updateFilterAndResetPage(setQualification)}
            formatOption={formatQualificationFilter}
          />
          <LeadFilterMenu
            label="Source"
            value={source}
            options={LEAD_SOURCE_OPTIONS}
            onChange={updateFilterAndResetPage(setSource)}
            formatOption={formatEnumLabel}
          />
          <LeadFilterMenu
            label="Owner"
            value={ownerId}
            // Unassigned first: a lead with no owner is a first-class state
            // (ownerId is nullable by design), and these are usually the rows
            // someone is looking for.
            options={[UNASSIGNED_OWNER_FILTER, ...ownerOptions.map((o) => o.id)]}
            onChange={updateFilterAndResetPage(setOwnerId)}
            formatOption={(id) =>
              id === UNASSIGNED_OWNER_FILTER
                ? 'Unassigned'
                : (ownerOptions.find((o) => o.id === id)?.label ?? id)
            }
          />

          {hasActiveFilters ? (
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground text-sm">View</span>
            <div className="border-border inline-flex rounded-lg border p-0.5">
              <Button
                variant={view === 'list' ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setView('list')}
                aria-label="List view"
                aria-pressed={view === 'list'}
              >
                <ListIcon />
              </Button>
              <Button
                variant={view === 'grid' ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setView('grid')}
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
              >
                <LayoutGridIcon />
              </Button>
            </div>
          </div>
        </div>

        <div className="border-border bg-card flex overflow-hidden rounded-xl border">
          <div className="min-w-0 flex-1 overflow-auto">
            {uiState === 'loading' ? (
              <div className="p-8">
                <EmptyState
                  icon={Loader2Icon}
                  title="Loading leads…"
                  description="Fetching the latest leads for your organization."
                />
              </div>
            ) : uiState === 'error' ? (
              <div className="p-8">
                <EmptyState
                  icon={TriangleAlertIcon}
                  title="Couldn't load leads"
                  description={errorMessage ?? 'Something went wrong. Please try again.'}
                  action={
                    <Button variant="outline" onClick={() => void fetchLeads()}>
                      Retry
                    </Button>
                  }
                />
              </div>
            ) : leads.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  icon={UsersIcon}
                  title="No leads match your filters"
                  description="Try a different search term or clear your filters to see all leads."
                />
              </div>
            ) : view === 'list' ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>
                      <button
                        type="button"
                        onClick={() => toggleSort('name')}
                        className="hover:text-foreground inline-flex items-center gap-1"
                      >
                        Lead {sortIndicator('name')}
                      </button>
                    </TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead title="Where the lead is in your sales process">Status</TableHead>
                    <TableHead title="AI assessment of lead potential">Qualification</TableHead>
                    <TableHead title="AI qualification score, 0–100">AI Score</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>
                      <button
                        type="button"
                        onClick={() => toggleSort('createdAt')}
                        className="hover:text-foreground inline-flex items-center gap-1"
                      >
                        Created {sortIndicator('createdAt')}
                      </button>
                    </TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead) => {
                    const ownerLabel = lead.owner
                      ? (lead.owner.name ?? lead.owner.email)
                      : 'Unassigned'
                    return (
                      <TableRow
                        key={lead.id}
                        data-state={selectedLeadId === lead.id ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => setSelectedLeadId(lead.id)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="accent-primary"
                            aria-label={`Select ${lead.name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <LeadAvatar name={lead.name} />
                            <div className="min-w-0">
                              <p className="text-foreground truncate text-sm font-medium">
                                {lead.name}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">{lead.email}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-foreground text-sm">
                          {lead.company ?? '—'}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={lead.status} />
                        </TableCell>
                        <TableCell>
                          <QualificationBadge outcome={lead.qualificationOutcome} />
                        </TableCell>
                        <TableCell>
                          <AiScoreBadge score={lead.aiScore} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatEnumLabel(lead.source)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <LeadAvatar name={ownerLabel} />
                            <span className="text-foreground text-sm">{ownerLabel}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatRelativeTime(lead.createdAt)}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Actions for ${lead.name}`}
                              >
                                <MoreVerticalIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setSelectedLeadId(lead.id)}>
                                View details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setSelectedLeadId(lead.id)}>
                                Edit lead
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => void handleDeleteLead(lead.id)}
                              >
                                Delete lead
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                {leads.map((lead) => {
                  const ownerLabel = lead.owner
                    ? (lead.owner.name ?? lead.owner.email)
                    : 'Unassigned'
                  return (
                    <button
                      key={lead.id}
                      type="button"
                      onClick={() => setSelectedLeadId(lead.id)}
                      data-state={selectedLeadId === lead.id ? 'selected' : undefined}
                      className="border-border hover:border-ring flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors data-[state=selected]:border-ring data-[state=selected]:bg-muted"
                    >
                      <div className="flex items-center gap-2.5">
                        <LeadAvatar name={lead.name} />
                        <div className="min-w-0">
                          <p className="text-foreground truncate text-sm font-medium">
                            {lead.name}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">{lead.email}</p>
                        </div>
                      </div>
                      <p className="text-foreground text-sm">{lead.company ?? '—'}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={lead.status} />
                        <QualificationBadge outcome={lead.qualificationOutcome} />
                        <AiScoreBadge score={lead.aiScore} />
                      </div>
                      <div className="text-muted-foreground flex items-center justify-between text-xs">
                        <span>{ownerLabel}</span>
                        <span>{formatRelativeTime(lead.createdAt)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {uiState === 'idle' && leads.length > 0 ? (
              <div className="border-border flex items-center justify-between border-t px-4 py-3">
                <p className="text-muted-foreground text-sm">
                  Showing {(page - 1) * LEADS_PAGE_SIZE + 1} to{' '}
                  {(page - 1) * LEADS_PAGE_SIZE + leads.length} of {total} leads
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={page === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeftIcon />
                  </Button>
                  {Array.from({ length: pageCount }, (_, i) => i + 1)
                    .filter((n) => n === 1 || n === pageCount || Math.abs(n - page) <= 1)
                    .reduce<number[]>((acc, n) => {
                      const prev = acc.at(-1)
                      if (prev !== undefined && n - prev > 1) acc.push(-1)
                      acc.push(n)
                      return acc
                    }, [])
                    .map((n, i) =>
                      n === -1 ? (
                        <span key={`ellipsis-${i}`} className="text-muted-foreground px-1 text-sm">
                          …
                        </span>
                      ) : (
                        <Button
                          key={n}
                          variant={n === page ? 'default' : 'outline'}
                          size="icon-sm"
                          onClick={() => setPage(n)}
                        >
                          {n}
                        </Button>
                      ),
                    )}
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={page === pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {selectedLead ? (
            <LeadDetailPanel
              lead={selectedLead}
              onClose={() => setSelectedLeadId(null)}
              onSave={handleSaveLead}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}
