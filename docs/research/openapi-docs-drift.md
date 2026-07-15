# Research: OpenAPI response-schema drift audit

Ticket: creatives-tracker #68 — "Research: response-schema drift in the generated OpenAPI doc"

Scope: every operation emitted by `src/lib/trpc/openapi.ts` (`getOpenApiProcedures()`), i.e. all
procedures carrying `openapi` meta minus the `abTest` router. Walking the live router yields
**73 operations** (the ticket said 69; the count has since grown — `metaSync` alone contributes 7).
Every operation's documented 200-response schema was compared against the procedure's actual
return shape in `src/lib/trpc/routers/*`.

## Summary

| Verdict | Count |
| --- | --- |
| accurate | 25 |
| drifted | 36 |
| untyped | 12 |
| **total** | **73** |

Worst offenders:

- **`adCreative.trackerList`, `getDailyPerformance`, `getDailyPortfolioPerformance`, `getMerAccountBreakdown`, `getAdPreviewUrl`** — all fall back to "one `ad_creative` table row" while actually returning arrays of computed/joined shapes with essentially zero overlapping fields.
- **Every `delete` mutation** (`adCreative`, `campaign`, `adSet`, `ad`, `performanceLog`, `adAccount`, plus `tag.detach`) documents a full table row but returns nothing (the REST wrapper serializes it as `null`).
- **`adAccount.delete`** additionally documents the raw `ad_account` row via the select fallback, which exposes the `metaAccessToken` column in the public doc — the very column `sanitizeAccount` exists to hide.
- **`adAccount.list/getById/create/update`** — the hand-maintained schema is a stale copy of `publicAdAccountSchema`: it is missing `defaultFacebookPageId`, `defaultInstagramActorId`, and `isDisabled`.
- **`tag.listForEntity`** — the one procedure with a special-cased schema documents `{tagId, tagName, tagColor, entityTagId}` but the procedure returns plain `tag` rows (`{id, name, color, organizationId, createdAt}`). The special case matches neither the fallback nor reality.
- **`metaSync.*` (7 ops)** — untyped `object` in the doc even though every procedure declares a precise `.output()` Zod schema inline in the router; the generator just never looks at `_def.output`. Easy win: honoring `.output()` would also fix `team.*` and `adAccount.*`.

A recurring minor caveat (noted per-row, not counted as drift): SQL aggregates over integer
columns (`sum`, `count`) come back from node-postgres as **strings** (Postgres `bigint`/`numeric`),
so fields documented as `number` (e.g. `logCount`, `totalConversions`) actually serialize as strings.

## Per-operation table

