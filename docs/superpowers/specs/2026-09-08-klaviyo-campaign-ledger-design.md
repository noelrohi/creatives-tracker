# Klaviyo Campaign Ledger — Design

**Date:** 2026-09-08
**Status:** Approved
**Branch:** `feat/klaviyo-campaign-ledger` (off `main`)

## 1. Goal

Give Klaviyo the same shape the Meta campaigns page has: every campaign and
flow as a row you can rank and compare, with a drill-down that shows what a
single send did. Today the lab's Reports view shows raw object IDs and five
statistics; the attribution panel shows a four-column "we confirm vs Klaviyo
says" table. Neither answers "how did this email do".

The ledger replaces the lab's Reports view. Its job is **rank first, inspect
second**: the table ranks sends by confirmed revenue, and a row opens into a
side sheet with the funnel, the revenue reconciliation, list damage, orders by
day, top products, and message variants.

### Decisions taken during brainstorming

| Question | Decision |
| --- | --- |
| Primary job | Both: ledger first, row opens a deep view |
| Where it lives | Inside the Klaviyo Lab, replacing the Reports view |
| Scope | This feature only; the full lab redesign is a follow-up (§10) |
| Rows | Campaigns and flows in one list, expandable to their messages |
| Columns | "Funnel + trust": Recipients, Delivered, Open, Click, Orders, We confirm, Klaviyo says, Unsub |
| Drill-down | Right-side sheet at one third of the viewport, seven blocks |
| Date range | Selects campaigns by **send time**, with their full results (Klaviyo's rule) |
| Data source | Extend the existing report pipeline; no event ingestion, no live proxy |

## 2. Non-goals

- Changing the attribution panel's headline, which keeps order-date semantics
  on purpose ("of this week's sales, how much came from email").
- Per-person engagement data. The pilot's aggregate-only rule stands; opens,
  clicks, and unsubscribes arrive as Klaviyo's per-campaign totals.
- Ingesting Opened/Clicked/Unsubscribed events.
- Any mutation toward Klaviyo or Shopify. The ledger is read-only.
- The broader lab redesign, charts, and navigation regrouping (§10).

## 3. Data model and sync

### 3.1 Marketing objects

`klaviyo_marketing_object` gains two nullable columns:

- `sent_at timestamp` — campaigns only. Klaviyo's `send_time`, falling back to
  `scheduled_at`. Null for drafts, never-sent campaigns, and every flow row.
- `subject text` — `campaign_message` and `flow_message` rows. The subject
  inside the message `definition` that the existing fetch already returns and
  currently discards.

The campaign list request adds `send_time,scheduled_at` to its sparse fields.
Both new fields join the source checksum, so the next dimension refresh
rewrites every existing campaign with its send time. No backfill script.

### 3.2 Report facts

`klaviyo_report_fact` gains four nullable numeric columns: `delivered`,
`bounced`, `unsubscribes`, `spam_complaints`. The statistics allowlist grows
from five to nine:

```
conversions, conversion_value, recipients, clicks_unique, opens_unique,
delivered, bounced, unsubscribes, spam_complaints
```

All nine come from the same two endpoints already in use
(`POST /api/campaign-values-reports`, `POST /api/flow-values-reports`).
Unknown statistics keep being dropped and recorded, as today.

Rates are computed by us, matching Klaviyo's own definitions:

| Rate | Formula |
| --- | --- |
| Delivered | delivered ÷ recipients |
| Open | opens_unique ÷ delivered |
| Click | clicks_unique ÷ delivered |
| Unsubscribe | unsubscribes ÷ delivered |

A rate is `null` (rendered as an em dash) when its denominator is null or
zero. Never "0%".

### 3.3 Per-message report kinds

`KLAVIYO_REPORT_KINDS` grows from `campaign | flow` to
`campaign | flow | campaign_message | flow_message`. Each kind is its own
generation with the existing staging → current → superseded lifecycle and the
existing one-`current`-per-scope guarantee.

- `campaign_message` calls the campaign endpoint with an explicit
  `group_by: ["campaign_id", "campaign_message_id"]`; `flow_message` calls the
  flow endpoint with `group_by: ["flow_id", "flow_message_id"]`. These
  grouping keys are added to the grouping allowlist. Revision `2026-07-15`
  requires the parent id grouped alongside the message id (verified live
  2026-09-08).
- Facts for the message kinds set `message_object_id` (a column that exists
  today and is always null) alongside the parent `campaign_object_id` or
  `flow_object_id`.
- The parent kinds `campaign` and `flow` keep sending **no** grouping on the
  wire, so their request body shape is unchanged. Their publication-scope
  fingerprints *do* change, because the statistics list is part of the
  fingerprint; that is intended — it makes the next scheduled preflight see
  every slot as stale and refresh it once with the nine statistics. Prior
  current generations are superseded by window and kind at publication
  (§3.3 supersession), so no stale slot lingers.
- The nightly refresh and the lab's Refresh button run four kinds instead of
  two, keeping the existing 1.1s spacing between report calls and the 24h
  freshness rule.
- The kind check constraints on `klaviyo_report_generation` and
  `klaviyo_report_fact` widen to the four kinds.

**Fallback.** If revision `2026-07-15` rejects the message grouping, that
generation records `failed` with reason `grouping_unsupported`, the parent kind
still publishes, and ledger rows render without an expand chevron. The plan
verifies the grouping key names through the existing report probe before
wiring them.

**Window assumption to verify in the same probe.** Klaviyo's report timeframe
selects campaigns by send time and credits conversions inside the attribution
window regardless of order date. This is what makes rule (a) in §4 line up
with Klaviyo's number on the same row.

### 3.4 Migration

One generated migration: the two `ALTER TABLE ... ADD COLUMN` sets and the
widened kind checks. Applied by hand in prod (`bun run db:migrate:prod`), as
always.

## 4. Loaders and row rules

One new module, `src/lib/klaviyo/campaign-ledger.ts`, with three loaders. Each
takes the connection scope and an account-timezone day range, converted to the
same half-open UTC window the report request uses, so "the current generation
for this window" is an exact key match, as in the lab's Reports view today.

### 4.1 `loadLedgerRows` — the top level

**Which rows appear**

- A **campaign** appears when its `sent_at` falls inside the window. Drafts and
  never-sent campaigns never appear.
- A **flow** appears when it has at least one fact in the current flow
  generation for this window **or** at least one confirmed order in it. A flow
  with nothing in the range stays out rather than showing a row of dashes.

**Klaviyo's side per row** — read from the current generation for this window:
recipients, delivered, unique opens, unique clicks, bounced, unsubscribes, spam
complaints, conversions, conversion value. Null when there is no fact; the row
still renders because our side may have numbers.

**Our side per row** — confirmed order count and refund-net revenue, using the
attribution panel's primary-claim rule (last non-bot claim on the order's
selected conversion event, `campaign_object_id` else `flow_object_id`),
extracted into a shared SQL fragment so the panel and the ledger cannot drift.

