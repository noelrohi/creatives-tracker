# Google Ads Aggregate Pilot — Design

**Status:** Approved for specification

**Approved:** 2026-08-13

**Pilot tenant:** Reviv

**Chosen approach:** Klaviyo-mirror pilot (connection + claims + probe discipline), aggregate depth first

## 1. Decision summary

| Decision | Approved direction |
| --- | --- |
| Evidence depth | Probe-then-decide: aggregate "Google says" facts now; a gclid coverage probe over stored Shopify journeys decides whether order-level matching gets a later spec |
| Credentials | Start from zero: Google Cloud project, OAuth client, test manager + test client account, unapproved developer token; Basic-access application submitted in parallel |
| Pilot tenant | Reviv only, environment-provided credentials bound to one explicit connection |
| App scope | Attribution lens only — no Google entities in the campaign manager ledger |
| Spec slicing | This spec covers the pilot; the `/attribution` panel (and any order-level evidence) gets its own spec after the probe reports |
| Architecture | Dedicated `google_ads_*` schema mirroring the Klaviyo pilot's boundaries; no generic multi-provider framework yet |
| Effect on attribution | Advisory only; never changes the production bucket, Net sales, or journey fields |

The pilot answers: **what does Google Ads claim (spend, conversions, conversion value), what does our Shopify google-bucket data show for the same period, and is order-level linkage via click IDs feasible at all for this merchant?**

This is the second instance of the repeatable "external source vs our evidence" reading established by the Klaviyo pilot and the email revenue panel.

## 2. Context and repository ground truth

- The attribution rules already classify `utm_source=google`/`adwords` (plus the Google Shopping feed medium) into a `google` bucket; the UI labels it "Google ads". There is no Google Ads API client, connection, schema, or sync anywhere in the repo.
- `shopify_order` stores the raw `customerJourney` JSONB (journey moments with landing/referrer URLs). Google auto-tagging appends `gclid` (and `wbraid`/`gbraid` for iOS/web-to-app) to landing URLs, so click-ID evidence may already exist in stored data. The Klaviyo design already treats these raw URLs as sensitive: they are never exposed to the UI unredacted.
- Meta precedent: `trigger/meta-sync.ts` pulls ad performance aggregates and orders carry an order-level Meta verification path (`metaVerified`, `metaCampaignId/AdSetId/AdId`, `metaAdMatchMethod`). Google Ads has no equivalent of Meta's per-order verification inputs; its API is aggregate-only, which is why click IDs are the only order-level hook.
- The Klaviyo pilot established the load-bearing invariants this pilot inherits: Shopify is revenue truth, one production bucket per order, bucket totals reconcile to Net sales, provider claims live in provider tables.
- Trigger.dev tasks have a 600-second limit; long operations are a supervisor plus resumable bounded children (the Klaviyo source sync is the hardened template).

## 3. Goals

1. Stand up Google Ads API access from zero: cloud project, OAuth client, test manager/client accounts, developer token; apply for Basic access in parallel.
2. Build a credentialed, rate-limit-disciplined GAQL client behind a provider boundary that can later support per-org OAuth.
3. Ingest campaign-level daily facts (spend, impressions, clicks, conversions, conversion value) for a 90-day window with nightly incremental refresh and conversion-restatement handling.
4. Measure, with a durable probe report, how many stored Reviv orders carry Google click IDs (`gclid`/`wbraid`/`gbraid`) in their customer journeys, split by production bucket.
5. Expose an admin-only lab page showing connection health, sync runs, the probe report, and a "Google says" campaign table beside our google-bucket revenue reference total.
6. Keep every Google number physically and semantically separate from Shopify truth.

## 4. Non-goals

- Order-level matching or any advisory match graph (the probe only measures feasibility; a later spec decides).
- The `/attribution` revenue panel (Phase 3, separate spec after probe results).
- Google campaigns/ad groups/ads in the campaign manager ledger, or any creative/keyword/ad-group depth.
- Changing bucket classification rules or any production attribution behavior.
- Multi-merchant support, self-service OAuth UI, or credential storage in the database.
- Persisting raw click IDs, raw landing URLs, or raw Google error payloads.
- Treating Google conversion value as Shopify revenue, or reconciling the two numbers as if they shared semantics.

### 4.1 Rejected approaches