### adCreative (17 ops — 5 accurate, 12 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| adCreative.list | custom (`creativeListItemSchema[]`) | Array of computed creative rows with perf window + health fields | drifted | Actual items carry ~13 fields missing from the doc: `destinationUrl`, `teamId`, `firstSeen`, `recentCtr`, `recentCpc`, `avgCpc`, `avgFrequency`, `recentHookRate`, `priorHookRate`, `recentCpa`, `thumbstopRatio`, `health`, `healthReasons`. |
| adCreative.trackerList | select-fallback (single `ad_creative` row) | Array of performance-log join rows: `{adId, adName, creativeId, creativeName, assetUrl, videoUrl, format, ownership, destinationUrl, dateStart, dateEnd, spend, roas, cpa, ctr, conversions, impressions, linkClicks, purchaseValue, landingPageViews}` | drifted | Wrong container (object vs array) and wrong shape entirely — name doesn't match the `list`/`listBy*` heuristic so it isn't even wrapped in an array. |
| adCreative.dashboardStats | custom | `{portfolio, topPerformers[], bottomPerformers[], survivingCreatives[]}` | drifted | Doc omits the whole `survivingCreatives` array; performer items are missing `assetUrl`, `videoUrl`, `runningDays`, `isEvergreen`, `health`, `healthReasons`; bottom performers additionally return `bleederAdCount`, `activeAdCount`, `bleederSpend`, `bleederDollarsAtRisk`, `hasWinnerAd`, `bleederMetaIds`, `tier`. |
| adCreative.getDailyPortfolioPerformance | select-fallback (single `ad_creative` row) | Array of per-day aggregates `{dateStart, dateEnd, spend, purchaseValue, roas, cpa, ctr, conversions, impressions, reach, cpm, linkClicks}` | drifted | Zero field overlap with the documented creative row; also array vs object. |
| adCreative.getMerAccountBreakdown | select-fallback (single `ad_creative` row) | Array of per-account rows `{accountId, accountName, spend, revenue, roas, priorSpend, priorRoas, spendDelta, roasDelta, sparkline[]}` | drifted | Zero field overlap; array vs object. |
| adCreative.getById | custom (`creativeGetByIdSchema`) | Creative row + `destinationUrl` (subquery) + `teamId` | drifted | Minor: doc is missing `destinationUrl` and `teamId`. |
| adCreative.getAdPreviewUrl | select-fallback (single `ad_creative` row) | `{previewUrl: string \| null}` | drifted | Documents a full creative row; actual is a single-key object. |
| adCreative.fetchMetaPreview | select-fallback (single `ad_creative` row) | `MetaCreativePreview`: `{assetUrl, format, videoUrl?, destinationUrl?, caption?}` | drifted | Documents a creative table row; actual is the Meta preview helper shape from `src/lib/meta-creative-assets.ts`. |
| adCreative.create | select-fallback | Full inserted `ad_creative` row (`.returning()`) | accurate | |
| adCreative.update | select-fallback | Full updated `ad_creative` row | accurate | Throws NOT_FOUND when missing. |
| adCreative.duplicate | select-fallback | Full inserted `ad_creative` row | accurate | |
| adCreative.bulkUpdateOwnership | select-fallback (single `ad_creative` row) | `{updated: number}` | drifted | Bulk mutation returns a count object, not a row. |
| adCreative.bulkUpdateTeam | select-fallback (single `ad_creative` row) | `{updated: number}` | drifted | Same as above. |
| adCreative.bulkImport | custom | `{created: {id,name}[], totalRows, uniqueAds, perfLogs}` | accurate | Router explicitly re-picks these four keys from `importMetaRows` (which itself returns more). |
| adCreative.getPerformance | custom | `{totalSpend, avgRoas, avgCpa, avgCtr, totalConversions, totalImpressions, totalClicks, logCount, minDate, maxDate, portfolioAvg*, liveStatus}` | accurate | Field-for-field match. Caveat: `totalConversions`/`totalImpressions`/`totalClicks`/`logCount` are documented as numbers but serialize as strings (bigint sums via node-postgres). |
| adCreative.getDailyPerformance | select-fallback (single `ad_creative` row) | Array of per-log-window aggregates `{dateStart, dateEnd, spend, purchaseValue, roas, cpa, ctr, conversions, impressions, reach, cpm, linkClicks}` | drifted | Zero field overlap; array vs object. |
| adCreative.delete | select-fallback (single `ad_creative` row) | `undefined` → REST wrapper returns `null` | drifted | Documents a full row, returns null. |

### campaign (7 ops — 5 accurate, 2 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| campaign.list | select-fallback (array) | Array of full `campaign` rows | accurate | |
| campaign.getById | select-fallback | Full `campaign` row | accurate | |
| campaign.create | select-fallback | Full inserted row | accurate | |
| campaign.update | select-fallback | Full updated row | accurate | Returns `undefined`→`null` if id not found (no throw) — edge case only. |
| campaign.duplicate | select-fallback | Full inserted row | accurate | |
| campaign.bulkImport | select-fallback (single `campaign` row) | Array of `{id, name}` | drifted | Array of two-key objects vs one full row. |
| campaign.delete | select-fallback (single `campaign` row) | `undefined` → `null` | drifted | Documents a full row, returns null. |

### adSet (8 ops — 3 accurate, 5 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| adSet.list | select-fallback (array of `ad_set` rows) | Joined rows: table fields + `campaignName`, `accountName`, `accountMetaAccountId`, `adCount`; no `organizationId` | drifted | Adds 4 joined/computed fields the doc lacks; omits `organizationId`. |
| adSet.listByCampaign | select-fallback (array of `ad_set` rows) | 10-field subset `{id, name, accountId, metaId, costCap, dailyBudget, status, notes, createdAt, adCount}` | drifted | Doc promises the full table row (targeting, geos, placements, schedule, updatedAt...); actual is a slim subset plus computed `adCount`. |
| adSet.getById | select-fallback (single row) | Table fields + `campaignName`, `accountName`, `accountMetaAccountId`; no `organizationId` | drifted | Joined fields undocumented. |
| adSet.create | select-fallback | Full inserted row | accurate | |
| adSet.update | select-fallback | Full updated row | accurate | Throws NOT_FOUND when missing. |
| adSet.duplicate | select-fallback | Full inserted row | accurate | |
| adSet.bulkImport | select-fallback (single row) | Array of `{id, name}` | drifted | Array of two-key objects vs one full row. |
| adSet.delete | select-fallback (single row) | `undefined` → `null` | drifted | Documents a full row, returns null. |