- For a **campaign**: every confirmed order whose primary claim names it, with
  **no order-date filter**. A campaign sent Aug 28 shows its Sep 3 orders. This
  is rule (a): the row describes the send.
- For a **flow**: confirmed orders whose primary claim's
  `interaction_occurred_at` falls in the window. That is what "emails the flow
  sent in the range" means on our side and matches how the flow report's
  timeframe works.

Refunds are netted through their parent order's primary claim, as in the panel.

Kind, channel, and search filters apply in SQL. Sorting is client-side.

### 4.2 `loadLedgerMessages` — the child rows

For one campaign or flow: its `campaign_message` / `flow_message` rows from the
dimension table, joined to the message-kind generation for Klaviyo's numbers
and to claims by `message_object_id` for ours. Claims already carry that
column, so per-email confirmed revenue inside a flow needs no new attribution
work. Same window rules as the parent.

### 4.3 `loadLedgerDetail` — the sheet

For one object:

1. **Header** — name, kind, channel, status, send time, subject from its first
   message.
2. **Funnel** — recipients, delivered rate, open rate, click rate, our
   confirmed orders.
3. **Revenue** — our refund-net revenue and order count; Klaviyo's conversion
   value and conversions; unconfirmed orders = Klaviyo conversions minus ours,
   floored at zero; revenue per recipient = ours ÷ recipients; average order
   value = ours ÷ our orders.
4. **List impact** — unsubscribes, spam complaints, bounced, each with its
   rate.
5. **Orders by day** — for a campaign, confirmed orders and revenue by day
   offset from `sent_at` over the first 14 days; for a flow, by calendar day
   across the window.
6. **Top products** — the panel's product query filtered to this object's
   confirmed orders, top 10.
7. **Messages** — the child rows, only when the object has more than one.

### 4.4 Value conventions

Money is summed and rounded in SQL and travels as a two-decimal string. Counts
are integers. Rates are numbers or null and are never formatted in the loader.

## 5. API

Three new queries under `klaviyo.ledger`, all on the admin-only procedure the
rest of the lab uses, each taking the account-day `dateFrom`/`dateTo` the
Reports view already validates:

- **`list`** — `kind` (`all | campaign | flow`), `channel`
  (`all | email | sms`), optional search string with the Meta ledger's length
  cap. Returns the rows plus report metadata (account timezone, generation
  `asOf`, whether a refresh is running).
- **`messages`** — one object id, returns its child rows. Fetched lazily on
  expand and cached with the lab's stale time.
- **`detail`** — one object id, returns the §4.3 payload.

One existing query changes: **`orders`** gains an optional `sourceObjectId`
filter so "View all N orders" lands on the Orders view already narrowed to the
campaign. Page size and status filters are unchanged.