- **Meta-style report sync** (no connection/probe formalism) — fastest to data, but loses the claims/truth discipline, produces no probe artifact to gate the order-level question, and makes later OAuth and evidence work a retrofit.
- **Generic provider framework first** — premature abstraction; two providers do not prove the interface. Revisit when a third source lands.

## 5. Truth model and invariants

Two concepts stay physically separate:

1. **Shopify truth** — orders, Net sales, production buckets (unchanged, untouched).
2. **Google Ads claims** — aggregate campaign facts and account metadata, always labeled as Google observations.

Invariants:

- Every Google record is scoped by organization, Shopify store, and Google Ads connection.
- Google campaign facts have no foreign key to orders and never participate in bucket assignment.
- Claims never overwrite `netSales`, `bucket`, `bucketRuleVersion`, journey, or Meta verification fields.
- One Google Ads customer ID maps to at most one active connection.
- The probe reads journeys server-side and publishes only aggregates and redacted shape fingerprints; raw click IDs and URLs never leave the extraction function.
- Every fact and run records the pinned API version that produced it.

## 6. Phases

### Phase 0 — gclid probe (no Google credentials required)

Runs immediately and in parallel with everything else, since it consumes only stored Shopify data.

- Trigger.dev task `trigger/gclid-probe.ts`, bootstrapped like the Shopify evidence sync: the Reviv store resolves from the allowlisted environment domain server-side; no browser-supplied store ID is ever accepted.
- Scans the trailing 90 days of `shopify_order.customerJourney` for that store. For each order, journey moments' landing/referrer URLs are parsed in memory and checked for `gclid`, `wbraid`, and `gbraid` query parameters.
- Tallies published to the durable report:
  - Orders scanned; orders with any click ID; per-click-ID-kind counts.
  - Coverage split by production bucket. The diagnostic cells: google-bucket orders **without** a click ID and non-google-bucket orders **with** one — both are misclassification/coverage signals.
  - Orders whose stored journey is missing or not ready (`customerJourney` null or
    `lastVisit` absent), and orders carrying more than one click-ID kind. The stored
    journey is Shopify's `customerJourneySummary` (last visit only — no moments/first
    visit), so click-ID presence is measured on the last visit's landing/referrer URLs.
  - Redacted parameter-shape fingerprints (key presence and coarse value shape only).
- The report gates Phase 3's order-level question: high coverage → a click-ID evidence graph earns a spec; low coverage → the panel stays aggregate-only, with the report stating so in numbers.

### Phase 1 — sandbox

- Create the Google Cloud project and OAuth 2.0 client; run the one-time consent flow to mint a refresh token.
- Create a **test** manager account, obtain its developer token (works against test accounts without approval), create a test client account, and seed campaigns in it so GAQL responses are structurally real.
- Submit the **Basic access** application for the developer token in parallel — Google's review is the long pole for Phase 2.
- Build and validate the client, schema, discovery, and facts sync end-to-end against the test account. Test accounts serve no ads, so this proves plumbing (auth, GAQL, pagination, quota handling, persistence, checkpoints), not data richness.

### Phase 2 — real credentials

- Swap the environment credential set to the approved developer token and Reviv's real customer ID; create the explicit Reviv connection row via discovery.
- Run the 90-day campaign-fact backfill, then enable the nightly incremental schedule.

### Phase 3 — separate spec later

- The `/attribution` "Google Ads revenue" panel mirroring the email revenue panel.
- Order-level click-ID evidence, only if the Phase 0 report supports it.

## 7. Architecture

```text
Env credential set (server/worker only)
    -> GoogleAdsCredentialProvider
    -> Google Ads REST client (GAQL)
    -> discovery (customer resource validation)
    -> campaign daily facts (claims)
    -> tRPC googleAds router (admin-only)
    -> /attribution/google-ads

Stored shopify_order.customerJourney (existing, unchanged)
    -> gclid probe task (in-memory URL parsing)
    -> gclid_probe_report (aggregates + redacted fingerprints only)
```

### 7.1 Credential provider

`GoogleAdsCredentialProvider` resolves credentials for a connection; callers never read `process.env`. The pilot implementation reads only the allowlisted server/worker-only set:

- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_OAUTH_CLIENT_ID`
- `GOOGLE_ADS_OAUTH_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (manager account)
- `GOOGLE_ADS_CUSTOMER_ID` (client ad account)

