# Analytics reporting contracts (#257–259)

Status: proposed written spec; approach approved, awaiting spec review.

## Delivery boundaries

Implement #257–259 together because effective-window, source evidence and leaderboard metadata share response contracts. Follow with a separate fulfillment design/implementation for #260 and a primary-source discovery record only for #261. Preserve existing response fields, defaults, organization isolation and read-key authorization. No UI changes, alert-rule changes, credentials, production backfills or production migrations in this work.

The alternative of five independent implementations duplicates metadata logic. One implementation covering all five obscures the fulfillment migration and the discovery-only stop condition.

## Inspected code

- `src/lib/trpc/routers/ad-creative.ts`: dashboard filters, portfolio query and three leaderboard queries.
- `src/lib/trpc/routers/attribution.ts` and `attribution.shared.ts`: explicit inclusive ranges, store lookup and output schemas.
- `src/lib/attribution-queries.ts`: connector health currently aggregates connected Meta accounts; keep its public fields.
- `src/schema/account.ts`: account timezone, import progress and disabled/connection evidence.
- `src/lib/trpc/openapi-meta.ts`: OpenAPI descriptions are attached to procedures; generated contracts derive from output schemas.
- `src/lib/trpc/routers/ad-creative.analytics.test.ts`: mocked caller tests currently inspect generated SQL; returned fixture order alone cannot prove SQL ranking.

## 1. Effective window (#257)

Add a shared Zod reporting contract with an `effectiveWindow` containing `dateFrom`, `dateTo`, inclusive boundary semantics, selection mode and the calendar used to resolve rolling dates. Keep attribution's existing `range` and store fields.

Resolve dashboard bounds once through PostgreSQL, using its `current_date` and session timezone for rolling defaults. Pass the resolved bounds to all windowed queries and metadata; do not compute a second window from the application clock. A request crossing midnight therefore retains one consistent selection. Explicit bounds bypass rolling selection, but are normalized by the same database date casts used by the query.

Preserve these input rules:

- Both `from` and `to`: explicit inclusive bounds; `days` does not affect selection.
- Neither bound, or only one bound: rolling database-calendar selection, ignoring the lone bound as today.
- Rolling `days = N`: `[current_date - N, current_date]`, potentially N + 1 calendar dates.
- Keep the performance-log overlap predicate (`date_start <= dateTo AND date_end >= dateFrom`). This is selection of overlapping stored reporting rows, not clipping multi-day rows into daily prorated values.
- Attribution endpoints continue using their validated explicit dates.

Source calendar evidence is distinct from the calendar that chose rolling bounds. Shopify uses the store timezone recorded for `orderDay`; Meta uses individual account reporting timezones. Return account identifiers and known timezone values, with explicit uniform/mixed/unknown state; a missing timezone prevents a fully known classification. Do not infer timezone from server settings or imply identical instants across source date labels. Existing historical day labels are not recomputed after a store/account timezone change.

Apply the contract to dashboard aggregate/leaderboard responses and attribution overview, metaCheck, campaignLedger and dailySeries. Include other date-range aggregate attribution responses when they share this contract, documenting their event basis (for example refund day rather than order day). Lifetime metrics are explicitly exempted per list.

## 2. Reporting evidence (#258)

Add `reporting` with one response `generatedAt` and separate source entries. Use focused modules for Zod shapes, pure evidence classification and org-scoped evidence loading; avoid adding another large block of policy to the routers.

For each relevant Meta account expose non-secret account identity, connection state, timezone, last successful sync, latest attempt outcome/time when recorded, freshness, coverage state and revisability. Include accounts in the requested organization/account scope even if disabled, disconnected or never synced; do not derive the inventory from successful runs. Campaign/ad-set scopes may narrow that inventory when safely established; if evidence is broader than metric filters, label its account scope explicitly. Team/format/ownership filters must not falsely imply a separate connector synchronization scope.

Definitions:

- Freshness: elapsed time since successful ingestion under existing connector staleness thresholds; success is not coverage.
- Coverage: proof of gap-free ingestion for the requested window. Default to `unknown` with an evidence reason because max imported day and successful partial runs do not prove completeness. An observed maximum imported day may be disclosed only as progress, never complete-through.
- Revisability: Meta attribution can revise after ingestion; report provisional/unknown source state without a finality promise. Do not introduce `finalizedThrough` or an implicit settling guarantee.

Summaries retain missing and lagging accounts: aggregate freshness cannot use only the newest successful run. A failed latest attempt and an older successful run are both represented. Shopify gets its own successful-run evidence and unknown completeness, separate from Meta state. Preserve existing overview `health` fields even where the new evidence is more detailed.

Evidence reads must be organization scoped, select no tokens, and remain bounded to the relevant account inventory. No sync jobs or alert evaluators change for these issues.

