# Studio v2 — suggestion-centered studio + swipe files

Assembled from the wayfinder map [Studio v2 — suggestion-centered studio + swipe files](https://github.com/noelrohi/creatives-tracker/issues/37) (8 resolved tickets, 2026-07-14). Visual reference: the approved home-surface prototype on branch `prototype/home-surface`; other primary sources listed under Further Notes.

## Problem Statement

The Image Studio is overwhelming. Five surfaces (composer, starters, feed, suggestions, library) compete for attention, the composer demands a blank-page brief, and nothing tells the team what to do when they open it. Meanwhile the team's actual creative process — PERKI-style reference-anchored iteration — leans on third-party swipe tools (gethookd, trendtrack) whose share links we don't control. Ken's ask is direct: the tool should tell us which ads to make more of, give us the copy, show us 3–4 variants, and let us mark each Good or Bad.

## Solution

Studio v2 is one small weekly loop. The studio opens on a plain-language to-do list of suggested ads derived from winners and saved swipes; approving a card generates 3–4 image variants that land in the Library, where each gets marked Good (will do it) or Bad and Good ones can be marked published. An in-house swipe library (paste URL + screenshot) replaces third-party reference links and feeds both a one-click rebrand flow and the weekly queue. A minimal copy-package bank carries proven Meta copy (primary text + headline + description) onto approved variants. Everything else is cut: starters, the generation feed, and the full composer shrink to a slim start-from-scratch dialog.

## User Stories

1. As a media buyer, I want `/studio` to open a short weekly to-do list of suggested ads, so that I know what to make next without composing from scratch.
2. As a media buyer, I want each suggestion phrased in plain language with why it's proposed and the source ad's ROAS, so that I can judge it at a glance.
3. As a media buyer, I want to approve a suggestion in one click, so that 3–4 image variants are generated with no further input.
4. As a media buyer, I want to edit a suggestion's brief and copy package before approving, so that I can steer the output without starting over.
5. As a media buyer, I want to skip suggestions I don't like, so that the queue stays short and future weeks stop proposing them.
6. As a media buyer, I want approved items to move to a Done section that shows generation progress and where the results went, so that the queue reads like a checklist.
7. As a media buyer, I want a "New in Library" panel beside the queue, so that fresh results are one glance away.
8. As a media buyer, I want unactioned suggestions to expire at the weekly refresh, so that the queue never silts into a backlog.
9. As a media buyer, I want the queue to refresh automatically every Monday and on demand via a refresh button, so that there's a weekly heartbeat without waiting on it.
10. As a media buyer, I want to see a note when last week's suggestions expired unactioned, so that nothing disappears silently.
11. As a media buyer, I want to mark each generated variant Good (will do it) or Bad, so that the tool learns what to propose.
12. As a media buyer, I want the Library to filter on Good variants, so that keepers are findable at publish time.
13. As a media buyer, I want to mark a Good variant as published, so that the team tracks what actually shipped.
14. As a media buyer, I want my skips and Good/Bad marks fed into next week's generation, so that the queue stops proposing what we keep rejecting.
15. As a creative operator, I want a slim start-from-scratch composer (brief + format + reference images) behind a button, so that the escape hatch exists without dominating the studio.
16. As a creative operator, I want to save a competitor ad by uploading a screenshot with optional source URL, brand, tags, and a "why it works" note, so that we keep our own swipe file instead of relying on third-party tools.
17. As a creative operator, I want a warning when I save a source URL that already exists, so that the library doesn't fill with duplicates.
18. As a creative operator, I want board (masonry) and table views over the swipe library with angle/style filter chips, so that I can browse for inspiration or operate the list.
19. As a creative operator, I want to archive or delete swipes, so that stale references leave the pickers without losing history.
20. As a creative operator, I want "Use as reference" on a swipe to open a prefilled rebrand composer, so that I can generate rebranded variants immediately.
21. As a creative operator, I want the option to queue a rebrand for this week instead of generating now, so that it rides the normal approval loop.
22. As a media buyer, I want the weekly queue to propose rebrands from swipes I saved but never tried, so that the library earns its keep.
23. As a creative operator, I want a blocked generation to tell me why (likeness/logo moderation) and offer a retry without the reference image, so that failures are actionable.
24. As a workspace admin, I want seeded angle and visual-style lists that I can add to and archive, so that tagging matches our products and vocabulary.
25. As a creative operator, I want to save a winning ad's copy as a package tagged with its angle in one click, so that proven copy is reusable.
26. As a creative operator, I want to create and edit copy packages manually in a small manager, so that the bank stays curated.
27. As a media buyer, I want an approved variant to carry its copy package, visible and copyable beside the image in the Library, so that publish-time copy is one tap.
28. As a media buyer, I want generated variant copy to match our proven voice, so that new ads read like the ones that already convert.

## Implementation Decisions

**Information architecture.** The studio has three tabs: Home (the weekly to-do), Swipes, Library. Cut entirely: the starters surface, the generation feed, the full composer page and its angle/persona/awareness inputs, and "Create" as a nav destination. The composer survives only as a slim dialog (brief text, format, reference images); editing a suggestion opens this same dialog prefilled.

**Home surface** (per the approved prototype): header with "N of M actioned · refreshes Monday" and a manual Refresh button; a dashed note when the previous week expired suggestions; to-do cards showing kind label, plain-language title, the why, and the source line (winner + ROAS, or swipe provenance), with Approve / Edit / Skip; a "View production details" disclosure holding the element keep/change spec and a Copy row naming the attached package; a Done section of struck-through rows (generating → "3 images → Library", or "skipped"); a New-in-Library panel with Good/Bad marking and mark-as-published; distinct all-done and cold-start empty states.

**Lifecycle.** Suggestion kinds gain `rebrand_swipe` alongside the existing three. The state model (from the grilling + prototypes):

```
suggestion: proposed → approved | skipped | expired   (expired set by refresh)
variant:    mark ∈ good | bad | null                  (single axis; replaces starredAt)
            publishedAt set manually, only meaningful when mark = good
```

Existing starred variants are backfilled to `good`. There is no star anywhere in v2. "Published" is a manual mark with no Meta inference or write-back.

**Refresh rhythm.** A Monday cron plus the existing manual refresh; refresh expires unactioned proposals and generates the new week's queue.

**Weekly generator inputs** (fully specified): account performance (winners), skip history, Good/Bad tallies per angle/style, untried swipes (proposed as rebrand cards), and the angle's copy package quoted as a tone reference.

**Swipe record.** Organization-scoped. Required at save: the screenshot, persisted to the app's blob storage immediately (pasted URLs expire and are never the stored asset). Optional: source URL, brand name, angle tag, visual-style tag, free-text "why it works" note; plus added-by and timestamps. Saving a duplicate source URL surfaces the existing swipe. Archive hides from pickers; hard delete allowed. The Swipes tab is one page with a board (masonry, default) / table view toggle sharing filter chips and the same record. Swipes are external references only — own winners keep the remix flow and the Library.

**Rebrand-from-swipe.** "Use as reference" opens the slim composer prefilled with the swipe as reference image and a pre-written rebrand brief, offering Generate now and Queue for this week. The reference image rides the existing image-edits path; the generation prompt must explicitly instruct: keep layout/composition, replace all branding, product, likeness, and copy with ours (the image model preserves reference branding by default). A vision call writes the element keep/change spec from the screenshot, using the same elements structure suggestions already carry. Moderation blocks surface the category (likeness/logo) on the variant with one-tap "Retry without image", which regenerates from the written spec only.

**Taxonomy.** Two organization-scoped value lists — angle and visual style — seeded with plain-language values (angles: vs. the expensive fix, creams don't work, week-by-week timeline, nobody talks about this, clothing freedom, feel like yourself again, offer/bundle; styles: before/after, us vs. them, testimonial, facts & stats, features & benefits, native/screenshot), workspace add/archive, slug identity, no display codes anywhere. Awareness remains a generation-input enum, not a tag; persona remains free text.

**Copy packages.** Organization-scoped, holding the full Meta trio (primary text, headline, description), tagged by angle. Two sources: one-click "Save copy as package" off a winning synced creative (pre-tagged with the ad's angle), and manual create/edit in a small manager. Attachment is optional at approve time, defaulting to the angle's most recent package; the variant stores the reference and the Library shows the copy one-tap copyable beside the image.

**Concurrency note.** Queueing an approved suggestion must claim the row first (guarded status update) to fix the existing double-queue race.

**Standing constraints.** Studio output is never written to the ad-creatives domain. URL state via nuqs. Plain-language surfaces with machinery behind disclosures.

## Testing Decisions

Good tests here assert external behavior at the existing seams — what a procedure returns and what rows/statuses result — never internals of prompts, components, or jobs.

- **tRPC studio-router seam** (prior art: the existing studio and studio-suggestions router tests): suggestion status transitions including expiry on refresh; swipe CRUD, archive semantics, and duplicate-URL behavior; package creation from a creative and the attach-default (angle's most recent); variant mark transitions and mark-as-published; rebrand queueing including the claim-first guard (double-queue attempt yields one generation).
- **Pure-function seam** (prior art: the existing prompt-builder and remote-image unit tests): weekly prompt assembly includes skips, Good/Bad tallies, untried swipes, and the angle package when present; rebrand prompt contains the explicit replace-branding instructions; element-spec parsing/shape.
- No UI tests, matching the codebase today. No new seams; the Trigger.dev tasks stay untested directly — their logic lives in the pure functions above.

## Out of Scope

Video briefs and the script pipeline; auto-scraping or auto-capture from pasted URLs; competitor monitoring as a living workflow; PERKI-style codes; promoting a variant's generated copy into a package; package versioning, per-placement copy variants, and package-level performance stats; inferring "published" from Meta sync or any write-back to synced creatives.

## Further Notes

Primary sources, all on the adsolute repo as throwaway branches: `prototype/results-placement` (queue vs library placement — variant B won), `prototype/taxonomy-vocabulary` (vocabulary model — seeded+editable won, codes rejected), `prototype/swipes-surface` (board + table toggle won), `prototype/rebrand-flow` (both-paths flow won), `prototype/home-surface` (approved definitive home mock, four page states), and `research/reference-image-support` (image-pipeline findings: reference images already supported end-to-end; ~$0.03/variant per reference; watch the `response_format` SDK quirk on ai-sdk upgrades). The PERKI pipeline extraction is pinned as a comment on the wayfinder map. Decision detail lives on the map's closed tickets; this spec is the assembled, build-ready view.