All are added to `.env.example` with comments prohibiting client-side exposure. A later per-org OAuth provider implements the same interface. The connection row stores an auth mode (`environment`) and a credential-reference enum whose only pilot value names this env set; arbitrary env-var names are forbidden.

### 7.2 REST client

Hand-rolled (`src/lib/google-ads/client.ts`), mirroring the Klaviyo client choice — no heavyweight SDK dependency.

- OAuth access-token refresh with in-memory caching and single-flight refresh.
- `customers/{id}/googleAds:search` GAQL endpoint with page-token pagination.
- API version pinned as a named constant and recorded on every row and run.
- Bounded exponential backoff with jitter for retryable failures (quota/rate errors, 5xx, timeouts), honoring `Retry-After` where present; non-retryable auth/request errors fail fast.
- Sanitized errors: Google error payloads can echo request contents and account details — raw payloads are never logged or persisted; a stable error code plus safe message is.

## 8. Data model

New schema file `src/schema/google-ads.ts`. Primary keys are `crypto.randomUUID()` in `text` columns per repo convention; repo timestamp conventions apply. Migration generated with `bun run db:generate`, applied with `bun run db:migrate`, validated with `node scripts/check-migrations.mjs`.

### `google_ads_connection`

- `organization_id` + `shopify_store_id`, composite FK to the store, unique together.
- Google customer ID (client account, digits-only canonical form), descriptive account name, currency code, account timezone.
- Status: `pending` / `ready` / `degraded` / `disabled`.
- Auth mode (`environment`) and credential-reference enum (single allowlisted pilot value).
- Last discovery and last facts-sync timestamps.
- Google customer ID unique across active connections.
- No secret or token stored, ever.

### `google_ads_sync_run`

- Connection, operation kind (`discovery` / `facts`), requested half-open UTC window.
- Checkpoint: last committed account-timezone day.
- Status, read/inserted/updated/failure counts, sanitized error code/message, started/finished timestamps, pinned API version.
- Prior facts remain available when a later run fails.

### `google_ads_campaign_fact`

- Connection, Google campaign ID, campaign name, campaign status, advertising channel type (name/status snapshotted at fetch time so renames do not orphan history).
- `segments.date` day in **account timezone** (Google reporting semantics; converted only for display).
- Spend in micros, impressions, clicks, conversions (numeric — Google reports fractional conversions), conversions value, currency code.
- API version and fetch timestamp.
- Unique on (connection, campaign ID, date); re-fetch upserts in place, which is what makes conversion restatement convergent.
- No foreign key to orders; aggregate claims only.

### `gclid_probe_report`

- Organization + Shopify store scope; connection reference nullable (Phase 0 predates any connection).
- Sampled half-open window; orders scanned.
- Counts: orders with any click ID; per-kind (`gclid`/`wbraid`/`gbraid`) counts; per-production-bucket coverage matrix; journey-missing counts; multi-kind orders.
- Redacted parameter-shape fingerprints (key presence + coarse shape; no values).
- Status (`pending` / `completed` / `failed`), immutable checksum, created timestamp.

All tables carry explicit cascade behavior from organization/store/connection parents, mirroring the tenant-scoped FK discipline the Klaviyo migration established.

## 9. Synchronization design

- **Discovery** runs first: query the `customer` resource for the configured customer ID; verify it is not a manager account; capture currency, timezone, and descriptive name into the connection row. A mismatch (wrong ID, manager account, changed currency) fails closed and marks the connection `degraded` — no facts sync under wrong assumptions.
- **Facts sync** is a supervisor plus bounded children under the 600-second task limit, following the hardened Klaviyo sync shape: children process bounded day-range chunks of a GAQL query grouped by `campaign.id, segments.date`; each child commits its rows and its checkpoint in one transaction; a retry replays a chunk without duplicates via the unique-key upsert; an interrupted run resumes at its checkpoint.
- **Initial backfill**: trailing 90 days of account-timezone days.
- **Nightly incremental** (enabled only after backfill succeeds, like Klaviyo's schedule gate): fetch yesterday plus a trailing **30-day** re-fetch window, because Google restates conversions for up to the conversion window and 7 days (Klaviyo's choice) is too short for paid search lag.
- Time windows are half-open; account-timezone day boundaries are computed once, centrally, and tested.
- Rate limits: bounded concurrency, backoff on quota errors, and no parallel children hammering the same customer ID.

