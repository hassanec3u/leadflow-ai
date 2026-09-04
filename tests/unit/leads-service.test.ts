import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 1B — lib/services/leads.ts.
 *
 * `requireUser()` is mocked directly (who the caller is, per test) and
 * `@/lib/db/prisma` is replaced with a small in-memory fake that mimics just
 * enough of Prisma to prove the SERVICE's own logic:
 *
 *  - the OWNERSHIP scope: a SALES_REP only ever sees and edits leads they own.
 *    Row level security is gone, so this filter is the ONLY thing scoping
 *    reads — which is exactly why it is pinned down here in detail.
 *  - a real `Prisma.PrismaClientKnownRequestError` (P2002) for the duplicate
 *    email case, so the service's actual error-mapping code path runs.
 */

const state = vi.hoisted(() => {
  type FakeLead = {
    id: string
    ownerId: string | null
    name: string
    email: string
    company: string | null
    phone: string | null
    source: string
    status: string
    aiScore: number | null
    qualification: string | null
    qualificationOutcome: string | null
    deletedAt: Date | null
    createdAt: Date
    updatedAt: Date
    lastActionAt: Date
  }

  const leads: FakeLead[] = []
  const users = new Map<string, { id: string }>()
  let nextId = 1

  function reset() {
    leads.length = 0
    users.clear()
    nextId = 1
  }

  function matchesWhere(lead: FakeLead, where: Record<string, unknown>): boolean {
    if ('id' in where && lead.id !== where.id) return false
    if (where.deletedAt === null && lead.deletedAt !== null) return false
    if ('ownerId' in where && lead.ownerId !== where.ownerId) return false
    if ('status' in where && lead.status !== where.status) return false
    if ('qualificationOutcome' in where && lead.qualificationOutcome !== where.qualificationOutcome)
      return false
    if ('source' in where && lead.source !== where.source) return false
    if (Array.isArray(where.OR)) {
      const term = (
        (where.OR[0] as { name?: { contains?: string } })?.name?.contains ?? ''
      ).toLowerCase()
      const haystack = `${lead.name} ${lead.email} ${lead.company ?? ''}`.toLowerCase()
      if (!haystack.includes(term)) return false
    }
    return true
  }

  return {
    leads,
    users,
    reset,
    matchesWhere,
    get nextId() {
      return nextId++
    },
  }
})

vi.mock('@/lib/auth/session', () => ({
  requireUser: () => requireUserMock(),
}))

