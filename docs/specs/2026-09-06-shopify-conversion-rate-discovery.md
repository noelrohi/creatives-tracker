# Shopify store conversion rate — decision record (#261)

Date: 2026-09-06. Discovery only; no authenticated API probe, credential inspection/change, connector provisioning or endpoint implementation.

## Decision

**A documented authoritative source exists: ShopifyQL `sessions` through Admin GraphQL `shopifyqlQuery`. Existing installation access is unverified, so Adsolute must currently treat this metric as unsupported, not return estimated sessions.** Authorize an aggregate-only access/semantic validation step before deciding on ingestion. Do not infer sessions from order customer journeys or substitute Meta conversions.

This is not a claim that Shopify lacks a sessions API. Current 2026-07 documentation explicitly exposes `sessions`, `sessions_that_completed_checkout` and `conversion_rate` [1,2].

## Metric and reporting population

Proposed metric: **online-store session conversion rate**, not conversion across every sales channel.

- Numerator: `sessions_that_completed_checkout` — online-store visits in which a purchase completed.
- Denominator: `sessions` — online-store visits, not unique visitors. `conversion_rate` is their ratio; Shopify's `PERCENT` type uses 0.25 for 25% [1].
- Order count / sessions is not equivalent: an order ledger is not a count of converted sessions, may include other sales channels and has a different event-date basis. Unique visitors can also have multiple sessions [1].
- Proposed initial population: all sessions recorded in the `sessions` dataset, all referrers and storefront clients, with **no additional bot filter**. This makes the population reproducible without assuming the store's default report filters. Do not label it “human-only” or “all physical visitors.” Shopify exposes `human_or_bot_session` and `session_api_client`; matching a particular admin report requires explicitly matching those filters. A human-only variant would be a separately versioned definition [1].
- Date basis: `day` is the day the visit **started**, not order creation day, payment date or fulfillment date [1]. Both `SINCE` and `UNTIL` are inclusive [3]. A session that starts before midnight and later converts belongs to the source's session-start cohort, not necessarily the order-day cohort.
- Intended calendar: store IANA timezone from the shop record. The inspected session-day reference does not explicitly establish the timezone conversion/cross-midnight contract. Validate a store-midnight and DST comparison against the admin report before advertising store-calendar equivalence; no UTC or browser-time assumption is acceptable.
- Missing/denied/parse-error/no-table response: numerator, denominator and rate remain null with a reason. A successful authoritative zero denominator also yields a null rate (`zero_denominator`), not 0%. A positive known denominator and zero converted sessions yields a genuine 0%.

Synthetic query for the later validation step (not executed):

```graphql
query {
  shopifyqlQuery(query: "FROM sessions SHOW sessions, sessions_that_completed_checkout, conversion_rate TIMESERIES day SINCE 2026-08-01 UNTIL 2026-08-07 ORDER BY day ASC LIMIT 100") {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}
```

No customer/session identifiers or identifying dimensions are selected.

## Access and current code

`src/lib/shopify-admin.ts` pins Admin API `2026-07`, uses an environment-provided shop domain/token and fetches order-ledger/journey data. `shopify-ingest.ts` derives order days in store timezone; `src/schema/shopify.ts` has no sessions denominator table; `attribution.ts` reports ledger revenue/orders. None proves the token can query ShopifyQL.

The current API guide requires API version **2025-10 or newer**, **`read_reports`**, and **Level 2 protected customer data access**, even though this proposed query only requests aggregates [2,4]. The pinned API version is compatible. Granted scopes, app distribution type, protected-data eligibility and store plan were not checked; existing order access does not prove reporting access.

The inspected current ShopifyQL API prerequisites do not state a Plus-only restriction; do not repeat older Plus-only assumptions as current fact. Protected-data rules distinguish public apps (review), custom apps (Level 2 available), and admin-created custom apps (Level 2 varies by plan) [5]. The actual app category/plan remains an access gate, not assumed approval.

## Freshness, revisions and limits

