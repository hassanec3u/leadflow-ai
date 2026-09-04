# LeadFlow AI — Architecture

Status: v1 — **Phase 0 implemented** (see §11 for what is actually built). Companion to `product-spec.md`.

## 1. Guiding Constraints

- Multi-tenant SaaS; every tenant-owned row scoped by `org_id`.
- The automation pipeline (§8 of product-spec) calls three external APIs per lead (Clearbit, OpenAI, email provider) plus Slack/Airtable — these are slow and can fail, so pipeline execution must be **asynchronous and resumable**, not inline in the request/response cycle.
- The dashboard needs live-ish workflow status (screenshot shows step checkmarks and an "Active" badge) — steps must report progress observably, not just fire-and-forget.
- Of the pipeline's external calls, only three are confirmed vendors: **OpenAI GPT-4o** (AI qualification), **Airtable** (CRM sync), **Slack** (notifications). The enrichment provider and the email-sending provider are unconfirmed — the mockup's "Clearbit API" label is illustrative, not a requirement. Architecture must not hard-depend on either; both go behind a swappable provider interface (§9).

## 2. High-Level System

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Next.js App │◄────►│  API Layer        │◄────►│  PostgreSQL (Prisma) │
│ (App Router, │      │ (Next.js Route    │      │  org-scoped tables   │
│  React UI)   │      │  Handlers / REST) │      └─────────────────────┘
└─────────────┘      └────────┬─────────┘
                               │ enqueue
                               ▼
                     ┌───────────────────┐
                     │  Job Queue          │  (Inngest — durable step
                     │  (workflow runner)  │   functions, managed)
                     └────────┬───────────┘
                               │
          ┌──────────┬───────────┬───────────┬────────┬─────────┐
          ▼          ▼           ▼           ▼        ▼
    ┌──────────┐┌──────────┐┌──────────┐┌────────┐┌─────────┐
    │Enrichment││  OpenAI  ││  Email   ││ Slack  ││ Airtable│
    │ provider ││  GPT-4o  ││ provider ││        ││         │
    │(TBD, plu-││(confirmed││(TBD, plu-││(confir-││(confir- │
    │  ggable) ││    )     ││  ggable) ││  med)  ││  med)   │
    └──────────┘└──────────┘└──────────┘└────────┘└─────────┘
