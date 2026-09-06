# Unfulfilled Shopify order counts (#260)

Status: approved by the user and implemented. Operator documentation: `docs/specs/2026-09-06-shopify-unfulfilled-orders.md`. Migration/backfill have not been run in production.

## Definition

Expose `attribution.unfulfilledOrders` as a read-only org/store-scoped aggregate. Input uses existing validated inclusive `dateFrom`/`dateTo`. Select stored `orderDay`, derived from Shopify `createdAt` in the store timezone; status is the latest observed current status, not reconstructed status at the historical range end. Cancellation exclusion is independent of financial status.

Use Shopify's authoritative aggregate `Order.displayFulfillmentStatus`; do not fetch fulfillment writes, customer identifiers or line-item details for this feature. The [2026-07 enum reference](https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderDisplayFulfillmentStatus), inspected 2026-09-06, defines:

| Source status | Count in unfulfilled | Treatment |
| --- | --- | --- |
| UNFULFILLED | yes | No items fulfilled |
| OPEN | yes | Legacy predecessor of UNFULFILLED |
| RESTOCKED | yes | Legacy status replaced by UNFULFILLED |
| PARTIALLY_FULFILLED | no | Separate partial count; not wholly unfulfilled |
| FULFILLED | no | Separate fulfilled count |
| ON_HOLD, IN_PROGRESS, PENDING_FULFILLMENT, REQUEST_DECLINED, SCHEDULED | no | Separate named counts; do not equate workflow states with wholly unfulfilled |
| missing or unrecognized | no | Separate unknown count; incomplete classification |

This is a **strict status count**, not every order with outstanding fulfillment work. All cancelled orders are excluded from these status counts and reported in a separate cancellation-excluded count. Count distinct Shopify order identities within the scoped store.

Alternative: combine partial/on-hold/in-progress into an “outstanding fulfillment” count. That answers a different question; retain the breakdown so callers can make that decision explicitly, rather than silently broadening unfulfilled.

## Storage and ingestion

Add nullable `fulfillmentStatus` text and `fulfillmentStatusObservedAt` timestamp on `shopify_order`. Null defaults distinguish pre-migration rows. Preserve unrecognized raw statuses for forward compatibility without classifying them as known.

Add `displayFulfillmentStatus` to the shared order GraphQL selection used by normal, bulk and ID refresh paths. Normalize alongside cancellation/creation data. Stamp observation time only when a status was actually returned. A response omitting status must not erase a previously observed status; an older Shopify `updatedAt` must not overwrite newer fulfillment evidence. Apply that rule in the upsert, not only application-side normalization.

Generate through `bun run db:generate`; validate with `node scripts/check-migrations.mjs`. Do not rename snapshots or run production migration/backfill as part of implementation. Keep schema and migration changes together.

## Refresh and coverage

`trigger/shopify-sync.ts` already queries incremental changes by `updated_at` without a creation-date cutoff. Adding the field to shared order selections refreshes changed historical orders, including later fulfillment and cancellation changes, subject to source access. The enum's linked Order reference warns that only 60 days of orders are accessible by default; older access requires approved `read_all_orders` in addition to order access. Existing grants are not assumed or changed.

Backfill existing stored rows with missing observation evidence using bounded ID batches through the existing fetch-by-ID/ingest path, as an explicit operator-triggered job. Include org/store verification before credential use, a bounded batch size, deterministic cursor and run progress. Null/inaccessible source nodes remain unknown; never mark them covered. No automatic production run. New order ingestion and incremental updated-at refresh then maintain status observations. A successful batch is not proof the entire source order ledger was ingested.

Return:

- Existing shared `effectiveWindow` (order creation-day selection), store timezone and `reporting` with Shopify evidence only.
- `statusBasis: latest_observed_current_status`, `cancellationsExcluded: true`, and the exact counted statuses.
- Known strict unfulfilled count, partial/fulfilled/other status breakdown, unknown count, total observed non-cancelled orders and excluded cancellation count. Counts are of locally observed orders, not promised source totals.
- Status coverage over observed rows: known/unknown counts, `complete_for_observed_orders` only if a nonempty observed population has no unknown statuses, otherwise `partial` or `unknown`. Separately retain ingestion coverage `unknown`; complete classification is not complete ingestion.
- Oldest/newest fulfillment observation timestamps. The count remains explicitly an observed count even if zero. No last-sync timestamp can turn an empty or incomplete ledger into a complete source zero.

## API and verification

Add typed output schema and GET OpenAPI metadata using `orgProcedure`/`requireStore`. Never accept organization identity from request input. No returned order/customer identifiers and no mutations in the public summary endpoint.

Tests cover every listed enum, unknown and missing status, cancellations regardless of financial status, distinct identity, exact inclusive boundaries, store midnight, spring/fall DST, old created orders updated later, missing/stale updates that cannot erase newer observations, legacy rows, empty population and partial coverage. Add real PostgreSQL aggregate fixtures and caller/OpenAPI read-key/cross-org tests. Backfill tests cover batching/cursors, inaccessible IDs, org/store mismatch and resumed runs. Provide a synthetic summary example with nonzero unknown status count.

Run targeted Vitest, typecheck, lint and migration validation. Deploy/apply/backfill only under a separate explicit operator action.
