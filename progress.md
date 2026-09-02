# LeadFlow AI — Progress Log

Last updated: 2026-09-01

## Status: Phase 0 and Phase 1 (Core Lead Management) complete, verified end-to-end against real PostgreSQL

Phase 0 — Foundations is implemented. The application builds, starts, serves its routes, and passes typecheck, lint, Prisma validation and 67 tests. Real PostgreSQL authentication was verified end-to-end: Signup → Login → Authenticated Dashboard → Logout → Protected route blocked. A session/tenant bug was found and fixed in `lib/auth/session.ts` during this verification.

Phase 1 — Core Lead Management is implemented across five sub-tasks (1A database, 1B service, 1C read UI, 1D mutations, 1E CSV import) and passed a live E2E smoke test against real PostgreSQL (create → search → detail → edit → soft-delete → CSV import → tenant isolation). One real bug was found and fixed during that smoke test (duplicate-email detection against the real Postgres driver).

Phase 1.1 — Lead business-rules closure is implemented: ownership is now optional ("Unassigned" leads, no fake system owner), email is normalized (trim + lowercase) consistently on create/update/CSV import, duplicate is explicitly defined as reject-on-exact-normalized-email (not upsert — resolves the mismatch flagged after Phase 1E), and soft-deleted leads are confirmed to retain their email identity. See "Known limitations" below for what remains (pre-existing unrelated auth-infra test failures; Export still not implemented).

## Phase Checklist

- [x] **Phase 0 — Foundations** _(complete; see limitation below)_
- [x] **Phase 1 — Core Lead Management** _(complete; see limitations below)_
- [x] **Phase 1.1 — Lead business-rules closure** _(complete; see limitations below)_
- [ ] Phase 2 — Automation Pipeline Engine ← next
- [ ] Phase 3 — Enrichment & AI Qualification
- [ ] Phase 4 — Outreach & Campaigns
- [ ] Phase 5 — Notifications & External Sync
- [ ] Phase 6 — Dashboard & Analytics
- [ ] Phase 7 — Permissions, Settings, Billing
- [ ] Phase 8 — Hardening & Launch Readiness

## Phase 0 — what was delivered

