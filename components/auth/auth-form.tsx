'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AuthActionState } from '@/app/(auth)/actions'

/**
 * Shared form shell for sign-in and sign-up.
 *
 * Uses `useActionState` so validation and error messages come back from the
 * server action — the server is the authority on whether input is acceptable,
 * and client-side checks would only be a convenience layer.
 */

type Field = {
  name: string
  label: string
  type?: string
  autoComplete?: string
  placeholder?: string
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Please wait…' : label}
    </Button>
  )
}

export function AuthForm({
  action,
  fields,
  submitLabel,
  hiddenFields,
}: {
  action: (state: AuthActionState, formData: FormData) => Promise<AuthActionState>
  fields: readonly Field[]
  submitLabel: string
  hiddenFields?: Record<string, string>
}) {
  const [state, formAction] = useActionState<AuthActionState, FormData>(action, {})

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}

      {state.message ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {state.message}
        </p>
      ) : null}

      {fields.map((field) => {
        const errors = state.fieldErrors?.[field.name]
        const errorId = `${field.name}-error`

        return (
          <div key={field.name} className="grid gap-2">
            <Label htmlFor={field.name}>{field.label}</Label>
            <Input
              id={field.name}
              name={field.name}
              type={field.type ?? 'text'}
              autoComplete={field.autoComplete}
              placeholder={field.placeholder}
              aria-invalid={errors ? true : undefined}
              aria-describedby={errors ? errorId : undefined}
            />
            {errors ? (
              <p id={errorId} className="text-destructive text-xs">
                {errors[0]}
              </p>
            ) : null}
          </div>
        )
      })}

      <SubmitButton label={submitLabel} />
    </form>
  )
}
