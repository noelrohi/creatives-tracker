# Dashboard Format Filter and Campaign Ad Links

## Goal

Make dashboard reporting filterable by creative format and make Campaigns ad rows open the same creative detail view used by the Creatives table.

## Dashboard format filter

Add a URL-backed `format` query parameter to the dashboard. The header filter offers All Formats, Static, Video, UGC, and Carousel, using the existing creative format values.

The selected format applies consistently to:

- portfolio KPIs and all Overview leaderboards;
- daily performance charts;
- demographic breakdowns;
- export preview and raw performance-log CSV export;
- “View all” links from dashboard leaderboards.

Filtering is performed server-side by joining each performance row through its ad to `ad_creative.format`. With no format selected, behavior and query results remain unchanged. The dashboard URL preserves the selection across reloads and sharing.

## Campaign ad-row navigation

Extend the manager ad response with nullable `creativeId`, sourced from `ad.ad_creative_id`. Campaign and ad-set response shapes remain unchanged.

A Campaigns ad row with a linked creative is keyboard- and pointer-clickable. Activating it navigates to:

`/creatives/{creativeId}?from={from}&to={to}`

The current Campaigns date range is preserved. Pause and overflow-menu interactions do not trigger row navigation. An ad without a linked creative remains visually and behaviorally non-clickable.

## Components and data flow

- `DashboardPage` owns the URL-backed format selection and passes it to all dashboard queries and exports.
- Dashboard tRPC inputs accept the existing creative format enum and apply a shared SQL format condition where possible.
- `performanceLog.demographicBreakdown` accepts the same optional format input.
- `manager.ads` returns `creativeId` only for ad rows.
- `ManagerLedgerRow` accepts an optional navigation callback. `ManagerAdRows` builds the detail URL from its existing filters and routes linked ads.

## Error handling and accessibility

Existing query loading and error states remain in place. Navigation is not attempted when `creativeId` is null. Clickable rows expose focus styling and keyboard activation through a semantic interactive element or equivalent accessible row behavior. Nested action controls stop propagation.

## Testing

Add or update tests to verify:

1. Dashboard analytics, chart, demographic, and export queries apply format filtering.
2. `manager.ads` returns the linked creative ID and null when no creative is linked.
3. Linked ad rows navigate with the current date range.
4. Pause and overflow actions do not navigate.
5. Unlinked ad rows are not interactive.

Run `bun run test`, `bun run lint`, and `bun run build` before opening the pull request.

## Out of scope

- Multi-select format filtering.
- Navigation from campaign or ad-set rows.
- Creating creatives for unlinked ads.
- Changing creative detail-page behavior.
