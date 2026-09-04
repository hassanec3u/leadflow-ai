# LeadFlow AI — Implementation Roadmap

Phases are ordered so each produces something demoable and de-risks the hardest unknowns (async pipeline, AI cost/quality) early.

## Phase 0 — Foundations ✅ COMPLETE

Implemented 2026-09-01. As-built detail in `docs/architecture.md` §11; status and limitations in `progress.md`.

- [x] Repo scaffold (Next.js 16.3.4 App Router, TypeScript strict, Tailwind v4, shadcn/ui), lint/typecheck/test pipeline via `npm run verify`
- [x] Auth via **Auth.js (NextAuth v5) + Prisma Adapter** — Credentials provider only; **Google OAuth not implemented**
- [x] ~~Organization model + signup that provisions an org and its first ADMIN~~ — removed: the product is single-tenant, and accounts are provisioned by `npm run db:seed`
- [x] Base DB schema (Prisma 7) + migrations for User — **not** Lead, which is Phase 1
- [x] ~~Session-derived multi-tenancy DAL + Postgres RLS~~ — removed with multi-tenancy. The session-derived DAL (`requireUser`, `requireCapability`) remains.
- [x] `AppShell` (dark sidebar + light content), routing skeleton, capability-based nav filtering
- [ ] CI/CD — not configured; `npm run verify` runs the gate locally
- [ ] Invite flow — deferred to Phase 7 (settings/users), was not in the Phase 0 requirement list

**Blocking Phase 1:** a real `DATABASE_URL` (Neon) so `npm run db:migrate` can run and the signup/login flow can be confirmed end-to-end.

## Phase 1 — Core Lead Management

- Leads CRUD, `/leads` table (filter/sort/search/paginate), `/leads/:id` detail
- Manual lead entry + CSV import (with per-row error reporting)
- Empty/loading/error states for leads table

## Phase 2 — Automation Pipeline Engine (highest technical risk — build first)

- Job queue integration: **Inngest** (decided — see `docs/architecture.md` §3.2)
- ~~Multi-tenant foundation~~ — removed. The product is single-tenant (architecture.md §4).
- Single auto-provisioned `Workflow`/`WorkflowStep` (fixed pipeline definition, not a builder — architecture.md §10) + `WorkflowRun`/`WorkflowRunStep` schema, including the `blocked` status and `dedup_key` uniqueness (architecture.md §5). Originally 7 steps including "Add to CRM"; that step was later removed (architecture.md §5) since LeadFlow's own `Lead` row is already the system of record — the shipped pipeline is Ingest + 5 execution steps.
- Inbound webhook + form capture → upsert-on-`(org_id, email)` → enqueue run, with idempotency keys on every side-effecting step call.
- `/automation/runs` execution history view, retry action.
- Ship with Ingest and Notify (in-app only) working end-to-end before AI/enrichment are real, using stub/mock providers — validates the async architecture independent of AI quality. (Originally also listed the now-removed "Add to CRM" step here.)
- Rate limiting on the public lead-capture endpoint ships in this phase, not deferred to Phase 8 — it's a day-one abuse/cost vector once the endpoint is live.

## Phase 3 — Enrichment Slot & AI Qualification

- `EnrichmentProvider` interface (step 2) shipped with **no vendor wired in yet** — vendor is unconfirmed; step is `skipped` (per architecture.md §5) until one is chosen
- OpenAI GPT-4o integration (**confirmed**): schema-validated/structured-output scoring (clamped 0–100), summary, intent keywords, recommended action (step 3–4); malformed output flags the lead for manual review instead of guessing a score
- Per-org monthly AI budget check enforced before every OpenAI call; `regenerate-insight` rate-limited per lead
- `/ai-qualification` threshold config
- `AIInsightPanel` on lead detail + dashboard
- Cost/latency monitoring for OpenAI calls (token usage per lead)
- Decision needed before this phase starts: which enrichment vendor (or none for v1) — see Open Questions

## Phase 4 — Outreach & Campaigns

- [x] `EmailProvider` — **vendor decided: Resend** (2026-09-04). Sends an acknowledgement to the prospect who submitted the form; deliberately contains no AI-generated text (see below)
- AI-drafted personalized email (step 6) — **NOT built, deliberately.** The qualification `summary` is an internal explanation of the score ("company unverified, authority in doubt") and must never be mailed to the prospect. A dedicated prospect-facing drafting call is a separate task; the shipped template uses only the lead's own words
- `/campaigns` list + `/campaigns/:id` builder (fixed sequence, no visual builder yet)
- Reply-detected → status update workflow

## Phase 5 — Notifications & CRM Sync

- Slack integration (**confirmed**, step 7 real delivery); `User.slackUserId` for owner DMs, falling back to a default channel when unset
- Airtable integration (**confirmed**, step 5 CRM sync, **one-way LeadFlow → Airtable**, upsert keyed by a stable external id to stay idempotent on retry)
- `/integrations` connect/manage UI, credential storage, test-connection action

## Phase 6 — Dashboard & Analytics

- Full dashboard (screenshot parity): StatCards, donut, leads-over-time chart, recent leads table
- `DailyMetric` rollup job for completed days + live computation for the current day (architecture.md §7)
- `/analytics` deeper reporting + CSV/PDF export (PII-bearing; Admin/Manager only)

## Phase 7 — Permissions, Settings, Billing

- Full RBAC enforcement across all routes/API (Admin/Manager/Sales Rep)
- `/settings/users`, `/settings/billing`, `/settings/api-keys`
- Org-level plan/usage limits (esp. AI call volume)

## Phase 8 — Hardening & Launch Readiness

- Full pass on error/loading/empty states across all pages
- Security review (webhook signing for both our own and third-party providers, credential encryption, audit log coverage)
- Verify lead-deletion cascade (product-spec.md §12.1) actually removes PII-bearing child rows
- Load-test the pipeline (queue backpressure under lead-volume spikes; confirm dedup/idempotency holds under duplicate webhook delivery)
- Test suite completion (see `tests.json`)

## Sequencing Rationale

The automation pipeline (Phase 2) is built _before_ real AI/enrichment providers are wired in, using stubs, because the async/queue/retry architecture is the highest-risk unknown and the dashboard's core visual language (the stepper, run history) depends on it existing. AI quality and integration reliability are then layered in without touching the execution model.