### ad (10 ops — 3 accurate, 7 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| ad.list | select-fallback (array of `ad` rows) | Joined subset `{id, name, adSetId, adSetName, campaignId, campaignName, adCreativeId, adCreativeName, destinationUrl, status, notes, createdAt, updatedAt}` | drifted | Adds joined names; omits `accountId`, `caption`, `metaId`, `metaImageHash/VideoId/CreativeId`, `rawMeta*Status`, `organizationId`, `enrichmentAttemptedAt`; `status` is the computed effective status, not the raw column. |
| ad.listByAdSet | select-fallback (array of `ad` rows) | 8-field joined subset `{id, name, adCreativeId, adCreativeName, destinationUrl, status, notes, createdAt}` | drifted | Same class of drift as `ad.list`, even slimmer. |
| ad.listByCreative | select-fallback (array of `ad` rows) | Per-ad aggregate rows: `{id, metaId, name, caption, adSetId, adSetName, campaignName, destinationUrl, status, notes, createdAt, totalSpend, avgRoas, totalConversions, runningDays, disableTier, minDate, maxDate}` | drifted | Heavy computed shape (spend/ROAS aggregates, `disableTier` pause recommendation) nothing like the table row. |
| ad.getById | select-fallback (single row) | Joined subset (same shape as `ad.list` items) | drifted | Joined names undocumented; many table columns never returned. |
| ad.create | select-fallback | Full inserted row | accurate | |
| ad.update | select-fallback | Full updated row | accurate | Throws NOT_FOUND when missing. |
| ad.pauseMetaAds | select-fallback (single `ad` row) | `{paused: {id, metaId, name}[], failed: {id, metaId, name, error, metaPaused?}[]}` | drifted | Result-report object, zero overlap with an ad row. |
| ad.duplicate | select-fallback | Full inserted row | accurate | |
| ad.bulkImport | select-fallback (single `ad` row) | Array of `{adId, name}` (or `[]`) | drifted | Array of two-key objects vs one full row; key is `adId`, not `id`. |
| ad.delete | select-fallback (single row) | `undefined` → `null` | drifted | Documents a full row, returns null. |

### performanceLog (6 ops — 4 accurate, 2 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| performanceLog.listAll | select-fallback (array) | Array of full `performance_log` rows | accurate | |
| performanceLog.listByAd | select-fallback (array) | Array of full rows | accurate | |
| performanceLog.create | select-fallback | Full upserted row | accurate | |
| performanceLog.bulkCreate | select-fallback (single row) | Array of full upserted rows (`[]` when input empty) | drifted | Name doesn't match `list*` heuristic, so the doc misses the array wrapper. |
| performanceLog.update | select-fallback | Full updated row | accurate | Returns `undefined`→`null` if id not found — edge case only. |
| performanceLog.delete | select-fallback (single row) | `undefined` → `null` | drifted | Documents a full row, returns null. |

### tag (4 ops — 1 accurate, 3 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| tag.search | select-fallback (single `tag` row) | Array of `tag` rows | drifted | Row shape is right but `search` doesn't match the `list*` heuristic, so the array wrapper is missing. |
| tag.listForEntity | select-fallback special case (`{tagId, tagName, tagColor, entityTagId}[]`) | Array of plain `tag` rows: `{id, name, color, organizationId, createdAt}` | drifted | The hand-written special case matches an older flattened join shape; the procedure now returns `rows.map(r => r.tag)`. |
| tag.attach | select-fallback (single `tag` row) | Full `tag` row (found or created) | accurate | |
| tag.detach | select-fallback (single `tag` row) | `undefined` → `null` | drifted | Documents a full row, returns null. |

