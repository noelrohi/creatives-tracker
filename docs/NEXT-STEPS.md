# Adsolute — Next Steps

> Updated March 23, 2026. Replaces the old v1.0–v2.0 roadmap. Context: team call with Usman, decision to simplify stack.

## What Adsolute Is

A resolution library — a dashboard where the team tags every ad and landing page with the strategy behind it (angle, persona, awareness level, hook, tone, CTA), sees performance data next to those tags, and over time surfaces patterns about what actually converts.

## What Changed

Adsolute was originally built as a multi-tenant SaaS (Postgres, Better Auth, org scoping, invite flows). We're a 4-person team. That's overkill.

**Decisions made:**
- Keep the UX and schema — the resolution fields, inline editing, comparisons, A/B tests
- Keep cloud Postgres (Neon/Supabase/Railway) — no need to migrate to SQLite/Turso
- Rip out Better Auth and org scoping — single workspace, no login
- Merge Meta API data into the same Postgres — one DB for everything
- Cowork queries the same Postgres for reports and analysis
- Jelo's creative brain app queries via API for context
- Navigation is creative-first, not campaign-first — the Meta hierarchy (campaign → ad set → ad) is metadata, not the primary nav

## What's Shipped (V1.0)

- Resolution schemas: ad creatives, landing pages (versioned), campaign configs
- Ad sets linking creative + landing page version + campaign
- Performance logging (ROAS, CPA, CTR, spend, conversions)
- Notion-style inline editing
- Dashboard, list views, skeleton loading, empty states
- Org scoping (will be removed)
- tRPC + Drizzle + shadcn/ui + nuqs

---

## Phase 1: Simplify (Current)

**Goal:** Strip auth/org overhead, merge data sources, get the team using it.

### 1.1 Remove Auth & Org Scoping
- Remove Better Auth (user, org, session, member, invitation tables)
- Remove all `organizationId` and `createdBy` columns from data tables
- Remove auth middleware from tRPC — `protectedProcedure` becomes `baseProcedure`
- Remove auth pages (/sign-in, /sign-up, /setup-org, /invite)
- Remove org switcher from sidebar
- Simplify settings page
- Optional: add a simple shared password middleware if deploying publicly

### 1.2 Merge Meta API Data
- Add Meta API tables to the same Postgres: `campaigns`, `ad_sets`, `ads`, `*_daily_metrics`
- Keep existing integer PK + `meta_id` pattern from the SQLite schema
- Add `ad_creative_id` and `landing_page_version_id` FK columns to `ads` table
- Bridge: when you tag an ad in the UI, it creates/links an `ad_creative` record
- Migrate existing `ad_tags` data (~42 tagged ads) into `ad_creative` records

### 1.3 Update Cron Sync
- Update Meta API sync script to write to cloud Postgres instead of local SQLite
- Same filters (30-day window, daily granularity)
- Run via Cowork scheduled task or external cron

### 1.4 REST API
- Add REST API routes alongside tRPC (Next.js route handlers under `src/app/api/v1/`)
- Endpoints for everything agents need:
  - `GET /api/v1/ads` — list ads with resolution tags + performance data, filterable
  - `GET /api/v1/ads/:id` — single ad with full resolution + metrics
  - `GET /api/v1/creatives` — list creatives, filter by angle/persona/tone/awareness
  - `GET /api/v1/creatives/top` — top performers by metric (roas, cpa, ctr)
  - `GET /api/v1/creatives/patterns` — aggregated insights by resolution field
  - `GET /api/v1/landing-pages` — list with versions
  - `GET /api/v1/metrics/daily` — daily performance data, filterable by date range
  - `GET /api/v1/metrics/summary` — rollup stats (total spend, avg ROAS, etc.)
  - `POST /api/v1/creatives` — create/tag a creative (for CLI and agents)
  - `PATCH /api/v1/creatives/:id` — update resolution tags
  - `POST /api/v1/sync` — trigger Meta API sync on demand
- Simple API key auth via `x-api-key` header (shared key in env var)
- JSON responses, consistent error format
- This is what Cowork, Jelo's brain, and the CLI all hit

### 1.5 CLI Tool
- Lightweight CLI (`bunx adsolute` or `npx adsolute`) that wraps the REST API
- Commands:
  - `adsolute sync` — trigger Meta API sync
  - `adsolute ads [--sort roas] [--limit 10]` — list ads with performance
  - `adsolute top [--metric roas] [--days 7]` — top performers
  - `adsolute tag <ad-id> --angle "teeth grinding" --tone clinical` — tag an ad
  - `adsolute patterns` — show what's working (aggregated by resolution fields)
  - `adsolute summary [--days 7]` — quick spend/ROAS/CPA summary
  - `adsolute export [--format csv|json]` — dump data for external use
