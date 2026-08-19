# Attribution Becomes the Main Dashboard

**Date:** 2026-08-19
**Status:** Approved
**Branch:** `feat/attribution-dashboard` (based on `main`; Google Ads pilot #190 and the Klaviyo email revenue panel are already merged)

## Summary

The attribution page graduates from a beta feature into the app's home page.
Opening `/` shows the attribution view: header rail, channel ledger, findings.
Clicking a source in the ledger opens that source's drawer, which now stacks
three things: a button to the source's dedicated dashboard/lab, the source's
revenue panel, and the existing "Orders from X ads" table. The old Meta
dashboard moves to `/meta`.

## Goals

- `/` renders the attribution view for every org (flag retired).
- Per-source drawers merge the revenue panels (Meta, Google, Klaviyo) with the
  orders table, plus a button to the source's dashboard or lab.
- A new Meta revenue panel built from existing queries (`metaCheck`,
  `campaignLedger`) — no backend changes.

## Non-goals

- No schema, tRPC, or Trigger.dev changes.
- No panels or labs for tiktok / ai / organic_direct / unattributed /
  untracked — their drawers stay orders-table-only.
- No redesign of the Meta dashboard itself; it only moves.

## 1. Routing & navigation

| Concern | Decision |
| --- | --- |
| `/` (route group `(dashboard)`) | Renders the attribution page content (moved from `src/app/(protected)/attribution/page.tsx`). Nav/breadcrumb label: "Dashboard". |
| Old Meta dashboard | Moves wholesale (page + `loading.tsx`) to `src/app/(protected)/meta/page.tsx`. No functional changes. |
| `/attribution` | Stub page that server-redirects to `/` (bookmarks survive). |
| Labs | `/attribution/klaviyo` and `/attribution/google-ads` keep their URLs, untouched. |
| Sidebar | "Dashboard" → `/` stays first. New "Meta" item → `/meta` (Solar icon). |
| Feature flag | The `attribution` flag is retired: remove its definition from `src/lib/feature-flags.ts` (settings row and flag-gated sidebar entry disappear with it) and delete any remaining `flags.attribution` checks. Stale jsonb keys in stored org settings are ignored; no migration. |

## 2. Source drawers

New component `src/components/blocks/attribution/source-drawer.tsx` with a
registry keyed by `AttributionBucket`:

| Bucket | Panel | Dashboard button |
| --- | --- | --- |
| `meta` | `MetaRevenuePanel` (new) | "Open Meta dashboard" → `/meta`, visible to **all roles** |
| `google` | `GoogleAdsRevenuePanel` (existing) | "Open Google Ads Lab" → `/attribution/google-ads`, privileged only (reuse lab-link gating) |
| `klaviyo` | `EmailRevenuePanel` (existing) | "Open Klaviyo Lab" → `/attribution/klaviyo`, privileged only |
| all others | none | none — drawer renders exactly today's `BucketOrdersPanel` |

Drawer layout, top to bottom:

1. Slim action row, right-aligned dashboard/lab button (only for the three
   sources that have one). The button lives in the drawer chrome, not inside
   the panel, because panels are privileged-gated while the Meta dashboard
   button must show for members too.
2. The source's revenue panel (if any).
3. `BucketOrdersPanel` (unchanged component).

`renderDrawer` in the page becomes a single `<SourceDrawer bucket={…} />`
call. The standalone `EmailRevenuePanel` / `GoogleAdsRevenuePanel` sections
below the ledger are removed, as are the `KlaviyoLabLink` /
`GoogleAdsLabLink` header links. Both existing panels get a light styling
pass (compact drawer variant) so they sit inside the drawer instead of as
full-width page sections.

## 3. Meta revenue panel (new)

`src/components/blocks/attribution/meta/revenue-panel.tsx`, mirroring the
Google panel's shape, built entirely from existing queries:

- **Headline:** "Meta says vs. our count" comparison with share bar, from
  `attribution.metaCheck` — same data as today's Meta-check fold, including
  metaDown / no-data-yet states, the footnote, and the Meta-vs-Shopify detail
  link.
- **Table:** the campaign ledger, reusing `campaign-table.tsx` and
  `attribution.campaignLedger`.
- **Gating:** visible to all roles, matching today's fold behaviour (unlike
  the privileged Google/Klaviyo panels).

`DetailFolds` drops its "meta" and "campaigns" folds (content now lives in the
Meta drawer) and keeps "needs attention" (findings) and "how we count".

## 4. Error handling & states

Nothing new. Each panel keeps its own loading/error/empty states; a panel
query failing never blocks the orders table beneath it (independent queries).
First-load backfill progress, the frozen-connection banner, findings rail and
mobile sheet all move with the page unchanged. Orgs that never enabled the
attribution flag now see the attribution view at `/` by design.

## 5. Testing

- Component tests (existing `*.component.test.tsx` pattern, `bun run
  test:components`):
  - `SourceDrawer`: correct panel + button per bucket; orders-table-only for
    unmapped buckets; member vs. privileged button visibility.
  - `MetaRevenuePanel`: data, meta-down, and no-data-yet states.
- Update existing tests touched by the moves (detail-folds, page-level,
  panel styling variants).
- `bun run test`, `bun run test:components`, and `bun run lint` green.

## Decisions log

- Base on `main`, single branch (Google pilot + Klaviyo panel already merged).
- Meta dashboard moves to `/meta`; `/attribution` redirects to `/`.
- Meta panel = metaCheck headline + campaign ledger table, existing queries only.
- Header lab links removed; drawer buttons are the single entry point.
- `attribution` feature flag retired outright.
- Drawer composition via `SourceDrawer` + registry (adding a future source is
  one registry entry).