```

Inbound lead capture (webhook/form/ad-platform) hits an API route, writes the `Lead` row, then enqueues a `WorkflowRun`. A worker process executes each `WorkflowStep` in order, writing a `WorkflowRunStep` row (pending → running → success/failed) after every step — this is what powers the dashboard's stepper and "Active/All automations running" widget. Failures are retried with backoff; after N failures the run is marked `failed` and surfaced as an error state (§13 product-spec) with a manual re-run action.

## 3. Tech Stack

| Layer                           | Choice                                                   | Why                                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend                        | Next.js 14+ (App Router), TypeScript, Tailwind, Recharts | SSR for dashboard perf, one deploy target, strong AI/agent tooling ecosystem                                                                                                                                                                    |
| API                             | Next.js Route Handlers (REST)                            | Colocated with frontend; simplest deploy; can extract to standalone service later if needed                                                                                                                                                     |
| DB                              | PostgreSQL + Prisma ORM                                  | Relational data fits the entity model cleanly; Prisma migrations give safe schema evolution                                                                                                                                                     |
| **Auth**                        | **Auth.js (NextAuth v5) + Prisma Adapter**               | Decided — see §3.1                                                                                                                                                                                                                              |
| **Job queue / workflow runner** | **Inngest**                                              | Decided — see §3.2                                                                                                                                                                                                                              |
| **DB hosting**                  | **Neon** (managed Postgres)                              | Decided — see §3.3                                                                                                                                                                                                                              |
| Hosting                         | Vercel (app) + Neon (Postgres)                           | Low-ops path to production; no self-managed Redis/queue infra needed (Inngest is fully managed)                                                                                                                                                 |
| AI qualification                | OpenAI API (GPT-4o)                                      | **Confirmed** — named explicitly in the source screenshot                                                                                                                                                                                       |
| CRM sync                        | Airtable                                                 | **Confirmed** — named explicitly in the source screenshot                                                                                                                                                                                       |
| Team notifications              | Slack                                                    | **Confirmed** — named explicitly in the source screenshot                                                                                                                                                                                       |
| Enrichment                      | Pluggable provider interface, no vendor selected         | **Not confirmed** — screenshot's "Clearbit API" label is illustrative only. This is a _product/vendor_ decision pending stakeholder input, not an infrastructure ambiguity, so it is intentionally left open (see §9) rather than decided here. |
| Email sending                   | Pluggable provider interface, no vendor selected         | **Not confirmed** — screenshot only shows "Personalized Email," no vendor. Same reasoning as Enrichment.                                                                                                                                        |

### 3.1 Decision: Auth.js (NextAuth v5) over Clerk / Supabase Auth

**Decision:** Auth.js (NextAuth v5) with the Prisma Adapter, Credentials (email/password) + Google OAuth providers, sessions stored in our own Postgres via Prisma.

> **As-built note (Phase 0):** only the **Credentials** provider is implemented. Google OAuth is configured for but not wired up — adding it is a provider entry plus a client id/secret, with no change to the session, tenancy or RBAC design. Tracked as remaining Phase 0 scope in `progress.md`.

**Alternatives considered:** Clerk (hosted auth-as-a-service with prebuilt UI, org/invite management), Supabase Auth (bundled with Supabase Postgres).

**Rationale:**

- **Simplicity for this schema:** `Organization`, `User`, and `role` are already first-class tables in our own Prisma schema (product-spec.md §5). Auth.js writes sessions/accounts directly into that same database — there's no second user store to keep in sync. Clerk and Supabase Auth both own the user record externally, requiring a webhook-driven sync job to mirror users into our `User` table just to satisfy our own `org_id` scoping and RBAC model — that's an extra moving part this MVP doesn't need.
- **Reliability:** No dependency on a third auth vendor's uptime/API for every login; failure mode is the same as any other query against our own Postgres, which we're already operationally responsible for.
- **Developer experience:** Auth.js v5 has first-class App Router support (route handlers, middleware, server components) and is the incumbent, best-documented choice for this exact stack; the team isn't adopting a new vendor SDK/dashboard just for auth.
- **Cost:** Free and self-hosted — no per-MAU billing. Clerk's free tier (10k MAU) is generous but becomes a recurring cost as the org grows; Supabase Auth is free but only if we also adopt Supabase as the DB host, which competes with the Neon decision below.
- **MVP suitability:** We need email/password + one OAuth provider (Google) and org-scoped RBAC — exactly Auth.js's core use case, without the extra prebuilt-UI surface (Clerk) or platform lock-in (Supabase) we'd otherwise be paying for and not fully using.

### 3.2 Decision: Inngest over Trigger.dev / BullMQ+Redis

**Decision:** Inngest for the workflow engine — each `WorkflowStep` is an Inngest step function (`step.run(...)`), triggered by an event emitted on lead ingestion.

**Alternatives considered:** Trigger.dev (comparable managed durable-execution platform), BullMQ + self-hosted Redis.

**Rationale:**

- **Simplicity:** Inngest functions are invoked over a single HTTP endpoint from Next.js (`/api/inngest`) — no separate worker process or Redis instance to provision, deploy, or monitor. BullMQ requires standing up and operating a Redis instance plus a long-running worker process, which is unnecessary ops overhead for an MVP on Vercel's serverless model.
- **Reliability:** Inngest persists step state server-side and automatically retries failed steps with backoff, which is exactly the `WorkflowRunStep` (pending/running/success/failed) behavior specified in §5 — we get durable, resumable execution without building our own retry/backoff/dead-letter logic on top of BullMQ.
- **Developer experience:** Inngest's built-in run/step dashboard gives per-lead, per-step visibility for free, closely matching what `/workflows/:id/runs` needs to render — reducing custom observability tooling we'd otherwise build. Trigger.dev offers similar capability, but Inngest's step-function model maps more directly onto our fixed 7-step pipeline and its Next.js integration (single route handler, no separate deploy target) is simpler for this codebase.
- **Cost:** Inngest's free tier covers MVP-scale execution volume (tens of thousands of function runs/month); pricing then scales with usage rather than requiring an always-on Redis instance to pay for regardless of load (as BullMQ would via Upstash/self-hosted Redis).
- **MVP suitability:** Zero infrastructure to manage before the first lead is processed; the team can focus on pipeline logic instead of queue operations.

### 3.3 Decision: Neon over Supabase for managed Postgres

**Decision:** Neon as the managed PostgreSQL host.

**Alternatives considered:** Supabase Postgres.

**Rationale:**

- **Simplicity:** Since Auth.js (not Supabase Auth) was chosen in §3.1, Supabase's main differentiator — bundled auth + DB — isn't used, so it would add an unused platform surface. Neon is Postgres-only, matching exactly what Prisma needs.
- **Developer experience:** Neon's branching (a full DB branch per PR/preview environment) fits a Vercel preview-deployment workflow well, useful for testing schema/migration changes safely during active MVP development.
- **Cost:** Neon's free tier is sufficient for MVP development and early production load; scales on usage without requiring adoption of Supabase's broader (and pricier) platform tier as data grows.
- **Reliability & MVP suitability:** Standard managed Postgres with point-in-time recovery; no functional gap versus Supabase for our purposes since we aren't using Supabase's auth, storage, or edge functions.

## 4. Multi-Tenancy

**Revised after architecture review — this is now a Phase 0 requirement, not deferred hardening:**

- `org_id` is denormalized onto **every** tenant-owned table, including ones only reachable via a join in the logical model (`LeadEnrichment`, `AIInsight`, `EmailEvent`, `CampaignStep`, `WorkflowRunStep`) — not just the top-level entities (`Lead`, `Campaign`, `Workflow`). This closes the gap where a query that forgets one join hop could silently span tenants.
- Postgres Row-Level Security (RLS) policies (`org_id = current_setting('app.current_org_id')`) are enabled on all tenant tables **from Phase 0**, as the primary enforcement mechanism — application-layer scoping is a second layer, not the only one. Previously this was described as deferred defense-in-depth; that was a mistake for a multi-tenant SaaS and is corrected here.
- All API/DB access goes through a query layer that injects `org_id` from the authenticated session; RLS is the backstop if that layer is ever bypassed (a script, an admin tool, a future direct-DB integration).

**Two deployment constraints, both discovered while implementing and verifying this in Phase 0. Neither is optional — either one silently voids every policy above:**

1. **The application's database role must not be a superuser and must not hold `BYPASSRLS`.** PostgreSQL superusers ignore RLS entirely. This was caught by the Phase 0 test suite: the first run of the isolation tests "passed" tenant queries that should have been blocked, purely because the test connection was the bootstrap superuser. Provision a dedicated role (`GRANT SELECT, INSERT, UPDATE, DELETE`, nothing more) for the app's `DATABASE_URL`.
2. **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** Plain `ENABLE` exempts the table's owner. If the app connects as the role that owns the tables — the default when migrations and the app share a role — `ENABLE` alone would leave policies unenforced. Both are set in the RLS migration, and a test asserts `relforcerowsecurity` is true.

## 5. Data Flow: the pipeline

**Revised after Phase 2:** the original design below numbered 7 steps including "Add to CRM." That step was removed — LeadFlow AI is itself the CRM, so syncing a lead to a separate CRM mid-pipeline duplicated `Lead`, which is already the system of record from ingestion onward. The implemented pipeline (`lib/automation/pipeline.ts`, `PIPELINE_STEPS`) is Ingest + 5 execution steps: Enrich, AI Qualification, Score & Tag, Send Email, Notify Team. Step 5 below ("Add to CRM") is left in place, struck through, as a record of the original design and why it was cut — not as a description of current behavior.

**Deduplication & idempotency (added after architecture review):** ingestion computes a `dedup_key` from the triggering event (e.g., org + source + external id, or org + email for form submits) and upserts `Lead` on `(org_id, email)` rather than always inserting — a repeat submission updates the existing lead and is treated as re-engagement, not a fresh pipeline run, unless the existing lead has no active run. `WorkflowRun.dedup_key` is unique, so a duplicate webhook delivery (a standard at-least-once delivery hazard) cannot start a second concurrent run for the same lead. Every side-effecting step (email send, Slack notify, Airtable upsert) is called with the owning `WorkflowRunStep.id` as an idempotency key where the provider supports one, and otherwise checked against existing records (e.g., "does an `EmailEvent(sent)` already exist for this run?") before executing — a retried step must never re-send a real email or re-create a real Slack message.

1. **Ingest** — `POST /api/webhooks/lead-capture` (or `/api/leads` for manual/import) validates payload, resolves `org_id` (via API key/webhook secret), upserts `Lead(status=new)` per the dedup rule above. **Only webhook/form/ad-source ingestion enqueues a `WorkflowRun`** — manual and CSV-imported leads do not auto-enroll (see product-spec.md §8 enrollment policy).
2. **Enrich** — worker calls the configured enrichment provider (**pluggable, vendor TBD**) with lead email/domain, writes `LeadEnrichment`, updates `Lead.status=enriching→enriched`. If no enrichment provider is connected, this step's `WorkflowRunStep.status=skipped` and the pipeline proceeds with unenriched data.
3. **AI Qualification** — worker calls **OpenAI GPT-4o** (confirmed) with lead + enrichment data using a schema-validated (structured-output) request, writes `AIInsight` (summary, keywords, recommended action), computes `ai_score` clamped to [0,100]. A per-org AI budget check runs before this call; if the org has exceeded its monthly quota, the step is `blocked`, not silently skipped. If the model's response fails schema validation, `ai_score` is left `null` and the lead is flagged for manual review rather than defaulting to a guessed score.
4. **Score & Tag** — apply org-configurable thresholds to `ai_score` → `Lead.qualification`. Skipped (not applicable) if step 3 left `ai_score` null.
5. ~~**Add to CRM** — sync the `Lead` to Airtable~~ **Removed after Phase 2.** LeadFlow's own `Lead` row created at step 1 already IS the CRM record — there was never a second system of record for this step to sync into. If an optional Airtable projection is ever built, it is a separate, decoupled integration, not a pipeline step (see product-spec.md §10). Kept numbered here, struck through, only so steps 6–7 below and their cross-references elsewhere in this document keep their original numbers.
6. **Send Email** — generate personalized email via OpenAI (lead-supplied text passed as data, never concatenated into the system/instruction prompt — mitigates prompt injection), send via the configured email provider (**pluggable, vendor TBD**), log `EmailEvent(type=sent)` linked to the triggering `WorkflowRunStep.id`; provider webhooks later log `opened`/`replied`. If no email provider is connected, `WorkflowRun.status=blocked` (see new status below) — sending is core to the product's value, so this is surfaced as blocked, not silently skipped like enrichment.
7. **Notify Team** — **Slack** (confirmed) message to the lead owner (via `User.slackUserId` if set) or a default channel; in-app `Notification` row created regardless of Slack connectivity (Slack is a delivery channel, not the source of truth).

`WorkflowRun.status` includes `pending/running/succeeded/failed/blocked` (added `blocked` for the missing-required-integration case, so a run stuck on step 6 with no email provider is distinguishable from an actual failure in workflow-success-rate analytics). `WorkflowRunStep.status` uses the same vocabulary plus `skipped`, and both now consistently use `succeeded` (not `success`) to avoid an enum-naming inconsistency the prior draft had.

Each step's `WorkflowRunStep` is what the dashboard's `WorkflowStepper` and `WorkflowStatusWidget` render; the frontend polls (or subscribes via SSE, if adopted later) `GET /api/automation/runs` for live status.

## 6. Security & Compliance Notes

- Integration credentials (OpenAI/Airtable/Slack tokens, plus whichever enrichment/email providers are eventually chosen) stored encrypted at rest (e.g., KMS-backed envelope encryption), never returned to the client.
- **Two distinct webhook-verification schemes** (previously described as one generic rule — corrected after architecture review): (1) our own inbound lead-capture endpoint (`/api/webhooks/lead-capture`) is authenticated via a per-org signing secret we issue; (2) each third-party provider's own inbound webhook (e.g., the eventual email provider's open/reply events) is verified using _that provider's_ signature scheme, not ours. Both reject unsigned/invalid payloads, but they are not the same code path.
- `/api/webhooks/lead-capture` is public-facing by design and is rate-limited per API key/source IP; sustained abuse is a direct cost vector (§7) as well as a security one, since each accepted lead can trigger a paid OpenAI call, an email send, and an Airtable write.
- PII (lead emails, phone numbers) — soft-delete + child-record cascade defined in product-spec.md §12.1; propagation of deletion to Airtable/OpenAI-held data is manual/best-effort for MVP (documented gap, not solved automatically).
- Audit log (`AuditLog`) captures role/permission-sensitive actions (user invites, integration changes, lead reassignment).
- Untrusted lead-supplied text is passed to OpenAI as data, never merged into the instruction/system portion of a prompt, to reduce prompt-injection risk from a crafted form submission whose output later drives an automated email.

## 7. Observability & Cost Control

- Structured logs per workflow step (provider, latency, success/failure) for debugging pipeline issues.
- Metrics: workflow success rate, per-provider error rate, AI cost per lead (token usage) — needed early since OpenAI (and, once chosen, an enrichment provider) costs scale with lead volume.
- Alerting on sustained workflow failure (e.g., an integration goes down) surfaced first as the in-app error banner, later to an ops channel.
- **AI cost guardrails (added after architecture review):** a per-org monthly AI call/token budget is checked before every OpenAI call in step 3; exceeding it blocks further AI qualification for that org with an in-app notice rather than silently continuing to bill. `POST /api/ai/regenerate-insight/:leadId` is separately rate-limited per lead to prevent cost abuse via repeated manual triggers.
- **Dashboard "today" metrics:** `DailyMetric` is a once-daily rollup covering completed days only; the current, in-progress day is computed live from raw `Lead`/`EmailEvent` tables so the dashboard never shows stale data for "today" before the nightly job runs.

## 8. Integration Provider Abstraction

Because two of the four pipeline integrations are unconfirmed (enrichment, email), every provider — confirmed or not — is implemented behind a small interface per capability, not called directly from workflow-step code:

- `EnrichmentProvider.enrich(domainOrEmail) → EnrichmentResult`
- `AIQualificationProvider.qualify(lead, enrichment) → { score, summary, keywords, recommendedAction }`
- `EmailProvider.send(to, subject, body) → EmailSendResult`
- `NotificationProvider.notify(channel, message) → void`

(`CrmSyncProvider` existed here for the "Add to CRM" step, removed after Phase 2 — see §5. It is not part of the current registry.)

Each `WorkflowStep` calls the interface, not a named vendor SDK. `Integration.provider` selects which concrete implementation is active per org. This means:

- Confirmed vendors (OpenAI for `AIQualificationProvider`, Slack for `NotificationProvider`) ship as the default/only implementation initially, without blocking a second implementation being added later.
- Unconfirmed slots (`EnrichmentProvider`, `EmailProvider`) can ship v1 with **no implementation connected** (steps skip/block per §5) or with a placeholder implementation, and a real vendor is plugged in once decided — with no change to the pipeline engine, schema, or step-sequencing logic.
- No workflow step, API route, or DB field should be named after an unconfirmed vendor (e.g., no `clearbitId` column) — use provider-neutral naming (`enrichmentProvider`, `LeadEnrichment.provider`) everywhere.

## 9. Deferred/Not-Yet-Decided

- Whether AI insight generation streams to the UI or is request/poll only (v1: poll).
- Which vendor fills the enrichment and email-provider slots (open question, carried from product-spec.md).
- Lead lifecycle termination/archival rule (when a Cold, unengaged lead is considered "lost") — no automated rule for MVP.
- Login brute-force lockout / MFA — deferred past MVP, tracked as a known gap.
- Two-way Airtable sync (edits made in Airtable flowing back to LeadFlow) — deliberately out of scope; §5 is one-way for MVP.
- Automated third-party data-erasure propagation (Airtable/OpenAI) on a delete request — manual/best-effort for MVP per product-spec.md §12.1.

## 10. Scope Correction: Single Fixed Pipeline, Not a Multi-Workflow Builder

**This section resolves an over-engineering finding from the pre-implementation architecture review.** The original draft modeled `Workflow`/`WorkflowStep` as a fully general, multi-workflow, user-configurable engine (create/delete API routes, a `/workflows` list page, a per-workflow builder). Nothing in the reference screenshot or confirmed requirements supports that generality — the screenshot shows exactly one pipeline with a single "Active / All automations are running" status and one workflow link, and no drag-drop builder or multiple-workflow UI.

**Decision:** for MVP, each org has **exactly one** `Workflow` row, auto-provisioned at org creation, representing the fixed 7-step pipeline. `WorkflowStep` rows are seeded from a fixed, code-defined list (enrich_data/ai_qualification/score_tag/add_to_crm/send_email/notify_team) and support per-step config/enable-disable and threshold tuning — not arbitrary creation, reordering, or new step types. There is no workflow create/delete API and no `/workflows` list page; see product-spec.md §3 (`/automation`, `/automation/runs`) and §7 (API routes) for the corrected surface. `WorkflowRun`/`WorkflowRunStep` are unaffected by this correction — per-lead execution history and observability are still fully modeled, since that's what the dashboard's stepper and run history genuinely need.

If a real multi-workflow requirement emerges later (e.g., different pipelines per lead source), it should be scoped and approved as its own project increment, not built speculatively now.

## 11. Phase 0 Implementation (as built)

Phase 0 is implemented. This section records what exists in the repository, so later phases extend it rather than re-deciding it.

### 11.1 Folder structure

```
app/
  (app)/                  # authenticated shell — layout enforces auth
    layout.tsx            # AppSidebar + auth/organization resolution
    dashboard|leads|campaigns|automation|analytics|integrations|settings/
  (auth)/                 # unauthenticated screens
    layout.tsx, login/, signup/, actions.ts
  api/auth/[...nextauth]/ # Auth.js route handler
  layout.tsx, page.tsx, error.tsx, global-error.tsx, not-found.tsx