vi.mock('@/lib/db/prisma', async () => {
  const { Prisma } = await import('@prisma/client')

  // Shaped like the REAL error @prisma/adapter-pg reports against Postgres
  // (verified directly during Phase 1 E2E smoke testing) — no `meta.target`
  // at all; the constraint name sits nested under `driverAdapterError`. Using
  // the real shape here, rather than Prisma's classic `meta.target` array,
  // is what actually exercises isUniqueEmailViolation()'s production code
  // path (Phase 1.1 business-rules closure, requirement #14).
  function uniqueEmailViolation() {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        modelName: 'Lead',
        driverAdapterError: { cause: { constraint: { index: 'leads_email_key' } } },
      },
    })
  }

  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = state.users.get(where.id)
        if (!user) return null
        return { id: user.id }
      },
    },
    lead: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const email = data.email as string
        if (state.leads.some((l) => l.email === email)) {
          throw uniqueEmailViolation()
        }
        const now = new Date()
        const lead = {
          id: `lead_${state.nextId}`,
          ownerId: (data.ownerId as string | null | undefined) ?? null,
          name: data.name as string,
          email,
          company: (data.company as string | undefined) ?? null,
          phone: (data.phone as string | undefined) ?? null,
          source: data.source as string,
          status: 'NEW',
          aiScore: null,
          qualification: null,
          qualificationOutcome: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
          lastActionAt: now,
        }
        state.leads.push(lead)
        return lead
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return state.leads.find((l) => state.matchesWhere(l, where)) ?? null
      },
      findMany: async ({
        where,
        orderBy,
        skip = 0,
        take,
      }: {
        where: Record<string, unknown>
        orderBy?: Record<string, 'asc' | 'desc'>
        skip?: number
        take?: number
      }) => {
        let results = state.leads.filter((l) => state.matchesWhere(l, where))
        const [sortEntry] = Object.entries(orderBy ?? {})
        if (sortEntry) {
          const [field, direction] = sortEntry
          results = [...results].sort((a, b) => {
            const av = (a as Record<string, unknown>)[field]
            const bv = (b as Record<string, unknown>)[field]
            const cmp = av! > bv! ? 1 : av! < bv! ? -1 : 0
            return direction === 'asc' ? cmp : -cmp
          })
        }
        return results.slice(skip, take ? skip + take : undefined)
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        return state.leads.filter((l) => state.matchesWhere(l, where)).length
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const lead = state.leads.find((l) => l.id === where.id)!
        if (typeof data.email === 'string' && data.email !== lead.email) {
          if (state.leads.some((l) => l.email === data.email && l !== lead)) {
            throw uniqueEmailViolation()
          }
        }
        Object.assign(lead, data, { updatedAt: new Date() })
        return lead
      },
    },
  }

  return {
    prisma: {
      ...tx,
      // listLeads uses the ARRAY form (page + count in one snapshot); the
      // write paths use the callback form. Both must work.
      $transaction: async (arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : (arg as (c: unknown) => Promise<unknown>)(tx),
    },
  }
})

const requireUserMock = vi.fn()

function user(
  overrides: Partial<{
    id: string
    role: 'ADMIN' | 'MANAGER' | 'SALES_REP'
  }>,
) {
  return {
    id: 'user_1',
    email: 'user@test.dev',
    name: 'Test User',
    role: 'SALES_REP' as const,
    ...overrides,
  }
}

const ADMIN_ACME = user({ id: 'admin_acme', role: 'ADMIN' })
const REP1_ACME = user({ id: 'rep1_acme', role: 'SALES_REP' })
const REP2_ACME = user({ id: 'rep2_acme', role: 'SALES_REP' })
const ADMIN_OTHER = user({ id: 'admin_other', role: 'ADMIN' })

async function importService() {
  vi.resetModules()
  return import('@/lib/services/leads')
}

