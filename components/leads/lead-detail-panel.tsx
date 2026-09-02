'use client'

import { useState } from 'react'
import {
  Building2Icon,
  FileIcon,
  MailIcon,
  MessageSquareIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  StickyNoteIcon,
  XIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LeadAutomationTab } from '@/components/leads/lead-automation-tab'
import { LeadAvatar } from '@/components/leads/lead-avatar'
import { QualificationBadge, StatusBadge } from '@/components/leads/lead-badges'
import { formatDateTime, formatEnumLabel, formatRelativeTime } from '@/components/leads/lead-format'
import type { LeadMutationActionResult } from '@/app/(app)/leads/actions'
import type { LeadWithOwner } from '@/lib/services/leads'

type EditableFields = { name: string; email: string; company: string; phone: string }

export function LeadDetailPanel({
  lead,
  onClose,
  onSave,
}: {
  lead: LeadWithOwner
  onClose: () => void
  /** Persists an edit via the real Lead service (see leads-view.tsx). */
  onSave: (leadId: string, changes: Partial<EditableFields>) => Promise<LeadMutationActionResult>
}) {
  // Tags have no backing Lead column yet (docs/product-spec.md §5 lists no
  // such field) — kept as a local, non-persisted affordance so the panel's
  // approved layout is unchanged; nothing here is saved.
  const [tags, setTags] = useState<string[]>([])
  const ownerLabel = lead.owner ? (lead.owner.name ?? lead.owner.email) : 'Unassigned'

  const [isEditing, setIsEditing] = useState(false)
  const [form, setForm] = useState<EditableFields>(() => toForm(lead))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState(false)

  function startEditing() {
    setForm(toForm(lead))
    setFieldErrors({})
    setIsEditing(true)
  }

  function cancelEditing() {
    setIsEditing(false)
    setFieldErrors({})
  }

  async function handleSave() {
    setSaving(true)
    setFieldErrors({})

    const result = await onSave(lead.id, {
      name: form.name.trim(),
      email: form.email.trim(),
      company: form.company.trim() || undefined,
      phone: form.phone.trim() || undefined,
    })

    setSaving(false)

    if (!result.ok) {
      if (result.fieldErrors) setFieldErrors(result.fieldErrors)
      toast.error(result.message)
      return
    }

    toast.success('Lead updated')
    setIsEditing(false)
  }

  return (
    <aside className="border-border bg-card flex w-[380px] shrink-0 flex-col overflow-y-auto border-l">
      <div className="flex items-start justify-between gap-2 px-5 pt-5">
        <div className="flex items-start gap-3">
          <LeadAvatar name={lead.name} size="lg" />
          <div className="min-w-0">
            <h2 className="text-foreground truncate text-base font-semibold">{lead.name}</h2>
            <p className="text-muted-foreground truncate text-sm">{lead.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!isEditing ? (
            <Button variant="ghost" size="icon-sm" onClick={startEditing} aria-label="Edit lead">
              <PencilIcon />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close lead details">
            <XIcon />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-5 pt-3">
        <StatusBadge status={lead.status} />
        <QualificationBadge outcome={lead.qualificationOutcome} />
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-3 px-5 pt-4 pb-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-lead-name">Name</Label>
            <Input
              id="edit-lead-name"
              value={form.name}
              onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
            />
            {fieldErrors.name ? (
              <p className="text-destructive text-xs">{fieldErrors.name[0]}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-lead-email">Email</Label>
            <Input
              id="edit-lead-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((current) => ({ ...current, email: e.target.value }))}
            />
            {fieldErrors.email ? (
              <p className="text-destructive text-xs">{fieldErrors.email[0]}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-lead-company">Company</Label>
            <Input
              id="edit-lead-company"
              value={form.company}
              onChange={(e) => setForm((current) => ({ ...current, company: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-lead-phone">Phone</Label>
            <Input
              id="edit-lead-phone"
              value={form.phone}
              onChange={(e) => setForm((current) => ({ ...current, phone: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={cancelEditing} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="px-5 pt-4">
          <Tabs defaultValue="overview">
            <TabsList className="max-w-full overflow-x-auto">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
              <TabsTrigger value="emails">Emails</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="automation">Automation</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="flex flex-col gap-5 pt-4 pb-6">
              {/*
                What the prospect actually wrote. Placed first because it is
                the only thing on this panel they said themselves, and it is
                what the AI score is largely a judgement of.

                Read-only by design: this is a record of a submission, not an
                editable field — the edit form covers name/email/company/phone
                and deliberately cannot touch it.
              */}
              {lead.formMessage ? (
                <section>
                  <h3 className="text-foreground mb-2 text-sm font-semibold">Message</h3>
                  <p className="border-border bg-muted/40 text-foreground rounded-lg border p-3 text-sm break-words whitespace-pre-wrap">
                    {lead.formMessage}
                  </p>
                </section>
              ) : null}

              {lead.company ? (
                <section>
                  <h3 className="text-foreground mb-2 text-sm font-semibold">Company</h3>
                  <div className="flex items-center gap-2">
                    <span className="bg-accent text-accent-foreground flex size-8 items-center justify-center rounded-lg">
                      <Building2Icon className="size-4" aria-hidden />
                    </span>
                    <p className="text-foreground text-sm font-medium">{lead.company}</p>
                  </div>
                </section>
              ) : null}

              <section>
                <h3 className="text-foreground mb-2 text-sm font-semibold">Contact Information</h3>
                <ul className="flex flex-col gap-2 text-sm">
                  <li className="flex items-center gap-2">
                    <MailIcon className="text-muted-foreground size-4" aria-hidden />
                    <a href={`mailto:${lead.email}`} className="text-primary hover:underline">
                      {lead.email}
                    </a>
                  </li>
                  {lead.phone ? (
                    <li className="flex items-center gap-2">
                      <PhoneIcon className="text-muted-foreground size-4" aria-hidden />
                      <span className="text-foreground">{lead.phone}</span>
                    </li>
                  ) : null}
                </ul>
              </section>

              <section>
                <h3 className="text-foreground mb-2 text-sm font-semibold">Lead Details</h3>
                <dl className="grid grid-cols-2 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Source</dt>
                  <dd className="text-foreground">{formatEnumLabel(lead.source)}</dd>
                  <dt className="text-muted-foreground">Owner</dt>
                  <dd className="flex items-center gap-1.5">
                    <LeadAvatar name={ownerLabel} />
                    <span className="text-foreground">{ownerLabel}</span>
                  </dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="text-foreground">{formatDateTime(lead.createdAt)}</dd>
                  <dt className="text-muted-foreground">Last Activity</dt>
                  <dd className="text-foreground">{formatRelativeTime(lead.lastActionAt)}</dd>
                </dl>
              </section>

              <section>
                <h3 className="text-foreground mb-2 text-sm font-semibold">Tags</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() => setTags((current) => [...current, `Tag ${current.length + 1}`])}
                    aria-label="Add tag"
                  >
                    <PlusIcon />
                  </Button>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="activity" className="pt-4 pb-6">
              <EmptyState
                icon={MessageSquareIcon}
                title="No activity yet"
                description="Automated follow-up and outreach activity will show up here once workflows are live."
              />
            </TabsContent>

            <TabsContent value="notes" className="pt-4 pb-6">
              <EmptyState
                icon={StickyNoteIcon}
                title="No notes yet"
                description="Notes your team adds about this lead will appear here."
              />
            </TabsContent>

            <TabsContent value="emails" className="pt-4 pb-6">
              <EmptyState
                icon={MailIcon}
                title="No emails yet"
                description="Sent and received emails with this lead will appear here once campaigns are live."
              />
            </TabsContent>

            <TabsContent value="files" className="pt-4 pb-6">
              <EmptyState
                icon={FileIcon}
                title="No files yet"
                description="Documents attached to this lead will appear here."
              />
            </TabsContent>

            <TabsContent value="automation" className="pt-4 pb-6">
              <LeadAutomationTab key={lead.id} leadId={lead.id} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </aside>
  )
}

function toForm(lead: LeadWithOwner): EditableFields {
  return {
    name: lead.name,
    email: lead.email,
    company: lead.company ?? '',
    phone: lead.phone ?? '',
  }
}