components/
  layout/                 # AppSidebar, SidebarNav, UserMenu, PageHeader
  auth/                   # AuthForm
  ui/                     # shadcn/ui primitives + EmptyState
lib/
  auth/                   # config.ts (Auth.js), session.ts (DAL), rbac.ts
  db/                     # prisma.ts (base client), tenant.ts (withTenant)
  services/               # signup.ts — business logic, no request context
  validation/             # Zod schemas
  api/handler.ts          # uniform Route Handler error envelope
  env.ts, errors.ts, logger.ts, navigation.ts, utils.ts
prisma/
  schema.prisma, migrations/
tests/
  unit/ integration/ components/ helpers/ setup/ stubs/
types/                    # next-auth.d.ts module augmentation
proxy.ts                  # Next.js 16 proxy (was middleware.ts)
prisma.config.ts          # Prisma 7 config — datasource URL lives here
```

Rule enforced throughout: business logic lives in `lib/services` and `lib/`, never in components. Pages compose and authorize; they do not implement.

### 11.2 Authentication architecture

- **Auth.js v5** with the **Prisma adapter** and a **JWT session strategy**. JWT rather than database sessions so `proxy.ts` can do an optimistic check without a database round trip per navigation.
- **Credentials provider** with bcrypt (cost 12). Sign-in failure is uniform for "no such user" and "wrong password", and a dummy bcrypt comparison runs when the user is absent so response timing does not reveal whether an email is registered.
- `trustHost: true` is set — required for any non-Vercel deployment, which otherwise fails every auth request with `UntrustedHost`. Because `trustHost` lets Auth.js derive callback URLs from the client-supplied `Host` header, **`AUTH_URL` must be set in production** to pin them.
- The JWT carries `organizationId` and `role`, but they are treated as a **cache, not the source of truth** — see below.

### 11.3 Organization resolution (the multi-tenancy rule)

`lib/auth/session.ts` is the Data Access Layer and the only sanctioned way to learn who the caller is:

| Function                                             | Purpose                                  |
| ---------------------------------------------------- | ---------------------------------------- |
| `getCurrentUser()`                                   | Signed-in user or `null`                 |
| `requireUser()`                                      | Same, but throws `UnauthenticatedError`  |
| `getCurrentOrganization()` / `requireOrganization()` | Current tenant                           |
| `requireRole(...roles)`                              | Assert role membership                   |
| `requireCapability(capability)`                      | Assert a capability from the RBAC matrix |

Three properties make this trustworthy, each covered by a test:

- The organization comes from the **session**, never from request input. An `organizationId` in a body, query string, header or route param is never read.
- The user is **re-read from the database** on each request rather than trusted from the token, so a JWT issued before a role change or user deletion cannot retain privileges. A token claiming a different organization is ignored.
- A **soft-deleted organization** revokes access immediately, even for a session that was valid when issued.

`cache()` memoises the lookup per render pass, so a layout plus several server components cost one query.

### 11.4 RBAC architecture

`lib/auth/rbac.ts` holds a pure, dependency-free capability matrix (`ADMIN` / `MANAGER` / `SALES_REP`), mirroring product-spec.md §11. Capability names (`integrations:manage`, `analytics:view:org`, …) are preferred over role lists at call sites so the matrix can change in one place.

Enforcement is server-side, at the page/action. The sidebar filters items by capability, but that is presentation only: every privileged page independently calls `requireCapability()`, so a `SALES_REP` typing `/campaigns` directly is refused. Note also that a Next.js layout auth check does not by itself protect its children (layouts do not re-render on every navigation) — which is exactly why each page checks too.

### 11.5 Database architecture

- PostgreSQL + Prisma 7. **Prisma 7 breaking change:** the datasource URL is no longer permitted in `schema.prisma`; it lives in `prisma.config.ts` for CLI/migrations and reaches the runtime client through the `@prisma/adapter-pg` driver adapter.
- Phase 0 models only: `Organization`, `User`, plus the Auth.js models (`Account`, `Session`, `VerificationToken`). No business models — those belong to Phase 1+.
- `User.email` is **globally unique, not unique-per-organization**. Auth.js resolves a login identity by email before any organization context exists, so a per-org constraint would make sign-in ambiguous. The accepted consequence: one email maps to one organization. Multi-org membership would need a `Membership` join model and an org-selection step at login — deliberately out of scope.
- Two clients, with different jobs:
  - `lib/db/prisma.ts` — base client, **no tenant context**. Under RLS it matches zero rows for tenant tables, so forgetting to scope fails closed. Legitimate uses: pre-authentication lookups and signup, where no organization exists yet.
  - `lib/db/tenant.ts` — `withTenant(organizationId, work)` runs `work` inside a transaction that first issues `set_config('app.current_org_id', $1, true)`. The id is a **bound parameter**, not interpolated SQL.

`SET LOCAL` semantics matter here: the setting is transaction-scoped and discarded at commit, so it cannot leak onto a pooled connection later reused by another tenant. A plain `SET` would.

### 11.6 RLS approach

`prisma/migrations/20260901000100_rls/migration.sql` installs, per tenant table:

```sql
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "users_tenant_isolation" ON "users"
  FOR ALL USING ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());
