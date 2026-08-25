# Klaviyo List Health — Design

2026-08-24 · brainstormed and approved with owner. Branch `feat/klaviyo-list-health` off main. Builds on the Klaviyo pilot's event pipeline (order-core + journey source modes).

## Goal

Track email-list consent movement — how many people subscribed, unsubscribed, and flipped — joined to the same date ranges as revenue. Short summary in the attribution page's Email revenue panel; full view as a new Klaviyo Lab tab.

## Decisions (made during brainstorming)

| Decision | Choice |
| --- | --- |
| Consent signal | List membership: Klaviyo's "Subscribed to List" / "Unsubscribed from List" events, aggregated across lists in v1 (list reference stored for a later per-list breakdown). Matches Klaviyo's own list-growth numbers; a person on two lists counts once per list. |
| Flip metrics | Won back **and** quick churn. Won back = in-range subscribe whose immediately-previous consent event (full history, any time) is an unsubscribe. Quick churn = in-range unsubscribe within 14 × 24h of that profile's immediately-previous subscribe. Net = subscribed − unsubscribed, derived. |
| Panel presentation | One-line dashed strip at the bottom of the Email revenue panel (gap-strip idiom), chevron deep-linking to the Lab tab. |
| Architecture | Third `consent` source mode riding the existing event engine (approach 1). No aggregates API, no hybrid. No new tables. |

## Ingestion — the consent source mode

- **Kinds**: `subscribed_to_list`, `unsubscribed_from_list` join the closed `KLAVIYO_ALLOWED_METRIC_KINDS` union (`src/lib/klaviyo/types.ts`); discovery's metric-name map (`src/lib/klaviyo/discovery.ts`) gains "Subscribed to List" / "Unsubscribed from List". Not part of the order-core gate: no probe, no join rules — consent events are profile-timeline facts and never join to orders.
- **Contract**: `ConsentSourceContract` (`sourceMode: "consent"`, fixed two-kind list), modeled byte-for-byte on the journey contract: exact-shape assertions, checkpoint fingerprinting, immutable run parameters deciding dispatch inside `processEventSourceBatch`.
- **Normalization, fail-closed**: per-kind properties allowlist keeps only the list reference (`listId`, `listName`); everything else is stripped before persistence. `profileId` (Klaviyo's opaque id) stored as for journey events. No emails, no HMACs (nothing joins to Shopify).
- **Windows**: 90-store-day boundary like all sources. First run backfills 90d (list churn is low-volume — minutes). The nightly `klaviyo-incremental` supervisor gains a `consent` stage after the events stage: incremental 7d, same lease/reap/deadline patterns. **Failure isolation**: a failed consent stage records `failed` in the supervisor report and blocks nothing — it is a leaf; matching/claims/panel revenue never consume it.

## Aggregates, flips, and the API

- New read-only module `src/lib/klaviyo/list-health.ts` (sibling of `email-attribution.ts`):
  `loadListHealth({ scope, window, days })` →
  `{ totals: { subscribed, unsubscribed, wonBack, quickChurn, net }, daily: [{ day, subscribed, unsubscribed, wonBack, quickChurn, net }] }`.
- Counts are event counts in the window (list-membership semantics). Daily buckets in the store timezone. Window params interpolated as UTC ISO text with `::timestamp` casts (the established `utcTimestamp` rule — never raw Date params in raw SQL).
- **Flip SQL**: per profile, consent events ordered by `occurred_at` with `LAG()`; won-back and quick-churn per the definitions above. Computed from `occurred_at`, not ingestion order, so out-of-order arrivals self-correct on the next read.
- **tRPC**: one `klaviyo.listHealth` query (`orgAdminProcedure`, `{ dateFrom, dateTo }`, `storeDaySchema`), consumed by both surfaces — panel strip and Lab tab are two renderings of one payload.

## UI

- **Panel strip** (Email revenue panel, below the gap strip): `List health: +142 subscribed · −38 unsubscribed · 12 won back · 5 quick churn · net +104 ▸` — chevron to `/attribution/klaviyo?view=list-health` with the page's range (same `labUrl` pattern as the gap strip). Renders only when the query succeeds with any nonzero total; hides entirely when consent metrics are undiscovered (older connections that haven't re-run discovery see nothing, not an empty strip).
- **Lab tab**: `list-health` joins `LAB_VIEWS`. KPI row (Subscribed / Unsubscribed / Won back / Quick churn ≤14d / Net), daily table, CSS-only daily net bars (plain divs scaled by max |net|, green in / red out — no chart library). Obeys the Lab's range chips.
- **Aggregate-only everywhere**: no per-profile rows in any UI; profile-level data exists only inside the SQL.

## Edge cases

- Connection not ready → Lab tab shows the standard pending state.
- Consent metrics undiscovered → Lab tab shows "Run discovery to enable list tracking" (discovery re-run is idempotent); panel strip hidden.
- A profile whose first-ever event is an unsubscribe counts as an unsubscribe, never won-back — no prior state is invented.
- Quick-churn boundary is 14 × 24h from the subscribe instant, not calendar days.
- Multi-list double-counting is accepted, documented v1 semantics (matches Klaviyo's list numbers).

## Testing

- **Integration** (disposable-PG harness): profile sequences — plain subscribe; unsub→resub (won back); sub→unsub at 13d (quick churn) and at 15d (not); first-event-unsubscribe; multi-list double-count; UTC window-edge seeds (both boundaries); daily bucketing across a store-timezone midnight.
- **Contract/unit**: consent contract exact-shape + checkpoint fingerprint tests mirroring the journey ones; normalization test proving only the list reference survives and an email-shaped property dies.
- **Router**: `listHealth` rides the shared RBAC loops + one behavior test. Supervisor boundary test for the consent stage payload.
- **Component**: strip renders/hides + deep-link href; Lab tab KPIs/table render; undiscovered-state message.

## Out of scope (v1)

- Per-list breakdown (stored list reference makes it a later query change).
- Global profile-consent semantics (list membership only).
- Any per-profile UI, exports, or flip-person lists.
- Alerting on churn spikes.
