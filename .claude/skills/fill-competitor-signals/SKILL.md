---
name: fill-competitor-signals
description: Fill the app with every tracked competitor's live Meta Ad Library ads, run from the operator's machine. Use when the user asks to refresh competitor ads or re-cluster a competitor.
---

# Competitor Signals fill harness

You are the harness. Collection and every LLM step run **here, on this machine** — the app never fetches the Ad Library and never calls an LLM for this feature (`docs/spec/competitor-signals-v1.md` §2). The server is the gatekeeper, the store, and the scorer; a fill is an authenticated push.

Steps 1–7 are the fill; steps 8–9 turn the ranked evidence into the standing test plan. A fill that stops after step 7 is complete and useful — the plan is a separate push and can be regenerated later without re-collecting.

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

Confirm the flags against `meta-ads-collector --help` before the first run — the installed version is the authority.

**Breakage canary (§11).** If a page *known to be active* (AIRWAAV) returns **zero ads**, or the collector errors on a Meta GraphQL shape change: **stop. Do not POST.** A zero-ad fill is valid at the API, but a known-active page returning zero is a collector break, and posting it would mark every live ad `noLongerSeenAt`. Report to the user, then either fix the collector or switch over (below). Shock Doctor returning 0–2 ads is *not* the canary — that page really is sparse.

**Fallback switch-over.** Rerun collection through **ScrapeCreators** (`SCRAPECREATORS_API_KEY`, on the remaining free credits), map its response to the same NormalizedAd shape, and POST with `source: "scrapecreators"`. Both sources return Meta's native snapshot shape, so steps 2–7 are byte-identical. If credits are near exhaustion, say so — that's the trigger to revisit paid vendors.

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
`title`, `endDate`, `ctaText`, `ctaType`, `linkDescription`, `collationId`, `collationCount`, `imageUrl`, `videoHdUrl`, `videoSdUrl`, `videoPreviewImageUrl`, `variants`, `mediaKinds`.

**`displayFormat` derivation.** MetaAdsCollector has no explicit format field — derive it:
- every creative has an empty `body` and they share one description → **`DPA`** (a product-catalog feed, see below);
- otherwise more than one creative in the card → `DCO` (or `CAROUSEL` when the source labels it a carousel);
- otherwise a single creative with a video URL → `VIDEO`, with only an image → `IMAGE`.

**`mediaKinds` — the same judgement, kept.** While deriving `displayFormat` you decide, creative by creative, whether it is video or image. Send that: `mediaKinds` is the distinct set across **all** the ad's creatives, primary and variants, as `["image"]`, `["video"]`, or `["image","video"]`. A creative with any video URL is `video`; one without is `image`.

This is what format breadth scores from (§8), and it must describe the competitor's creative — not our copy of it. Scoring used to fall back to the media the server had managed to mirror, which meant the same ads scored higher in an org that had mirrored them on an earlier fill, and a newly tracked competitor ranked below an incumbent for reasons that had nothing to do with its advertising. **Do not derive `mediaKinds` from whether a URL is present in the payload** — this collector returns no URL at all for image creatives, so URL-presence would report every image ad as having no media. Derive it from the same creative-shape rule you used for `displayFormat`. Send `null` only if you genuinely cannot tell.

**Catalog ads carry no copy.** A product-catalog ad is a feed of products — six creatives, each a different product and landing page, every `body` empty, one shared brand description across all of them. Take the shared `description` (falling back to `title`) as `bodyText` so the ad survives normalization. Dropping it instead is the dangerous path: the ad is genuinely live, and a fill that omits it stamps `noLongerSeenAt` on the competitor's whole ad history. Shock Doctor's only live US ad is exactly this shape.

**Primary + `variants[]` (never flatten, never explode).** 60/101 trial ads are DCO. Top-level copy/headline/media come from the **primary** creative; every additional creative becomes an entry in `variants[]`:
`{ bodyText: string|null, title: string|null, linkUrl: string|null, media: object|null }`. `variants: []` or `null` when there are none.

**Media URLs.** Pass the expiring signed `scontent.*` links through as-is — the server mirrors the primary creative's media immediately at ingest and never persists source URLs. Do not download or rewrite them here. Variant media is not mirrored in v1.

Where they live in the source: single-creative ads keep them in `raw_data.images[]` / `raw_data.videos[]`, but **card-based ads (DCO/carousel) keep them in `raw_data.cards[]`** (`original_image_url` / `resized_image_url` / `video_*_url` per card) — take the primary creative's from the first card. The server also recovers them from `raw` when all four top-level URLs are null (`src/lib/competitor-signals/raw-media.ts`), but send them explicitly; the fallback is a safety net, not the contract.

Step 2 is done when every ad collected in step 1 has a NormalizedAd carrying all 23 keys — required fields populated, nullable fields explicit `null`.

**The canary applies here too.** A fill is a full-snapshot replacement, so an ad dropped in normalization reads to the server as an ad that went dark. If step 2 yields fewer ads than step 1 collected, fix the mapping before posting — count them and compare, every run.

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
- `verdictRationale` — **1–3 sentences, written to be shown to the client**. This string is rendered verbatim as the "strategic read" on the signals screen: write it in the client's own language, direct and committed, as if a strategist put it in a deck.

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
      "mediaKinds": ["image", "video"],
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

The same GET drives the poll and feeds step 8, so keep the last response around.

```bash
curl -sS "$ADSOLUTE_URL/api/openapi/signals/rankedSignals" \
  -H "Authorization: Bearer $ADSOLUTE_API_KEY"
```

Poll every ~10s until every posted fill's `pipelineStatus` is `complete`. Stages: `received → mirroring → scoring → complete | failed`. On `failed`, **stop and report** the snapshot's `error` — do not re-POST blindly; the fill is already stored and a retried pipeline resumes from the failed stage.

