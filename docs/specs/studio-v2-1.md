# Studio v2.1 — hardening the suggestion loop

Assembled from the wayfinder map [Wayfinder: Studio v2.1 — hardening the suggestion loop](https://github.com/noelrohi/creatives-tracker/issues/62) (12 resolved tickets, 2026-07-15). Builds on [Studio v2](https://github.com/noelrohi/creatives-tracker/issues/47) (adsolute PR #48, branch `feat/studio-v2`). Visual references: adsolute branches `prototype/library-lifecycle`, `prototype/winner-confidence`, `prototype/swipe-capture`.

## Problem Statement

Studio v2 shipped the weekly loop, but a three-persona expert review of PR #48 (senior Meta buyer, DTC founder, creative-ops lead) found it fragile in three ways. First, the feedback loop runs on taste: reaching real market signal takes three manual steps (Good → published → link), so MARKET RESULTS stays empty and the generator learns from pre-launch opinions — while a "winner" needs only 3 purchases to be crowned, dressing variance up as signal. Second, the generator will converge: Good/Bad tallies are all-time, nothing tells it "we already made this," rebrand variants are near-clones by design, and the untried-swipe feed never reaches past the 4 newest. Third, for a medical-adjacent brand there is no claims guardrail anywhere — the rewrite stage is literally instructed to "lead with proof." Underneath it all, the ~6-action swipe save threatens the capture habit that feeds the whole loop.

## Solution

Close the signal loop, guard the claims, keep the flywheel spinning. Publishing becomes the moment of linking: a dialog asks "which ad did this ship as?" with name-matched suggestions (a human always confirms — no write-back anywhere), backed by a copyable ad-name template that makes future matches near-certain. Linked winners surface in a "Proven in market" strip with one-click "Make 3 more like this," and per-variant market results join the weekly prompt. Thin winners (<10 purchases) wait in a demoted "Worth watching" list instead of polluting the queue. The brand profile gains prohibited-claims and required-disclaimers lists enforced in every prompt path plus a pre-generation text scan. Swipe capture collapses to ⌘V-anywhere with tag-later; retrieval gains ranked search and multi-select filters; and the generator gets a memory — decaying tallies, a RECENTLY MADE anti-repeat section, a NOT TRIED LATELY exploration nudge — plus three new dimensions (hook type, social proof, price framing) to learn along.

## User Stories

**Signal loop**
1. As a media buyer, I want "Mark as published" to open a "Which ad did this ship as?" dialog with best-match suggestions and a search over synced creatives, so that linking happens at the moment I already have the ad in hand.
2. As a media buyer, I want an explicit "Publish without linking" escape that warns me unlinked images never teach the generator, so that the honest path is one click but the lazy path is informed.
3. As a media buyer, I want a copyable templated ad name (`{BRAND}-ST-{angle}-{id}`) in the publish dialog and on any Good-marked variant, so that naming the ad in Ads Manager makes the next sync's match automatic.
4. As a media buyer, I want published-but-unlinked variants visibly flagged ("Not linked — link to see results"), so that orphans don't accumulate silently.
5. As a media buyer, I want linked variants with real performance pinned in a "Proven in market" strip (ROAS, trend, purchases), so that what actually works is one glance away.
6. As a media buyer, I want "Make 3 more like this" on a proven variant to queue a generation in one click (original brief + winning image as reference + same angle and copy package), so that extending a winner costs nothing.
7. As a media buyer, I want the weekly generator to see individual proven images (not just angle averages) and to propose extend cards from them, so that a single 3.1x image isn't diluted into a bucket.
8. As a media buyer, I want winners with fewer than 10 purchases demoted to a collapsed "Worth watching" section — outside the actioned count, with Propose anyway / Dismiss — so that the queue never crowns variance.
9. As a media buyer, I want Monday's refresh to promote, keep, or drop watch-list items by re-checked evidence, so that thin winners graduate or leave on facts.

**Claims guardrail**
10. As a workspace admin, I want prohibited-claims and required-disclaimers lists on the brand profile, so that compliance rules live where the brand is defined.
11. As a creative operator, I want every generation path (weekly cards, prompt rewrite, rebrand) hard-constrained by those lists, so that banned framing never reaches an image prompt.
12. As a creative operator, I want a deterministic banned-phrase scan of the final prompt before image generation, so that violations are caught before image spend, not after.

**Flywheel**
13. As a creative operator, I want ⌘V anywhere on the Swipes page to save a screenshot instantly as an optimistic card with a retry state on upload failure, so that capture costs one action.
14. As a creative operator, I want a brand input and angle chips (Done / Later) inline on the fresh card, so that tagging is a two-second choice, never a gate.
15. As a creative operator, I want an exact content-hash soft warning when I paste an image identical to an existing swipe, so that double-pastes don't pile up.
16. As a creative operator, I want typo-tolerant ranked search over swipe brand and why-it-works notes, so that a 100-swipe library stays findable.
17. As a creative operator, I want multi-select angle/style filter chips (OR within a dimension, AND across), so that browsing scales past single filters.
18. As a media buyer, I want the weekly untried-swipe feed to rotate 2 newest + 2 oldest, so that older saves eventually earn their keep.
19. As a media buyer, I want Good/Bad tallies limited to the trailing 90 days, so that last quarter's taste doesn't rule this week's queue.
20. As a media buyer, I want the generator told what was RECENTLY MADE (all generations, last 30 days), so that it stops re-proposing what we just did.
21. As a media buyer, I want a NOT TRIED LATELY nudge with about one exploration card per week, so that stale angles and styles get periodic shots.
22. As a workspace admin, I want hook type as a third taxonomy kind and social proof / price framing as element slots — vision-filled, with a suggested hook tag on saved swipes — so that the tool learns along the dimensions that move DTC statics.

## Implementation Decisions

**Publish→link** (per #49/#52/#53): publish stamps `publishedAt` only; linking sets read-only `linked_creative_id`; nothing writes to `adCreatives` or Meta. Name template `{BRAND}-ST-{angle}-{id}`: brand prefix from the brand profile (slugified, uppercased), slugified generation angle, 6-char variant-UUID slice. Match ranking: exact template-id hit → name contains angle slug → fuzzy similarity → recency; top 2–3 as "Best matches"; existing org-scoped ILIKE candidate search as fallback list.

**Market results & extend** (per #54): keep the per-angle rollup `{angle, shipped, avgRoas, spend}` and add the top ~5 individual linked variants (creative name, ROAS, purchases, trend) with the instruction to extend specific proven images. "Make 3 more like this" = one-click queued generation reusing original brief + winning image as reference + angle + copy package (rides existing `studio.generate` reference-image path). The generator may also propose extend cards for proven variants not yet extended; kind (`extend_winner` vs reuse) is implementer's choice, but the card must name the specific image.

**Winner confidence** (per #50/#55): `evidence = thin` computed in code (<10 purchases in window; `WINNER_MIN_PURCHASES=3` stays as the appearance floor); thin cards render in the collapsed dashed "Worth watching" section — excluded from "N of M actioned," Propose anyway / Dismiss, stats spelled out plainly. Refresh re-evaluates: ≥10 purchases → fresh card in the main queue; still thin → keeps waiting without duplication; declining/paused source → dropped and mentioned in the expiry note.

**Claims guardrail** (per #56): `prohibitedClaims[]` + `requiredDisclaimers[]` on `studio_brand_profile`, edited on /studio/brand. One constraint block appended to the mandate lists of the weekly generator, prompt-rewrite stage, and rebrand prompt. Deterministic banned-phrase scan of the final rewritten prompt (and card copy) pre-generation; flagged prompts regenerate. No post-generation OCR.

**Swipe capture** (per #51/#57): window paste handler on the Swipes page; optimistic card (local preview + uploading state) with "Upload failed — retry"; `createSwipe` already accepts bare `imageUrl`. New nullable `imageHash` (SHA-256) with non-blocking identical-image warning. Tag-later strip: brand + angle chips + Done/Later; everything else via the existing edit flow. Analyze-swipe vision task continues to fire on insert.

**Retrieval** (per #59): pg_trgm ranked search over `brandName` + `whyItWorks` with a GIN index — the repo's first extension migration (custom SQL alongside `db:generate`/`db:migrate`; push stays disabled). List input moves to `angleIds[]`/`styleIds[]` (OR within, AND across), nuqs array state. Untried feed: 2 newest + 2 oldest untried per week.

**Generator freshness** (per #58): tallies gain a 90-day date filter. New prompt sections: RECENTLY MADE (angle/style of all generations in the last 30 days, with a no-near-duplicates instruction unless market results justify a refresh) and NOT TRIED LATELY (active taxonomy values with no generation in ~6 weeks; ~1 exploration card per week).

**Taxonomy expansion** (per #60): `hook_type` as a third taxonomy kind — DB needs no migration (kind is text, unique on org/kind/slug); Zod unions, Taxonomy Manager, and seeds update; seed values chosen at implementation (suggested: question, callout, stat, testimonial-quote, price-anchor, curiosity). `socialProof` and `priceFraming` join `SuggestionElements` as nullable `{action, value}` slots; the structured-output schema updates in lockstep; vision auto-fills the slots and proposes a hook tag on saved swipes (confirmable in tag-later/edit).

**Standing constraints.** Everything from v2 carries over: no `adCreatives` writes, plain-language surfaces with machinery behind disclosures, nuqs for URL state, Solar icons.

## Testing Decisions

Same seams as v2 — external behavior at existing seams, no UI tests, Trigger tasks untested directly:

- **tRPC seam:** link-candidate ranking (template hit outranks fuzzy); publish/link transitions incl. publish-without-linking; watch-list flag on suggestion rows and refresh promote/keep/drop; swipe create with bare imageUrl, hash-dupe warning, multi-select filters and search; taxonomy third-kind add/archive.
- **Pure-function seam:** name-template builder (slugging, id slice); confidence classifier at the 10-purchase boundary; banned-phrase scanner (hit/miss/casing); weekly prompt assembly includes per-variant market results, RECENTLY MADE, NOT TRIED LATELY, decayed tallies, and the claims constraint block; element-spec shape with the two new slots.

## Out of Scope

Capture bookmarklet (deferred at #57); rebrand vision post-check and active-offer input + offer-tagged packages (deferred at triage); promoting a generated variant's copy into a package; post-generation OCR/claims checking; meeting-ritual support (decision-note on cards — never triaged, candidate for a future effort); and all of v2's standing exclusions (video, auto-scraping, Meta write-back beyond suggest-and-confirm linking, package versioning).

## Further Notes

Primary sources: prototype branches `prototype/library-lifecycle` (publish→link + proven strip, A won), `prototype/winner-confidence` (demoted watch list, C won), `prototype/swipe-capture` (paste-anywhere, A won), all on the adsolute repo. Decision detail lives on the map's closed tickets (#49–#60); code ground truth was gathered into per-ticket dossiers (read-only pi runs, 2026-07-15). Mirror this spec to `docs/specs/studio-v2-1.md` on the implementation branch.
