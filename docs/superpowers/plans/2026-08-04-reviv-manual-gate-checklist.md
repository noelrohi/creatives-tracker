# Reviv Manual Gate — Plan 2 Stop/Go Checklist

> Task 13 Step 4 of `2026-07-31-klaviyo-02-source-ingestion.md`. A human runs
> this against the live Reviv Klaviyo account and decides stop/go. Plan 3 may
> begin only after every box is checked.

## A. Prerequisites

### Credential staging (2026-08-07 status)

Real Reviv credentials are staged in `.env` under a `_PROD` suffix
(`KLAVIYO_PRIVATE_API_KEY_PROD`, `KLAVIYO_REVIV_ACCOUNT_ID_PROD`,
`KLAVIYO_REVIV_SHOP_DOMAIN_PROD`, `KLAVIYO_REVIV_ALLOWED_URL_HOSTS_PROD`).
The app reads only the unsuffixed names, so the sandbox stays active until
the suffixes are swapped. Verified 2026-08-07 (status codes only, no
values logged): key authenticates against the real, non-test Reviv
account; the returned account ID matches `_PROD`; account timezone
Asia/Bangkok; `Profiles: Read`, `Events`, `Metrics`, `Campaigns` all
readable; 69 metrics visible including native Shopify `Placed Order` and
`Ordered Product`.

Fix before swapping:

- [ ] `KLAVIYO_REVIV_ALLOWED_URL_HOSTS_PROD` second entry is an email
      address — remove it; entries must be bare hostnames or credential
      resolution throws at startup
- [ ] `KLAVIYO_REVIV_SHOP_DOMAIN_PROD` currently holds the custom
      storefront domain. It must be Reviv's `*.myshopify.com` **admin**
      domain — the same value the Shopify store row is ingested under —
      or the connection binding will not match the store. Keep the custom
      storefront domain as an `ALLOWED_URL_HOSTS` entry instead.

To run the gate: rename the four `_PROD` vars to the unsuffixed names
(stash the sandbox values under `_SANDBOX`), restart **both** `bun dev`
and `npm run trigger:dev`, then proceed below.

- [x] Klaviyo credentials received — read-only scopes: `Accounts: Read`,
      `Metrics: Read`, `Events: Read`, `Profiles: Read` (probe email
      fieldset 403s without it), plus `Campaigns: Read` / `Flows: Read`
      for Plan 4 dimensions
- [ ] Env vars set wherever the app **and** the Trigger worker run:
  - [ ] `KLAVIYO_PRIVATE_API_KEY`
  - [ ] `KLAVIYO_REVIV_ACCOUNT_ID`
  - [ ] `KLAVIYO_REVIV_SHOP_DOMAIN`
  - [ ] `KLAVIYO_REVIV_ALLOWED_URL_HOSTS` (comma-separated bare hostnames —
        no schemes, paths, ports, or wildcards)
  - [ ] Existing `IDENTITY_HMAC_*` and `IDENTITY_ERASURE_HMAC_*` secrets present
- [ ] Migrations applied: `npm run db:migrate` (0053 + 0054 in `_journal`)
- [ ] **Plan 1 Shopify evidence backfill completed** for the Reviv store
      (`shopify-evidence-start` mode `initial_90d`, run status success).
      The probe samples only evidence-complete orders; without
      `shopify_order_line` rows it fails with
      "requires at least 20 evidence-complete Shopify orders".
- [ ] Trigger.dev worker running: `npm run trigger:dev` (or deployed) and the
      three tasks registered: `klaviyo-discovery`, `klaviyo-probe`,
      `klaviyo-order-core-batch`
- [ ] Signed in to the app as an **owner or admin** of the org that owns the
      Reviv store (no UI until Plan 5 — calls go through browser devtools)

### Console helpers (paste in devtools on the app origin)

```js
const trpc = async (proc, input) => {
  const r = await fetch(`/api/trpc/${proc}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ 0: { json: input ?? null } }),
  });
  return (await r.json())[0];
};
const trpcGet = async (proc, input) => {
  const q = input
    ? `&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`
    : "";
  const r = await fetch(`/api/trpc/${proc}?batch=1${q}`);
  return (await r.json())[0];
};
```

> **Sandbox note (dev-store dry-runs only):** Shopify blocks PII (customer
> emails/names/phones) via API on development stores and Basic plans, so
> `source_identity_hmac` stays empty and the evidence run reports
> `identity_capability: unavailable`. This is expected degradation, not a
> failure: the probe's deterministic OrderId overlap still works and drives
> `bindingOverlapCount`. Email-diagnostic overlap can only be exercised on
> the real store (Shopify plan or higher).

## B. Discovery

- [ ] `await trpc("klaviyo.startDiscovery")` returns `{ runId, syncRunId }`
- [ ] Trigger run completes without retries exhausting
- [ ] `await trpcGet("klaviyo.health")` shows `connection.status: "pending"`
      with `accountName` populated
- [ ] `klaviyo.syncRuns` shows the discovery run `success`
- [ ] Sanity: the persisted account equals `KLAVIYO_REVIV_ACCOUNT_ID`
      (a mismatch fails the run with **no** rows written — if discovery
      failed, check the env binding before anything else)
- [ ] Exactly one enabled metric per kind:

```sql
SELECT canonical_kind, external_metric_id FROM klaviyo_metric
 WHERE ingestion_enabled = 1 ORDER BY canonical_kind;