A fill with no media at all lands at `complete` immediately (nothing to mirror).

---

## Step 8 — Generate the test plan

**You do this**, once, after every posted fill reads `complete`. One pass over the **whole ranking** — not just the competitors you filled this run. `rankedSignals` already returns `signals` sorted by score descending; take the **top 6**, tier-agnostic, across all competitors. Tier is deliberately ignored: a young roster may hold no HIGH clusters at all, and the generator still needs inputs.

Each of those clusters hands you: `label`, `angle`, `summary`, `adCount`, `score` and its five component points, `tier`, `verdictRationale` (the strategic read), `formatsObserved`, `landingFocusUrl`, `landingFocusShare`, `representativeCopy`, and the owning competitor. Put all of it in the prompt — the component breakdown is what lets a concept cite *why* a cluster is strong.

Prompt contract:

> You are drafting a creative test plan from competitor evidence.
> Client positioning: <one paragraph — the client's product, market, and angle>.
> Below are the top-ranked competitor copy clusters, each with its evidence: score components, strategic read, formats observed, landing-page focus, and representative copy.
> Return **3 concepts**. Each concept: a `title`; an `angle` (exactly one of the seven values); the `audience` it targets; `evidenceClusterIds` naming the clusters it draws on; an `evidenceCitation` of 1–2 sentences pointing at what was actually observed — how long the ads have run, how many creatives, which formats — and never at performance you cannot see; a `measurementPlan` naming the decision metric and the horizon; a `claimGuardrail` **only** where a product claim carries real risk, otherwise `null`; and exactly **3 hooks**.
> Then expand each concept's hooks into ad rows: every hook × `static` and `video` = 6 rows per concept, 18 in all.

Output schema:

```
concepts[]: { title, angle, audience, evidenceClusterIds[], evidenceCitation,
              measurementPlan, claimGuardrail | null, hooks[3],
              ads[]: { hook, format: "static" | "video" } }
```

Three rules that are easy to get wrong:

- **`angle` is hard-validated here**, unlike step 4. A plan concept's angle column is non-null, so an off-vocabulary value is a **400 on the whole push** — not a silent `null`. Use the seven `ANGLE_TYPES` values verbatim.
- **Every `ads[].hook` must be one of that concept's `hooks`**, character for character. A hook that drifted while expanding is a 400.
- **Never write budget guidance into any field.** The rule that scale and kill decisions follow measured CTR/CAC/ROAS in Adsolute — never evidence scores — is rendered by the app on every concept header, as a fixture the LLM cannot paraphrase away (§9). Repeating it in a citation or guardrail only dilutes it.

`claimGuardrail` is for product-claim risk (what a mouthguard ad must not promise), nothing else. Most concepts should be `null`.

## Step 9 — POST the test plan

`POST $ADSOLUTE_URL/api/openapi/signals/ingestTestPlan` — **one POST for the whole plan**, Bearer key, `write` scope.

```bash
curl -sS -X POST "$ADSOLUTE_URL/api/openapi/signals/ingestTestPlan" \
  -H "Authorization: Bearer $ADSOLUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @test-plan.json
```

Payload (`test-plan.json`):

```json
{
  "generatedSnapshotId": "<snapshotId of the newest fill in this run, or null>",
  "concepts": [
    {
      "title": "Breathing proof, athlete-first",
      "angle": "problem_solution",
      "audience": "Strength athletes who plateau on conditioning",
      "evidenceClusterIds": ["<clusterId>", "<clusterId>"],
      "evidenceCitation": "AIRWAAV has run this breathing-performance claim for 105 days across 16 creatives in both image and video, all pointing at one product page.",
      "measurementPlan": "Decide on CTR and CAC after 7 days or 1,000 clicks per ad, whichever lands first.",
      "claimGuardrail": "No performance-gain percentages — the product is not cleared to promise measured output.",
      "hooks": [
        "Stop gasping mid-set.",
        "Your conditioning isn't the problem.",
        "The breath you're not taking."
      ],
      "ads": [
        { "hook": "Stop gasping mid-set.", "format": "static" },
        { "hook": "Stop gasping mid-set.", "format": "video" }
      ]
    }
  ]
}
```

Response: `{ "conceptCount": 3, "adCount": 18, "replacedAdCount": <n>, "keptConceptCount": <n> }`.

Rules the server enforces:

- **Regeneration replaces `proposed` only.** Ads the client has moved to `approved`, `testing`, `done`, or `rejected` survive, and so does the concept header above them. `replacedAdCount` is what got wiped; `keptConceptCount` is what was left alone. Human decisions are never trampled — which is also why a regenerated concept can sit alongside a surviving one with a similar title. That is expected in v1; concepts have no stable identity across generations.
- **Unknown `angle` → 400**, **an `ads[].hook` outside its concept's `hooks` → 400**, **a `generatedSnapshotId` from another org → 404**.
- `evidenceClusterIds` are stored as given and never validated — clusters are wiped and rebuilt on every fill, so those ids go stale by design. The `evidenceCitation` is what has to survive; write it to stand on its own.
- Six concepts max, 24 ad rows per concept. The 3 × 3 × 2 shape is the client's default, not a server constraint.

---

## Report

At the end, tell the user per competitor: ads collected, distinct copies after dedup, clusters formed, verdict spread, `snapshotId`, and final `pipelineStatus`. If you generated a plan, add the concept titles, the ad count, and how many existing rows were replaced versus kept. Name anything skipped (canary stop, fallback source, poll unavailable, plan not regenerated).

Note what is deliberately absent from the app: there is **no in-app collect, no re-cluster, and no generate button** — all three require this device-side run. Re-score is the only in-app action, and moving a test-plan ad's status is the only in-app edit.
