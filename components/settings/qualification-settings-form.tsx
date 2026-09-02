'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { saveQualificationConfigAction } from '@/app/(app)/settings/qualification/actions'
import { ICP_MAX_LENGTH, INSTRUCTIONS_MAX_LENGTH } from '@/lib/validation/qualification-config'
import type { QualificationConfigView } from '@/lib/services/qualification-config'

/**
 * Qualification settings — free text, deliberately not a builder.
 *
 * An organization describes WHO it sells to and where the bar sits. It cannot
 * edit the system prompt: the scoring contract, the output contract and the
 * prompt-injection defence are not configurable, and this form offers no way
 * to reach them.
 *
 * Read-only for anyone who is not an ADMIN — the server enforces that too
 * (the action calls `requireCapability`), so hiding the controls here is
 * presentation, never the boundary.
 */
export function QualificationSettingsForm({
  initial,
  canEdit,
}: {
  initial: QualificationConfigView
  canEdit: boolean
}) {
  const [icp, setIcp] = useState(initial.icp)
  const [instructions, setInstructions] = useState(initial.instructions ?? '')
  const [threshold, setThreshold] = useState(String(initial.threshold))
  const [version, setVersion] = useState(initial.version)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    setFieldErrors({})

    const result = await saveQualificationConfigAction({
      icp,
      instructions: instructions.trim() === '' ? null : instructions,
      threshold,
    })

    setSaving(false)

    if (!result.ok) {
      if (result.fieldErrors) setFieldErrors(result.fieldErrors)
      toast.error(result.message)
      return
    }

    // Every save that actually changes something creates a new version; the
    // runs already scored keep pointing at the version that judged them.
    setVersion(result.data.version)
    toast.success(`Saved as version ${result.data.version}`)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="qualification-icp">Ideal customer profile</Label>
        <p className="text-muted-foreground text-xs">
          Describe the companies and roles worth pursuing. The AI uses this to judge fit — it never
          overrides LeadFlow&apos;s scoring or security rules.
        </p>
        <textarea
          id="qualification-icp"
          value={icp}
          onChange={(e) => setIcp(e.target.value)}
          disabled={!canEdit}
          rows={7}
          maxLength={ICP_MAX_LENGTH}
          className="border-input bg-background focus-visible:ring-ring/50 min-h-32 rounded-lg border px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-60"
        />
        <p className="text-muted-foreground text-xs tabular-nums">
          {icp.length} / {ICP_MAX_LENGTH}
        </p>
        {fieldErrors.icp ? <p className="text-destructive text-xs">{fieldErrors.icp[0]}</p> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="qualification-instructions">Additional guidance (optional)</Label>
        <p className="text-muted-foreground text-xs">
          Anything else the AI should weigh — segments you never sell to, signals that matter more
          than usual.
        </p>
        <textarea
          id="qualification-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          disabled={!canEdit}
          rows={5}
          maxLength={INSTRUCTIONS_MAX_LENGTH}
          className="border-input bg-background focus-visible:ring-ring/50 min-h-24 rounded-lg border px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-60"
        />
        <p className="text-muted-foreground text-xs tabular-nums">
          {instructions.length} / {INSTRUCTIONS_MAX_LENGTH}
        </p>
        {fieldErrors.instructions ? (
          <p className="text-destructive text-xs">{fieldErrors.instructions[0]}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="qualification-threshold">Qualification threshold</Label>
        <p className="text-muted-foreground text-xs">
          A lead scoring at or above this is QUALIFIED and eligible for outreach. Runs already
          scored keep the threshold they were judged against.
        </p>
        <Input
          id="qualification-threshold"
          type="number"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          disabled={!canEdit}
          className="max-w-28"
        />
        {fieldErrors.threshold ? (
          <p className="text-destructive text-xs">{fieldErrors.threshold[0]}</p>
        ) : null}
      </div>

      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-muted-foreground text-sm">
          {version === 0
            ? 'Using LeadFlow defaults — no version saved yet.'
            : `Current version: ${version}`}
        </p>
        {canEdit ? (
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">Only an administrator can change this.</p>
        )}
      </div>
    </div>
  )
}