## 3. Reproducible leaderboards (#259)

Add validated `sortBy: "conversions" | "roas"`, default `conversions`, affecting only top performers. Build a closed SQL ordering choice, applied to the entire eligible population before LIMIT:

- conversions: summed conversions DESC NULLS LAST, aggregate ROAS DESC NULLS LAST, creative ID ASC.
- roas: aggregate ROAS DESC NULLS LAST, summed conversions DESC NULLS LAST, creative ID ASC.

Keep existing eligibility: window aggregate spend >= 50, aggregate ROAS >= 1, and at least one effectively active qualifying ad with positive window spend. Display totals aggregate the ads allowed by the existing filters, not just active qualifying ads.

Surviving keeps lifetime spend >= 50, ROAS >= 1, lifetime span >= 14 days, and an active ad with spend. Order by lifetime span DESC, ROAS DESC NULLS LAST, creative ID ASC. It does not apply the requested date/status filters; disclose that asymmetry.

Attention keeps the existing per-ad algorithm: active ad, spend >= 25 and zero conversions or ROAS < 1. Fair-shot threshold is max(50, portfolio CPA), with existing fallback and includePortfolio-dependent query scope preserved. `pause_now` requires fair-shot spend and lifetime age >= 5; `watch` requires fair-shot spend or lifetime age >= 7; cooking ads are omitted. Rank creative groups by most urgent tier, at-risk spend DESC NULLS LAST, creative ID ASC. Display totals include all scoped ads; requested status filtering is not applied to this list. Age is lifetime, not window bounded. Also stabilize ties in returned bleeder-ad ordering by ad ID.

Return per-list `leaderboards` metadata: inclusion state, effective ordering/directions/null handling/tie-breaker, eligibility thresholds, applied and ignored filter dimensions, displayed-metric and qualification scopes, lifetime exceptions, requested limit and returned count. Return the actual top IDs excluded by surviving and attention, documenting that changing top sort or limit changes those exclusions. Describe truncation as capped/possibly truncated rather than asserting more rows exist solely because returned count equals limit. Do not add count queries just to infer total population. An omitted surviving list remains an empty array with explicit omitted metadata.

## 4. Verification and contracts

- Test single and multi-day explicit requests, both bounds plus days, either lone bound, rolling inclusive semantics, database timezone different from application timezone and database midnight crossing.
- Test Shopify store midnight and DST boundaries; multiple, missing and differing Meta timezones; never claim shared instants.
- Test successful partial runs, stale success, failed latest attempt, disconnected/disabled and never-synced accounts, mixed account progress and empty account scopes.
- Test conversions and ROAS fixtures with opposite rankings, ROAS ranking across the full population before LIMIT, ties, nulls, zero spend/conversions, all eligibility boundaries, limits and omitted portfolio/surviving behavior.
- Extend SQL/caller tests for account/team/campaign/ad-set/status/format/ownership filters and disclosure of existing asymmetries. Use database-backed fixtures for ranking semantics where supported; mocked sorted rows alone are not evidence that SQL ranks correctly.
- Test output schema parsing, generated OpenAPI metadata and existing read-key/cross-org caller regressions. Existing consumers retain their fields.
- Run targeted Vitest suites with `bun run test`, then typecheck and lint. Record environmental limits rather than claiming unrun database tests passed.

## Subsequent workstreams

### #260: fulfillment counts

Use a separate spec after this contract is settled. Add nullable authoritative Shopify fulfillment status and observation evidence, preserving missing legacy values. Define exact status classification against current primary Shopify documentation before implementation. Count distinct non-cancelled orders selected by inclusive store-calendar creation day; financial status is irrelevant. Return a status breakdown and latest-observed-current-status basis, not historical end-of-window status. Missing status coverage cannot yield a purported complete zero.

The existing incremental sync uses `updated_at` without a creation-window lower bound and can refresh older changed orders subject to Shopify access restrictions. Define an explicit status backfill for already stored rows and expose incomplete coverage until evidence supports otherwise. Generate and validate a migration through Drizzle; do not manually rename migration files or run a production backfill. Add an aggregate-only read-scoped, org/store-isolated OpenAPI query and synthetic example.

### #261: conversion-rate discovery

Produce a concise cited decision record using current primary API/report documentation and inspected integration assumptions. Define sessions and converted sessions, population/channel/date/timezone basis, latency/revisions, zero versus missing denominator, permissions, plan/access restrictions and relevant pagination/retention/rate limits. Order journeys are not all-store sessions, and order count is not automatically converted-session count. Verify whether existing access suffices without exposing credentials or changing provisioning. Estimate ingestion/storage/API effort and operating cost if feasible; otherwise record an honest unsupported state and required decision. No endpoint implementation follows automatically.
