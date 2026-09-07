const GUIDE = `# Adsolute Studio — Agent Guide

REST access to the full Image Studio loop. Every operation is documented in the
OpenAPI doc at \`/api/openapi\` (rendered at \`/reference\`); this guide covers the
semantics and multi-step workflows that don't fit a single endpoint description.

## Auth

Send an organization API key on every request:

    Authorization: Bearer <key>

Keys are org-scoped. \`read\` scope covers all GET operations; \`write\` (or a
full-access \`*\` key) is required for POST operations, including the upload
endpoint. Keys are managed in Settings → API Keys.

## Analytics evidence

\`adCreative/dashboardStats\`, \`adCreative/portfolioSummary\` and attribution
range aggregates return additive \`effectiveWindow\` and \`reporting\` metadata.
Existing metrics, attribution \`range\` and connector health fields remain.

- Boundaries are inclusive. Dashboard \`from\` + \`to\` override \`days\`; a lone
  bound is ignored. Rolling \`days=N\` selects PostgreSQL's current date and N
  preceding dates, not N dates total. The response and SQL use the same bounds.
- Dashboard rows overlap the window; multi-day reporting rows are not prorated.
  Attribution Meta rows use date_start, Shopify orders use creation day, and
  revenue refunds use refund day. Read \`rowSelection\` for the event basis.
- Meta dates use each account's reporting timezone; Shopify uses store-calendar
  days. Equal labels need not cover equal instants. Mixed/missing account
  timezones are explicit. Historical timezone changes are not reconstructed.
- \`reporting.generatedAt\` is response generation time. Ingestion freshness is
  separate from unknown gap-free coverage and provisional attribution. A recent
  partial sync or maximum imported date does not establish complete or final data.
  Account evidence includes lagging, never-synced and disconnected accounts.
- \`sortBy=conversions|roas\` affects only top performers, before LIMIT.
  Conversions-first remains the default; complete ties use creative ID.
  For historical questions use \`rankingMode=historical\`: the top list ignores
  current status filters and does not require a currently active ad. Default
  \`current_active\` behavior is unchanged. Both modes retain spend >= 50 and
  ROAS >= 1 eligibility; inspect sample counts and low-conversion warnings.
  This ranks observed performance, not historical ad-status snapshots.
  \`leaderboards\` describes eligibility, ordering, filter asymmetries, lifetime
  exceptions and health scope. Surviving/attention exclude only the returned top
  IDs, so changing the top sort or limit changes their membership. A full capped
  list is possibly truncated, not proof of the total eligible population.

### Answering historical business questions

Use explicit date bounds resolved from the original question's date, not the
current date. For example, “yesterday” asked September 3, 2026 means September 2.
A Monday-start week-to-date on September 1 means August 31–September 1.

Distinguish Shopify-derived net sales (discounted item sales less item refunds,
excluding shipping/tax) from Meta-attributed purchase value. Neither a successful
order sync nor order-derived totals establish reconciliation with Shopify's
reporting UI. Order access does not imply ShopifyQL reporting access.

Read currency evidence before combining Meta amounts: never infer account
currency from Shopify currency or timezone, and never silently sum mixed or
unknown currencies. Read requested-window attempt evidence as sync history,
not a promise that the selected historical period is complete or final.
Missing data is not zero; a disabled account with no observed rows is unavailable.

### Shopify fulfillment summary

\`GET attribution/unfulfilledOrders\` accepts inclusive \`dateFrom\`/\`dateTo\`
store-calendar creation dates and requires only read access. It counts locally
observed UNFULFILLED, OPEN and RESTOCKED orders, excluding cancellations
independently of payment status. Partial, fulfilled and other workflow statuses
are separate; missing/unrecognized statuses stay unknown. Status is the latest
observed current status, not historical status at the window end. A complete
classification of observed rows is not proof of complete ingestion or source zero.
Older status changes refresh through updated-at sync subject to Shopify access;
legacy rows need the explicit operator fulfillment backfill. Read
\`answer.unfulfilledCount\`, which is null for partial/unknown classification,
instead of treating \`observedUnfulfilledCount: 0\` as a complete answer.
An available answer is still limited to observed orders, with unknown source
coverage. No customer/order identifiers or fulfillment mutations are exposed
by this summary.

### Shopify storefront conversion availability

\`GET attribution/conversionAvailability\` accepts \`dateFrom\`/\`dateTo\` and
checks the configured store's reporting access using a bounded read-only scope
probe. A \`missing_read_reports\` blocker returns null numerator, denominator
and rate. Granted scopes alone do not validate ShopifyQL access or session
calendar/population semantics; those remain explicitly blocked until validated.
No sessions are estimated from orders and no Meta conversion metric is used.
The requested dates are not a claim that session data was fetched.

## Core semantics

- **Star, don't save.** Studio output never becomes an ad creative record.
  Marking a variant \`good\` (\`studio/setVariantMark\`) is the save action; the
  library is curated from marks, publishes, and links.
- **Weekly cadence.** Suggestions are generated for a Monday triage rhythm.
  Element tallies decay over ~90 days; a refresh expires unactioned proposals
  and generates a fresh batch. Thin-evidence winners (<10 purchases) sit in a
  collapsed "worth watching" set rather than the main queue.
- **Async = trigger, then poll.** Mutations that start jobs return the ids you
  poll. Poll \`studio/generation\` (or \`studio/generations\`) until \`status\` is
  \`ready\` or \`failed\`; poll the suggestion run state exposed by \`studio/home\`
  until \`completed\` or \`failed\`. Responses may also include a Trigger.dev
  \`runId\` + short-lived \`publicAccessToken\` — an optional realtime upgrade;
  polling is the supported path.
- **Duplicates are soft.** \`createSwipe\` hard-returns an existing swipe on a
  matching source URL and soft-warns (\`duplicateImage\`) on a matching image
  hash. Always pass the \`hash\` the upload endpoint returns.

## Recipes

### Swipe-dump session

1. \`POST /api/upload\` (multipart \`file\`) → \`{ url, hash }\`.
2. \`POST studio/createSwipe\` with \`imageUrl\`, \`imageHash\`, optional
   \`sourceUrl\`, \`brandName\`, \`angleId\`, \`visualStyleId\`, \`whyItWorks\`.
3. Tags are optional at capture — analysis runs automatically and untagged
   swipes still count as untried. Repeat per image.

### Monday triage

1. \`POST studio/refreshSuggestions\` → note \`suggestionRunId\`.
2. Poll \`GET studio/home\` until the latest run is \`completed\` (or \`failed\` —
   report the error summary and stop).
3. Review cards from \`GET studio/suggestions\`; for each, either
   \`POST studio/setSuggestionStatus\` (\`approved\` / \`skipped\`) or
   \`POST studio/approveSuggestion\`.
4. \`POST studio/generateApproved\` → per-suggestion generation ids.
5. Poll \`GET studio/generation\` per id until \`ready\`/\`failed\`; retry failures
   with \`POST studio/retry\` or \`POST studio/retryVariant\`.
6. Mark keepers \`good\` via \`POST studio/setVariantMark\`.

### Make more like a winner

1. \`GET studio/winningAngles\` / \`GET studio/topByPurchases\` for proven angles
   and linked variants; \`GET studio/remixSource\` for a concrete source.
2. \`POST studio/extendVariant\` on the winning variant → poll the returned
   generation to a terminal state.

### Publish → link

1. When an ad ships, \`GET studio/linkCandidates\` proposes name-matched ads
   (template \`{BRAND}-ST-{angle}-{id6}\`).
2. Confirm with \`POST studio/linkVariantToCreative\` — or do both steps at once
   with \`POST studio/publishAndLink\`. Linking is always human/agent-confirmed;
   nothing is inferred silently, and nothing writes back to Meta.

## Supporting config

Brand profile (\`studio/brandProfile\` / \`saveBrandProfile\`) carries voice,
prohibited claims, and required disclaimers enforced at generation time.
Taxonomies (\`studio/taxonomies\`, \`addTaxonomyValue\`, \`archiveTaxonomyValue\`)
hold the message / concept / hook-type vocabulary. Copy packages live under
\`studio/copyPackages\` and friends.
`;

export function GET() {
  return new Response(GUIDE, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