```

`current_org_id()` reads `current_setting('app.current_org_id', true)` in its missing-ok form, so an **unset context matches zero rows** — forgetting tenant context returns nothing rather than everything. `WITH CHECK` covers the write direction, so a tenant cannot plant a row inside another organization.

The Auth.js tables (`accounts`, `sessions`, `verification_tokens`) are **deliberately excluded**: Auth.js must read them during sign-in, before any organization is known, so a policy there could only be "always true" — no security gained, authentication broken. Isolation begins one hop later, once the session resolves to a user and `organizationId` is derived.

See §4 for the two deployment constraints (non-superuser role; `FORCE`) that this depends on.

### 11.7 Environment configuration

`lib/env.ts` validates `process.env` with Zod, lazily and memoised, and is marked `server-only` so importing it from a Client Component is a build error.

- **Required:** `DATABASE_URL` (must be a PostgreSQL URL), `AUTH_SECRET` (≥32 chars). Missing or malformed values stop startup with a message naming the variable — never its value.
- **Optional:** `AUTH_URL`, and the Phase 3-5 integration credentials `OPENAI_API_KEY`, `AIRTABLE_API_KEY`, `SLACK_BOT_TOKEN`, `EMAIL_PROVIDER_API_KEY`. **The application starts and runs correctly without any of them**; `getIntegrationAvailability()` reports which are present, and `/integrations` displays that.

### 11.8 Error handling and logging

- `lib/errors.ts` — an `AppError` taxonomy where the `message` is always safe to show a user and sensitive detail goes in `logContext`, which is logged but never serialised to a client. Unknown errors collapse to a generic 500, deliberately discarding detail.
- `lib/api/handler.ts` — `withApiErrorHandling()` gives every Route Handler the same client-safe envelope; a stray `ZodError` becomes a 422 with field errors.
- `app/error.tsx` / `global-error.tsx` render a generic message plus the Next.js digest for correlation. `error.message` is never displayed, in any environment.
- `lib/logger.ts` — one JSON object per line, with **structural redaction**: keys matching `password`/`secret`/`token`/`apiKey`/`authorization`/`cookie` become `[redacted]`, and PII keys (`email`, `phone`, `slackUserId`) become `[pii:present]`, preserving debuggability without writing PII to logs.

### 11.9 Testing approach

**Vitest** (chosen in Phase 0; no stack pre-existed) with two projects: `node` for logic/security/database tests, `jsdom` for components.

The notable choice is **PGlite** — real PostgreSQL compiled to WASM — for database tests. It runs in-process with no Docker, no server and no external dependency, while behaving like genuine Postgres: RLS, policies, roles, constraints and `current_setting()` all work. The tests apply **the same migration files** Prisma will run in production, so they validate the migration SQL as well as the policies. A mock could not have caught the superuser-bypass problem described in §4; PGlite did.

`server-only` is aliased to an empty stub under Vitest so server modules are importable in tests. The real guard remains active in the application build.