-- expect exactly: ordered_product, placed_order (one row each)
```

## C. Probe

- [ ] `await trpc("klaviyo.runProbe", { sampleSize: 30 })` (any 20–50);
      Trigger run completes
- [ ] Task payload contained only `syncRunId` (visible in the Trigger.dev run)
- [ ] `await trpcGet("klaviyo.probe")` returns the pending report

### Report review (human judgment — the actual gate)

- [ ] `sampledShopifyOrders` between 20 and 50
- [ ] `bindingOverlapCount > 0` (real Reviv order overlap)
- [ ] `redactionVerified: true`
- [ ] Candidate alias set unambiguous, every `observedMalformed = 0`
- [ ] `collisionSummary` inspected; note which properties have collisions
- [ ] No leakage in persisted evidence:

```sql
-- must return 0
SELECT count(*) FROM klaviyo_probe_report
 WHERE (key_type_shapes::text || identifier_coverage::text ||
        collision_summary::text || unmatched_examples::text)
       ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}';
```

- [ ] Eyeball `unmatched_examples`: no URL queries/fragments, no
      `/profiles/<id>` or `/customer/<id>` path IDs; benign product paths
      (e.g. `/products/summer-dress`) remain readable

## D. Review decisions

- [ ] If all of section C holds:
      `await trpc("klaviyo.approveProbe", { reportId, reviewNote: "..." })`
      — else `rejectProbe` and stop here (record why)
- [ ] After approval: `klaviyo.health` shows `status: "ready"`; the report's
      aliases are `approved`:

```sql
SELECT canonical_field, source_property, state FROM klaviyo_event_alias
 WHERE state = 'approved' ORDER BY canonical_field;
```

- [ ] For each candidate join rule with `observedCollisions = 0` and
      populated observations:
      `await trpc("klaviyo.approveJoinRule", { ruleId, reviewNote: "..." })`
- [ ] `rejectJoinRule` for everything else (roadmap gate: **zero collisions
      on any approved rule** — the server enforces this too)

## E. Order-core source backfill

- [ ] `await trpc("klaviyo.startOrderCoreSync", { dateFrom, dateTo })` with
      the inclusive 90-store-day range (`dateFrom` = today − 89 in the
      store's IANA timezone, `dateTo` = today)
- [ ] Batches self-chain (5 pages each); poll `klaviyo.syncRuns` until the
      events run is `success`
- [ ] `klaviyo.health` shows `lastEventSyncedAt` set
- [ ] Request parameters and checkpoint carried the direct order-core
      contract (`sourceMode: "order_core"`,
      `metricKinds: ["placed_order","ordered_product"]`)

## F. Negative and replay checks

- [ ] A `dateFrom` older than 90 store-days is rejected **before** any task
      fires (error mentions the 90-store-day boundary / approved floor)
- [ ] Re-running the same window returns `resumed: true` and creates no
      duplicate provider rows:

```sql
-- must return 0 rows
SELECT external_event_id, count(*) FROM klaviyo_event
 GROUP BY 1 HAVING count(*) > 1;
```

- [ ] Events persisted with internal metric row IDs only:

```sql
-- must return 0
SELECT count(*) FROM klaviyo_event e
 LEFT JOIN klaviyo_metric m ON m.id = e.metric_id
 WHERE m.id IS NULL;
```

- [ ] No plaintext email in stored events:

```sql
-- must return 0
SELECT count(*) FROM klaviyo_event
 WHERE redacted_properties::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}';
```

## G. Verdict

- [ ] All sections pass → **GO**: record the measured overlap/coverage rates
      below and start Plan 3 (`2026-07-31-klaviyo-03-advisory-matching.md`)
- [ ] Any section fails → **STOP**: record what failed and why; fix or amend
      the design before proceeding

| Measured | Sandbox dry-run (framesignal) | Reviv |
| --- | --- | --- |
| Sampled Shopify orders | 30 | |
| Binding overlap count | 25 (25/25 events matched) | |
| Identifier coverage (top property) | `$event_id`: 25 | |
| Collisions on approved rules | 0 | 0 (required) |
| Events ingested (90d) | 135 placed_order; 0 ordered_product (Klaviyo emitted none) | |
| Replay idempotency | 135 read / 0 inserted / 0 updated | |
| Decision / date / reviewer | sandbox PASS / 2026-08-05 / owner dry-run | |

Sandbox limitations (retest on Reviv): email-diagnostic overlap (dev-store
PII block), Ordered Product product evidence (no OP events emitted).
