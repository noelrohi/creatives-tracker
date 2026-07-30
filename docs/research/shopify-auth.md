# Research: Shopify connection model — admin token vs OAuth app

*Researched 2026-07-30. Claims are tagged **[DOC]** (Shopify documentation, URL cited), **[STAFF]** (Shopify employee post in the developer forums), **[COMMUNITY]** (third-party/user report), or **[INFERENCE]** (my reasoning from the cited facts).*

## TL;DR

1. **The current approach is not extensible — not for policy reasons, but because Shopify removed it.** Since **January 1, 2026**, "You can no longer create new custom apps in the Shopify admin" **[DOC]**. Baby Planet cannot be onboarded the way Reviv was. This decides the question on its own.
2. **Build the custom-distribution OAuth install now.** No Shopify review, protected customer data "Always available" for custom apps at both levels, and custom apps are **exempt** from the expiring-token mandate, so offline tokens stay non-expiring **[DOC]**.
3. **The repo is already most of the way there**: `/Users/rohi/sandbox/adsolute/src/app/api/shopify/install/route.ts` and `callback/route.ts` implement the full code grant with HMAC + state verification; `shopifyStores.accessToken` already exists in the schema. The callback currently *prints* the token for manual `.env` paste instead of persisting it.
4. **The one real risk is `read_all_orders`**: it is auto-granted to admin-created custom apps (the Reviv case) but must be **requested and approved per app** for anything created in the Partner/Dev Dashboard **[DOC]**. Request it early and let the 90-day backfill degrade to 60 days while pending.
5. **Do not go full public app yet.** It adds App Store review, protected-customer-data review, mandatory compliance webhooks, and — for any app created after April 1, 2026 — expiring tokens with 90-day refresh plumbing **[DOC]**. That is the right stage-3 move when you want self-serve signup or Shopify-billed subscriptions, not at a handful of agency-managed stores.

---

## How comparable apps connect

### Wetracked (wetracked.io)

**Public app on the Shopify App Store** — listing at https://apps.shopify.com/wetracked-io-connect, developer "wetracked.io", launched **October 27, 2025** **[DOC]**. Install is ordinary App Store OAuth with a scope consent screen; their help centre gives the sequence: *"Step 1: Install wetracked.io Connect in the Shopify App Store. Step 2: Provide the app with access to the required data. Step 3: The app will ask you to enter your API key."* **[DOC]**

Architecture is **split**: the real dashboard is at `app.wetracked.io`, and onboarding *starts* there (*"Go to app.wetracked.io and select Shopify > Add New Store"*). The Shopify-side app is a thin connector whose *"only function is to authenticate your store and maintain a reliable data link for tracking"* **[DOC]**. The two halves are linked by a **manually pasted API key**, not by Shopify identity.

**The most useful single data point in this research:** their listing's Data access block reads, verbatim, *"Edit orders — **All order history for the last 60 days**"* **[DOC]**. That is Shopify's rendering for order scopes **without** `read_all_orders`. A 2025-launched attribution app in exactly your business did **not** obtain extended historical order access.

They do request protected customer data at the top tier — *"Sensitive data — Name, email address, phone number, physical address"* plus *"Geolocation, IP address, browser and operating system, browsing behavior, client ID cookie"* **[DOC]**. Those are Shopify's protected customer *fields*, i.e. level 2.

### Triple Whale

