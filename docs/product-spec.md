# LeadFlow AI — Product Specification

Status: Draft v1 (pre-implementation). Source: dashboard screenshot ("AI Lead Qualification & Follow-up Automation") + stakeholder answers.

## 1. Product Summary

LeadFlow AI is a multi-tenant SaaS "full revenue platform": it captures leads from multiple sources, enriches them, uses AI to score/qualify and summarize intent, automates personalized follow-up email, syncs to a CRM, and notifies the sales team — with a dashboard for pipeline visibility and reporting.

**Primary users:** SMB / agency sales & marketing teams (assumed — see Open Questions). Roles: Administrator, Manager, Sales Rep.

## 2. Confirmed vs. Assumed

**Confirmed by the reference screenshot** (treat as fixed requirements):

- The reference screenshot's pipeline: New Lead → Enrich Data → AI Qualification → Score & Tag → Add to CRM → Send Email → Notify Team.
  **Revised after Phase 2:** the implemented pipeline drops the "Add to CRM" step — LeadFlow AI **is itself the CRM** (its own `Lead` row is the system of record from the moment a lead is captured, not something a downstream step needs to create), so syncing a lead to a separate CRM mid-pipeline was redundant business logic, not a real product requirement. The pipeline is now: Enrich Data → AI Qualification → Score & Tag → Send Email → Notify Team (`lib/automation/pipeline.ts`). Airtable — if ever built — becomes an optional external projection, decoupled from the pipeline (see §10).
- **Slack** is the team-notification integration behind the "Notify Team" step.
- **OpenAI GPT-4o** is the AI provider behind the "AI Qualification" step.
- Dashboard metrics, charts, recent-leads table, and AI insight panel as shown.

**Not confirmed — do not treat as required vendors:**

- The enrichment provider behind "Enrich Data" is unconfirmed. The reference mockup labels it "Clearbit API," but that has not been confirmed as a product decision — treat it as an illustrative example only. The system must support a pluggable enrichment provider, not hard-depend on Clearbit specifically.
- The email-sending provider behind "Send Email" is unconfirmed (the mockup just says "Personalized Email," no vendor named). Treat as a pluggable provider, TBD.

**Assumptions (pending confirmation, unrelated to the vendor question above):**

- Multi-tenant SaaS, one workspace ("Organization") per customer, org-scoped data isolation.
- Stack: Next.js (App Router) + TypeScript, PostgreSQL + Prisma, background job queue for async workflow steps, hosted on Vercel + a managed Postgres (Supabase/Neon).

**Integration extensibility principle:** every third-party integration (confirmed or not) is implemented behind a common provider interface (see `docs/architecture.md` §3/§9) so an unconfirmed choice (enrichment, email) can be swapped in later without redesigning the pipeline, and a confirmed one (Airtable, Slack, OpenAI) is not hard-baked in a way that blocks adding alternatives.

## 3. Pages

