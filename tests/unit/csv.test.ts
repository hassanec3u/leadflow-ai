import { describe, expect, it } from 'vitest'

import { parseLeadsCsv } from '@/lib/csv'

describe('parseLeadsCsv', () => {
  it('parses a valid CSV into rows', () => {
    const result = parseLeadsCsv(
      'name,email,company\nJane Doe,jane@test.dev,Acme\nBob Roe,bob@test.dev,',
    )

    if ('error' in result) throw new Error('expected rows')
    expect(result.rows).toEqual([
      { name: 'Jane Doe', email: 'jane@test.dev', company: 'Acme' },
      { name: 'Bob Roe', email: 'bob@test.dev', company: '' },
    ])
  })

  it('rejects an empty file', () => {
    const result = parseLeadsCsv('')
    expect(result).toEqual({ error: 'The CSV file is empty.' })
  })

  it('rejects a file missing required headers', () => {
    const result = parseLeadsCsv('company,phone\nAcme,555-1234')
    if (!('error' in result)) throw new Error('expected an error')
    expect(result.error).toMatch(/Missing required column/)
  })

  it('rejects unrecognized columns (defense against a smuggled organizationId column)', () => {
    const result = parseLeadsCsv('name,email,organizationId\nJane,jane@test.dev,org_other')
    if (!('error' in result)) throw new Error('expected an error')
    expect(result.error).toMatch(/Unrecognized column/)
  })

  it('handles quoted fields containing commas', () => {
    const result = parseLeadsCsv('name,email,company\n"Doe, Jane",jane@test.dev,"Acme, Inc."')
    if ('error' in result) throw new Error('expected rows')
    expect(result.rows).toEqual([
      { name: 'Doe, Jane', email: 'jane@test.dev', company: 'Acme, Inc.' },
    ])
  })
})