describe('Lead service', () => {
  beforeEach(() => {
    state.reset()
    requireUserMock.mockReset()
    for (const u of [ADMIN_ACME, REP1_ACME, REP2_ACME, ADMIN_OTHER]) {
      state.users.set(u.id, { id: u.id })
    }
  })

  it('1. creates a Lead', async () => {
    requireUserMock.mockResolvedValue(ADMIN_ACME)
    const { createLead } = await importService()

    const lead = await createLead({
      name: 'Jane Prospect',
      email: 'jane@prospect.test',
      source: 'WEBSITE_FORM',
    })
    expect(lead.ownerId).toBe(ADMIN_ACME.id)
    expect(lead.status).toBe('NEW')
    expect(lead.aiScore).toBeNull()
  })

  it('2. gets a Lead belonging to the current tenant', async () => {
    requireUserMock.mockResolvedValue(ADMIN_ACME)
    const { createLead, getLead } = await importService()

    const created = await createLead({
      name: 'Jane',
      email: 'jane2@prospect.test',
      source: 'MANUAL',
    })
    const fetched = await getLead(created.id)

    expect(fetched.id).toBe(created.id)
  })

  it('5. delete performs soft deletion, not a physical delete', async () => {
    requireUserMock.mockResolvedValue(ADMIN_ACME)
    const { createLead, deleteLead } = await importService()
    const created = await createLead({
      name: 'Jane',
      email: 'jane5@prospect.test',
      source: 'MANUAL',
    })

    await deleteLead(created.id)

    const stored = state.leads.find((l) => l.id === created.id)
    expect(stored).toBeDefined()
    expect(stored?.deletedAt).not.toBeNull()
  })

  it('6. deleted Leads do not appear in normal list results', async () => {
    requireUserMock.mockResolvedValue(ADMIN_ACME)
    const { createLead, deleteLead, listLeads } = await importService()
    const created = await createLead({
      name: 'Jane',
      email: 'jane6@prospect.test',
      source: 'MANUAL',
    })
    await deleteLead(created.id)

    const { leads } = await listLeads({})
    expect(leads.find((l) => l.id === created.id)).toBeUndefined()
  })

  it('7. rejects a duplicate email within the same organization', async () => {
    requireUserMock.mockResolvedValue(ADMIN_ACME)
    const { createLead } = await importService()
    await createLead({ name: 'Jane', email: 'dup@prospect.test', source: 'MANUAL' })

    await expect(
      createLead({ name: 'Someone Else', email: 'dup@prospect.test', source: 'MANUAL' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  describe('9. SALES_REP restrictions', () => {
    it('always becomes the owner of a lead it creates, ignoring a different requested owner', async () => {
      requireUserMock.mockResolvedValue(REP1_ACME)
      const { createLead } = await importService()

      await expect(
        createLead({
          name: 'Jane',
          email: 'rep-create@prospect.test',
          source: 'MANUAL',
          ownerId: REP2_ACME.id,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('cannot see a lead owned by another rep', async () => {
      requireUserMock.mockResolvedValue(REP2_ACME)
      const { createLead, getLead } = await importService()
      const created = await createLead({
        name: 'Rep2 Lead',
        email: 'rep2lead@prospect.test',
        source: 'MANUAL',
      })

      requireUserMock.mockResolvedValue(REP1_ACME)
      await expect(getLead(created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('cannot reassign a lead to someone else', async () => {
      requireUserMock.mockResolvedValue(REP1_ACME)
      const { createLead, updateLead } = await importService()
      const created = await createLead({
        name: 'Rep1 Lead',
        email: 'rep1lead@prospect.test',
        source: 'MANUAL',
      })

      await expect(updateLead(created.id, { ownerId: REP2_ACME.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })

    it('list only returns leads the rep owns, while an admin sees all', async () => {
      requireUserMock.mockResolvedValue(REP1_ACME)
      const { createLead, listLeads } = await importService()
      await createLead({ name: 'Rep1 A', email: 'rep1a@prospect.test', source: 'MANUAL' })

      requireUserMock.mockResolvedValue(REP2_ACME)
      await createLead({ name: 'Rep2 A', email: 'rep2a@prospect.test', source: 'MANUAL' })

      requireUserMock.mockResolvedValue(REP1_ACME)
      const repView = await listLeads({})
      expect(repView.leads.map((l) => l.email)).toEqual(['rep1a@prospect.test'])

      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const adminView = await listLeads({})
      expect(adminView.total).toBe(2)
    })
  })

  describe('11. mutations (Phase 1D)', () => {
    it("updates a Lead's fields", async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, updateLead } = await importService()
      const created = await createLead({
        name: 'Jane',
        email: 'jane11@prospect.test',
        source: 'MANUAL',
      })

      const updated = await updateLead(created.id, { name: 'Jane Updated', company: 'New Co' })

      expect(updated.name).toBe('Jane Updated')
      expect(updated.company).toBe('New Co')
    })

    it('rejects a duplicate email on update within the same organization', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, updateLead } = await importService()
      await createLead({ name: 'Existing', email: 'taken@prospect.test', source: 'MANUAL' })
      const target = await createLead({
        name: 'Other',
        email: 'other@prospect.test',
        source: 'MANUAL',
      })

      await expect(updateLead(target.id, { email: 'taken@prospect.test' })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
    })

    it('a rep cannot update a lead owned by another rep (unauthorized mutation)', async () => {
      requireUserMock.mockResolvedValue(REP2_ACME)
      const { createLead, updateLead } = await importService()
      const created = await createLead({
        name: 'Rep2 Lead',
        email: 'rep2-upd@prospect.test',
        source: 'MANUAL',
      })

      requireUserMock.mockResolvedValue(REP1_ACME)
      await expect(updateLead(created.id, { name: 'Hijacked' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('a rep cannot delete a lead owned by another rep (unauthorized mutation)', async () => {
      requireUserMock.mockResolvedValue(REP2_ACME)
      const { createLead, deleteLead } = await importService()
      const created = await createLead({
        name: 'Rep2 Lead',
        email: 'rep2-del@prospect.test',
        source: 'MANUAL',
      })

      requireUserMock.mockResolvedValue(REP1_ACME)
      await expect(deleteLead(created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('12. importLeads (Phase 1E — CSV import)', () => {
    it('imports every valid row, defaulting source to CSV_IMPORT', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { importLeads } = await importService()

      const result = await importLeads([
        { name: 'Jane Doe', email: 'jane-csv@prospect.test', company: 'Acme' },
        { name: 'Bob Roe', email: 'bob-csv@prospect.test', company: '' },
      ])

      expect(result.created).toBe(2)
      expect(result.failed).toBe(0)
      expect(result.results.every((r) => r.ok)).toBe(true)
      expect(state.leads.map((l) => l.source)).toEqual(['CSV_IMPORT', 'CSV_IMPORT'])
    })

    it('reports invalid rows individually without failing the whole batch', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { importLeads } = await importService()

      const result = await importLeads([
        { name: 'Valid Lead', email: 'valid-csv@prospect.test' },
        { name: '', email: 'not-an-email' },
      ])

      expect(result.created).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.results[0]).toMatchObject({ row: 1, ok: true })
      expect(result.results[1]).toMatchObject({ row: 2, ok: false })
      if (result.results[1]!.ok) throw new Error('expected row 2 to fail')
      expect(result.results[1]!.fieldErrors).toBeDefined()
    })

    it('handles a mixed valid/invalid/duplicate batch, keeping valid creates and reporting the rest', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, importLeads } = await importService()
      await createLead({ name: 'Existing', email: 'existing-csv@prospect.test', source: 'MANUAL' })

      const result = await importLeads([
        { name: 'New Lead', email: 'new-csv@prospect.test' },
        { name: '', email: 'missing-name@prospect.test' },
        { name: 'Dup Lead', email: 'existing-csv@prospect.test' },
      ])

      expect(result.created).toBe(1)
      expect(result.failed).toBe(2)
      expect(result.results[0]).toMatchObject({ ok: true })
      expect(result.results[1]).toMatchObject({ ok: false })
      expect(result.results[2]).toMatchObject({ ok: false, email: 'existing-csv@prospect.test' })
    })

    it('rejects a duplicate email against an existing Lead, per the existing uniqueness rule', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, importLeads } = await importService()
      await createLead({ name: 'Existing', email: 'dup-import@prospect.test', source: 'MANUAL' })

      const result = await importLeads([{ name: 'Dup', email: 'dup-import@prospect.test' }])

      expect(result.created).toBe(0)
      expect(result.results[0]).toMatchObject({
        ok: false,
        message: expect.stringContaining('already exists'),
      })
    })

    it('rejects rows with empty required fields', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { importLeads } = await importService()

      const result = await importLeads([{ name: '', email: '' }])

      expect(result.created).toBe(0)
      expect(result.failed).toBe(1)
      if (result.results[0]!.ok) throw new Error('expected row to fail')
      expect(result.results[0]!.fieldErrors).toMatchObject({
        name: expect.any(Array),
        email: expect.any(Array),
      })
    })

    it('requires an authenticated user (authorization)', async () => {
      requireUserMock.mockRejectedValue(
        Object.assign(new Error('Unauthenticated'), { code: 'UNAUTHENTICATED' }),
      )
      const { importLeads } = await importService()

      await expect(
        importLeads([{ name: 'Nope', email: 'nope@prospect.test' }]),
      ).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      })
    })

    it('does not trigger any workflow/outbound side effect for imported leads', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { importLeads } = await importService()

      const result = await importLeads([{ name: 'Quiet Lead', email: 'quiet-csv@prospect.test' }])

      // No workflow/automation module exists to enroll into (Phase 2, not built) —
      // the created Lead simply sits at its default status with nothing further
      // triggered, matching docs/product-spec.md §8's "no automated pipeline for
      // manual/CSV leads" rule.
      const created = state.leads.find((l) => l.email === 'quiet-csv@prospect.test')
      expect(result.created).toBe(1)
      expect(created?.status).toBe('NEW')
      expect(created?.qualification).toBeNull()
      expect(created?.aiScore).toBeNull()
    })
  })

  describe('13. Phase 1.1 — business rules closure', () => {
    it('1. creates a Lead with no owner (Unassigned) when ownerId is explicitly null', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()

      const lead = await createLead({
        name: 'Nobody Yet',
        email: 'unassigned@prospect.test',
        source: 'MANUAL',
        ownerId: null,
      })

      expect(lead.ownerId).toBeNull()
    })

    it('1b. a SALES_REP may also explicitly leave a Lead Unassigned', async () => {
      requireUserMock.mockResolvedValue(REP1_ACME)
      const { createLead } = await importService()

      const lead = await createLead({
        name: 'Nobody Yet',
        email: 'rep-unassigned@prospect.test',
        source: 'MANUAL',
        ownerId: null,
      })

      expect(lead.ownerId).toBeNull()
    })

    it('2. creates a Lead with an owner when ownerId is omitted (unchanged default behavior)', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()

      const lead = await createLead({
        name: 'Has Owner',
        email: 'has-owner@prospect.test',
        source: 'MANUAL',
      })

      expect(lead.ownerId).toBe(ADMIN_ACME.id)
    })

    it('3. normalizes email (trim + lowercase) on create', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()

      const lead = await createLead({
        name: 'Jane',
        email: '  John@Example.COM  ',
        source: 'MANUAL',
      })

      expect(lead.email).toBe('john@example.com')
    })

    it('4. normalizes email (trim + lowercase) on update', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, updateLead } = await importService()
      const created = await createLead({
        name: 'Jane',
        email: 'jane13@prospect.test',
        source: 'MANUAL',
      })

      const updated = await updateLead(created.id, { email: '  Jane.New@Example.COM ' })

      expect(updated.email).toBe('jane.new@example.com')
    })

    it('5. normalizes email (trim + lowercase) on CSV import', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { importLeads } = await importService()

      const result = await importLeads([{ name: 'Csv Case', email: '  CSV.Case@Example.COM ' }])

      expect(result.created).toBe(1)
      expect(result.results[0]).toMatchObject({ ok: true, email: 'csv.case@example.com' })
    })

    it('6. detects a duplicate by normalized email, even with different case/whitespace', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()
      await createLead({ name: 'Jane', email: 'normalize-dup@prospect.test', source: 'MANUAL' })

      await expect(
        createLead({
          name: 'Someone Else',
          email: '  Normalize-Dup@Prospect.TEST  ',
          source: 'MANUAL',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('7. rejects a syntactically invalid email', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()

      await expect(
        createLead({ name: 'Bad Email', email: 'not-an-email', source: 'MANUAL' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })

    it('8a. getLead excludes a soft-deleted Lead (NotFound, not disclosed)', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, deleteLead, getLead } = await importService()
      const created = await createLead({
        name: 'Gone',
        email: 'gone@prospect.test',
        source: 'MANUAL',
      })
      await deleteLead(created.id)

      await expect(getLead(created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('8b. search excludes a soft-deleted Lead', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, deleteLead, listLeads } = await importService()
      const created = await createLead({
        name: 'Searchable Gone',
        email: 'searchable-gone@prospect.test',
        source: 'MANUAL',
      })
      await deleteLead(created.id)

      const result = await listLeads({ search: 'Searchable Gone' })
      expect(result.leads).toHaveLength(0)
    })

    it('9. the same normalized email cannot create a second Lead in the same organization, even after the first is soft-deleted', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead, deleteLead } = await importService()
      const created = await createLead({
        name: 'Original',
        email: 'identity@prospect.test',
        source: 'MANUAL',
      })
      await deleteLead(created.id)

      // A soft-deleted Lead retains its email identity — its email cannot be
      // reused by a second Lead in the same org (see prisma/schema.prisma
      // Lead.email doc comment and tests/integration/lead-rls.test.ts for the
      // real-Postgres equivalent of this check).
      await expect(
        createLead({ name: 'Reused Email', email: 'IDENTITY@prospect.test', source: 'MANUAL' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('10. a differently-cased, padded duplicate of the same email is rejected', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()
      await createLead({ name: 'Jane', email: 'dup-norm@prospect.test', source: 'MANUAL' })

      // Normalisation happens before the uniqueness check, so casing and
      // padding cannot smuggle a second row past it. (Email is globally unique
      // now — there is no second organization for it to belong to.)
      await expect(
        createLead({
          name: 'Jane',
          email: '  Dup-Norm@Prospect.TEST  ',
          source: 'MANUAL',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('11. manual Lead creation does not trigger any workflow/outbound side effect', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()

      const lead = await createLead({
        name: 'Quiet Manual Lead',
        email: 'quiet-manual@prospect.test',
        source: 'MANUAL',
      })

      // No workflow/automation module exists to enroll into (Phase 2, not
      // built yet) — status/qualification/aiScore stay at their untouched
      // defaults, matching docs/product-spec.md §8's rule that manually
      // created leads never auto-enroll in the automation pipeline.
      expect(lead.status).toBe('NEW')
      expect(lead.qualification).toBeNull()
      expect(lead.aiScore).toBeNull()
    })
  })

  describe('10. pagination, filter, search, sort', () => {
    beforeEach(async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { createLead } = await importService()
      await createLead({
        name: 'Alice Adams',
        email: 'alice@prospect.test',
        company: 'Acme',
        source: 'WEBSITE_FORM',
      })
      await createLead({
        name: 'Bob Brown',
        email: 'bob@prospect.test',
        company: 'Bright Co',
        source: 'REFERRAL',
      })
      await createLead({
        name: 'Cara Chen',
        email: 'cara@prospect.test',
        company: 'Acme',
        source: 'LINKEDIN',
      })
    })

    it('paginates results', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { listLeads } = await importService()

      const page1 = await listLeads({ page: 1, pageSize: 2, sortBy: 'name', sortDirection: 'asc' })
      expect(page1.leads.map((l) => l.name)).toEqual(['Alice Adams', 'Bob Brown'])
      expect(page1.total).toBe(3)

      const page2 = await listLeads({ page: 2, pageSize: 2, sortBy: 'name', sortDirection: 'asc' })
      expect(page2.leads.map((l) => l.name)).toEqual(['Cara Chen'])
    })

    it('filters by source', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { listLeads } = await importService()

      const result = await listLeads({ source: 'REFERRAL' })
      expect(result.leads.map((l) => l.name)).toEqual(['Bob Brown'])
    })

    it('searches across name/email/company', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { listLeads } = await importService()

      const result = await listLeads({ search: 'acme' })
      expect(result.leads.map((l) => l.name).sort()).toEqual(['Alice Adams', 'Cara Chen'])
    })

    describe('qualification filter', () => {
      /** Set the pipeline's verdict directly: the Lead service never writes it. */
      function setOutcome(name: string, outcome: string | null) {
        const lead = state.leads.find((l) => l.name === name)
        if (!lead) throw new Error('fixture not found: ' + name)
        lead.qualificationOutcome = outcome
      }

      beforeEach(() => {
        setOutcome('Alice Adams', 'QUALIFIED')
        setOutcome('Bob Brown', 'UNQUALIFIED')
        // Cara Chen keeps qualificationOutcome = null (never scored).
      })

      it('filters on QUALIFIED', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        const result = await listLeads({ qualification: 'QUALIFIED' })
        expect(result.leads.map((l) => l.name)).toEqual(['Alice Adams'])
      })

      it('filters on UNQUALIFIED', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        const result = await listLeads({ qualification: 'UNQUALIFIED' })
        expect(result.leads.map((l) => l.name)).toEqual(['Bob Brown'])
      })

      it('filters UNSCORED on a null column, not on the sentinel value', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        // Without this translation the sentinel would be compared as a value
        // and match nothing — precisely how the old filter failed.
        const result = await listLeads({ qualification: 'UNSCORED' })
        expect(result.leads.map((l) => l.name)).toEqual(['Cara Chen'])
      })

      it('returns everything when no qualification filter is given', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        expect((await listLeads({})).total).toBe(3)
      })

      it('rejects the retired HOT/WARM/COLD values', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        // The bucket is never written, so accepting it would silently mean
        // "always zero results" again.
        await expect(listLeads({ qualification: 'HOT' })).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        })
      })

      it('combines with another filter rather than replacing it', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        expect(
          (await listLeads({ qualification: 'QUALIFIED', source: 'WEBSITE_FORM' })).leads.map(
            (l) => l.name,
          ),
        ).toEqual(['Alice Adams'])
        expect((await listLeads({ qualification: 'QUALIFIED', source: 'REFERRAL' })).leads).toEqual(
          [],
        )
      })
    })

    describe('owner filter', () => {
      it('filters Unassigned on a null ownerId', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { createLead, listLeads } = await importService()
        await createLead({
          name: 'Dana Unassigned',
          email: 'dana@prospect.test',
          ownerId: null,
          source: 'WEBSITE_FORM',
        })

        const result = await listLeads({ ownerId: 'UNASSIGNED' })
        expect(result.leads.map((l) => l.name)).toEqual(['Dana Unassigned'])
      })

      it('still filters by a real owner id', async () => {
        requireUserMock.mockResolvedValue(ADMIN_ACME)
        const { listLeads } = await importService()

        const result = await listLeads({ ownerId: ADMIN_ACME.id })
        expect(result.leads.map((l) => l.name).sort()).toEqual([
          'Alice Adams',
          'Bob Brown',
          'Cara Chen',
        ])
      })
    })

    describe('owner filter and rep scope', () => {
      it('does not let a SALES_REP widen scope via Unassigned', async () => {
        requireUserMock.mockResolvedValue(REP1_ACME)
        const { listLeads } = await importService()

        // The fixtures belong to the admin. A rep asking for Unassigned must
        // still see only their own — the filter cannot widen their scope.
        expect((await listLeads({ ownerId: 'UNASSIGNED' })).leads).toEqual([])
      })

      it('does not let a SALES_REP widen scope via another user id', async () => {
        requireUserMock.mockResolvedValue(REP1_ACME)
        const { listLeads } = await importService()

        expect((await listLeads({ ownerId: ADMIN_ACME.id })).leads).toEqual([])
      })

      it('returns nothing when a filter matches no lead', async () => {
        requireUserMock.mockResolvedValue(ADMIN_OTHER)
        const { listLeads } = await importService()

        expect((await listLeads({ qualification: 'QUALIFIED' })).leads).toEqual([])
        expect((await listLeads({ ownerId: 'UNASSIGNED' })).leads).toEqual([])
      })
    })

    it('sorts descending by name', async () => {
      requireUserMock.mockResolvedValue(ADMIN_ACME)
      const { listLeads } = await importService()

      const result = await listLeads({ sortBy: 'name', sortDirection: 'desc' })
      expect(result.leads.map((l) => l.name)).toEqual(['Cara Chen', 'Bob Brown', 'Alice Adams'])
    })
  })
})