| Route                                                      | Purpose                                                                                                                                                                                   | Primary Roles                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/login`, `/signup`, `/forgot-password`, `/reset-password` | Auth                                                                                                                                                                                      | All                                     |
| `/onboarding`                                              | Org creation, invite team, connect first integration                                                                                                                                      | Admin                                   |
| `/dashboard`                                               | Home: KPIs, qualification breakdown, leads-over-time, recent leads, AI insights, workflow status (screenshot)                                                                             | All                                     |
| `/leads`                                                   | Full lead list, filter/sort/search, bulk actions, import                                                                                                                                  | All (scoped by ownership for Sales Rep) |
| `/leads/:id`                                               | Lead detail: profile, enrichment data, AI insight history, timeline/activity, email thread, manual actions                                                                                | All (scoped)                            |
| `/ai-qualification`                                        | Scoring rules/thresholds config, review queue for AI-scored leads, model settings                                                                                                         | Admin, Manager                          |
| `/campaigns`                                               | List of outreach campaigns/sequences                                                                                                                                                      | All (scoped)                            |
| `/campaigns/:id`                                           | Campaign builder/detail: steps, templates, performance                                                                                                                                    | Admin, Manager                          |
| `/automation`                                              | The single fixed pipeline's status, per-step config (enable/disable, thresholds) — **not** a multi-workflow list/builder (scope-limited per architecture review, see architecture.md §10) | Admin, Manager                          |
| `/automation/runs`                                         | Execution history per lead, per-step status/logs                                                                                                                                          | Admin, Manager                          |
| `/integrations`                                            | Connect/manage confirmed integrations (OpenAI, Airtable, Slack) plus pluggable/TBD ones (enrichment provider, email provider), ad/form sources                                            | Admin                                   |
| `/analytics`                                               | Deeper reporting: campaign performance, rep performance, funnel, exports                                                                                                                  | Admin, Manager                          |
| `/settings`                                                | Org profile                                                                                                                                                                               | Admin                                   |
| `/settings/users`                                          | Invite/manage users & roles                                                                                                                                                               | Admin                                   |
| `/settings/billing`                                        | Plan, usage, invoices                                                                                                                                                                     | Admin                                   |
| `/settings/api-keys`                                       | Webhook URLs / API keys for inbound lead capture                                                                                                                                          | Admin                                   |
| `404`, `500`, `403`                                        | Error pages                                                                                                                                                                               | All                                     |

## 4. Components

**Layout:** `AppShell` (Sidebar nav + Topbar), `Sidebar` (nav items, active state, workflow-status mini widget, user menu), `Topbar` (page title/subtitle, date-range picker, primary action button).

**Data display:** `StatCard` (label, value, delta %, icon), `DonutChart` (qualification breakdown), `LineChart` (leads over time, multi-series), `DataTable` (sortable/paginated/selectable, row-action menu), `LeadAvatarBadge` (initials/color), `ScoreBadge` (0–100, color-coded), `QualificationBadge` (Hot/Warm/Cold), `StatusBadge` (Pending/Emailed/Opened/Replied/Converted/Lost), `WorkflowStepper` (horizontal step chain with per-step status icon), `WorkflowStatusWidget` (compact active/paused indicator + link).

**AI:** `AIInsightPanel` ("AI Generated" badge, intent-keyword tag list, summary text, `RecommendedActionCard` with suggested action + best-time + CTA).

**Interaction:** `DateRangePicker`, `ExportButton` (CSV/PDF), `Modal`/`Drawer` (lead quick-view, integration connect flow), `Toast` notifications, `ConfirmDialog` (destructive actions), `RoleGate` (renders children only if user's role is permitted).

**Feedback states:** `EmptyState`, `ErrorState`, `Skeleton` loaders — generic, themeable per context (see §12–14).

## 5. Database Entities

- **Organization** — tenant root: id, name, plan, created_at
- **User** — id, org_id, email, name, role (admin/manager/sales_rep), status, created_at
- **Organization** — add `deleted_at` (soft-delete, for org offboarding/data purge).
- **User** — add `slack_user_id` (nullable) — resolves a LeadFlow user to a Slack identity for owner-DM notifications; without it, notifications fall back to channel-only.
- **Lead** — id, org_id, owner_id (**nullable — a Lead may be "Unassigned"**; no fake system owner is invented and no auto-assignment to an admin happens, per Phase 1.1 business-rules closure), name, company, email (**normalized before persistence/comparison: trimmed and lowercased**, e.g. `" John@Example.COM "` → `"john@example.com"`), phone, source (website_form/webhook/linkedin/google_ads/referral/manual/csv_import), ai_score (nullable — null means "not yet scored" or "AI output failed validation, needs manual review", never a default 0), qualification (hot/warm/cold — the AI-assessed potential **bucket**; a separate concept from `status`, the sales/process **stage**, and not interchangeable with it), status (new/enriching/qualified/emailed/email_opened/replied/converted/lost), deleted_at (soft-delete — **a soft-deleted Lead remains part of the organization's data and retains its email identity**: its email cannot be reused by a second Lead in the same org), created_at, updated_at, last_action_at. **Unique constraint on `(org_id, normalized email)`** — for MVP, a duplicate means an exact match on the normalized email within the same org (no fuzzy matching, no name/company/phone heuristics); a duplicate is **rejected** (`ConflictError`), not merged or upserted, and the database constraint is the final authority — this applies identically to manual create, update, and CSV import. `status` is treated as **derived** — recomputed from the latest `WorkflowRunStep`/`EmailEvent`, never hand-set independently of those, to avoid the two staying in sync manually. Manually created and CSV-imported leads never auto-enroll in the automation pipeline (see §8) regardless of ownership state.
- **LeadEnrichment** — id, org_id, lead_id, provider (pluggable, not yet confirmed), payload (jsonb), enriched_at
- **AIInsight** — id, org_id, lead_id, summary, intent_keywords (jsonb array), recommended_action, recommended_action_time, model_used, prompt_version, token_usage, generated_at
- **Campaign** — id, org_id, name, type, status, created_by, created_at
- **CampaignStep** — id, org_id, campaign_id, step_order, subject, body_template, delay_hours
- **EmailEvent** — id, org_id, lead_id, campaign_id, workflow_run_step_id (nullable, links a send back to the run that caused it — used for idempotency checks), type (sent/opened/replied/bounced), occurred_at
- **Workflow** — id, org_id, name, status (active/paused), created_at. **Exactly one `Workflow` row per org for MVP**, auto-created on org signup, representing the fixed 7-step pipeline — this is a configuration record (enable/disable, thresholds), not a general multi-workflow builder (see §8 and architecture.md §10 — dropped as over-scoped for MVP).
- **WorkflowStep** — id, workflow_id, step_order, type (enrich_data/ai_qualification/score_tag/add_to_crm/send_email/notify_team), config (jsonb) — seeded from a fixed list at org creation; not user-creatable.
- **WorkflowRun** — id, org_id, workflow_id, lead_id, dedup_key (unique — derived from the triggering event, prevents a duplicate webhook delivery from starting a second run for the same lead), status (pending/running/succeeded/failed/**blocked**), started_at, completed_at
- **WorkflowRunStep** — id, org_id, workflow_run_id, workflow_step_id, status (pending/running/succeeded/failed/skipped), output (jsonb), occurred_at
- **Integration** — id, org_id, provider (confirmed: openai/airtable/slack; pluggable/TBD: enrichment_provider/email_provider; capture sources: google_ads/linkedin), status (connected/disconnected/error), credentials_encrypted, config (jsonb), connected_at
- **Notification** — id, org_id, user_id, type, payload (jsonb), read_at, created_at
- **DailyMetric** — id, org_id, date, total_leads, hot_leads, warm_leads, cold_leads, emails_sent, replies, reply_rate (materialized rollup for **completed days only**; the current day is computed live — see architecture.md §7)
- **AuditLog** — id, org_id, actor_id, action, entity_type, entity_id, metadata (jsonb), created_at
- **ApiKey** — id, org_id, key_hash, label, created_at, last_used_at

**`org_id` is denormalized onto every tenant-owned table above** (including ones reachable only via a join, like `LeadEnrichment`/`AIInsight`/`EmailEvent`/`CampaignStep`/`WorkflowRunStep`) specifically so Postgres RLS can be enforced on all of them independently — see architecture.md §4.

## 6. Relationships

- Organization 1—N { User, Lead, Campaign, Workflow, Integration, Notification, DailyMetric, AuditLog, ApiKey }
- Lead N—1 User (owner); Lead 1—N { LeadEnrichment, AIInsight, EmailEvent, WorkflowRun }; Lead N—1 Campaign (current, optional)
- Campaign 1—N { CampaignStep, EmailEvent }
- Workflow 1—N { WorkflowStep, WorkflowRun }
- WorkflowRun N—1 Lead; WorkflowRun 1—N WorkflowRunStep; WorkflowRunStep N—1 WorkflowStep

All tenant-owned tables carry `org_id` for isolation (enforced at query layer + Postgres RLS).

## 7. API Routes (REST)

**Auth:** `POST /api/auth/{signup,login,logout,refresh,forgot-password,reset-password}`

**Org/Users:** `GET/PATCH /api/org`, `POST /api/org/invite`, `GET /api/users`, `PATCH/DELETE /api/users/:id`

**Leads:** `GET/POST /api/leads`, `GET/PATCH/DELETE /api/leads/:id`, `POST /api/leads/import`

**Inbound capture:** `POST /api/webhooks/lead-capture`, `POST /api/webhooks/:provider` (email/ad-platform events)

**AI:** `POST /api/ai/qualify-lead/:id`, `GET /api/ai/insights/:leadId`, `POST /api/ai/regenerate-insight/:leadId`, `POST /api/ai/draft-email/:leadId`

**Campaigns:** `GET/POST /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/:id`, `POST /api/campaigns/:id/send`

**Automation (single fixed pipeline per org — no create/delete; it's auto-provisioned):** `GET /api/automation`, `PATCH /api/automation` (per-step config/thresholds), `POST /api/automation/toggle`, `GET /api/automation/runs`, `POST /api/automation/runs/:runId/retry`

**Integrations:** `GET /api/integrations`, `POST /api/integrations/:provider/connect`, `DELETE /api/integrations/:provider`, `POST /api/integrations/:provider/test`

**Analytics:** `GET /api/analytics/summary?range=`, `GET /api/analytics/leads-over-time`, `GET /api/analytics/export`

**Notifications:** `GET /api/notifications`, `PATCH /api/notifications/:id/read`

## 8. Workflows (business process)

**Scope note:** this is a single fixed pipeline per org (matches the screenshot's one "Active / All automations are running" status and one workflow link) — not a general multi-workflow builder. Building support for multiple, user-configurable workflows was flagged as over-engineering in the architecture review and is explicitly out of MVP scope (see architecture.md §10).

**Enrollment policy:** only leads captured via **webhook/form/ad source** auto-enroll in this pipeline. Manually entered or CSV-imported leads are created in `status=new` **without** triggering the pipeline (no automated email is sent on their behalf) — a rep must explicitly choose "Run automation" for that lead. This avoids surprising an operator with an automated outbound email for a lead they added as a personal note.

**Primary pipeline** (async/queued, each step recorded as a `WorkflowRunStep`). The original reference screenshot showed a 7-step sequence including "Add to CRM" — dropped after Phase 2 (see §2): LeadFlow AI is itself the CRM, so a separate CRM-sync step was redundant against `Lead` as the system of record.

1. New Lead — ingested via form/webhook/manual/import
2. Enrich Data — call to a pluggable enrichment provider (not yet confirmed; mockup shows "Clearbit API" as an illustrative example only), populates company/firmographic data
3. AI Qualification — **OpenAI GPT-4o** (confirmed) scores intent from enrichment + form/behavioral data
4. Score & Tag — apply configurable thresholds → Hot/Warm/Cold
5. Send Email — AI-drafted personalized email via a pluggable email provider (vendor not yet confirmed)
6. Notify Team — **Slack** message to owner/channel (confirmed)

**Secondary workflows:** reply detected → status update → notify owner; manual re-score; lead reassignment; campaign step sequencing/nurture drip for Warm/Cold; failed-step retry with backoff and manual re-run from `/automation/runs`.

## 9. AI Features

- Lead scoring (0–100) from enrichment + engagement signals
- Hot/Warm/Cold qualification bucketing (configurable thresholds)
- AI-generated lead summary (per-lead)
- Top intent keyword extraction
- Recommended next action + suggested best time to act
- AI-drafted personalized outreach email
- _Future:_ reply sentiment/intent classification, deal-risk prediction, conversational lead Q&A

**AI output validation & cost control** (added after architecture review):

- OpenAI calls use structured/schema-validated output (score, summary, keywords, recommended action as a defined JSON shape), not free-form parsing. Score is clamped to 0–100; if the model's output fails validation, the lead is marked "needs manual review" (score left `null`) rather than defaulting to a guessed value.
- Untrusted lead-supplied text (form fields, enrichment payload) is passed to the model as data, never concatenated into the instruction/system portion of the prompt — mitigates prompt injection from a crafted form submission.
- Per-org monthly AI call/token budget is enforced before invoking OpenAI; exceeding it blocks further AI qualification with an in-app notice, it does not silently skip or silently bill past the plan.
- `POST /api/ai/regenerate-insight/:leadId` is rate-limited per lead to prevent repeated-click cost abuse.

## 10. Integrations

**Confirmed** (named explicitly in the reference screenshot):

| Provider      | Purpose                                                            | Direction                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI GPT-4o | Scoring, summarization, email drafting                             | Outbound (API call)                                                                                                                                                                                                       |
| Airtable      | Optional external CRM projection, **not a pipeline step** — see §2 | **Future/optional, decoupled from the pipeline.** If ever built: one-way (LeadFlow → Airtable), a projection for the sales team, not an alternate write path — LeadFlow's own `Lead` row stays the sole system of record. |
| Slack         | Team notifications ("Notify Team" step)                            | Outbound                                                                                                                                                                                                                  |

**Not confirmed — implemented as a pluggable provider slot, no vendor hard-dependency:**

| Provider slot          | Purpose                                        | Notes                                                                                                                      |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Enrichment provider    | Firmographic enrichment ("Enrich Data" step)   | Mockup shows "Clearbit API" as an example only; not a confirmed requirement. Build against a generic enrichment interface. |
| Email-sending provider | Send + track opens/replies ("Send Email" step) | Mockup labels this step only "Personalized Email," no vendor shown. Build against a generic email-sending interface.       |

**Lead capture sources** (implied by the "Source" column in the Recent Leads table): Website Form, Webhook, LinkedIn, Google Ads, Referral, manual/CSV — these are data-source labels, not necessarily third-party API integrations, and don't require a live LinkedIn/Google Ads connection to implement.

**Future/candidate** (not in scope, not confirmed): HubSpot/Salesforce as alternative CRM targets, Calendly for meeting booking — only relevant once the enrichment/email/CRM provider abstraction (§9 architecture) makes adding them low-cost.

## 11. Authentication & Permissions

**Auth:** Email/password + Google OAuth; session via JWT (Auth.js / NextAuth v5 with the Prisma Adapter — see `docs/architecture.md` §3.1 for the decision and rationale); email verification; invite-based org join; password reset flow.

**Roles (RBAC):**

| Capability                 | Admin | Manager | Sales Rep               |
| -------------------------- | ----- | ------- | ----------------------- |
| View all org leads         | ✅    | ✅      | ❌ (own only)           |
| Edit/reassign any lead     | ✅    | ✅      | ❌ (own only)           |
| Manage workflows/campaigns | ✅    | ✅      | ❌ (view own campaigns) |
| Manage integrations        | ✅    | ❌      | ❌                      |
| Manage users/billing       | ✅    | ❌      | ❌                      |
| View analytics (org-wide)  | ✅    | ✅      | ❌ (own metrics only)   |

## 12. Analytics

Dashboard KPIs (Total Leads, Hot Leads, Emails Sent, Reply Rate) with % delta vs. prior period; qualification-breakdown donut; leads-over-time by qualification tier; campaign performance (open/reply/conversion rate); workflow run success/failure rate; per-rep leaderboard (future); CSV/PDF export.

The current (incomplete) day is computed live from raw tables, not from the `DailyMetric` rollup, so "today" is never shown stale before the nightly rollup job runs; completed prior days read from `DailyMetric`. A period with zero leads shows a `0%`/flat state rather than a divide-by-zero delta.

## 12.1 Data Deletion & Retention

- `Organization` and `Lead` support soft-delete (`deleted_at`). Deleting a `Lead` hard-deletes its PII-bearing children (`LeadEnrichment`, `AIInsight`, `EmailEvent` bodies) and retains only anonymized `WorkflowRunStep` counts needed for historical analytics integrity.
- Propagating a delete request to Airtable (already-synced record) or accounting for data already sent to OpenAI is a **manual/best-effort process for MVP**, not automated — full third-party erasure automation is out of scope until a compliance-driven roadmap phase is scheduled.
- Analytics CSV/PDF exports (§12) include lead PII; access to export is restricted to Admin/Manager per the RBAC table in §11.

## 13. Error States

- Failed workflow step (e.g., enrichment API timeout, OpenAI rate-limit, Slack webhook down): surfaced on `WorkflowStepper` with a red indicator + retry action; lead not silently dropped.
- Integration disconnected/invalid credentials: banner on `/integrations` and blocking indicator on affected workflow steps.
- API/network failure on any page: `ErrorState` component with retry; toast for transient failures on background actions.
- Form validation errors: inline field-level messages.
- Import errors (bad CSV rows): per-row error report after `POST /api/leads/import`.

## 14. Loading States

- Skeleton loaders for `StatCard`, `DataTable`, both charts, and `AIInsightPanel` on initial dashboard/leads load.
- Inline spinner on `WorkflowStepper` step currently `running`.
- Button loading state on submit actions (send email, connect integration, invite user).

## 15. Empty States

- No leads yet: illustration + "Connect a source or add your first lead" CTA on `/leads` and dashboard table.
- No AI insight yet (lead not yet processed): "AI qualification pending" placeholder in `AIInsightPanel`.
- No campaigns created yet: CTA to create first one. (The automation pipeline itself is auto-provisioned per org, not user-created, so `/automation` always has content — its empty state is "no runs yet," not "no pipeline yet.")
- No integrations connected: onboarding-style checklist on `/integrations`.
- Date range with zero activity: charts render flat/zero state with explanatory caption, not blank.
