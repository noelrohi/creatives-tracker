# Google Ads sandbox bring-up runbook (manual steps)

Phase 1 of the pilot spec
(`docs/superpowers/specs/2026-08-13-google-ads-aggregate-pilot-design.md`).
Everything here is console clicking plus one script; no app code changes.
Do these once, in order.

## 1. Google Cloud project + OAuth client
1. Create a Google Cloud project (any name, e.g. `adsolute-google-ads-pilot`).
2. APIs & Services → enable **Google Ads API**.
3. OAuth consent screen: internal (or external/testing with the pilot Google
   account added as a test user), scope `https://www.googleapis.com/auth/adwords`.
4. Credentials → Create OAuth client ID → **Desktop app**. Record the client
   ID/secret as `GOOGLE_ADS_OAUTH_CLIENT_ID` / `GOOGLE_ADS_OAUTH_CLIENT_SECRET`.

## 2. Test manager + test client accounts
1. While logged into a Google account for the pilot, create a **test manager
   account**: https://developers.google.com/google-ads/api/docs/best-practices/test-accounts
   (the test-account creation link on that page). Record its ID as
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
2. Inside the test manager, create a **test client account**. Record its ID as
   `GOOGLE_ADS_CUSTOMER_ID`.
3. In the test client account, create 2–3 campaigns (any type; paused is
   fine). Test accounts serve no ads — the campaigns exist so GAQL responses
   are structurally real.

## 3. Developer token
1. In the **production** manager account UI (a test manager has no token
   page): Tools → API Center → apply for a developer token. The token starts
   in "test account only" access — exactly what the sandbox needs.
2. Record it as `GOOGLE_ADS_DEVELOPER_TOKEN`.
3. Submit the **Basic access** application in the same API Center now; the
   review is the long pole before Phase 2 (real Reviv data).

## 4. Refresh token
Run `node scripts/google-ads-mint-refresh-token.mjs` with the client ID and
secret in the environment; complete consent with the Google account that owns
the test manager. Paste the printed value into `GOOGLE_ADS_REFRESH_TOKEN`.

## 5. Environment
Fill every `GOOGLE_ADS_*` variable from `.env.example` in the local + worker
environments. `GOOGLE_ADS_REVIV_SHOP_DOMAIN` must equal the Reviv store's
`shop_domain` row value exactly.

## 6. Verify the API version pin
Check the current Google Ads API version at
https://developers.google.com/google-ads/api/docs/release-notes and set
`GOOGLE_ADS_API_VERSION` in `src/lib/google-ads/client.ts` to the newest
non-sunset version before first sync (verified 2026-08-17: v21 is blocked
with UNSUPPORTED_VERSION; the constant is now "v22").

## 7. End-to-end sandbox pass (definition of done for Phase 1)
1. `bun run trigger:dev` + `bun dev`.
2. As an org admin, open `/attribution/google-ads`.
3. Run gclid probe → report completes with real coverage numbers (no Google
   credentials involved).
4. Run discovery → connection becomes `ready` with the test account's
   name/timezone/currency (or `degraded` with a reason code if misconfigured).
5. Sync facts → the 90-day backfill completes; campaign rows appear (zero
   metrics is expected for test accounts); `backfill_completed_at` is set.
6. Kill the facts task mid-run once and confirm the next batch resumes from
   the checkpoint instead of restarting at day one.

## Recovery: degraded connection with `currency_changed`
Discovery fails closed if the ad account's currency differs from the stored
one (a currency change invalidates historical spend comparisons). There is
deliberately no UI reset. After confirming the change is expected, clear the
stored currency so the next discovery re-adopts it:

```sql
UPDATE google_ads_connection
SET currency_code = NULL, status = 'pending'
WHERE id = '<connection id from the lab header>';
```

Then run discovery again from the lab. Historical `google_ads_campaign_fact`
rows keep their original per-row `currency_code`; interpret mixed-currency
ranges manually.

## Phase 2 swap (after Basic access approval)
Replace `GOOGLE_ADS_LOGIN_CUSTOMER_ID` / `GOOGLE_ADS_CUSTOMER_ID` with the
real manager + Reviv account IDs, re-mint the refresh token with the real
account's Google login, run discovery, then run the 90-day backfill from the
lab. The nightly schedule picks the connection up automatically once the
backfill completes.
