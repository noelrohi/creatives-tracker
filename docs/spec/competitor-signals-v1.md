# Competitor Signals v1 — build-ready spec

The destination of the [Competitor Signals v1 wayfinder map (#146)](https://github.com/noelrohi/creatives-tracker/issues/146): a competitor ad-intelligence tool over the public Meta Ad Library — collect → cluster → score → recommend a creative test plan — per the [Competitor Signals MVP plan artifact](https://claude.ai/code/artifact/cf9626af-56a7-4f6e-92e4-859e8142f599). Every decision below was locked in tickets [#147](https://github.com/noelrohi/creatives-tracker/issues/147)–[#154](https://github.com/noelrohi/creatives-tracker/issues/154); this document compiles them. Where an earlier assumption was superseded by a later decision, the supersession is noted inline — nothing here re-litigates.

**The architectural invariant that shapes everything:** collection and all LLM work run **device-side** on the operator's machine; the server is the gatekeeper, the store, and the (pure-function) scorer. The app never fetches from the Ad Library and never calls an LLM for this feature. Fills arrive as authenticated pushes; the dashboard reads what the last fill left behind.

**The honesty invariant:** scores reflect *observable evidence* — longevity, variant counts — never measured ad performance. Every surface that shows a score also says so (§10).

---

## 1. Ground facts

From the live vendor trial ([#149](https://github.com/noelrohi/creatives-tracker/issues/149), captures in [docs/research/ad-library-trial](https://github.com/noelrohi/creatives-tracker/tree/research/ad-library-vendors/docs/research/ad-library-trial) on `research/ad-library-vendors`; 101 real ads: AIRWAAV ×100, Shock Doctor ×1):

| Fact | Value | Consequence |
|---|---|---|
| AIRWAAV active US ads | 143 (trial capped at 100 → silently dropped 30%) | Fill cap raised to **200 ads/page** (#150) |
| Shock Doctor active US ads | **1** | Young/sparse accounts are the *normal* case; screens need real empty states |
| Creative mix | 60/101 ads are DCO; `collation_count` groups variants | Contract is primary + `variants[]`, never flatten or explode (#150) |
| Null rates | title 2%, linkDescription 25%, collationId 3% | Drives required-vs-nullable split in the contract (§4) |
| Media URLs | Expiring signed `scontent.*` CDN links | **Mirror at ingest, immediately** — never persist source URLs as the display copy (#150) |
| Pagination | 30-then-10 ads/page | Runbook detail only; the contract is page-shaped, not request-shaped |
| `link_url` | True destination, no redirect indirection | Landing-page focus scoring needs no unwrapping (§8) |
| Dedup shape | 101 ads → 65 distinct normalized bodies; 46 collapse into 10 groups | Exact-match dedup pre-pass is enough; no fuzzy rules (#152) |
| MetaAdsCollector parity | 84/100 shared archive ids vs paid vendor same-day, 1/1 on Shock Doctor, same null rates | The $0 OSS collector is trustworthy as primary (#150) |
| Vendor freshness | All vendors (and Meta's own UI) lag indexing ~24–48h | Never promise recency (#147) |

Client parameters ([#148](https://github.com/noelrohi/creatives-tracker/issues/148)): competitors **AIRWAAV** and **Shock Doctor** (sports mouthguards; list expandable anytime); market **mostly US + some AU** (competitors do run EU ads — official `ads_archive` would be a supplement at best, and is ruled out for v1); data budget **$100/month ceiling** with **manual-trigger cadence** (actual spend: $0/fill); test matrix **3 × 3 × 2 = 18 ads** (client-deferred default, veto rights, parameterized in the generator).

---

## 2. Architecture — collection is a push, not a server fetch

Locked in [#150](https://github.com/noelrohi/creatives-tracker/issues/150), extended by [#152](https://github.com/noelrohi/creatives-tracker/issues/152) and [#154](https://github.com/noelrohi/creatives-tracker/issues/154). *Supersession: the plan artifact's server-side `fetchPageAds` adapter and Trigger.dev collect job are dead — collection cannot run from datacenter IPs, and the harness agent is already in the loop for every fill.*

```
Operator device (residential IP, Claude Code harness on subscription tokens)
  1. MetaAdsCollector per tracked competitor        → raw ads
  2. Normalize to NormalizedAd (§4)                 → snapshot
  3. Dedup pre-pass (exact normalized-body match)   → distinct copies
  4. LLM cluster pass (one call per competitor)     → clusters[]
  5. LLM strategic verdicts (per cluster)           → verdicts
  6. POST signals.ingestFill  ──────────────────────→ server
                                                       gatekeeper validation (§5)
                                                       upsert ads, rebuild clusters
                                                       Trigger.dev: mirror media → score
  7. GET ranked signals (poll until scored) ←────────  cross-fill, cross-competitor ranking
  8. LLM test-plan generation (top ~6 clusters)     → plan
  9. POST signals.ingestTestPlan ───────────────────→ server replaces `proposed` ads only
```

- **Server runs no LLM and no collection.** Re-score is possible in-app anytime (pure function over stored inputs); **re-cluster and plan regeneration require the device** — no in-app buttons for either (#152, #153, #154).
- **Dashboard:** no "Collect new data" trigger anywhere; the competitors screen shows **last fill** per competitor (#150, #153).
- **Vendors:** primary is [MetaAdsCollector](https://github.com/promisingcoder/MetaAdsCollector) (`meta-ads-collector` v1.4.0, MIT, $0), run device-side. Break-glass fallback is **ScrapeCreators** (89 free credits remain; key `SCRAPECREATORS_API_KEY`, stub on the research branch's `.env.example`) behind the same NormalizedAd contract — the harness runs identical dedup/cluster/verdict steps over either source. SearchAPI.io stays un-trialed, named only in [the vendor research (#147)](https://github.com/noelrohi/creatives-tracker/issues/147). Official `ads_archive` is ruled out for v1 (EU-reached ads only; client market is US/AU).

---

## 3. Data model — seven tables

Locked in [#151](https://github.com/noelrohi/creatives-tracker/issues/151) (five tables), amended by #152 (pipeline stages, scoring columns), extended by #154 (two test-plan tables). Conventions: text UUID PKs (`crypto.randomUUID()`), nullable un-FK'd `organizationId` pattern, `createdAt`/`updatedAt`, org-scoped uniques. Schema files under `src/schema/`, kept **fully separate from `ad`/`ad_creative`** — zero-spend competitor rows never touch spend queries.

### `competitor`
`id`, `organizationId`, `metaPageId`, `name`, `status` (`active | archived`), timestamps. Unique `(organizationId, metaPageId)`.

### `intel_snapshot` — a fill-run log, not an immutable copy
*Supersession: the plan artifact's "immutable snapshot" language is retired (#151).* One row per fill POST: `id`, `organizationId`, `competitorId`, `source` (`meta_ads_collector | scrapecreators`), `adCount`, `pipelineStatus` (`received → mirroring → scoring → complete | failed` — *the `clustering` stage was removed by #152; clusters arrive in the payload*), `error`, `mirroredCount`, `filledAt`, timestamps. Zero-ad fills still get a row. Latest row per competitor powers the "last fill" display. `pipelineStatus` doubles as pipeline resume state (§6).

### `competitor_ad` — living rows, upserted by archive ID
`id`, `organizationId`, `competitorId`, `archiveId` (unique `(organizationId, archiveId)`), `startDate`, `endDate`, `bodyText`, `title`, `linkUrl`, `linkDescription`, `ctaText`, `ctaType`, `displayFormat`, `publisherPlatforms` (jsonb), `collationId`, `collationCount`, `variants` (jsonb — additional creatives per §4), `raw` (jsonb, verbatim source payload), `mirroredImageUrl`, `mirroredVideoUrl`, `mirroredPreviewUrl`, `firstSeenAt`, `lastSeenAt`, `noLongerSeenAt` (null = active; set when absent from a fill, cleared on reappearance), `copyClusterId` (nullable), `lastSnapshotId`, timestamps.

### `copy_cluster` — wiped and rebuilt per fill
Attaches **per competitor**; each pipeline run deletes and rebuilds that competitor's clusters in one transaction, stamping the triggering `intel_snapshot` as provenance. Cluster ids are **not stable across runs** — accepted for v1; nothing references them externally, and the future multi-snapshot upgrade is additive. Columns: `id`, `organizationId`, `competitorId`, `snapshotId`, `label`, `angle` (nullable — `ANGLE_TYPES` value or null when the gatekeeper rejects it), `summary`, `adCount`, and the #152 scoring columns: `score` (0–100), `tier` (`high | moderate | watch`), per-component points (`longevityPoints`, `variantPoints`, `strategicPoints`, `formatPoints`, `landingPoints`), `verdict` (`high | medium | low` | null), `verdictRationale` (null when the verdict was invalid → UI flags "strategic read unavailable"), timestamps.

### `test_plan_concept` and `test_plan_ad`
*Supersession: #151's `test_plan_item` skeleton is replaced by #154's two-table shape.*

- **`test_plan_concept`** (×3 per plan): `id`, `organizationId`, `title`, `angle` (`ANGLE_TYPES`), `audience`, `evidenceClusterIds` (jsonb), `evidenceCitation` (1–2 sentences), `measurementPlan` (decision metric + horizon), `claimGuardrail` (nullable — product-claim risks only), `hooks` (jsonb, exactly 3), provenance (`generatedSnapshotId`, `generatedAt`), timestamps.
- **`test_plan_ad`** (×18 per plan): `id`, `organizationId`, `conceptId`, `hook`, `format` (`static | video`), `status` (`proposed | approved | testing | done | rejected`), `sortOrder`, timestamps.

Per repo zod convention: every payload field required or `.nullable()` — never `.optional()`.

### Migration plan
One migration: `bun run db:generate` after adding the seven schema files, `bun run db:migrate` to apply, `node scripts/check-migrations.mjs` before the PR. No changes to existing tables. Phases 2 and 3 (§12) add no further migrations — all columns land in this one migration even though the writing code ships later; empty scoring/plan columns are inert.

---

## 4. NormalizedAd — the contract that crosses the ingest boundary

Locked in #150, grounded in the 101-ad trial. Both sources return Meta's native snapshot shape, so one contract covers primary and fallback.

- **Required (0/101 empty in trial):** `archiveId`, `pageId`, `pageName`, `isActive`, `startDate`, `bodyText`, `linkUrl`, `displayFormat` (`IMAGE | VIDEO | CAROUSEL | DCO | DPA` — derived from creatives/media for MetaAdsCollector, which lacks an explicit field), `publisherPlatforms[]`, `raw` (full source payload, persisted verbatim).
- **Nullable (trial empty-rates):** `title` (2%), `endDate`, `ctaText`/`ctaType`, `linkDescription` (25%), `collationId`, `collationCount`, media URLs per format (`imageUrl`, `videoHdUrl`/`videoSdUrl`, `videoPreviewImageUrl`).
- **DCO/carousel — primary + `variants[]`:** one NormalizedAd per archive ID; top-level copy/headline/media come from the primary creative; `variants[]` carries each additional `{bodyText, title, linkUrl, media}`. 60/101 trial ads are DCO — flattening would discard most of what competitors are testing; exploding would inflate counts.
- **Media URLs are never persisted as display copies** — they're expiring signed CDN links; the server mirrors the **primary** creative's media at ingest (§6). Variant media stays in `variants`/`raw` unmirrored in v1 (variant *copy* is what clustering and scoring consume; variant media is not displayed).

### Fill semantics
One POST per competitor page = the **full active-ad snapshot** (all NormalizedAds in one body, capped at **200**; the cap exists so a mega-advertiser can't make fills/mirroring unbounded). Server upserts by archive ID, records the fill run, marks ads absent from the snapshot `noLongerSeenAt`. **Idempotent** — re-posting the same snapshot is safe. Unknown/untracked page → typed error; **zero ads is a valid fill** (empty snapshot, run still recorded); malformed ads rejected by validation; auth failure → standard API-key 401.

---

## 5. Ingest surface — three procedures on the OpenAPI router

Locked in #151, #152, #154. No new machinery: new domain router `signals.ts` (registered in `_app.ts`, splits to `signals.*.ts` as it grows), exposed automatically at `/api/openapi/signals/<procedure>` with `ask_` bearer keys via the existing `authenticateApiKey` path and scope enforcement (`src/lib/trpc/init.ts`).

| Procedure | Kind | Scope | Purpose |
|---|---|---|---|
| `signals.ingestFill` | mutation | `write` | The fill push: `{competitorPageId, source, ads[], clusters[]}` |
| `signals.rankedSignals` | query | `read` | Harness reads back the cross-fill, cross-competitor ranking (and `pipelineStatus` for polling) before plan generation |
| `signals.ingestTestPlan` | mutation | `write` | The plan push: concepts + ad rows |

`ingestFill.clusters[]` (nullable as a whole in Phase 1, §12): per cluster — `label` (≤6 words), `angle`, `summary`, member ad archive IDs, `verdict` (`high | medium | low`), `verdictRationale`.

### The gatekeeper (server, at ingest — pattern from `creative-tag-enrichment.ts`)
- zod validation of NormalizedAd plus cluster/verdict shapes; required fields hard-fail **per ad**.
- `angle` normalized via `matchVocabulary` against the 7-value `ANGLE_TYPES` in `src/lib/creative-taxonomy.ts` (competitor clusters and own creatives share one vocabulary) — invalid → `null`.
- `verdict` must be the closed enum; **invalid verdict → strategic component contributes 0, rationale null, cluster flagged "strategic read unavailable" in the UI.** Scoring never blocks on a bad verdict.
- `verdictRationale` doubles as the strategic-read text on the signals screen.

---

## 6. Post-ingest pipeline — one parent job per competitor

Locked in #151, amended by #152. Each fill POST triggers **one parent Trigger.dev job**: mirror media (bounded child batches via `src/lib/remote-image.ts` — the SSRF-safe mirror — kicked off immediately while CDN URLs are fresh) → rebuild clusters from the payload → **score** (§8). Follows the durable parent/child batch design (`docs/superpowers/specs/2026-08-12-durable-intelligence-batches-design.md`). Per-competitor queue with `concurrencyLimit: 1` so overlapping fills for the same competitor can't race. **Resume state = `intel_snapshot.pipelineStatus`** (`received → mirroring → scoring → complete | failed`) — a retried parent resumes from the failed stage; mirroring children skip already-mirrored ads (idempotent by archive ID + media URL).

---

## 7. Clustering — deterministic pre-pass + harness LLM

Locked in [#152](https://github.com/noelrohi/creatives-tracker/issues/152); runs **in the harness**, before the fill POST.

- **Dedup pre-pass** (plain code): group by exact match on normalized body text (lowercase, collapse whitespace, trim). Trial: 101 → 65 distinct keys. Fuzzier rules rejected — a 120-char-prefix rule caught only 6 more ads with false-merge risk, and the LLM pass groups paraphrases anyway. `collation_id` is useless for grouping (97 distinct across 100 ads).
- **LLM pass** (one structured-output call per competitor): groups the distinct copies into named message clusters. Output per cluster: `label`, `angle` (from `ANGLE_TYPES`), `summary` (1–2 sentences), member archive IDs.
- **No embeddings — validated**: at the 200-ad cap, ~65 distinct copies fit one context trivially. pgvector stays out of scope.
- **Strategic verdicts** (harness LLM, per cluster): `high | medium | low` relevance to the client's positioning + a rationale that becomes the strategic read in the UI.

---

## 8. Scoring — pure function, server-side, 0–100

Locked in #152. `src/lib/competitor-signals/score.ts`, pure and unit-tested — recomputable in-app anytime over stored inputs (dates, creative counts, formats, URLs, verdict enum). The formula was simulated against the real trial clusters before locking.

| Component | Pts | Formula |
|---|---|---|
| Longevity | 35 | `ln(1+days)/ln(1+547) × 35`; days = today − oldest `startDate` in cluster, capped at 18 months |
| Variant multiplication | 25 | total creatives (primary + `variants[]`) across cluster: `ln(1+c)/ln(1+30) × 25` |
| Strategic relevance | 15 | verdict `high\|medium\|low` → 15/8/3; invalid → 0 + flagged |
| Format breadth | 15 | distinct of {image, video, carousel} × 5 (DCO/DPA resolve to underlying media) |
| Landing-page focus | 10 | share of cluster ads on the modal URL (query-stripped) × 10 |

*Supersession: the plan artifact's linear-to-18mo longevity was broken on real data — AIRWAAV's oldest live ad is 105 days (median 30), so linear gave the best cluster 2.4/35 and made HIGH mathematically unreachable. The log curve gives 30d → 19.1, 105d → 25.9, 18mo → 35.*

**Tiers: HIGH ≥ 65 / MODERATE 40–64 / WATCH < 40.** Trial calibration: real clusters score 44–70; the best cluster (7 ads, 16 creatives, 32 days) hits 55 base → 70 with a high verdict. HIGH is earned — strong evidence *and* a high strategic read.

---

## 9. Test-plan generation — harness-run, top-6, replace-`proposed`-only

Locked in [#154](https://github.com/noelrohi/creatives-tracker/issues/154). The fill workflow's final step: after the server scores, the harness GETs `signals.rankedSignals`, generates, and POSTs `signals.ingestTestPlan`. Generation sees **cross-fill, cross-competitor state** — the full ranking, not just this fill's ads. No in-app Generate button.

- **Inputs: top ~6 clusters by score, tier-agnostic, across all competitors.** (HIGH-only rejected: the trial has only ~4 HIGH-capable clusters — a young account could hand the generator 0–1 inputs.) Per cluster the prompt gets: label, angle, summary, score + component breakdown, tier, strategic-read rationale, formats observed, landing-page focus, representative ad copy.
- **Shape: 3 concepts × 3 hooks × 2 formats = 18 ads**, parameterized. Light ad rows under rich concepts (§3 shapes) — per-ad copy drafts rejected (18 drafts per generation is where quality thins, and checklist rows don't display copy). Formats fixed per wave as `static | video`.
- **Statuses: `proposed → approved → testing → done` + terminal `rejected`** (the client veto needs somewhere to land). Status is **per ad**, moved manually in-app by **any org member** — no role gating in v1; the checklist is a tracking sheet, not an approval system.
- **Regeneration replaces `proposed` only.** Each generation wipes and regenerates ads still in `proposed`; anything `approved/testing/done/rejected` — and its concept header — is untouched. One live plan, no wave bookkeeping, human decisions never trampled.
- **Guardrails, two layers:** (1) the budget-routing rule — *scale/kill decisions follow measured CTR/CAC/ROAS in Adsolute, never evidence scores* — is **app-rendered boilerplate on every concept header**, a deterministic fixture the LLM cannot paraphrase away; (2) the LLM `claimGuardrail` field is scoped to **product-claim risks only** (what a mouthguard ad must not promise), `null` when there are none.

---

## 10. Screens — the Ledger direction

Converged over five prototype rounds in [#153](https://github.com/noelrohi/creatives-tracker/issues/153); final mock (live inside the Adsolute shell, fed with real trial data): [prototype artifact](https://claude.ai/code/artifact/04f67801-f549-45e0-8342-2fa0a2cc9c68) (rounds in version history, labels `round-1`…`round-5`).

Three routes as tabs under one **Competitors** nav item; components in `src/components/blocks/competitor-signals/`.

- **`/competitors` — cards.** One card per competitor: stat tiles (ads retrieved of active total, clusters, oldest ad), top-3 leading clusters with tier badges, a **last-fill line only** — fill-history UI was declined for v1.
- **`/competitors/signals` — master–detail ledger.** Compact 4-column ranking left (#, cluster + competitor/angle meta, score, tier); sticky evidence panel right: tier-colored conic dial with the 0–100 score, five labeled component meters (Longevity /35, Variants /25, Strategic /15, Formats /15, Landing /10), strategic read below, compact facts + Ad Library link in the footer. Invalid verdict → "strategic read unavailable" flag badge + italic explainer; meters still render with strategic at 0.
- **`/competitors/test-plan` — ad checklist.** All 18 ads flattened to one row each, grouped under concept headers that carry evidence citations + the claim guardrail + the app-rendered budget-routing boilerplate; status tracked and edited **per ad**.

Cross-cutting, locked as mocked:

- **Honesty guardrail:** per-session dismissable banner atop Signals and Test plan ("Scores reflect observable evidence — longevity, variants — not measured ad performance") + ⓘ tooltip repeating it on **every** score/tier badge, including competitor stat tiles.
- **No collect and no re-cluster buttons anywhere**; empty states point at the operator-device fill. **Re-score is the only in-app action**, with a realtime "Scoring…" state.
- Tier colors reuse the validated attribution status palette (`--attr-good/-warning/-neutral` pattern); tier always carried by label + color, never color alone.

### Gating
New org feature flag in `src/lib/feature-flags.ts`: key `competitorSignals`, label "Competitor Signals", badge "Beta", href `/competitors`, group `"analyze"`, a Solar icon (e.g. `solar:radar-2-linear`). Routes live under `src/app/(protected)/competitors/` behind the flag, same guard pattern as attribution. The `signals` router's in-app procedures use the standard org-scoped `protectedProcedure`; only the three OpenAPI procedures (§5) accept API-key principals.

---

## 11. The fill-harness runbook — operational spec

The map's last fog item, folded in here now that the boundary contract is locked (#150/#152/#154). The harness is a Claude Code session (subscription tokens, $0 marginal) on the operator's machine — a skill/checklist-driven workflow, not shipped app code. v1 ships it as a documented runbook (a `.claude/skills/fill-competitor-signals` skill wrapping these steps is the natural packaging).

1. **Collect** — run MetaAdsCollector per tracked competitor (`meta-ads-collector`, country US, active ads, up to 200), from a residential IP.
2. **Normalize** — map raw output to NormalizedAd (§4): derive `displayFormat` from creatives/media, pick the primary creative, fold the rest into `variants[]`, keep the verbatim payload in `raw`.
3. **Dedup** — exact normalized-body grouping (§7), plain code.
4. **Cluster** — one structured-output LLM call per competitor over the distinct copies. Prompt contract: given the client's positioning context and the deduped copies, return clusters `{label ≤6 words, angle ∈ ANGLE_TYPES, summary, memberArchiveIds}`; every ad assigned to exactly one cluster; singletons allowed.
5. **Verdicts** — per cluster: `relevance ∈ high|medium|low` to the client's positioning + a 1–3 sentence rationale written to be shown to the client as the strategic read.
6. **POST `signals.ingestFill`** — one POST per competitor; `ask_` key with `write` scope.
7. **Poll `signals.rankedSignals`** until every posted fill's `pipelineStatus` is `complete` (or `failed` → stop and report).
8. **Generate the plan** — LLM call over the top ~6 ranked clusters (§9 prompt inputs); emit 3 concepts × 3 hooks, ad rows expanded ×2 formats.
9. **POST `signals.ingestTestPlan`.**

**Breakage canary:** step 1 fails loudly, not silently — if MetaAdsCollector returns zero ads for a page known to be active (AIRWAAV), or errors on Meta GraphQL shape changes, the harness stops before POSTing (a zero-ad fill is *valid* at the API but the runbook treats known-active-page-zero-ads as suspect) and reports. **Fallback switch-over:** rerun collection through ScrapeCreators (`SCRAPECREATORS_API_KEY`, 89 free credits) mapped to the same NormalizedAd shape, `source: "scrapecreators"`; all downstream steps identical. If credits are near exhaustion, that's the moment to revisit paid vendors ([research doc](https://github.com/noelrohi/creatives-tracker/blob/research/ad-library-vendors/docs/research/ad-library-vendors.md)).

Exact prompt wording for steps 4, 5, 8 is authored at build time inside the skill — the *contracts* above (inputs, output schemas, vocabularies, gatekeeper rules) are the spec; wording is implementation.

---

## 12. Phase plan — each phase independently shippable

- **Phase 1 — Collect & browse.** The migration (§3, all seven tables), the `signals` router with `ingestFill` (accepting `clusters: null`), media mirroring pipeline (`received → mirroring → complete`), the feature flag + `/competitors` cards screen, runbook steps 1–3 + 6. Ships: tracked competitors with mirrored ad snapshots and last-fill visibility. Value: the raw Ad Library view the client has never had.
- **Phase 2 — Cluster & score.** Clusters + verdicts in the fill payload (gatekeeper live), the scoring stage + `score.ts` with unit tests, `signals.rankedSignals`, the `/competitors/signals` ledger, in-app re-score, banner + tooltips, runbook steps 4–5 + 7. Ships: the ranked evidence view.
- **Phase 3 — Recommend.** `signals.ingestTestPlan`, the `/competitors/test-plan` checklist with per-ad statuses, regeneration semantics, runbook steps 8–9. Ships: the standing test plan.

Phase order matches pipeline order; nothing in a later phase reshapes an earlier phase's tables or procedures (the one migration lands in Phase 1).

---

## 13. Deferred — explicitly out of v1

From the map's out-of-scope list and decisions along the way:

- **Weekly collection cron** — cadence is manual/agent-driven; the $100/mo ceiling leaves huge headroom when this returns.
- **Multi-snapshot sighting history** for true longevity tracking — the fill-run-log model makes this an additive sighting table, not a rework.
- **Stable cluster identity across runs** — v1 re-clusters from scratch each fill; revisit with sighting history.
- **Ad explorer with saved swipes**, **pgvector embeddings** for clustering at scale, and the HeelBase surfaces cut from the MVP (executive-overview bubble chart, separate Ad Explorer, Data & Sources page).
- **Fill-history UI** — declined in the prototype; last-fill line only.
- **Variant media mirroring** — primary creative only in v1 (§4).
- **Role gating on test-plan statuses** — any member moves statuses in v1.
- **Image Studio brief-seed handoff** (test-plan concept → Studio brief) — revisit after the MVP proves out.
- **Official `ads_archive` EU supplement** — ruled out for v1.

---

## 14. Source tickets

| Ticket | Decision |
|---|---|
| [#147](https://github.com/noelrohi/creatives-tracker/issues/147) | Vendor research: ScrapeCreators/SearchAPI shortlist; Bright Data & Forager have no Ad Library product; universal ~24–48h indexing lag |
| [#148](https://github.com/noelrohi/creatives-tracker/issues/148) | Client parameters: AIRWAAV + Shock Doctor, US+AU market, $100/mo ceiling, 3×3×2 matrix |
| [#149](https://github.com/noelrohi/creatives-tracker/issues/149) | Trial provisioning: ScrapeCreators, 101-ad capture, trial ground facts |
| [#150](https://github.com/noelrohi/creatives-tracker/issues/150) | MetaAdsCollector device-side, push ingest, NormalizedAd contract, fill semantics, 200 cap |
| [#151](https://github.com/noelrohi/creatives-tracker/issues/151) | Data model: fill-run log, living ad rows, wipe-and-rebuild clusters, auto-chained pipeline, ingest procedure |
| [#152](https://github.com/noelrohi/creatives-tracker/issues/152) | Harness-run LLM, dedup pre-pass, score formula (log longevity), 65/40 tiers, gatekeeper, guardrail placement |
| [#153](https://github.com/noelrohi/creatives-tracker/issues/153) | Screens: Ledger master–detail, per-ad checklist, competitor cards, cross-cutting affordances |
| [#154](https://github.com/noelrohi/creatives-tracker/issues/154) | Test-plan generation: top-6 inputs, concept/ad shapes, five statuses, two-layer guardrail, replace-`proposed` regeneration |
