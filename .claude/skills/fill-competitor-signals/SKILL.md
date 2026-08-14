---
name: fill-competitor-signals
description: Run one Competitor Signals fill (collect → normalize → dedup → cluster → verdicts → POST → poll) for every tracked competitor from the operator's machine. Use when the user asks to run a competitor-signals fill, refresh competitor ad data, or re-cluster a competitor's Ad Library snapshot.
---

# Competitor Signals fill harness

You are the harness. Collection and every LLM step run **here, on this machine** — the app never fetches the Ad Library and never calls an LLM for this feature (`docs/spec/competitor-signals-v1.md` §2). The server is the gatekeeper, the store, and the scorer; a fill is an authenticated push.

Steps 1–7 below are the whole fill. Steps 8–9 (test-plan generation) are Phase 3 and are **not shipped** — see the end of this file.

## Competitors

There is no OpenAPI read for the tracked list (`signals.listCompetitors` is an in-app `orgProcedure`, session-auth only). Keep the roster here and update it when the client adds a competitor:

| Name | `metaPageId` | Notes |
|---|---|---|
| AIRWAAV | `109178280892310` | Known-active — the breakage canary (§11) |
| Shock Doctor | `92823337978` | Genuinely sparse (1 active US ad in the trial); zero-ish is normal here |

Get a `metaPageId` from the Ad Library URL for the brand: `https://www.facebook.com/ads/library/?view_all_page_id=<metaPageId>`. It must match a tracked competitor row in the app, or `ingestFill` returns `NOT_FOUND` (`No tracked competitor for Meta page <id>`); add it in-app at `/competitors` first.

## Prerequisites

Check all four before step 1. Stop and ask the user if any is missing — do not improvise around them.