**Public app on the Shopify App Store** (https://apps.shopify.com/triplewhale-1, launched December 4, 2020) **and** a Shopify Plus Certified App **[DOC]**. The OAuth flow is typically initiated from *inside Triple Whale's own dashboard* rather than from the App Store: *"In the Triple Whale dashboard, find the 'Integrations' section, click on the Shopify integration option and follow the prompts to authorize Triple Whale's access to your Shopify data."* **[COMMUNITY — search snippet; kb.triplewhale.com is Cloudflare-blocked and could not be read directly]**

Architecture is **standalone, not embedded**, and the evidence is decisive: they ship native iOS and Android apps, which an App-Bridge-embedded admin app cannot be, plus a Chrome extension specifically to inject their stats back *into* Shopify's admin **[DOC]**. You only build that if your product does not already live there.

Offline token is strongly implied by multi-day backfill and continuous sync with no merchant present **[INFERENCE]** — *"It can take about 24 hours before data is pulled in"* **[COMMUNITY]**.

**On historical orders: could not verify either way.** Worth flagging because it is easy to get wrong — the "60 days" figure that dominates search results for Triple Whale is **Amazon Ads' API limit, not Shopify's** order window (*"Amazon's API limits Triple Whale to 60 days of historical data from Amazon Ads"*) **[DOC]**. No evidence found that they hold `read_all_orders`.

### GemPages

**Public App Store app** (https://apps.shopify.com/gempages, launched March 2017, ~3,900 reviews) and the one genuinely **embedded** app of the set — *"in sync with the Polaris design system, now integrates seamlessly with Shopify admin"*, *"meeting Shopify App Bridge standards"* **[DOC]**.

Not a useful comparator for your case: it requests **no order and no customer scopes at all** (products, discounts, Online Store, themes, files only) **[DOC]**, so it never touches the 60-day window or protected customer data.

### Ecomwize

Findable, and it is the outlier. **Not on the App Store**; instead each merchant creates their *own* app and hands over the credentials. From their docs, verbatim: *"Open the **Shopify Dev Dashboard** by visiting dev.shopify.com/dashboard and click the **Create app** button… **Uncheck the Embed app in Shopify admin checkbox**… **Check the Use legacy install flow checkbox**… Copy and paste both values [Client ID and Secret] into the corresponding fields in EcomWize"* **[DOC]** (https://docs.ecomwize.io/shopify/store-connection).

So: bring-your-own-OAuth-credentials, then a standard authorization code grant against the merchant's own app. This is the closest published analogue to where you are now, and note they have already been forced onto the **Dev Dashboard** rather than the merchant admin — consistent with the January 2026 shutdown.

### Cross-app synthesis

Three of four are public App Store apps installed by ordinary OAuth; the fourth uses per-merchant credentials and is the least mature. But the pattern that matters for you is the **split architecture**: both attribution tools (Wetracked, Triple Whale) are App Store apps whose primary dashboard lives on the vendor's own domain, with only a thin connector inside Shopify. That is explicitly permitted — Built for Shopify requirement 3.1.2 carves out *"Exceptions apply on apps that need a standalone site to provide more complex features in a user-friendly way"* **[DOC]**. An attribution dashboard qualifies.

**No app in this set demonstrably obtained `read_all_orders`.** Wetracked provably did not. Established attribution vendors appear to live with the 60-day window rather than fight for the scope — which is worth weighing against the assumption that a 90-day backfill is table stakes.

---

## What Shopify requires per model

The three current distribution models, verbatim from https://shopify.dev/docs/apps/launch/distribution **[DOC]**:

| Model | Stores | Review | Auth | Limitations |
|---|---|---|---|---|
| **Public** | "Can be installed on multiple Shopify stores" | **Yes** | Token exchange + session tokens (embedded); authorization code grant (standalone) | "Must sync certain data with Shopify" |
| **Custom** | "Installed on a single Shopify store, on multiple stores that belong to the same Plus organization" | **No** | Same as public | "Can't use the Billing API to charge merchants" |
| **Shopify admin** | "Installed on a single Shopify store" | **No** | "Authenticate in the Shopify admin" | "Can't use Shopify App Bridge… Can't use app extensions… Can't use the Billing API" |

**The choice is permanent:** *"You can't change the distribution method after you select it"* **[DOC]**.

Two corrections to common assumptions, both worth knowing before you pick:

- **Custom distribution apps *can* be embedded** and can use App Bridge and app extensions. Only the *admin-created* model is barred from those **[DOC]**. The two are frequently conflated.
- **"Unlisted" is not a distribution model.** What exists is a *visibility* setting on a public app: **limited visibility** apps are installable via a direct URL but not indexed or searchable. Review is identical — *"Shopify's app requirements are the same for both fully visible and limited visibility public apps"* **[DOC]** (https://shopify.dev/docs/apps/launch/distribution/visibility). So limited visibility gets you agency-only distribution **without** escaping App Store review.

### The decisive change: admin-created custom apps are gone

From https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin, verbatim **[DOC]**:

> "You can no longer create new custom apps in the Shopify admin. Existing admin-created custom apps continue to work."
> "To create a new custom app, use the Dev Dashboard or Shopify CLI."

Effective **January 1, 2026** (https://changelog.shopify.com/posts/legacy-custom-apps-can-t-be-created-after-january-1-2026). Reviv's app is grandfathered and keeps working. **Baby Planet cannot get one.** Any onboarding runbook that says "go to Settings → Apps → Develop apps" is dead on arrival for every store from here on.

### `read_all_orders` — how it is granted per model

The scope grants *"All relevant orders rather than the default window of orders created within the last 60 days"* and must be used alongside `read_orders` or `write_orders` **[DOC]** (https://shopify.dev/docs/api/usage/access-scopes). The 60-day wall dates to July 9, 2018.

**(a) Merchant-created custom app (what you use today) — auto-granted, and undocumented.**
The original changelog states *"Private apps are not affected by this change and automatically will have the `read_all_orders` scope"* **[DOC]** (https://shopify.dev/changelog/apps-now-need-shopify-approval-to-read-orders-older-than-60-days). Shopify staff confirmed in the developer forums that *"private apps here are admin created custom apps"* and that the scope is absent from the admin picker precisely because it is already granted **[STAFF]** (https://community.shopify.dev/t/read-all-orders-scope-in-custom-apps-created-in-admin/4361). Shopify said the docs would be corrected; as of today they still have not been. Your working 90-day backfill against Reviv is empirical confirmation **[INFERENCE]**.

**(b) Public app — request and approval required.**
Partner Dashboard → Apps → your app → **API access** → **Access requests** → "Read all orders" card → describe the app and justify the need **[DOC]**. Shopify reviews it. The commonly quoted "~7 business days" is **[COMMUNITY]** — current docs state no timeline.

**(c) Custom distribution app — also request and approval required. This is the cost of migrating.**
The docs say *"Only public or custom apps are granted access scopes"* **[DOC]**, so custom-distribution apps are eligible — but the auto-grant is keyed to *where the app was created* (the merchant's admin), not to how few stores it reaches. Anything created in the Partner/Dev Dashboard goes through the request flow **[INFERENCE, high confidence]**, corroborated by a developer who hit a TOML validation error after assuming otherwise and was told *"a private app is created directly in the Shopify store admin"* whereas Partner Dashboard apps *"[are] not a private app"* **[COMMUNITY]** (https://community.shopify.dev/t/how-to-get-read-all-orders-scope-access-for-a-private-custom-app/4890).

**No report of a denial for a custom-distribution app was found**, but neither was a confirmed approval — searches turned up neither. Treat approval as likely but unproven, and verify the request card actually renders in the **Dev Dashboard** (the docs still describe the older Partner Dashboard UI).

**Net effect of migrating:** you acquire a `read_all_orders` approval dependency you do not currently have. That is the single biggest thing you give up by leaving admin tokens.

### Protected customer data

Verbatim table from https://shopify.dev/docs/apps/launch/protected-customer-data **[DOC]**:

| Level | Public app | Custom app | Admin created custom app |
|---|---|---|---|
| 1 | **Requires review** | **Always available** | Always available |
| 2 | **Requires review** | **Always available** | Varies by plan |

Level 1 is *"Customer data **excluding** name, address, phone, and email fields"*; level 2 *"including"* them. **Orders are in scope**: the protected-data table lists *"Orders, draft orders, abandoned checkouts, refunds, transactions, and other data that relate to a single customer."* **[DOC]**

Three consequences specific to your app:

- **Reading orders with no PII still puts you at level 1.** `src/lib/shopify-admin.ts` deliberately omits customer/email/shippingAddress, which correctly keeps you out of level 2 — but not out of the regime.
- **Gating is by scope, not by which fields you query:** *"You can add the relevant scopes to your app, but the API won't return data from non-development stores until your app is configured and approved for protected customer data use."* **[DOC]**
- **`Order.customerJourneySummary`** (the UTM/referrer/landing-page data your attribution depends on) carries only *"Requires `read_orders` access scope"* on its reference page, with **no** level 1/level 2 annotation **[DOC]**. **[INFERENCE]** It falls under the Orders row at level 1, so it is reachable without any level 2 PII approval — favourable for you, but not explicitly documented.

**For custom distribution this is a non-event** — both levels are "Always available", no review. For a public app it is a real gate, and note the sequencing trap: *"Applying for protected customer data isn't possible while the app is under review"* **[DOC]**, so you must request it *before* submitting.

### Mandatory compliance webhooks

The three topics are `customers/data_request`, `customers/redact`, and `shop/redact` **[DOC]** (https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance). The requirement is scoped narrowly: *"**If your app is distributed through the Shopify App Store**, it must be subscribed to Shopify's mandatory compliance topics."* **[DOC]**

So they are required for **public distribution only**. No doc requires them for custom distribution — but note the asymmetry: no doc states custom apps are *exempt* either, so that is **[INFERENCE]** from absence. The underlying GDPR/CCPA obligation exists regardless of what Shopify enforces, and the API Terms independently require deleting merchant data within 30 days of uninstall (see below).

---

## Operational comparison

| | **Admin token (today)** | **Custom distribution** | **Public app** |
|---|---|---|---|
| **Can you still create one?** | **No — dead since Jan 1, 2026** | Yes | Yes |
| Shopify review | None | **None** | **Required** |
| Protected customer data | L1 always, L2 by plan | **L1 + L2 always available** | L1 and L2 both require review |
| `read_all_orders` | **Auto-granted** | Request + approval, **per app** | Request + approval, once |
| Token lifetime | Non-expiring | **Non-expiring** (exempt) | **Expiring** if created after Apr 1 2026 |
| Apps needed for N clients | N (manual, in each admin) | **N** (one per merchant) | **1** |
| Install UX | You click through each client's admin, copy a token, paste into env | Merchant clicks one install link, approves scopes | Merchant clicks install link or App Store listing |
| Token storage | `.env`, one store only | DB row per store | DB row per store |
| Credential rotation | **Impossible** | Standard OAuth reinstall | Standard, plus 90-day refresh |
| Compliance webhooks | Not required by Shopify | Not required by Shopify | **Required** |
| Billing API | No | **No** | Yes |
| Rate limits | Identical | Identical | Identical |

**Rate limits do not differ by model** — this is worth stating plainly because it is often assumed otherwise. The only documented dimensions are (app × store) and the store's plan tier **[DOC]** (https://shopify.dev/docs/api/usage/limits): *"calls from one app don't affect the rate limits of another app, even on the same store."* GraphQL restore rates are 100 pts/s standard, 200 advanced, 1000 Plus. There is no penalty for switching models.

**Two bulk-operation details that affect your sync code** (`trigger/shopify-sync.ts` pins `SHOPIFY_API_VERSION = "2026-07"` in `src/lib/shopify-admin.ts:7`) **[DOC]** (https://shopify.dev/docs/api/usage/bulk-operations/queries):
- On **2026-01 and higher**, each app can run **five** concurrent bulk operations of each type per shop, up from one. Your version is above that line, so parallel per-store backfills are viable.
- `currentBulkOperation` is **deprecated** on 2026-01+ (it cannot express five concurrent operations) — use `bulkOperation(id:)`. Your code already polls by ID via `pollBulkOperation`, so this is fine.
- Bulk queries are exempt from the calculated-cost rate limit; only the submitting mutation and your polling count against it.

**Token behaviour worth designing around:**
- Offline tokens are for *"service-to-service requests where no user interaction is involved"*; online tokens are user-bound and expire in ~24h **[DOC]**. Your scheduled sync needs offline.
- **Custom apps are exempt** from the expiring-token mandate: *"These requirements don't apply to custom apps or apps created by merchants"* **[DOC]**. Public apps created on/after **April 1, 2026** must use expiring tokens (1h access, 90-day refresh), and all public apps must migrate by **January 1, 2027**.
- On uninstall the token is revoked and `app/uninstalled` fires; **[COMMUNITY]** consistently reports the token is already dead when your handler runs, so cleanup must not require API access.
- Scope increases prompt the merchant to re-approve on next open; scope *reductions* apply silently **[DOC]** (https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes).

---

## Risks of the current approach

**1. It cannot onboard Baby Planet.** The blocking issue is availability, not policy. As above, admin-created custom apps ceased to be creatable on January 1, 2026 **[DOC]**. This alone forces the decision.

**2. The token cannot be rotated.** Verbatim: *"You can't rotate API credentials for custom apps created in the Shopify admin. You need to delete the app and create a new custom app which has new API credentials."* **[DOC]** Since creating a new one is now impossible, **the documented remediation path requires an action Shopify has disabled**. A leaked Reviv token is a migration event, not a rotation. (The same page says new tokens require uninstall/reinstall of the existing app, which presumably still works — but that is untested post-deprecation.)

This is not hypothetical: Shopify's Partner Governance team has unilaterally disabled a custom app's API access over publicly exposed credentials, stating the *"security vulnerability presented by this exposure is still active"* **[COMMUNITY]** (https://community.shopify.dev/t/api-token-disabled-for-a-custom-app/3230). They police leaked tokens actively.

**3. The pattern itself is *legal* — this is the one worry you can drop.** Shopify's API Terms explicitly contemplate a third party using a merchant's admin-generated credentials. §6.1 enumerates exactly two lawful grant paths: *"the Merchant must grant Developer access (A) through a consent screen provided by Shopify at the time the Application is installed by a Merchant, **or (B) to the Merchant's Private API Credentials**. Any other access… is strictly prohibited."* **[DOC]** (https://www.shopify.com/legal/api-terms). §2.1.4 permits it *"with the express authorization of the account owner… and only for the purposes of providing your Application's service to the Merchant to whom the Private API Credentials relate"* — and §2.1.3 explicitly waives the Partner-account requirement for this case. Shopify's own partner guidance frames *"Build and sell a custom app tailored to a specific client's needs"* as a legitimate business model **[DOC]**.

**4. The real policy trap is reuse, and it applies to custom distribution too.** API Terms §2.3.20 bars making a Custom Application *"available to or for use by more than one Merchant… this means that Custom Applications may not be installed by more than one Merchant"* — and the remedy is severe: Shopify may *"determine, in its sole discretion, that the Application is deemed to be a Public Application"* **[DOC]**. The prohibition is **per-application, not per-vendor**: one custom app per client merchant is fine even if a single multi-tenant backend consumes all their tokens. Reusing *one* app across merchants is not. **This is the rule that forces one custom-distribution app per client**, and it is why the migration does not collapse to a single custom app for everyone.

**5. Unknowns you should test rather than design around.** Two genuinely undocumented behaviours, where searches found no reports either way:
- What happens to a `shpat_` token when the staff member who created it is removed or loses permissions. **[INFERENCE]** points to store-binding rather than user-binding (offline tokens are defined as revocable *"only through app uninstallation or secret revocation"*, and staff removal is not on that list), but this is not documented. A Shopify staffer confirmed the adjacent case — that legacy custom apps and their tokens survive a **store transfer** **[STAFF]**.
- Whether editing scopes on an admin custom app invalidates the existing token.

**6. Secondary, but real:** `SHOPIFY_ACCESS_TOKEN` in `.env` is a single-store design — `src/lib/shopify-admin.ts` calls `requireEnv` on every request, so there is no way to address a second store — and PCD level 1 requires encryption at rest, which an env var does not give you for a credential that will soon be a DB column.

---

## Recommendation & migration path

**Build the custom-distribution OAuth install now. Do not go public yet.**

The reasoning in one line: the admin-token path is closed to new stores, custom distribution costs you no review and no token-expiry work, and you have already written most of the code.

### Why not the public app yet

At a handful of agency-managed stores, a public app is strictly more work for no benefit you can currently use. It adds App Store review, a protected-customer-data review (which must be requested *before* submission), mandatory compliance webhook endpoints, App Store requirement 2.2.2's embedded-experience obligation, and — because any app you create now postdates April 1, 2026 — expiring offline tokens with 90-day refresh plumbing. The things it buys you (one app for all stores, one `read_all_orders` approval, the Billing API, self-serve discovery) only start paying off when you have enough stores that per-client app creation hurts, or when you want Shopify to bill your customers. Neither is true by September.

### Stage 1 — now, for Baby Planet

1. **Create a custom-distribution app in the Dev Dashboard** under your Partner org. Choose distribution deliberately: *it cannot be changed later* **[DOC]**.
2. **Request `read_all_orders` immediately** — before you need it, since approval is asynchronous and unproven for this model. Verify the request card actually renders in the Dev Dashboard.
3. **Persist the token instead of printing it.** `src/app/api/shopify/callback/route.ts:111-119` currently renders the token into HTML for manual `.env` paste. Replace that with an upsert into `shopifyStores` (`src/schema/shopify.ts:26-45` — `organizationId`, unique `shopDomain`, and a nullable `accessToken` column are already there). Encrypt the column at rest; PCD level 1 requires encryption at rest and in transit even though custom apps skip the review.
4. **Parameterize the Admin client.** `src/lib/shopify-admin.ts` resolves `SHOPIFY_SHOP_DOMAIN`/`SHOPIFY_ACCESS_TOKEN` through `requireEnv` inside `shopifyEndpoint()` and `shopifyGraphql()`. Thread a store record (domain + token) through instead. This is the largest code change and touches every exported function plus `trigger/shopify-sync.ts`.
5. **Carry the org through the OAuth state.** The install route reads `session.session.activeOrganizationId` but the callback does not — it only validates state against a cookie. Bind the state value to the organization so the callback knows which org owns the new store.
6. **Make the backfill degrade gracefully to 60 days** if `read_all_orders` is not yet granted, and record which window a store was backfilled at. This de-risks the whole plan: the scope gap only costs you 30 days of history *at onboarding*, and incremental sync closes it within a month of operation. It is not an ongoing dependency.
7. **Handle `app/uninstalled`** — mark the store disconnected and stop scheduling syncs. Not Shopify-mandated for custom apps, but the API Terms independently require deleting merchant data within 30 days of uninstall.

Repeat step 1 per client merchant: **one custom-distribution app per client**, per API Terms §2.3.20. Generating an install link is a few minutes of work in the Dev Dashboard, and the merchant just clicks it and approves — a large UX improvement over you clicking through their admin and handling a raw token.

### Stage 2 — keep Reviv where it is, for now

Reviv's existing app is grandfathered and keeps working with a non-expiring token **[DOC]**. **Do not migrate it until the custom-distribution `read_all_orders` request is approved** — migrating trades an auto-granted scope for one that must be approved, and you would lose 90-day history in the interim. Once approved, move it over so all stores share one code path and the un-rotatable token stops being a liability. Keep the env-var path as a fallback until then; the schema supports both simultaneously since `accessToken` is nullable.

### Stage 3 — public app, when the trigger fires

Revisit when any of these becomes true: you want merchants to self-serve without you touching the Dev Dashboard; you want Shopify to handle billing; per-client app creation becomes a bottleneck (realistically 10–20+ stores); or you want App Store discovery. Budget for App Store review, a PCD review requested *before* submission, compliance webhooks, and expiring-token refresh handling.

**The migration from custom distribution to public is a rebuild of the app registration, not of your code** — distribution cannot be changed on an existing app **[DOC]**, so you would create a new public app and re-install across stores. But the OAuth flow, per-store token storage, and multi-tenant sync you build in stage 1 all carry over unchanged. That is the main reason to do stage 1 properly now: it is the same work either way, and it is the prerequisite for stage 3 regardless of when you get there.

### Precedent check

This lands you in the same architecture as Wetracked and Triple Whale — OAuth install, offline token, standalone dashboard on your own domain, thin Shopify-side presence — just at custom-distribution scale instead of public **[DOC/INFERENCE]**. And note that neither of them demonstrably holds `read_all_orders`; Wetracked provably does not. If the approval is slow or denied, you are in the same position as the established players in your category, not at a disadvantage.

---

## Sources

**Shopify documentation**
- App distribution models — https://shopify.dev/docs/apps/launch/distribution
- Select a distribution method (custom install links) — https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
- App listing visibility (limited vs fully visible) — https://shopify.dev/docs/apps/launch/distribution/visibility
- Access scopes, `read_all_orders`, 60-day window, request flow — https://shopify.dev/docs/api/usage/access-scopes
- Protected customer data (levels, app-type table, fields) — https://shopify.dev/docs/apps/launch/protected-customer-data
- Generate access tokens for custom apps in the admin (creation disabled; no rotation) — https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin
- Offline access tokens (expiry mandate, exemptions) — https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
- Online access tokens — https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens
- Manage access scopes (re-consent behaviour) — https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes
- API rate limits — https://shopify.dev/docs/api/usage/limits
- Bulk operations (concurrency, `currentBulkOperation` deprecation) — https://shopify.dev/docs/api/usage/bulk-operations/queries
- Privacy law compliance / mandatory webhooks — https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- Webhooks reference — https://shopify.dev/docs/api/webhooks/latest
- App requirements checklist — https://shopify.dev/docs/apps/launch/app-requirements-checklist
- App Store requirements — https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
- Built for Shopify requirements (3.1.2 standalone-site exception) — https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
- App review process — https://shopify.dev/docs/apps/launch/app-store-review/review-process
- Submit app for review (PCD sequencing trap) — https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
- `Order` object — https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- `CustomerJourneySummary` object — https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary
- Custom apps (Help Center) — https://help.shopify.com/en/manual/apps/app-types/custom-apps
- Making apps (Partner guidance) — https://help.shopify.com/en/partners/build-integrate/making-apps

**Shopify changelogs**
- Legacy custom apps can't be created after January 1, 2026 — https://changelog.shopify.com/posts/legacy-custom-apps-can-t-be-created-after-january-1-2026
- Apps need approval to read orders older than 60 days (2018) — https://shopify.dev/changelog/apps-now-need-shopify-approval-to-read-orders-older-than-60-days
- Offline access tokens support expiry and refresh (Dec 10, 2025) — https://shopify.dev/changelog/offline-access-tokens-now-support-expiry-and-refresh
- Expiring tokens required for public apps, April 1 2026 — https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-public-apps-april-1-2026
- Expiring tokens required for all public apps, January 1 2027 — https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-all-public-apps-as-of-january-1-2027
- Custom apps on multiple Plus stores (July 2023) — https://shopify.dev/changelog/install-custom-apps-on-multiple-shopify-plus-stores

**Legal**
- Shopify API Terms of Service (§2.1.3, §2.1.4, §2.3.20, §6.1, §6.2.3) — https://www.shopify.com/legal/api-terms

**Community / staff forum posts** *(not documentation)*
- `read_all_orders` in admin-created custom apps — Shopify staff confirmation — https://community.shopify.dev/t/read-all-orders-scope-in-custom-apps-created-in-admin/4361
- `read_all_orders` for a Partner-Dashboard custom app — https://community.shopify.dev/t/how-to-get-read-all-orders-scope-access-for-a-private-custom-app/4890
- Custom app API token disabled over exposed credentials — https://community.shopify.dev/t/api-token-disabled-for-a-custom-app/3230
- Legacy custom apps workaround / store transfer — https://community.shopify.dev/t/legacy-custom-apps-workaround/32032
- Impossible to ask for `read_all_orders` access — https://community.shopify.com/t/impossible-to-ask-for-read-all-orders-access/276657
- Can't get `read_all_orders` approval without recreating app — https://community.shopify.com/t/cant-get-read-all-orders-scope-approval-without-recreating-our-app/266586

**Comparable apps**
- Wetracked App Store listing — https://apps.shopify.com/wetracked-io-connect
- Wetracked setup guide — https://help.wetracked.io/en/article/how-to-get-started-wetrackedio-for-shopify-stores-1h97xem/
- Triple Whale App Store listing — https://apps.shopify.com/triplewhale-1
- Triple Whale Shopify integration / Plus certification — https://www.triplewhale.com/integrations/shopify
- Triple Whale onboarding guide — https://kb.triplewhale.com/en/articles/5677051-onboarding-guide-account-setup *(Cloudflare-blocked; cited via search snippets)*
- Triple Whale third-party review — https://www.upcounting.com/blog/triplewhale-review
- GemPages App Store listing — https://apps.shopify.com/gempages
- GemPages install guide — https://help.gempages.net/articles/install-gempages-to-shopify-store
- Ecomwize store connection docs — https://docs.ecomwize.io/shopify/store-connection

**Could not verify**
- Whether a `read_all_orders` request has ever been approved (or denied) for a custom-distribution app specifically — no reports found in either direction.
- Shopify-documented app review duration; the page that once carried a timeline now redirects.
- What happens to an admin custom app token when the creating staff member is removed.
- Whether Triple Whale holds `read_all_orders` or protected-customer-data approval.
- Any published case of Shopify restricting the agency-uses-merchant-custom-app-token pattern on distribution grounds.
