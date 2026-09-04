/**
 * Minimal CSV parsing for Lead import (Phase 1E).
 *
 * Pure text -> rows transformation — no DB/session access, no business logic.
 * An unrecognized header is rejected outright, so a CSV can never smuggle an
 * extra column into the import.
 */

const REQUIRED_HEADERS = ['name', 'email'] as const
const OPTIONAL_HEADERS = ['company', 'phone', 'source'] as const
const KNOWN_HEADERS: readonly string[] = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]

export type ParsedCsv = { rows: Record<string, string>[] } | { error: string }

export function parseLeadsCsv(text: string): ParsedCsv {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    return { error: 'The CSV file is empty.' }
  }

  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase())
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h))
  if (missing.length > 0) {
    return { error: `Missing required column(s): ${missing.join(', ')}.` }
  }
  const unrecognized = headers.filter((h) => !KNOWN_HEADERS.includes(h))
  if (unrecognized.length > 0) {
    return { error: `Unrecognized column(s): ${unrecognized.join(', ')}.` }
  }

  const dataLines = lines.slice(1)
  const MAX_ROWS = 500
  if (dataLines.length > MAX_ROWS) {
    return { error: `Too many rows (${dataLines.length}). Import supports up to ${MAX_ROWS} leads at a time.` }
  }

  const rows = dataLines.map((line) => {
    const cells = splitCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((header, i) => {
      row[header] = (cells[i] ?? '').trim()
    })
    return row
  })

  return { rows }
}

/** Splits one CSV line on commas, honoring double-quoted fields (with `""` as an escaped quote). */
function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }
  result.push(current)
  return result
}
