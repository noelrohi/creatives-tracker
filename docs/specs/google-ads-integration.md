# Google Ads Integration Plan

## Context

The dashboard currently only supports Meta Ads. A client asked whether spend/revenue numbers include Google; they do not. This plan adds Google Ads as a second platform while still converging into the shared database tables and the existing `MappedRow` -> `bulkImport` pipeline.

The key constraint is that Google support must match the current pipeline's assumptions:

- performance data must stay daily, not range-aggregated
- imported revenue must remain purchase-only before it is written into `purchaseValue`
- Google identifiers must be stored in a cross-account-safe form
- creative upserts cannot reuse the current name-based canonicalization for Google imports

---

## Phase 1: Test Account Setup & Client Library

**Goal**: Working Google Ads API connection, testable standalone.

### Walkthrough: Google Ads Test Account

1. **Create a Manager Account (MCC)** at https://ads.google.com/home/tools/manager-accounts/
2. **Create a Test Account** inside the MCC (Settings > Sub-account settings > New test account); note the `customer_id` (strip dashes)
3. **Google Cloud Console** (https://console.cloud.google.com):
   - Create a new project (or use an existing one)
   - Enable the **Google Ads API**
   - Create an **OAuth 2.0 Client ID**
   - For Phase 1, choose one flow and configure it correctly:
     - **OAuth Playground flow**: authorize `https://developers.google.com/oauthplayground` as a redirect URI on the OAuth client used to mint the refresh token
     - **App-owned OAuth flow**: implement a real app callback such as `http://localhost:3000/api/auth/callback/google`
   - Do not mix the Playground token flow with an app callback setup in the same checklist
   - Note `client_id` and `client_secret`
4. **Get Developer Token**: in MCC, go to Tools & Settings > API Center
5. **Get Refresh Token**:
   - For Phase 1, the simplest path is OAuth Playground: https://developers.google.com/oauthplayground
   - Scope: `https://www.googleapis.com/auth/adwords`
   - Use your client ID/secret via "Use your own OAuth credentials"
   - This only works if the OAuth client explicitly allows the OAuth Playground redirect URI
   - Authorize and exchange the code for a refresh token
6. **Populate test data**: create at least 1 campaign, 1 ad group, and 1 ad in the test account

### Implementation

1. Install: `bun add google-ads-api`
2. Create `src/lib/google-ads-client.ts`:
   - singleton `GoogleAdsApi` factory
   - `getGoogleAdsCustomer(refreshToken, customerId)` helper
3. Add env vars to `.env`:
   ```
   GOOGLE_ADS_CLIENT_ID=
   GOOGLE_ADS_CLIENT_SECRET=
   GOOGLE_ADS_DEVELOPER_TOKEN=
   GOOGLE_ADS_LOGIN_CUSTOMER_ID=
   ```
4. Verification: standalone test that queries:
   ```sql
   SELECT campaign.id, campaign.name, campaign.resource_name
   FROM campaign
   LIMIT 10
   ```

### Files

- **New**: `src/lib/google-ads-client.ts`
- **Modified**: `.env.example`

---

## Phase 2: Schema Changes

**Goal**: Database supports multi-platform accounts without breaking Meta flows.

### Changes

**`src/schema/account.ts`**:

- Add `platform: text("platform").notNull().default("meta")` — `"meta" | "google"`
- Add `googleCustomerId: text("google_customer_id")`
- Add `googleRefreshToken: text("google_refresh_token")`
- Add `googlePurchaseConversionActionIds: text("google_purchase_conversion_action_ids").array()`
- Make `metaAccountId` nullable because Google accounts will not have one

**`src/schema/campaign.ts`**, **`src/schema/ad-set.ts`**, **`src/schema/ad.ts`**:

- Add `googleResourceName: text("google_resource_name").unique()` as the canonical Google lookup key
- Optional: add `googleId: text("google_id")` only for debug/display; do not use it as a unique cross-account identifier

**`src/schema/ad.ts`**:

- Add `platform: text("platform").notNull().default("meta")` — denormalized for query performance and filtering

**`src/schema/ad-creative.ts`**:

- Add `sourcePlatform: text("source_platform")`
- Add `sourceAccountId: text("source_account_id")`
- Add `sourceExternalId: text("source_external_id")`
- Add a unique imported-source key so Google creatives can be keyed by source ad identity instead of by ad name

**`src/lib/trpc/routers/account.ts`**:

- Update CRUD to accept and return Google fields
- Add `hasGoogleRefreshToken: boolean` and never expose the raw token
- Add `hasGooglePurchaseConversionConfig: boolean`
- Validate:
  - Google accounts require `googleCustomerId`
  - Meta accounts require `metaAccountId`
  - if the org wants Google revenue/ROAS in shared reports, Google accounts must also have `googlePurchaseConversionActionIds`

**`src/components/blocks/import/inline-account-dialog.tsx`**:

- Add platform selector (Meta / Google)
- Conditionally show Meta or Google credential fields
- For Google accounts, collect:
  - customer ID
  - refresh token
  - purchase conversion action IDs

### Migration

- `bun run db:generate` then `bun run db:migrate`
- Existing rows default to `platform = "meta"`

---

## Phase 3: Google Insights Router & Mapper

**Goal**: Fetch Google Ads data and normalize to daily `MappedRow[]`.

### `src/lib/google-api-mapper.ts` (new)

`mapGoogleAdsToRows(rows, level, options?) -> MappedRow[]`

Key transforms:

| Google Ads Field | MappedRow Field | Transform |
| --- | --- | --- |
| `segments.date` | `dateStart` / `dateEnd` | set both to the same YYYY-MM-DD date |
| `metrics.cost_micros` | `spend` | divide by 1,000,000 |
| `metrics.ctr` | `ctr` | multiply by 100 because Google returns decimal CTR |
| `metrics.average_cpc` | `cpc` | divide by 1,000,000 |
| `metrics.average_cpm` | `cpm` | divide by 1,000,000 |
| `ad_group.name` | `adSetName` | direct (ad group = ad set) |
| `campaign.resource_name` | `campaignId` | canonical Google identifier |
| `ad_group.resource_name` | `adSetId` | canonical Google identifier |
| `ad_group_ad.ad.resource_name` | `adId` | canonical Google identifier |
| purchase-only conversion totals | `purchaseValue` | aggregate only configured purchase conversion actions |
| ROAS | `roas` | calculate only when purchase-only revenue exists |

Revenue mapping rules:

- Do **not** map `metrics.conversions_value` directly to `purchaseValue` unless the account's included conversions are already purchase-only
- If the account tracks mixed conversion actions, fetch purchase revenue separately and sum only the configured purchase conversion actions
- If purchase-only revenue is not configured yet, leave `purchaseValue` and `roas` empty while still importing spend/click/impression data

### `src/lib/ad-status.ts` (modify)

Add `resolveGoogleAdStatus()`:

- `ENABLED -> active`
- `PAUSED -> paused`
- `REMOVED -> archived`

### `src/lib/trpc/routers/google-insights.ts` (new)

Single `fetchReport` mutation; no polling is required because the Google API query is synchronous:

```ts
googleInsights.fetchReport({ accountId, dateFrom, dateTo, level })
  -> load account
  -> build daily GAQL with segments.date and resource_name fields
  -> optionally fetch purchase-only conversion rows using configured conversion-action filters
  -> customer.queryStream()
  -> mapGoogleAdsToRows()
  -> return { rows: MappedRow[], totalRows }
```

GAQL example (ad level):

```sql
SELECT
  segments.date,
  campaign.id,
  campaign.name,
  campaign.resource_name,
  ad_group.id,
  ad_group.name,
  ad_group.resource_name,
  ad_group_ad.ad.id,
  ad_group_ad.ad.name,
  ad_group_ad.ad.final_urls,
  ad_group_ad.ad.resource_name,
  ad_group_ad.status,
  metrics.cost_micros,
  metrics.impressions,
  metrics.clicks,
  metrics.ctr,
  metrics.average_cpc,
  metrics.average_cpm,
  metrics.conversions,
  metrics.video_views
FROM ad_group_ad
WHERE segments.date BETWEEN '{dateFrom}' AND '{dateTo}'
  AND metrics.impressions > 0
```

Purchase revenue query pattern:

- Run a second daily query segmented by conversion action
- Aggregate only the conversion actions configured on the account as purchase actions
- Merge those daily purchase totals back into the main `MappedRow[]` by `ad resource_name + date`

### `src/lib/trpc/routers/_app.ts` (modify)

Register `googleInsightsRouter`

---

## Phase 4: Import UI & Bulk Import Adaptation

**Goal**: Add a "From Google" import tab and adapt the shared bulk import path safely.

### `src/components/blocks/import/google-api-tab.tsx` (new)

Model it after `meta-api-tab.tsx`, but use a simpler state flow:

- `idle -> fetching -> importing -> done`

Reuse:

- `mapRowsForImport()`
- `splitBulkImportRows()`

### `src/lib/trpc/routers/ad-creative.ts` (modify)

Extend `bulkImport` input to accept `platform: "meta" | "google"`.

When `platform === "google"`:

- look up campaigns, ad sets, and ads by `googleResourceName` instead of `metaId`
- write `googleResourceName` on insert and update
- skip `fetchMetaCreativePreviewsForAds()`
- resolve creatives by imported source identity, not by ad name
- key creatives by `(sourcePlatform="google", sourceAccountId, sourceExternalId=ad resource_name)` so identical ad names across platforms or accounts do not collapse into one creative
- if Google media metadata is unavailable, still create a stable creative record keyed to the source ad and allow later enrichment

### `src/app/(protected)/import/page.tsx` (modify)

Add a third tab: "From Google" with `<GoogleApiTab />`.

### `src/lib/import-utils.ts` (modify)

- No Google-only duplicate ID fields are required
- Reuse existing `campaignId` / `adSetId` / `adId` fields, but for Google populate them with `resource_name` values instead of raw numeric IDs
- Pass `platform` through to `bulkImport` so the import router knows which external ID column to match against

---

## Phase 5: Unified Dashboard

**Goal**: Combined Meta + Google data with platform filtering.

### Changes

- Add platform filter (All / Meta / Google) to dashboard queries in `src/lib/trpc/routers/performance-log.ts`
- Show platform badge (Meta / Google) on ad and campaign lists
- Add `compareDailyGoogleVsDb` to `googleInsightsRouter`
- Update `orgDataHealth` to break down by platform

---

## Verification Checklist

1. **Phase 1**: run the test script and print campaign data from the Google test account
2. **Phase 2**: create a Google-type account in the UI and confirm its fields render correctly
3. **Phase 3**: call `googleInsights.fetchReport` and confirm it returns valid daily `MappedRow[]`
4. **Phase 4**: run the full Google import flow and confirm data lands in the DB without cross-platform creative collisions
5. **Phase 5**: confirm the dashboard shows combined spend and the platform filter works

---

## Key Design Decisions

- **Separate accounts**: Google and Meta accounts stay as separate `adAccounts` rows
- **Shared import shape**: both platforms still converge at `MappedRow`, but Google must emit daily rows and canonical IDs to fit the current pipeline
- **Canonical Google IDs**: store Google `resource_name` as the lookup key because raw numeric IDs are only customer-scoped
- **Platform-aware creatives**: Google imports cannot reuse the current name-based creative canonicalization
- **Revenue safety over convenience**: only populate shared `purchaseValue` / `roas` fields from purchase-only Google conversion actions
- **Synchronous fetch**: no async polling for Google because `queryStream()` returns data directly
- **Global + per-account creds**: `client_id`, `client_secret`, and `developer_token` stay in env vars; `customer_id`, `refresh_token`, and purchase conversion configuration live per account
