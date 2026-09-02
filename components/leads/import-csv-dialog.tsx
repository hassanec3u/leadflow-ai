'use client'

import { useId, useRef, useState } from 'react'
import { UploadIcon } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import type { ImportLeadsResult } from '@/lib/services/leads'
import { importLeadsAction } from '@/app/(app)/leads/actions'

/**
 * CSV import flow. The file is read client-side only to get its text content
 * — parsing and every validation/business rule run server-side, in
 * `importLeadsAction` -> `lib/csv.ts` + `lib/services/leads.ts`'s
 * `importLeads()`. Nothing here decides what's valid.
 */
export function ImportCsvDialog({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ImportLeadsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInputId = useId()

  function reset() {
    setFileName(null)
    setSubmitting(false)
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setResult(null)
    setError(null)
    setSubmitting(true)

    const text = await file.text()
    const outcome = await importLeadsAction(text)

    setSubmitting(false)

    if (!outcome.ok) {
      setError(outcome.message)
      return
    }

    setResult(outcome.data)
    if (outcome.data.created > 0) {
      onImported()
      toast.success(`Imported ${outcome.data.created} lead${outcome.data.created === 1 ? '' : 's'}`)
    }
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
        <Button variant="outline">
          <UploadIcon data-icon="inline-start" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import leads from CSV</DialogTitle>
          <DialogDescription>
            Columns: <code>name</code>, <code>email</code> (required), <code>company</code>, <code>phone</code>,{' '}
            <code>source</code> (optional).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fileInputId}>CSV file</Label>
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept=".csv,text/csv"
              disabled={submitting}
              onChange={(e) => void handleFileChange(e)}
              className="border-border file:bg-secondary file:text-secondary-foreground rounded-md border text-sm file:mr-3 file:border-0 file:px-3 file:py-2"
            />
          </div>

          {submitting ? <p className="text-muted-foreground text-sm">Importing {fileName}…</p> : null}

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          {result ? (
            <div className="flex flex-col gap-2">
              <p className="text-foreground text-sm font-medium">
                {result.created} created, {result.failed} failed
              </p>
              {result.failed > 0 ? (
                <ul className="border-border max-h-48 overflow-y-auto rounded-md border text-sm">
                  {result.results
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <li key={r.row} className="border-border text-muted-foreground border-b px-2.5 py-1.5 last:border-b-0">
                        Row {r.row}
                        {r.email ? ` (${r.email})` : ''}: {r.message}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
