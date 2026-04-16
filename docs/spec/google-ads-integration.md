# Google Ads Integration Plan

## Context

The dashboard currently only supports Meta Ads. A client asked whether spend/revenue numbers include Google — they don't. This plan adds Google Ads as a second platform, reusing the existing `MappedRow` → `bulkImport` pipeline so both platforms converge into the same database tables.

---

## Phase 1: Test Account Setup & Client Library

**Goal**: Working Google Ads API connection, testable standalone.

### Walkthrough: Google Ads Test Account

1. **Create a Manager Account (MCC)** at https://ads.google.com/home/tools/manager-accounts/
2. **Create a Test Account** inside the MCC (Settings > Sub-account settings > New test account) — note the `customer_id` (strip dashes)
3. **Google Cloud Console** (https://console.cloud.google.com):
   - Create a new project (or use existing)
   - Enable the **Google Ads API** (APIs & Services > Enable APIs)
   - Create **OAuth 2.0 Client ID** (type: Web Application)
   - Set redirect URI: `http://localhost:3000/api/auth/callback/google`
   - Note `client_id` and `client_secret`
4. **Get Developer Token**: In MCC, go to Tools & Settings > API Center — works immediately for test accounts
5. **Get Refresh Token**: Use OAuth 2.0 Playground (https://developers.google.com/oauthplayground)
   - Scope: `https://www.googleapis.com/auth/adwords`
   - Use your client ID/secret (gear icon > "Use your own OAuth credentials")
   - Authorize, exchange code for refresh token
6. **Populate test data**: Create at least 1 campaign + 1 ad group + 1 ad in the test account

### Implementation

1. Install: `bun add google-ads-api`
2. Create `src/lib/google-ads-client.ts` — singleton `GoogleAdsApi` factory + `getGoogleAdsCustomer(refreshToken, customerId)` helper
3. Add env vars to `.env`:
   ```
   GOOGLE_ADS_CLIENT_ID=
   GOOGLE_ADS_CLIENT_SECRET=
   GOOGLE_ADS_DEVELOPER_TOKEN=
   GOOGLE_ADS_LOGIN_CUSTOMER_ID=
   ```
4. Verification: standalone test that queries `SELECT campaign.id, campaign.name FROM campaign LIMIT 10`

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
- Make `metaAccountId` nullable (Google accounts won't have it)

**`src/schema/campaign.ts`**, **`src/schema/ad-set.ts`**, **`src/schema/ad.ts`**:

- Add `googleId: text("google_id").unique()` — parallel to existing `metaId`

**`src/schema/ad.ts`** (additional):

- Add `platform: text("platform").notNull().default("meta")` — denormalized for query performance

**`src/lib/trpc/routers/account.ts`**:

- Update CRUD to accept/return Google fields
- Add `hasGoogleRefreshToken: boolean` (never expose raw token)
- Validate: Google accounts require `googleCustomerId`, Meta accounts require `metaAccountId`

**`src/components/blocks/import/inline-account-dialog.tsx`**:

- Add platform selector (Meta / Google)
- Conditionally show Meta or Google credential fields

### Migration

- `bun run db:generate` then `bun run db:migrate`
- Existing rows default to `platform = "meta"`

---

## Phase 3: Google Insights Router & Mapper

**Goal**: Fetch Google Ads data and normalize to `MappedRow[]`.

### `src/lib/google-api-mapper.ts` (new)

`mapGoogleAdsToRows(rows, level, options?) → MappedRow[]`

Key transforms:

| Google Ads Field | MappedRow Field | Transform |
| --- | --- | --- |
| `metrics.cost_micros` | `spend` | divide by 1,000,000 |
| `metrics.conversions` | `conversions` | round (Google returns float) |
| `metrics.conversions_value` | `purchaseValue` | direct |
| `metrics.ctr` | `ctr` | multiply by 100 (Google returns decimal) |
| `metrics.average_cpc` | `cpc` | divide by 1,000,000 |
| `metrics.average_cpm` | `cpm` | divide by 1,000,000 |
| `ad_group.name` | `adSetName` | direct (ad group = ad set) |
| ROAS | `roas` | calculated: `purchaseValue / spend` |

### `src/lib/ad-status.ts` (modify)

Add `resolveGoogleAdStatus()`: ENABLED → active, PAUSED → paused, REMOVED → archived

### `src/lib/trpc/routers/google-insights.ts` (new)

Single `fetchReport` mutation (no polling needed — Google API is synchronous via streaming):

```
googleInsights.fetchReport({ accountId, dateFrom, dateTo, level })
  → load account → build GAQL → customer.queryStream() → mapGoogleAdsToRows()
  → return { rows: MappedRow[], totalRows }
```

GAQL example (ad level):

```sql
SELECT
  campaign.id, campaign.name,
  ad_group.id, ad_group.name,
  ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls,
  ad_group_ad.status,
  metrics.cost_micros, metrics.impressions, metrics.clicks,
  metrics.ctr, metrics.average_cpc, metrics.average_cpm,
  metrics.conversions, metrics.conversions_value,
  metrics.cost_per_conversion, metrics.video_views
FROM ad_group_ad
WHERE segments.date BETWEEN '{dateFrom}' AND '{dateTo}'
  AND metrics.impressions > 0
```

### `src/lib/trpc/routers/_app.ts` (modify)

Register `googleInsightsRouter`

---

## Phase 4: Import UI & Bulk Import Adaptation

**Goal**: "From Google" tab on import page, bulk import handles Google IDs.

### `src/components/blocks/import/google-api-tab.tsx` (new)

Modeled after `meta-api-tab.tsx` but simpler — 4 states: `idle → fetching → importing → done` (no async polling needed).

Reuses `mapRowsForImport()` + `splitBulkImportRows()` from `src/lib/import-utils.ts`.

### `src/lib/trpc/routers/ad-creative.ts` (modify)

Extend `bulkImport` input to accept `platform: "meta" | "google"`. When `platform === "google"`:

- Look up campaigns/ad sets/ads by `googleId` instead of `metaId`
- Write to `googleId` column on insert/update
- Skip `fetchMetaCreativePreviewsForAds()` call

### `src/app/(protected)/import/page.tsx` (modify)

Add third tab: "From Google" with `<GoogleApiTab />`.

### `src/lib/import-utils.ts` (modify)

Pass through `googleAdId` / `googleAdSetId` / `googleCampaignId` fields.

---

## Phase 5: Unified Dashboard

**Goal**: Combined Meta + Google data with platform filtering.

### Changes

- Add platform filter (All / Meta / Google) to dashboard queries in `src/lib/trpc/routers/performance-log.ts`
- Show platform badge (Meta/Google icon) on ad/campaign lists
- Add `compareDailyGoogleVsDb` to `googleInsightsRouter`
- Update `orgDataHealth` to break down by platform

---

## Verification Checklist

1. **Phase 1**: Run test script → prints campaign data from Google test account
2. **Phase 2**: Create a Google-type account in UI → appears in account list with correct fields
3. **Phase 3**: Call `googleInsights.fetchReport` → returns valid `MappedRow[]`
4. **Phase 4**: Full import flow: "Sync data" on Google tab → data in DB → ads visible on creatives page
5. **Phase 5**: Dashboard shows combined spend; platform filter works

---

## Key Design Decisions

- **Separate accounts**: A Google account and Meta account are separate `adAccounts` rows with a `platform` field (not merged)
- **Converge at MappedRow**: Both platforms normalize to the same interface, so `bulkImport` pipeline is fully reused
- **Parallel ID columns**: `metaId` and `googleId` as separate columns (preserves existing unique constraints)
- **Synchronous fetch**: No async polling for Google (unlike Meta's 3-step flow) — `queryStream()` returns data directly
- **Global + per-account creds**: `client_id`, `client_secret`, `developer_token` in env vars; `customer_id` + `refresh_token` per account in DB
