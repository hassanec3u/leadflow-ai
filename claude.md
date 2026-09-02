# LeadFlow AI

AI lead qualification and follow-up automation for a multi-tenant B2B SaaS.

## 1. Project Context

LeadFlow AI captures leads, qualifies them with AI, automates follow-up,
syncs with external services, and provides CRM/revenue-management features.

The project is developed in phases.

**IMPORTANT:** The roadmap defines the order of the project, but does NOT
authorize implementing an entire phase in one task.

The current task scope is defined ONLY by the user's current prompt.

---

## 2. Documentation

Before working:

- Always read this file.
- Read ONLY the documentation relevant to the current task.
- Do NOT automatically read the entire documentation set.

Relevant documentation:

- `docs/product-spec.md` → product requirements
- `docs/architecture.md` → technical architecture
- `docs/roadmap.md` → phase order
- `progress.md` → current implementation status
- `tests.json` → planned and implemented tests

If a task concerns only one feature, read only the relevant sections.

Do NOT repeatedly reread unchanged documentation.

---

## 3. Stack

- Next.js 16 App Router
- TypeScript strict
- Tailwind CSS v4
- shadcn/ui
- Prisma 7
- PostgreSQL
- Auth.js v5
- Vitest
- PGlite for local/in-process PostgreSQL testing
- Inngest for the workflow engine (Phase 2)

### Next.js 16

- `middleware.ts` is replaced by `proxy.ts`
- the exported function must be named `proxy`
- `cookies()`, `headers()`, `params`, and `searchParams` are async

### Prisma 7

- datasource URL belongs in `prisma.config.ts`
- do NOT put the datasource URL in `schema.prisma`
- runtime PostgreSQL access uses `@prisma/adapter-pg`

Do not introduce a different database or ORM without explicit approval.

---

# 4. NON-NEGOTIABLE SECURITY RULES

## Tenancy

The organization MUST come from the authenticated session.

Use:

- `getCurrentUser()`
- `getCurrentOrganization()`
- `withTenant()`

from the existing authentication/database helpers.

NEVER trust an organization ID supplied by the client.

Never accept `organizationId` from:

- request body
- query string
- headers
- route parameters
- client-side state

A client must never be able to choose the tenant it operates on.

---

## Authorization

Authorization MUST happen server-side.

Use:

- `requireRole()`
- `requireCapability()`

Hiding a button or navigation item is NOT authorization.

A user accessing a protected URL directly must still be rejected
server-side.

Do not rely on layouts alone for authorization.

---

## PostgreSQL RLS

Tenant-owned tables must follow the existing RLS architecture.

They require:

- `organizationId`
- `ENABLE ROW LEVEL SECURITY`
- `FORCE ROW LEVEL SECURITY`
- policies using both `USING`
- and `WITH CHECK`

The application database role must:

- NOT be a PostgreSQL superuser
- NOT have `BYPASSRLS`

Never weaken RLS merely to make a feature work.

If authentication or another infrastructure concern requires a special
pre-authentication database mechanism, use the narrowest possible
security design and document it.

Never create a generic RLS bypass.

---

## Errors and logging

User-facing errors must use the existing `AppError` system.

Never expose raw unknown `error.message` values to clients.

Use `lib/logger.ts` for server-side logging.

Do not log:

- passwords
- secrets
- API keys
- authentication tokens
- unnecessary PII

Pass structured context to the logger instead of interpolating sensitive
values into log messages.

---

# 5. ARCHITECTURE RULES

Business logic belongs in `lib/`.

Pages and components should compose the application and handle presentation.

Do not put substantial business logic directly inside React components.

Do not introduce abstractions unless the current task requires them.

Prefer the existing architecture over creating a parallel pattern.

Before introducing a new dependency, verify that the current stack cannot
solve the requirement.

Do not replace existing infrastructure without an explicit reason.

---

# 6. SCOPE DISCIPLINE

Implement ONLY the task explicitly requested in the current prompt.

The roadmap does NOT mean:

> "Implement everything in the current phase."

It means:

> "Implement this specific task within the current phase."

### NEVER automatically:

- start another task
- start another feature
- start the next phase
- refactor unrelated code
- redesign the architecture
- add future functionality
- improve unrelated files
- implement anticipated requirements

If you discover an unrelated issue:

1. Do not fix it.
2. Report it briefly.
3. Continue only if it does not affect the current task.

If it blocks the current task, report the blocker.

---

# 7. NO SPECULATIVE ENGINEERING

Do NOT build things merely because they might be useful later.

Do NOT:

- add abstractions "for future use"
- implement unconfirmed requirements
- add integrations before they are required
- create configuration for hypothetical features
- refactor working code because another design looks cleaner
- add dependencies without a current requirement
- optimize code without evidence of a real problem

Solve the current problem.

Do not solve hypothetical future problems.

---

# 8. TASK BOUNDARIES

Every task must have:

1. a clearly defined objective
2. explicit acceptance criteria
3. a finite scope

If the current prompt does not provide enough information to safely
implement the task, ask for clarification instead of guessing.

### If something fails

Follow this process:

1. Identify the failure.
2. Determine whether it is within the current task.
3. If yes, make the smallest reasonable fix.
4. Run the relevant verification once again.

If the same issue still fails after a reasonable correction:

**STOP.**

Report the blocker instead of entering an endless fix/test loop.

If solving the issue requires an architectural decision:

**STOP and ask.**

Do not make major architectural decisions unilaterally.

---

# 9. VERIFICATION DISCIPLINE

Use the smallest verification that proves the current change works.

### Small change

Prefer:

- targeted test
- relevant typecheck/lint if necessary

Do NOT automatically run:

- full test suite
- production build
- unrelated tests
- broad repository audits

### Feature boundary

Run:

- relevant tests
- typecheck
- lint

### Phase / release boundary

Run:

```bash
npm run verify