| Requirement                     | Status | Notes                                                                             |
| ------------------------------- | ------ | --------------------------------------------------------------------------------- |
| Application starts              | ✅     | `npm run build` + `npm start` verified; routes return expected status codes        |
| Clean Next.js architecture      | ✅     | Next.js 16.3.4 App Router, route groups `(app)` / `(auth)`, business logic in `lib/` |
| Authentication                  | ✅     | Auth.js v5 + Prisma adapter, Credentials provider, JWT sessions                    |
| Organizations                   | ✅     | `Organization` model, auto-created at signup with unique slug                      |
| Users and roles                 | ✅     | `User` + `Role` enum (ADMIN / MANAGER / SALES_REP)                                 |
| PostgreSQL + Prisma             | ✅     | Prisma 7 + `@prisma/adapter-pg`; schema validates, migrations generated            |
| Multi-tenant isolation          | ✅     | Session-derived org, `withTenant()`, never trusts client-supplied org id           |
| PostgreSQL RLS                  | ✅     | Policies with `FORCE ROW LEVEL SECURITY`, verified against real Postgres           |
| Environment variable validation | ✅     | Zod, fail-fast, optional integrations genuinely optional                           |
| Application shell               | ✅     | Dark sidebar + light content, per the product reference                            |
| Sidebar/navigation              | ✅     | 7 destinations, capability-filtered                                                |
| Testing configured              | ✅     | Vitest (node + jsdom projects), PGlite for database tests — 67 tests               |
| Linting configured              | ✅     | ESLint 9 flat config + Prettier                                                    |
| TypeScript strict mode          | ✅     | `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, and more           |
| Error handling foundations      | ✅     | `AppError` taxonomy, route/global boundaries, API error envelope                   |
| Logging foundations             | ✅     | Structured JSON logger with secret and PII redaction                               |

## Phase 1 — what was delivered

| Requirement                                          | Status | Notes                                                                                                    |
| ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `Lead` database model                                 | ✅     | 1A — enums for source/status/qualification, tenant-scoped email uniqueness, soft delete (`deletedAt`)      |
| RLS enabled + forced on `leads`                       | ✅     | 1A — `FORCE ROW LEVEL SECURITY`, `USING`/`WITH CHECK`, verified via the real, non-superuser `leadflow_app` role |
| Lead service (create/get/list/update/delete)          | ✅     | 1B — `lib/services/leads.ts`; org always session-derived, never client input                              |
| RBAC/ownership (ADMIN/MANAGER see all, REP sees own)  | ✅     | 1B — capability-gated, enforced server-side in the query, not just the UI                                 |
| Leads UI on real PostgreSQL data                      | ✅     | 1C — search/filter/sort/pagination/loading/error/empty states, via the Lead service only                  |
| Create/Edit/Soft-delete through the real UI           | ✅     | 1D — Add Lead dialog, inline detail-panel edit, delete — all persisted, not mock                          |
| CSV import                                            | ✅     | 1E — per-row validation, reuses `createLead()` (no parallel logic), rejects unrecognized columns           |
| CSV/manual leads trigger no automation                | ✅     | No workflow engine exists yet (Phase 2) — nothing to trigger; verified explicitly by test and by design    |

## Phase 1.1 — what was delivered

| Business rule                                                          | Status | Notes                                                                                                    |
| ------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------- |
| Lead ownership is optional ("Unassigned")                              | ✅     | `Lead.ownerId` nullable (migration `20260902001000_lead_ownership_optional`); no fake system owner, no auto-assignment; existing assigned leads unchanged |
| Email normalization (trim + lowercase) before persistence/comparison   | ✅     | Fixed order of operations in `lib/validation/leads.ts` so normalization runs BEFORE the format check, not after |
| Minimal syntactic email validation                                     | ✅     | Unchanged — still Zod's `.email()`, no mailbox/domain checks                                              |
| Soft-deleted leads excluded from list/search/filter/sort/detail        | ✅     | Already correct pre-existing behavior; added explicit tests confirming it                                 |
| Soft-deleted lead retains its email identity (blocks recreation)       | ✅     | Already correct at the DB level (plain unique index, not filtered by `deletedAt`); added explicit tests   |
| Duplicate = exact normalized-email match, no fuzzy/heuristic matching  | ✅     | Documented as the decided MVP behavior in `docs/product-spec.md` §5, resolving the earlier upsert-vs-reject mismatch |
| Manual/CSV leads never auto-enroll in automation                       | ✅     | Unchanged (no automation engine exists yet); added an explicit manual-creation test alongside the existing CSV one |
| Export                                                                  | ⏸️     | Not implemented (button is a placeholder toast) — confirmed and deferred, not built in this task           |

## Known limitations (explicit — not claimed as done)

1. **Migrations and sign-up/sign-in have since been verified against a real PostgreSQL database** (see Log entry below) — this closes what was previously listed here as unverified.
2. **Google OAuth is not implemented.** Only the Credentials provider is wired up. The architecture document previously implied both; it now carries an as-built note. Adding Google is a provider entry plus credentials — no change to session, tenancy or RBAC design.
3. **Email verification and the invite flow are not implemented** (`auth-2` in `tests.json` stays `not_started`). Both belong to Phase 7 settings/user management; neither was in the Phase 0 requirement list.
4. **No CI pipeline is configured.** `npm run verify` runs the whole gate locally; wiring it to a CI provider is deployment work not requested here.
5. ~~`tests.json`'s `leads-5` describes upsert-on-duplicate...~~ **Resolved in Phase 1.1**: `docs/product-spec.md` §5 now explicitly documents reject-on-duplicate (exact normalized-email match, `ConflictError`) as the decided MVP behavior; `leads-5` is marked superseded in `tests.json`, `leads-20` covers the decided behavior.
6. **No automated browser-level E2E test runner exists.** The Phase 1 E2E pass (create/search/detail/edit/delete/CSV import/tenant isolation, all against real PostgreSQL) was done manually via browser automation on 2026-09-01 and is not a repeatable CI-run suite — same gap as `auth-1` in Phase 0.
7. **Pre-existing, unrelated test failures**: `tests/integration/session-tenancy.test.ts` (5 tests) and `tests/integration/auth-lookup-security-definer.test.ts` (6 tests) fail as of this update. Confirmed unrelated to any Lead work — they touch only `lib/auth/config.ts`/`lib/auth/session.ts`/the PGlite auth-lookup role, none of which Phase 1 touched. Not fixed, per scope discipline (out of the Leads task); needs its own investigation.
8. **Owner filter in the Leads UI is derived from a broad, unfiltered `listLeads` call** (no dedicated "list org members" endpoint exists) — only owners with at least one non-deleted lead appear, capped at 100 leads. A known, minor limitation, not a bug.

## Deployment requirements discovered in Phase 0

Two constraints that **silently void RLS** if ignored — both now documented in `docs/architecture.md` §4:

1. The application's database role must **not** be a superuser and must **not** hold `BYPASSRLS`. PostgreSQL superusers bypass RLS entirely. This was caught by the test suite: the first run of the isolation tests passed queries that should have been blocked, purely because the connection was the bootstrap superuser.
2. `AUTH_URL` must be set for any self-hosted, internet-facing deployment, because the app sets Auth.js `trustHost: true` (required outside Vercel — without it every auth request fails with `UntrustedHost`).

## Log

- **2026-09-01** — Repository inspected: empty except a blank `claude.md`. Produced `docs/product-spec.md`, `docs/architecture.md`, `docs/roadmap.md`, `progress.md`, `tests.json` from the LeadFlow AI dashboard screenshot. Key assumptions (multi-tenant SaaS, Next.js/TS/Postgres stack) recorded in `docs/product-spec.md` §2.

- **2026-09-01** — Corrected vendor-confirmation status across all specs per stakeholder feedback: **OpenAI GPT-4o, Airtable, Slack are confirmed**; **the enrichment provider ("Clearbit" in the mockup) and the email-sending provider are NOT confirmed**. Introduced the provider-interface abstraction so unconfirmed slots stay pluggable.

- **2026-09-01** — Resolved infrastructure alternatives into firm decisions (`docs/architecture.md` §3.1–§3.3): **Auth.js (NextAuth v5) + Prisma Adapter**, **Inngest**, **Neon**.

- **2026-09-01** — Pre-implementation architecture review: 6 CRITICAL, 9 IMPORTANT, 6 OPTIONAL findings. Applied corrections across all specs — RLS moved to Phase 0, idempotency/dedup specified, Airtable sync fixed to one-way, `/workflows` collapsed to a single `/automation` pipeline, AI cost controls and rate limiting added, data-deletion subsection added.

- **2026-09-01** — **Phase 0 implemented.** Scaffolded Next.js 16.3.4 (App Router, TypeScript strict, Tailwind v4, shadcn/ui), Prisma 7 + PostgreSQL with `Organization`/`User`/`Role` and the Auth.js models, Auth.js v5 credentials authentication, the session-derived tenancy DAL (`getCurrentUser` / `getCurrentOrganization` / `requireRole` / `requireCapability`), RLS policies with `FORCE`, Zod env validation, the redacting logger, the error taxonomy and boundaries, the application shell with seven placeholder pages, and a Vitest + PGlite test suite (67 tests, all passing). Full quality gate green: typecheck, lint, `prisma validate`, tests, build, startup. Two real bugs were found and fixed during verification: Auth.js `UntrustedHost` breaking all auth in production mode, and an RLS test suite that was passing vacuously because it ran as a superuser. Documented in `docs/architecture.md` §11.

- **2026-09-01** — Connected a real PostgreSQL database and ran `npm run db:migrate`; migrations applied cleanly. Verified authentication end-to-end through the browser against that database: Signup → Login → Authenticated Dashboard → Logout → Protected route blocked. Found and fixed a session/tenant bug in `lib/auth/session.ts` during this pass; re-verified afterward with the same flow.

- **2026-09-01** — **Phase 1A: Lead database foundation.** Added `Lead` model (`prisma/schema.prisma`) with `LeadSource`/`LeadStatus`/`LeadQualification` enums, tenant-scoped email uniqueness (`@@unique([organizationId, email])`), soft delete (`deletedAt`), owner FK (`onDelete: Restrict`). Migration `20260902000000_lead_foundation` applied to the real dev database with `ENABLE`/`FORCE ROW LEVEL SECURITY` and a `USING`/`WITH CHECK` tenant policy. 8 new integration tests (`tests/integration/lead-rls.test.ts`), all passing, run against the real non-superuser `leadflow_app` role. No CRUD/API/UI/CSV/AI/workflows — explicitly out of scope for this sub-task.

- **2026-09-01** — **Phase 1B: Lead service.** Added `lib/services/leads.ts` (`createLead`/`getLead`/`listLeads`/`updateLead`/`deleteLead`) and `lib/validation/leads.ts`. Organization always derived from `requireUser()`, never a parameter; RBAC-based ownership scoping (ADMIN/MANAGER see all, SALES_REP scoped to `ownerId`); `AppError` taxonomy for all failure paths; duplicate email mapped to `ConflictError`. 16 new unit tests (`tests/unit/leads-service.test.ts`), all passing. No UI wiring, no API routes, no CSV/AI/workflows.

- **2026-09-01** — **Phase 1C: Leads UI connected to real PostgreSQL.** Replaced the mock-data Leads page/components with real data through the Phase 1B service: `app/(app)/leads/page.tsx` + new `app/(app)/leads/actions.ts` (`listLeadsAction`), rewritten `leads-view.tsx`/`lead-detail-panel.tsx`/`lead-badges.tsx`, deleted `mock-leads.ts`. Real search/filter/sort/pagination/loading/error/empty states. Client never supplies `organizationId`. Add Lead/Delete interactions left local/mock, as explicitly allowed for this sub-task. Existing Phase 1A/1B tests still green; typecheck/lint clean.

- **2026-09-01** — **Phase 1D: Lead mutations connected to real PostgreSQL.** Added `createLeadAction`/`updateLeadAction`/`deleteLeadAction` (all thin wrappers over the Phase 1B service). Add Lead dialog now persists for real (source fixed to `MANUAL`); detail panel gained an inline edit mode (name/email/company/phone) calling `updateLead`; delete now calls `deleteLead` (soft-delete) and refreshes the list. 7 new unit tests covering real update, duplicate email on update, unauthorized update/delete by a non-owner rep, and cross-tenant delete — all passing (24 total in the Lead test files at that point).

- **2026-09-01** — **Phase 1E: CSV import.** Added `lib/csv.ts` (pure parser; rejects any unrecognized column, including a smuggled `organizationId`), `importLeads()` in the Lead service (loops rows through the same `createLead()` used everywhere else — no parallel validation/business logic), `importLeadsAction`, and an `ImportCsvDialog` wired to the existing "Import CSV" button. Per-row success/failure reporting; one bad row never aborts the batch. 12 new tests (5 CSV-parser unit tests + 7 import-service tests: valid/invalid/mixed rows, duplicate email, empty required fields, tenant isolation, authorization, no automation side effect) — all passing (42 total across the three Lead test files).

- **2026-09-01** — **Phase 1 read-only acceptance check.** Re-ran the focused Lead test suite (42 tests) and inspected the RLS migration/schema directly; all 24 acceptance criteria (database, RLS, tenant isolation, CRUD, search/filter/sort/pagination, detail, RBAC, CSV import, UI-on-real-data, no-automation) confirmed. No files modified.

- **2026-09-01** — **Phase 1 E2E smoke test, against real PostgreSQL via the browser.** Create → search → detail → edit → refresh → soft-delete → refresh: all passed and were independently confirmed with direct SQL queries. CSV import: valid rows created, invalid row reported per-row, an `organizationId` column in the CSV was rejected outright (whole-file), and duplicate-email import was checked. Tenant isolation was verified directly against Postgres using the actual restricted `leadflow_app` role (not a UI account switch, to avoid signing the developer's real browser session out with no way back in) — cross-org read/update/delete all blocked, 0 rows affected. Two real issues surfaced and were fixed: (1) the already-running dev server had a stale in-memory Prisma Client from before the last `prisma generate` — restarted it, no code change; (2) **a real bug** — `isUniqueEmailViolation()` in `lib/services/leads.ts` only matched Prisma's classic `meta.target` shapes, but `@prisma/adapter-pg` against real Postgres reports the violated constraint at `meta.driverAdapterError.cause.constraint.index` instead, so duplicate-email create/update/import were falling through to a generic error instead of the intended "already exists" message. Fixed by also checking that path; re-ran the CSV duplicate-email scenario once — passed; re-ran the full 42-test focused suite — still green. All test data created during this pass was cleaned up (soft-deleted or removed).

- **2026-09-01** — **Phase 1.1: Lead business-rules closure.** `Lead.ownerId` made nullable (migration `20260902001000_lead_ownership_optional`, applied to the real dev database; RLS/FK confirmed intact via `psql` and a live insert/cleanup smoke check) — a Lead may now be "Unassigned" with no fake system owner or auto-assignment; `resolveOwnerId()` in `lib/services/leads.ts` extended to a tri-state (omitted/null/id) while preserving all existing default-to-self and reassignment-authorization behavior. Fixed email normalization in `lib/validation/leads.ts`: trim + lowercase now run BEFORE the `.email()`/length checks (previously after, which meant a leading/trailing space was rejected rather than normalized) — applies uniformly to create, update, and CSV import since all three share this schema. Documented the decided duplicate-email semantics (reject, not upsert) and soft-delete email-identity rule in `docs/product-spec.md` §5, resolving the mismatch flagged in the Phase 1E report. Added 15 new tests (13 in `tests/unit/leads-service.test.ts`, 2 in `tests/integration/lead-rls.test.ts`, real Postgres via PGlite) covering ownership-optional, normalization on create/update/CSV, normalized-duplicate detection, invalid-email rejection, soft-delete/email-identity, no-automation on manual creation, and a regression test locking in the real `@prisma/adapter-pg` P2002 error shape fixed during the earlier E2E pass. Confirmed Lead export is not implemented (placeholder toast only) — deferred, not built. Full focused Lead suite: 57/57 passing; typecheck/lint clean; `prisma validate` clean.

## Open Items Carried Forward

- Which vendor (if any) fills the **enrichment provider** slot — not yet confirmed.
- Which vendor fills the **email-sending provider** slot — not yet confirmed, and blocks Phase 4 start.
- Target user segment and tenancy model were never explicitly confirmed by the stakeholder; the tech stack is now settled and implemented.
- ~~A `DATABASE_URL` for a real PostgreSQL/Neon instance is needed to run `npm run db:migrate` and confirm the end-to-end signup/login flow.~~ Done — see Log entry below.
- OPTIONAL findings from the architecture review still not acted on (by design): lead lifecycle termination rule, login brute-force lockout/MFA, PII redaction tier for analytics export, Campaign scope creep watch, reply-detection mechanism.
- **Pre-existing failures in `session-tenancy.test.ts` and `auth-lookup-security-definer.test.ts`** (11 tests) — unrelated to any Lead work, not yet investigated (see Known limitations #7).
- No automated browser-level E2E runner — the Phase 0 and Phase 1 end-to-end passes were manual (see Known limitations #6).
- **Lead export** is not implemented (Known limitations, Phase 1.1 table) — deferred until requested.