## 10. Pilot API and lab page

### 10.1 Route and authorization

New page at `/attribution/google-ads`, reachable via a privileged link in the attribution header beside Klaviyo Lab. Owners/admins only. The existing attribution ledger and `/attribution/klaviyo` are unchanged.

New tRPC router `googleAds` (`src/lib/trpc/routers/google-ads.ts`, composed in `_app.ts`), all procedures on `orgAdminProcedure`, organization scope derived from the session (never caller-supplied):

- Connection health and recent sync runs.
- Latest gclid probe report.
- Campaign facts for a date range, with the same range's google-bucket Shopify revenue as a reference total.
- Mutations: run probe, run discovery, trigger facts sync (manual; the nightly schedule is code-side and gated on backfill success).

Background workers call internal service entry points, not session tRPC.

### 10.2 Page content (deliberately minimal)

1. **Header** — connection status, account name/ID, currency/timezone, last discovery, last facts sync, manual sync controls.
2. **Probe panel** — the Phase 0 report front and center: coverage counts, the per-bucket matrix, and the two diagnostic cells (google-bucket without click ID; non-google-bucket with click ID).
3. **"Google says" table** — per campaign over the selected range: spend, impressions, clicks, conversions, conversion value; footer with totals. Beside it, a captioned reference: "our google-bucket Shopify Net sales for the same range". The caption states these are different measurement systems and the numbers are not expected to reconcile — the real comparison surface is Phase 3's panel.

The page obeys the app's date-range and skeleton conventions.

## 11. Privacy and security

- No user-level data is requested from Google Ads at any point in this pilot — campaign aggregates only. The minimal OAuth scope (`https://www.googleapis.com/auth/adwords`) is broad by Google's design, but the client only issues the discovery and campaign-fact queries.
- Click IDs are pseudonymous identifiers. The probe parses them in memory and persists only counts and redacted shape fingerprints; no raw click ID, raw URL, or per-order click-ID mapping is written in this pilot. If Phase 3 approves order-level evidence, persistence of click IDs gets designed there with its own retention/erasure treatment.
- Raw `customerJourney` JSON remains unexposed to the UI, consistent with the Klaviyo inspector rule.
- All credentials are server/worker-only environment values behind the provider boundary; no secret in the database, logs, or client bundle.
- Google error payloads are sanitized before logging or persistence.
- Refresh-token compromise surface is limited to one test account during Phase 1 and one merchant account in Phase 2; rotation is a manual env swap during the pilot.

## 12. Error handling

- Transient provider failures (quota, 5xx, timeouts, transport) are retryable with backoff and never become terminal states.
- Deterministic rejections (invalid developer token, revoked refresh token, permission denied, unknown customer ID) fail closed: the run fails with a sanitized reason and the connection degrades; nothing is deleted.
- A failed or partial run never deletes or overwrites previously committed facts; missing rows in a response never cause deletion.
- The probe records a `failed` report row with a sanitized reason rather than a half-tallied `completed` one; per-order URL parsing errors are counted, not fatal.

## 13. Testing

- **Unit**: GAQL query builders; response normalizers (micros → numeric, fractional conversions, account-timezone day handling); the click-ID URL extractor against fixture journey shapes (malformed URLs, missing moments, non-string values, duplicate params); credential provider fail-closed behavior on missing/blank env values.
- **Integration** (Vitest, mirroring the Klaviyo suites): schema contract; fact upsert/restatement semantics; sync-run checkpoint commit and resume; probe aggregation against seeded journey fixtures including the per-bucket matrix.
- **Sandbox contract**: recorded test-account responses exercised against the client so API-version drift surfaces in CI rather than production.
- **Migration**: `node scripts/check-migrations.mjs` against the generated artifact.

## 14. Success criteria

1. Sandbox: a full discovery + facts sync completes against the seeded test account, with checkpointed resume demonstrated.
2. Probe: a completed `gclid_probe_report` exists for Reviv's trailing 90 days with the per-bucket coverage matrix populated.
3. Real data (post-approval): 90-day backfill completes; nightly incremental converges restated conversions (same fact row updates in place).
4. Lab page renders connection health, probe report, and the "Google says" table for admins, and nothing for members.
5. Zero writes to any Shopify truth column; `bun run test` and lint pass.
