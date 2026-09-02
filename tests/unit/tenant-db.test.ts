import { describe, expect, it, vi } from 'vitest'

import { withTenant } from '@/lib/db/tenant'

/**
 * The application half of tenant scoping: every tenant query must run inside a
 * transaction that establishes `app.current_org_id` before doing any work.
 * The database half (that the policies then actually filter) is proven in
 * tests/integration/rls-tenant-isolation.test.ts.
 */
describe('withTenant', () => {
  function makeClient() {
    const executeRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRaw: executeRaw }
    const client = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    }
    return { client, tx, executeRaw }
  }

  it('runs the work inside a transaction', async () => {
    const { client } = makeClient()

    await withTenant('org_acme', async () => 'done', client as never)

    expect(client.$transaction).toHaveBeenCalledTimes(1)
  })

  it('sets tenant context before the work runs', async () => {
    const { client, executeRaw } = makeClient()
    const order: string[] = []

    executeRaw.mockImplementation(async () => {
      order.push('set-context')
      return 1
    })

    await withTenant(
      'org_acme',
      async () => {
        order.push('work')
        return null
      },
      client as never,
    )

    // Ordering is the whole point: work performed before the GUC is set would
    // run with no tenant context and silently see nothing.
    expect(order).toEqual(['set-context', 'work'])
  })

  it('passes the organization id as a bound parameter, not interpolated SQL', async () => {
    const { client, executeRaw } = makeClient()

    await withTenant("org_'; DROP TABLE users; --", async () => null, client as never)

    // $executeRaw is a tagged template: strings array first, then values.
    // The id must appear as a VALUE, never spliced into the SQL text.
    const [strings, ...values] = executeRaw.mock.calls[0] as [string[], ...unknown[]]
    expect(values).toContain("org_'; DROP TABLE users; --")
    expect(strings.join('')).not.toContain('DROP TABLE')
  })

  it('refuses an empty organization id', async () => {
    const { client } = makeClient()

    // Failing loudly beats running with empty context, which would return zero
    // rows and be misread as "no data" rather than "bug".
    await expect(withTenant('', async () => null, client as never)).rejects.toThrow(
      /non-empty organizationId/,
    )
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('returns the value produced by the work function', async () => {
    const { client } = makeClient()
    const result = await withTenant('org_acme', async () => ({ count: 3 }), client as never)
    expect(result).toEqual({ count: 3 })
  })
})
