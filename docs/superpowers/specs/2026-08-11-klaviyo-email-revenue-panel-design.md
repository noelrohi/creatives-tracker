# Klaviyo Email Revenue Panel — Design

2026-08-11 · brainstormed and approved with owner. Builds on the completed
Klaviyo + Shopify Evidence Pilot (plans 1–5, branch
`feat/klaviyo-shopify-evidence-pilot`).

## Goal

Put the Klaviyo evidence on the main attribution page so anyone reading it
can answer: of the Shopify revenue in this range, how much is tied to
email, through which campaigns/flows and products, what does Klaviyo
itself claim, and where does the rest of the money live. This is the first
instance of a repeatable "external source vs our evidence" reading; more
sources will follow the same shape.

## Decisions (made during brainstorming)

| Decision | Choice |
| --- | --- |
| Audience | Admin/owner only for v1; reuses `orgAdminProcedure`. Members do not see the section. |
| Placement | Dedicated always-visible section on `/attribution`, between the channel ledger and the detail folds. |
| Headline form | KPI trio + horizontal share bar (email slice split campaigns/flows), with "Klaviyo says" delta. |
| v1 content | All four pieces: headline totals, campaign/flow table, top products, gap diagnostics. |
| Architecture | One new read-only aggregate endpoint (`klaviyo.emailAttribution`); no schema changes, no new pipeline stages. |

## Panel composition (top to bottom)

1. **Title row** — "Email revenue · Klaviyo" + freshness caption
   (evidence as-of, last match publication), matching the page's caption
   style.
2. **KPI trio** — Shopify net sales (from the page's existing
   `attribution.overview` query, never refetched) · "Tied to email" with
   % of total and order count · "Klaviyo says" with an "unconfirmed"
   delta.
3. **Share bar** — full-width bar of Shopify net sales; email slice
   split into campaigns (dark) and flows (light) segments; legend with
   amounts.
4. **Two tables side by side** (stack on mobile):
   - *By campaign & flow* — name, our order count, our revenue
     ("we confirm"), and per campaign the Klaviyo-reported conversion
     value ("Klaviyo says") with delta. Footnote: "Klaviyo says" is
     their report over each campaign's own window, not this date range.
     Flows show "—" until flow reports exist.
   - *Top products in email-linked orders* — title, units, revenue,
     top 10 by revenue; "…more" expands in place.
5. **Gap strip** — one dashed line accounting for every remaining
   dollar: confirmed-but-no-email-link, not-evaluated (newer than
   evidence), no-Klaviyo-event, duplicate-flagged count, and the range's
   unmatched-event count. Each chevrons into the existing Klaviyo Lab
   pre-filtered to that state.

The panel obeys the page's date-range chips and skeleton conventions.
Rows are read-only in v1.

## Data contract

New procedure `klaviyo.emailAttribution` (`orgAdminProcedure`), input
`{ dateFrom, dateTo }` validated like `attribution.overview`. Output:

```ts
{
  connection: {
    status, lastMatchPublishedAt, evidenceAsOf,
  } | null,
  email: {
    revenue, orderCount, campaignsRevenue, flowsRevenue,
  },
  klaviyoSays: {
    conversionValue, requestedFrom, requestedTo, asOf,
  } | null,
  sources: Array<{
    objectType: "campaign" | "flow", name,
    orderCount, revenue,                       // ours, range-scoped
    klaviyoConversionValue, klaviyoWindow,     // theirs, own window (campaigns only)
  }>,
  products: Array<{ productId, title, units, revenue }>,  // top 10
  gaps: {
    confirmedNoEmailLink: { orders, revenue },
    notEvaluated: { orders, revenue },
    noKlaviyoEvent: { orders, revenue },
    duplicateFlagged: { orders, revenue },
    unmatchedEvents: { count },
  },
}
```

### Definitions

- **Email-linked order**: order in range (store-day calendar, identical
  to the overview) whose *published* match run result is `confirmed` and
  whose canonical conversion event carries ≥ 1 claim to a campaign or
  flow. Revenue is the order's `net_sales` — the same field the header
  rail sums, so slice and total can never disagree on definition.
- **Primary claim (last touch)**: when a conversion event has multiple
  claims, the primary is the most recent non-bot
  (`bot_click` unset/0) interaction by `interaction_occurred_at`. The
  primary decides campaign-vs-flow assignment for the headline split and
  the source table. An order whose only claims are bot clicks is
  *confirmed-without-email-link*.
- **Klaviyo says**: sum of `conversion_value` over the latest successful
  report generation's campaign facts. Windows (`requested_from/to`,
  account timezone) travel with the number; the UI always captions it as
  their window and never re-slices it to the page range. The
  "unconfirmed" delta is computed client-side and always carries that
  caption.
- **Sources**: names resolved from the marketing-objects graph
  (`klaviyo_marketing_object`); campaigns matched to report facts by
  campaign object id.
- **Products**: `shopify_order_line` joined over the email-linked order
  set, aggregated by product, top 10 by revenue.

### Partition invariant (load-bearing)

Every order in range lands in exactly one of: email-linked ·
confirmed-without-email-link · not-evaluated · no-Klaviyo-event ·
duplicate-flagged. The revenues of these buckets sum to the overview
total by construction. The gap strip is this equation made visible.
Duplicate-flagged orders (no canonical event pick) are excluded from
email-linked.

Advisory-only invariant inherited from the pilot: the endpoint reads
Shopify money and reads claims; it never mutates buckets or order rows.

## Edge cases & error handling

- **No Klaviyo connection** → section does not render (Lab link remains
  for setup). Connection present but not `ready`, or health stale →
  panel shell with the page's standard "no data yet" chip — never zeros.
- **Staleness is a caption, not a blocker**; orders newer than the
  evidence window surface in `notEvaluated`.
- **Query failure** → one-line error with retry inside the panel; the
  rest of the page is unaffected (independent query).
- **Timezones**: order days on the store calendar; report windows on the
  account calendar; the two are never mixed in one number.

## Testing

- **Aggregate integration tests** on the existing disposable-DB harness
  (`match-test-harness` world extended with claims + report-fact
  fixtures): headline split, last-touch rule, bot exclusion, product
  join, and the partition invariant (seeded orders partition exactly;
  bucket revenues sum to the seeded total).
- **Router RBAC test** in the existing pattern: member forbidden, admin
  passes middleware (settle-style assertion, DB-agnostic).
- **Component tests** (`.component.test.tsx`): KPI trio + share bar,
  no-data chip, gap-strip deep-link hrefs, error line, member-role
  non-render.

## Out of scope (v1)

- Member-visible read tier (revisit after v1).
- Flow-kind Klaviyo reports (facts table supports them; UI shows "—").
- Pre-aggregated rollup tables (revisit if aggregates get slow).
- Any change to bucket math, order rows, or the pilot's pipelines.
