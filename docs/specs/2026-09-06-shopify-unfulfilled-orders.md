# Unfulfilled Shopify order counts (#260)

## Read contract

`GET /api/openapi/attribution/unfulfilledOrders?dateFrom=2026-03-08&dateTo=2026-03-08`

Use an organization API key with `read` scope. Organization identity comes from authentication; the connected store is resolved server-side. The response is aggregate-only, with no customer/order identifiers or fulfillment writes.

The inclusive date range selects Shopify **creation days in store timezone**, not fulfillment date or local insertion time. Test orders are excluded by the existing ingestion pipeline. Cancellation exclusion is independent of financial/payment status.

`observedUnfulfilledCount` is a **strict source-status count**, not a count of all orders with outstanding work:

| Status | Treatment |
| --- | --- |
| UNFULFILLED, OPEN, RESTOCKED | Included (OPEN/RESTOCKED are legacy statuses replaced by UNFULFILLED) |
| PARTIALLY_FULFILLED | Separate count, excluded from strict unfulfilled |
| FULFILLED | Separate count |
| ON_HOLD, IN_PROGRESS, PENDING_FULFILLMENT, REQUEST_DECLINED, SCHEDULED | Separate workflow counts, excluded from strict unfulfilled |
| Missing, unobserved, unrecognized | Unknown, never assumed unfulfilled or fulfilled |
| Any cancelled order | Excluded from all status counts; counted in `excludedCancelledCount` |

Authoritative definition: [Shopify 2026-07 OrderDisplayFulfillmentStatus](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/OrderDisplayFulfillmentStatus).

`statusBasis=latest_observed_current_status` means a March order fulfilled in April changes a query for March after the update is ingested. This is not status as of March's end. `effectiveWindow` echoes creation-day bounds, and `reporting.shopify.timezone` identifies the store calendar.

## Coverage and freshness

All counts describe the locally observed ledger. `statusCoverage` classifies only those rows:

- `complete_for_observed_orders`: nonempty known population, no unknown status rows.
- `partial`: both known and unknown status rows.
- `unknown`: no known status rows, including an empty ledger.

This does **not** prove all Shopify orders were ingested. `reporting.shopify.coverage` remains independently unknown. The response also includes the oldest/newest non-cancelled status observation time and connector sync evidence. A fresh sync, a successful backfill batch or a zero observed count cannot establish a complete source zero.

Source `displayFulfillmentStatus` is requested in shared normal, bulk and ID-fetch selections. Missing fields never erase known fulfillment evidence; stale Shopify `updatedAt` values cannot overwrite newer status/cancellation evidence. The source update watermark stays monotonic. No status is inferred from `displayFinancialStatus`.

Synthetic response excerpt (other standard fields omitted here only for brevity):

```json
{
  "statusBasis": "latest_observed_current_status",
  "population": "locally_ingested_non_test_orders_by_creation_day",
  "cancellationsExcluded": true,
  "countedStatuses": ["UNFULFILLED", "OPEN", "RESTOCKED"],
  "observedUnfulfilledCount": 3,
  "observedNonCancelledCount": 12,
  "excludedCancelledCount": 1,
  "unknownStatusCount": 2,
  "statusCoverage": {
    "state": "partial",
    "knownCount": 10,
    "unknownCount": 2,
    "oldestObservedAt": "2026-04-01T08:00:00.000Z",
    "newestObservedAt": "2026-04-01T09:00:00.000Z"
  }
}
```

## Migration and explicit backfill

Migration `drizzle/0071_exotic_epoch.sql` adds nullable status and observation columns. Existing rows remain distinguishable as unknown. Apply through the repository migration workflow before deploying code that reads/writes these fields; do not use `db:push`.

No automatic backfill is scheduled. After migration/deployment, an operator may explicitly run Trigger.dev task **`shopify-fulfillment-backfill`** with:

```json
{
  "organizationId": "synthetic-org-id",
  "storeId": "synthetic-store-id",
  "batchSize": 50,
  "maxBatches": 10
}
```

The job verifies org/store identity and the configured shop domain **before credential-backed fetching**. It selects missing observations by deterministic local ID, fetches only those Shopify IDs, and reuses the existing hydration/ingestion path. Each batch reports scanned/fetched/inaccessible counts and its last cursor. Batch size is capped at 100; runs are capped at 100 batches. It shares the existing `shopify-sync` queue and has no cron.

If `hasMore=true`, run again with `afterId=nextCursor`. On failure, retry from the last successful progress cursor (or the original payload; already observed rows are skipped). `nextCursor=null` means this bounded scan reached its end, **not** source completeness. Inaccessible IDs or missing fields remain unknown and do not stall pagination. To revisit them after access is repaired, start a new scan without `afterId`.

Ongoing incremental sync already queries `updated_at` without a creation-date cutoff, so older orders whose status changes are refreshed when accessible. Shopify grants access to only the last 60 days of orders by default; older records require appropriate approved `read_all_orders` access in addition to order access. See [Order access restrictions](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order). This work does not change credentials, request permissions, or assume existing historical grants.

No production migration, deployment or backfill was performed during implementation.