- Shopify documents the current period as incomplete and instructs clients to label fetch time. Its caching guide states completed periods do not change [6]. That broad guidance is not a sessions-specific latency SLA or a verified guarantee about bot reclassification/corrections. No precise session ingestion delay or retention guarantee was established in the inspected docs. Record fetch time and reporting state; do not promise finality or invent retained-through dates.
- `shopifyqlQuery` returns tabular rows, not a GraphQL cursor connection. ShopifyQL supports `LIMIT ... OFFSET ...` with deterministic `ORDER BY` [7]. Prefer bounded date chunks and expected-day checks over paging a changing high-cardinality report. Missing rows must not silently become known zeros.
- Check both GraphQL `errors` and `parseErrors`; HTTP 200 can still mean no usable data. `RESPONSE_TOO_LARGE` requires fewer dimensions/shorter windows, not blind retries [6].
- Two budgets apply: GraphQL query cost and ShopifyQL complexity cost. Read `extensions.shopifyqlCost` (`requestedQueryCost`, `currentlyAvailable`, `maximumAvailable`, `windowResetAt`) as well as standard `extensions.cost`; wait for reset on ShopifyQL throttling [6]. Standard Admin restore rates depend on plan (100/200/1000/2000 points per second) and a query's maximum requested cost is 1000 [8]. Do not assume the example ShopifyQL budget is this store's entitlement.

## Conditional implementation and cost estimate

Only after access, timezone, filter equivalence and available historical coverage are verified:

1. Add a typed ShopifyQL adapter that validates columns/rows/errors and both budgets; run aggregate-only queries.
2. Store daily counts keyed by org, store, session day and definition version, with source API version, query/filter fingerprint, timezone basis, fetch time and coverage/error evidence. Upsert re-fetches; no customer/session-level storage.
3. Add a bounded scheduled refresh and explicitly authorized historical chunks. Example operational policy: refresh the recent seven days hourly (a reconciliation heuristic, not a finality guarantee).
4. Add a read-scoped org/store-isolated query returning definition/source, numerator, denominator, rate, effective inclusive range and freshness/coverage. Aggregate by summed counts, never average daily percentages.

Engineering estimate: **3–5 engineer-days after access approval**, including adapter, migration, refresh job, read contract and tests; access approval time is additional and unknown. Example load: 24 requests/day/store (about 720/month), about 5,040 daily-row upserts/month/store for seven-day hourly refresh, and 365 retained daily rows/year/definition if storing only the latest snapshot. Actual query points, job duration and dollar cost require measurement; no additional paid connector is proposed. Cache identical org/store/query requests. Long-term snapshots and more frequent refresh increase storage/work independently.

Synthetic conditional response: 25 converted sessions / 1,000 sessions = `0.025` (2.5%), with `population: online_store_sessions_no_additional_bot_filter` and explicit session-start dates. Current honest unsupported representation is conceptual only: `{ "state": "unsupported", "reason": "shopifyql_access_and_calendar_not_verified", "numerator": null, "denominator": null, "rate": null }`.

**Next decision:** authorize a read-only, aggregate-only validation using existing credentials and confirm whether the installation already has the required access. If not, decide whether to pursue reporting/protected-data access or leave the metric unsupported. This discovery does not authorize either action automatically.

## Primary sources inspected

1. [ShopifyQL sessions schema (2026-07)](https://shopify.dev/docs/api/shopifyql/latest/schemas/sessions_and_behavior/sessions): numerator, denominator, percentage scale, session-start dimensions and filters.
2. [Admin GraphQL shopifyqlQuery (2026-07)](https://shopify.dev/docs/api/admin-graphql/latest/queries/shopifyqlQuery): query contract and access requirements.
3. [ShopifyQL SINCE / UNTIL / DURING](https://shopify.dev/docs/api/shopifyql/latest/syntax/since-until-during): inclusive date selection.
4. [ShopifyQL GraphQL API guide](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api): minimum version and access prerequisites.
5. [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data): Level 2 and app-type/plan distinctions.
6. [ShopifyQL errors, budgets and freshness](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/errors-limits-and-performance): dual budgets, errors and caching guidance.
7. [ShopifyQL LIMIT](https://shopify.dev/docs/api/shopifyql/latest/syntax/limit): limit/offset and deterministic ordering.
8. [Shopify API limits](https://shopify.dev/docs/api/usage/limits): standard query cost and plan-specific rates.

Public web search was unavailable and the Help Center behavior-report page returned HTTP 403. Findings above rely on successfully retrieved first-party developer references; no inaccessible Help Center claim is treated as verified.
