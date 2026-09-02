'use client'

import { ChevronDownIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** Single-select filter dropdown ("Status", "Qualification", …) with an "All" reset option. */
export function LeadFilterMenu({
  label,
  value,
  options,
  onChange,
  formatOption = (option) => option,
  allOptionLabel,
}: {
  label: string
  value: string | null
  options: readonly string[]
  onChange: (value: string | null) => void
  /** Real enum values (e.g. "WEBSITE_FORM") need a human-readable label. */
  formatOption?: (option: string) => string
  /** Overrides the reset item's wording where "All <label>" reads awkwardly. */
  allOptionLabel?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {value ? formatOption(value) : label}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={value ?? ''}
          onValueChange={(next) => onChange(next === '' ? null : next)}
        >
          <DropdownMenuRadioItem value="">
            {allOptionLabel ?? `All ${label.toLowerCase()}`}
          </DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {formatOption(option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