- Config: `~/.adsolute.json` stores API URL + key
- Cowork's `reviv-data` skill calls the CLI or hits the REST API directly
- Useful for quick terminal checks without opening the web app

### 1.6 Update Cowork Skill
- Swap `reviv-data` skill from local SQLite queries to calling the REST API (or CLI)
- Same natural language interface, backed by the unified database now
- Test: "what's our ROAS this week" still works

---

## Phase 2: Core UX Improvements

**Goal:** Make tagging fast and the data actually useful.

### 2.1 Creative-First Navigation
- Primary view: all creatives, filterable by resolution tags
- Performance data shown inline (ROAS, CPA, spend, conversions)
- Campaign/ad set shown as metadata on the creative, not as nav structure
- Secondary view: drill into a campaign to see all its ads (optional)

### 2.2 Bulk CSV Import (from V1.5)
- Import Meta Ads Manager CSV exports
- Column mapping UI (Meta columns → our fields)
- Bulk insert into `performance_logs` or `*_daily_metrics`
- Useful when cron hasn't synced yet or for historical data

### 2.3 Comparison View (from V1.5)
- Select two ads, see side-by-side: resolution tags + performance
- Highlight differences
- Shareable URL (`/compare?a=id1&b=id2`)

### 2.4 Freeform Tags (from V1.5)
- Cross-entity tagging (already in schema: `tag` + `entity_tag`)
- Autocomplete, color coding
- Filter by tag on list pages

### 2.5 Duplicate/Clone (from V1.5)
- One-click duplicate for any entity
- "Copy of..." naming
- Speeds up iteration on winning creatives

---

## Phase 3: Intelligence Layer

**Goal:** Make the resolution library actively useful, not just a tagging tool.

### 3.1 Auto-Suggest Resolutions (from V2.0)
- Upload a creative asset → Claude vision analyzes it
- Pre-fills resolution fields (format, angle, persona, awareness, hook, tone, CTA)
- User accepts or overrides
- Reduces manual tagging by ~70%

### 3.2 Pattern Detection (from V2.0)
- Aggregate performance by resolution field values
- Surface insights: "clinical tone = 2.3x ROAS avg" or "problem-aware beats unaware by 40%"
- Start simple: SQL aggregates → graduate to Claude analysis
- Dashboard or insights page

### 3.3 Brief Generator (from V2.0)
- Select constraints (persona, awareness level, format)
- System pulls top-performing resolutions matching constraints
- Claude generates a brief: angle, hook, tone, CTA, landing page recommendations
- Save as a "Brief" entity or export

---

## Phase 4: Ecosystem

**Goal:** Close the loop — from data to insight to creative to performance to data.

### 4.1 Competitor Analysis (from V2.0)
- Tag competitor creatives with same resolution framework
- `is_competitor`, `competitor_brand`, `source_url` fields
- Filter: ours vs competitors
- Compare strategies

### 4.2 Shopify Integration
- Wire up products, orders, landing page attribution tables (schema already exists)
- Blended ROAS: actual Shopify revenue vs Meta-attributed
- Landing page → order attribution

### 4.3 A/B Test Tracking (from V1.5, schema already exists)
- Group ad variants under a test with hypothesis
- Track which variant wins
- Reuse comparison view

---

## Priority

| Phase | What | Effort | Impact |
|---|---|---|---|
| 1.1–1.3 | Simplify (auth removal, data merge, cron) | Medium | Unblocks everything |
| 1.4 | REST API | Medium | Enables Cowork, CLI, Jelo's brain — the integration layer |
| 1.5 | CLI tool | Small | Fast terminal access, Cowork skill backbone |
| 1.6 | Update Cowork skill | Small | Connects existing workflow to new DB |
| 2.1 | Creative-first navigation | Small | Better UX, team actually uses it |
| 2.2 | CSV import | Medium | Backfill data fast |
| 3.1 | Auto-suggest resolutions | Medium | 70% less manual tagging |
| 3.2 | Pattern detection | Medium | Core value — "what works and why" |
| 3.3 | Brief generator | Medium | Closes the loop |

Everything else is nice-to-have and can be added as velocity allows.

---

## Tech Stack (Post-Migration)

| Layer | Tech |
|---|---|
| Framework | Next.js 16, React 19, React Compiler |
| DB | Cloud Postgres (Neon/Supabase/Railway) |
| ORM | Drizzle |
| Internal API | tRPC v11 (web app ↔ server) |
| External API | REST (Next.js route handlers — Cowork, CLI, Jelo's brain) |
| CLI | Bun script wrapping REST API |
| UI | shadcn/ui (radix-nova, olive), Lucide icons |
| State | nuqs (URL state) |
| Uploads | Vercel Blob (or S3) |
| Auth | None (or simple shared password) |
| Hosting | Vercel |