**`refreshReports`** is unchanged from the caller's side; it stages four kinds
instead of two. The freshness rule and the one-running-run guard stay.

Every id crossing the wire is our internal row id, never a Klaviyo external id.
No new mutations, so the pilot's advisory-only invariant is untouched.

## 6. UI

### 6.1 Placement

The lab's `reports` view becomes `ledger`; the tab reads **Campaigns**. Old
`view=reports` bookmarks fall through to the default view, as the lab already
treats unknown values. The Reports table, its raw-ID column, and its copy are
deleted, not hidden. The per-kind Refresh button and the
"account timezone · range · as of" caption move to the ledger header.

### 6.2 Filter bar

Date range from the lab header in account-timezone mode (as Reports used). Kind
select, channel select, debounced search. All state lives in the URL through
the lab's state hook, with `source=<objectId>` added as the sheet selection,
following how `order` already selects the order sheet.

### 6.3 Table

New folder `src/components/blocks/attribution/klaviyo/ledger/`, mirroring the
Meta ledger's conventions: 13px text, 29px rows, monospace tabular numerics,
fixed-width metric columns, a `CMP` / `FLW` / `EMAIL` / `SMS` chip instead of
indentation, a chevron that lazily mounts child rows and unmounts on collapse,
and a skeleton row of the exact height.

Columns, in order:

| Column | Source |
| --- | --- |
| Name (with chip) | dimension |
| Sent | `sent_at` for campaigns, "ongoing" for flows |
| Recipients | Klaviyo |
| Delivered | computed rate |
| Open | computed rate |
| Click | computed rate |
| Orders | ours |
| We confirm | ours, refund-net |
| Klaviyo says | Klaviyo conversion value |
| Unsub | Klaviyo unsubscribes |

Sorting is client-side per sibling group with nulls last, default **We confirm
descending**. The Meta ledger's number formatters are imported, not copied;
the one email-specific formatter (percent, one decimal) lives in the new
folder. Clicking a row opens its sheet; the chevron only expands.

### 6.4 Sheet

A right-side sheet at one third of the viewport width, minimum 380px,
scrollable, using the same primitive as the order-detail sheet. The seven
blocks of §4.3 in order. The funnel is five equal cells; orders by day is plain
div bars like list health's daily strip, no chart library. "View all N orders"
switches the lab to the Orders view with the source filter set and the sheet
closed. In the Orders view, an active source filter shows as a dismissible chip
in the filter bar.

### 6.5 States

- No current generation for this range: one row saying "No report for this
  range yet" with the Refresh button beside it; our numbers still render for
  rows that have them.
- Fact present but a Klaviyo value missing: em dash, never zero.
- Refresh running: the header's existing spinner state.
- Query error: the lab's retry row.

## 7. Error handling

- Unknown report statistics are dropped and recorded, as today.
- A rate with a null or zero denominator is null.
- A campaign with a send time but no fact still gets a row.
- A fact with no matching marketing object is skipped and counted in the
  generation's warnings, never rendered as an unnamed row.
- The message-grouping fallback (§3.3) is the only new failure mode and
  degrades to "no expand chevron".

## 8. Testing

**Unit**

- Report normalization of the four new statistics and the two message kinds.
- Request fingerprints: change for message kinds, byte-identical for parent
  kinds.
- Dimension normalization: `send_time`, the `scheduled_at` fallback, subject
  extraction, and the checksum including both.
- Rate math, including every null-denominator case.

**Payload shape**

- Exact-shape assertion on the report request body: `group_by` present only on
  message kinds, absent on parent kinds, in the mutation style the pilot uses
  for payloads.

**Integration**

- The campaign row rule (sent-in-window, all orders regardless of order date)
  against the flow row rule (interaction-in-window).
- Refund-net revenue.
- A row with no fact.
- Child rows joined by message id.
- Detail day offsets and the 14-day cap.
- Products scoped to one object.
- The shared primary-claim fragment producing the same per-source totals as
  the attribution panel.

**Router**

- Admin gate on all three queries.
- The orders source filter.

**Component**

- Table chips, columns, per-group sort with nulls last, lazy child mount.
- The sheet's seven blocks.
- Every empty and error state.

## 9. Rollout

After merge: a manual Refresh in the lab fills the first ledger; the next
dimension refresh writes send times and subjects into existing campaigns; from
then on the nightly run keeps both current. The migration is applied by hand
in prod before either.

## 10. Next: the full lab redesign

Once this ships, the next brainstorm is the full Klaviyo Lab redesign, with
this ledger as its anchor:

- The ledger becomes the lab's default view.
- Probe and Unmatched move into a "diagnostics" group; Orders and List health
  sit beside the ledger.
- Charts are added around the ledger's data (revenue over time by source,
  funnel trends, list health alongside campaign sends) rather than designed
  from scratch.
