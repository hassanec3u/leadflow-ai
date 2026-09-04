'use client'

import { useId, useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createLeadAction } from '@/app/(app)/leads/actions'

/**
 * "Add Lead" flow, backed by the real Lead service via `createLeadAction`.
 * `source` is fixed to `MANUAL` here — a lead entered through this dialog is,
 * by definition, a manual entry; adding a source picker isn't required by
 * this task. `ownerId` is never supplied by this form — the service defaults
 * the owner to the caller.
 */
export function AddLeadDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const nameId = useId()
  const emailId = useId()
  const companyId = useId()

  function reset() {
    setName('')
    setEmail('')
    setCompany('')
    setFieldErrors({})
  }

  async function handleSubmit() {
    setSubmitting(true)
    setFieldErrors({})

    const result = await createLeadAction({
      name: name.trim(),
      email: email.trim(),
      company: company.trim() || undefined,
      source: 'MANUAL',
    })

    setSubmitting(false)

    if (!result.ok) {
      if (result.fieldErrors) setFieldErrors(result.fieldErrors)
      toast.error(result.message)
      return
    }

    toast.success('Lead added')
    onCreated()
    reset()
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon data-icon="inline-start" />
          Add Lead
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add lead</DialogTitle>
          <DialogDescription>Create a new lead in your organization.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Cooper" />
            {fieldErrors.name ? <p className="text-destructive text-xs">{fieldErrors.name[0]}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
            />
            {fieldErrors.email ? <p className="text-destructive text-xs">{fieldErrors.email[0]}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={companyId}>Company</Label>
            <Input
              id={companyId}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company Inc"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add Lead'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