1. **`meta-ads-collector`** (MetaAdsCollector, MIT, $0 — https://github.com/promisingcoder/MetaAdsCollector). Python 3.9+.
   ```bash
   pip install meta-ads-collector
   meta-ads-collector --help   # confirm the flags below exist in the installed version
   ```
2. **`ADSOLUTE_API_KEY`** — an `ask_`-prefixed org API key with **`write`** scope (step 7's poll additionally needs `read`). Sent as `Authorization: Bearer $ADSOLUTE_API_KEY`.
3. **`ADSOLUTE_URL`** — app base URL, default `https://<your-adsolute-domain>` (use `http://localhost:3000` when testing against a dev server).
4. **Residential IP.** Collection must not run from a datacenter IP (VPN off, no cloud shell) — that is the reason collection is device-side at all. If the collector returns empty or challenge pages, suspect the IP before suspecting the tool.

```bash
echo $ADSOLUTE_API_KEY | cut -c1-4    # expect: ask_
: "${ADSOLUTE_URL:=https://<your-adsolute-domain>}"
```

---

## Step 1 — Collect

One collector run per competitor page: country **US**, **active** ads, capped at **200** (the fill cap, §4).

```bash
meta-ads-collector \
  --page-url "https://www.facebook.com/ads/library/?view_all_page_id=<metaPageId>" \
  -c US -s active -n 200 \
  -o "raw-<name>.json"
```

Flags (verify against `--help`): `-c/--country` ISO-3166 alpha-2, `-s/--status` `active|inactive|all`, `-n/--max-results`, `-o/--output` (required), `--page-url`, `--page-ids`, `--page-name`. The Python API equivalent is `MetaAdsCollector().collect_by_page_id("<metaPageId>", country="US")`.

**Breakage canary (§11).** If a page *known to be active* (AIRWAAV) returns **zero ads**, or the collector errors on a Meta GraphQL shape change: **stop. Do not POST.** A zero-ad fill is valid at the API, but a known-active page returning zero is a collector break, and posting it would mark every live ad `noLongerSeenAt`. Report to the user, then either fix the collector or switch over (below). Shock Doctor returning 0–2 ads is *not* the canary — that page really is sparse.

**Fallback switch-over.** Rerun collection through **ScrapeCreators** (`SCRAPECREATORS_API_KEY`, ~89 free credits), map its response to the same NormalizedAd shape, and POST with `source: "scrapecreators"`. Both sources return Meta's native snapshot shape, so steps 2–7 are byte-identical. If credits are near exhaustion, say so — that's the trigger to revisit paid vendors.

## Step 2 — Normalize

Map raw → **NormalizedAd** (§4). One NormalizedAd per **archive ID**. Field names are exact — the server's zod schema (`src/lib/trpc/routers/signals.ts`) rejects nothing silently.

**Required** (0/101 empty in the trial — a missing value fails that ad):

| Field | Type | Source |
|---|---|---|
| `archiveId` | string | ad archive id |
| `pageId` | string | must equal the competitor's `metaPageId` |
| `pageName` | string | page name |
| `isActive` | boolean | active delivery |
| `startDate` | ISO 8601 string | delivery start |
| `bodyText` | string | **primary** creative body |
| `linkUrl` | string | true destination — no redirect unwrapping needed |
| `displayFormat` | `IMAGE`\|`VIDEO`\|`CAROUSEL`\|`DCO`\|`DPA` | **derived** (below) |
| `publisherPlatforms` | string[] | e.g. `["FACEBOOK","INSTAGRAM"]` |
| `raw` | any | the **verbatim** source payload for this ad |

**Nullable** — send explicit `null`, never omit the key (repo convention: `.nullable()`, never `.optional()`):
`title`, `endDate`, `ctaText`, `ctaType`, `linkDescription`, `collationId`, `collationCount`, `imageUrl`, `videoHdUrl`, `videoSdUrl`, `videoPreviewImageUrl`, `variants`.

**`displayFormat` derivation.** MetaAdsCollector has no explicit format field — derive it:
- more than one creative in the card → `DCO` (or `CAROUSEL` when the source labels it a carousel);
- product-catalog ad → `DPA`;
- otherwise a single creative with a video URL → `VIDEO`, with only an image → `IMAGE`.

**Primary + `variants[]` (never flatten, never explode).** 60/101 trial ads are DCO. Top-level copy/headline/media come from the **primary** creative; every additional creative becomes an entry in `variants[]`:
`{ bodyText: string|null, title: string|null, linkUrl: string|null, media: object|null }`. `variants: []` or `null` when there are none.

**Media URLs.** Pass the expiring signed `scontent.*` links through as-is — the server mirrors the primary creative's media immediately at ingest and never persists source URLs. Do not download or rewrite them here. Variant media is not mirrored in v1.

## Step 3 — Dedup

Plain code, no LLM. Group ads by exact match on the normalized body: **lowercase → collapse internal whitespace → trim**.

```js
const key = (bodyText) => bodyText.toLowerCase().replace(/\s+/g, " ").trim();
```

The trial collapsed 101 ads → 65 distinct keys. Only the **distinct copies** go into step 4's prompt (carry each key's member archive IDs alongside, so clusters can be expanded back to every ad). No fuzzy matching — the LLM groups paraphrases; `collationId` is useless for grouping (97 distinct across 100 ads).

## Step 4 — Cluster

**You do this** — one structured-output pass per competitor over that competitor's distinct copies.

Prompt contract:

> You are grouping a competitor's live Meta ads into message clusters.
> Client positioning: <one paragraph — the client's product, market, and angle>.
> Competitor: <name>. Below are the distinct ad copies (deduplicated), each with its archive IDs.
> Return clusters covering **every** ad. Rules: `label` ≤ 6 words; `angle` is exactly one of the seven values listed; `summary` is 1–2 sentences describing the shared message; `memberArchiveIds` lists every archive ID in the cluster. Every ad appears in **exactly one** cluster. Single-ad clusters are allowed and expected.

Output schema per cluster: `{ label, angle, summary, memberArchiveIds[] }`.

`angle` ∈ **ANGLE_TYPES** (`src/lib/creative-taxonomy.ts` — competitor clusters and own creatives share one vocabulary):
`problem_solution`, `social_proof`, `comparison`, `transformation`, `skepticism`, `offer_promo`, `education`.

An off-vocabulary `angle` is not a hard failure — the gatekeeper normalizes it and stores `null` — but aim for the seven. No embeddings: ~65 distinct copies fit one context trivially.

Before moving on, verify: every archive ID from step 2 appears in exactly one cluster's `memberArchiveIds`, and no ID appears twice.

## Step 5 — Verdicts

Per cluster, still device-side:

- `verdict` ∈ `high` | `medium` | `low` — the cluster's **relevance to the client's positioning**, not its quality.
- `verdictRationale` — **1–3 sentences, written to be shown to the client**. This string is rendered verbatim as the "strategic read" on the signals screen. No hedging, no internal jargon, no mention of this workflow.

An invalid verdict does not block the fill: the server nulls the rationale, contributes 0 to the strategic component (15 pts), and the UI flags "strategic read unavailable". Getting it right is worth 15/100 of the score.

## Step 6 — POST the fill

`POST $ADSOLUTE_URL/api/openapi/signals/ingestFill` — **one POST per competitor**, Bearer key, `write` scope.

```bash
curl -sS -X POST "$ADSOLUTE_URL/api/openapi/signals/ingestFill" \
  -H "Authorization: Bearer $ADSOLUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @fill-airwaav.json
```

Payload (`fill-<name>.json`):

```json
{
  "competitorPageId": "123456789",
  "source": "meta_ads_collector",
  "ads": [
    {
      "archiveId": "1234567890123456",
      "pageId": "123456789",
      "pageName": "AIRWAAV",
      "isActive": true,
      "startDate": "2026-05-02T00:00:00.000Z",
      "bodyText": "Breathe better. Train harder.",
      "linkUrl": "https://airwaav.com/products/performance-mouthpiece",
      "displayFormat": "DCO",
      "publisherPlatforms": ["FACEBOOK", "INSTAGRAM"],
      "raw": { "…": "verbatim source payload" },
      "title": "AIRWAAV Performance Mouthpiece",
      "endDate": null,
      "ctaText": "Shop now",
      "ctaType": "SHOP_NOW",
      "linkDescription": null,
      "collationId": "987654321",
      "collationCount": 4,
      "imageUrl": "https://scontent.xx.fbcdn.net/…",
      "videoHdUrl": null,
      "videoSdUrl": null,
      "videoPreviewImageUrl": null,
      "variants": [
        {
          "bodyText": "Stop gasping mid-set.",
          "title": null,
          "linkUrl": "https://airwaav.com/products/performance-mouthpiece",
          "media": { "imageUrl": "https://scontent.xx.fbcdn.net/…" }
        }
      ]
    }
  ],
  "clusters": [
    {
      "label": "Breathing performance proof",
      "angle": "problem_solution",
      "summary": "Ads frame mouth-breathing as the limiter and the mouthpiece as the fix. Athlete demos carry the claim.",
      "memberArchiveIds": ["1234567890123456", "1234567890123457"],
      "verdict": "high",
      "verdictRationale": "This is the same performance-breathing claim we compete on, and they are running it across four creatives. Worth a direct counter-test."
    }
  ]
}
```

Response: `{ "snapshotId": "<uuid>", "adCount": <n> }`.

Rules the server enforces:

- **200-ad cap** per fill — more than 200 `ads` is rejected outright.
- **Duplicate `archiveId` within one fill → 400.** Dedup by archive ID before posting (step 3 dedups *copy*, not IDs — both matter).
- **One POST = the full active-ad snapshot** for that page. Ads the server has but the payload omits get stamped `noLongerSeenAt`; ads that reappear are un-stamped. This is why the canary in step 1 is a hard stop.
- **Idempotent** — re-posting the same snapshot is safe.
- **Zero ads is a valid fill** (`"ads": []`): the run is still recorded, and every previously-live ad is marked no-longer-seen. Only post it when zero is genuinely true.
- **Untracked page → 404**; **bad/missing key → 401**; malformed ads fail validation per ad.
- `source` is `meta_ads_collector` or `scrapecreators`.
- `clusters` may be `null` (Phase 1 behavior). With clusters present, the competitor's clusters are wiped and rebuilt from this payload — cluster ids are not stable across fills.

## Step 7 — Poll

**`signals.rankedSignals` ships with Phase 2 and may not exist yet.** Try it; if it 404s, skip the poll and tell the user to check the `/competitors` cards screen, whose last-fill line shows `pipelineStatus` per competitor.

```bash
curl -sS "$ADSOLUTE_URL/api/openapi/signals/rankedSignals" \
  -H "Authorization: Bearer $ADSOLUTE_API_KEY"
```

Poll every ~10s until every posted fill's `pipelineStatus` is `complete`. Stages: `received → mirroring → scoring → complete | failed`. On `failed`, **stop and report** the snapshot's `error` — do not re-POST blindly; the fill is already stored and a retried pipeline resumes from the failed stage.

A fill with no media at all lands at `complete` immediately (nothing to mirror).

---

## Report

At the end, tell the user per competitor: ads collected, distinct copies after dedup, clusters formed, verdict spread, `snapshotId`, and final `pipelineStatus`. Name anything skipped (canary stop, fallback source, poll unavailable).

## Not yet: steps 8–9 (Phase 3)

Test-plan generation is **not shipped**. Once `signals.ingestTestPlan` exists, this skill gains:

8. **Generate the plan** — one LLM call over the top ~6 ranked clusters by score (tier-agnostic, across all competitors) → 3 concepts × 3 hooks, expanded ×2 formats = 18 ad rows.
9. **POST `signals.ingestTestPlan`** — replaces `proposed` ads only; `approved/testing/done/rejected` rows are never trampled.

Do not hand-write test plans through this skill in the meantime. Also note what is deliberately absent from the app: there is **no in-app collect and no in-app re-cluster button** — both require this device-side run. Re-score is the only in-app action.