### adAccount (5 ops — 0 accurate, 5 drifted)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| adAccount.list | custom | Array of `publicAdAccountSchema` objects | drifted | Custom doc is a stale copy: missing `defaultFacebookPageId`, `defaultInstagramActorId`, `isDisabled` (all present in the router's own `.output()` schema). |
| adAccount.getById | custom | `publicAdAccountSchema` object | drifted | Same 3 missing fields. |
| adAccount.create | custom | `publicAdAccountSchema` object | drifted | Same 3 missing fields. |
| adAccount.update | custom | `publicAdAccountSchema` object | drifted | Same 3 missing fields. |
| adAccount.delete | select-fallback (full `ad_account` table row) | `undefined` → `null` | drifted | No custom entry, so the fallback documents the raw table row — **including the `metaAccessToken` column** — while the procedure returns nothing. |

### apiKey (4 ops — 4 accurate)

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| apiKey.list | custom | Array of `{id, name, prefix, scopes, lastUsedAt, expiresAt, revokedAt, createdAt, createdByUserId}` | accurate | Exact column-for-column match. |
| apiKey.create | custom | `{id, name, prefix, scopes, expiresAt, createdAt, key}` | accurate | |
| apiKey.revoke | custom | `{id, revokedAt}` | accurate | |
| apiKey.delete | custom | `{id}` | accurate | |

### team (5 ops — 5 untyped)

`team` is missing from both `selectSchemas` and `TAG_METADATA`, so every operation documents
`{type: "object", additionalProperties: true}` — despite the router declaring a `teamSchema`
`.output()` on list/getById/create/update.

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| team.list | none | **Array** of `team` rows `{id, name, notes, organizationId, createdAt, updatedAt}` | untyped | Doc says `object`; actual is an array — wrong container on top of being untyped. |
| team.getById | none | `team` row | untyped | |
| team.create | none | Inserted `team` row | untyped | |
| team.update | none | Updated `team` row | untyped | |
| team.delete | none | `undefined` → `null` | untyped | |

### metaSync (7 ops — 7 untyped)

`metaSync` is also absent from `selectSchemas`/`TAG_METADATA`; every operation documents an
untyped `object`. Ironically, **every one of these procedures declares a precise `.output()` Zod
schema in `meta-sync.ts`** that the generator ignores (it only reads `_def.inputs`, never
`_def.output`). Honoring `.output()` when present would fix this whole router (and team/adAccount).

| Operation | Schema source | Actual return shape | Verdict | Note |
| --- | --- | --- | --- | --- |
| metaSync.listSyncableAccounts | none | **Array** of `{accountId, name, metaAccountId, lastSyncedAt, dataDateEnd, isStale, suggestedDateFrom, suggestedDateTo, gapDays}` | untyped | Doc says `object`; actual is an array. |
| metaSync.startReport | none | `{syncRunId, reportRunId}` | untyped | |
| metaSync.pollReport | none | `{phase, percentComplete, ready, errorMessage}` | untyped | |
| metaSync.importReport | none | `{done, nextCursor, importedThisCall, totalImported}` | untyped | |
| metaSync.refreshStatuses | none | `{ads: {checked, updated}, adSets: {checked, updated}}` | untyped | |
| metaSync.enrichPreviews | none | `{updatedAds, updatedCreatives, remaining}` | untyped | |
| metaSync.listRecentRuns | none | `{runs: publicAccountSyncRunSchema[], nextCursor}` | untyped | |

## Systemic patterns behind the drift

1. **The select fallback assumes CRUD-on-a-table.** Any procedure returning computed, joined, or aggregate shapes (analytics queries, bulk mutations, Meta helpers) gets a wrong doc by construction.
2. **The array heuristic is name-based** (`list` / `listBy*` / `listAll*`), so `trackerList`, `search`, `bulkCreate`, `bulkImport` and the daily-performance queries all lose their array wrapper.
3. **`delete`/`detach` mutations return `undefined`** but the fallback documents a full row for all of them.
4. **Hand-maintained schemas rot** (`adAccount.*` missing 3 fields, `tag.listForEntity` matching a removed shape, `adCreative.list`/`dashboardStats` trailing the router by many fields).
5. **`.output()` schemas already exist** for `team`, `metaSync`, and `adAccount` but are never consulted — reading `procedure._def.output` before falling back would eliminate all 12 untyped ops and the adAccount drift in one change.
