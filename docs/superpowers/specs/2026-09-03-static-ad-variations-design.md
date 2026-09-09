# Static ad variations — design

Date: 2026-09-03. Status: approved for planning.

## Problem

The team iterates on static ads by hand. The Image Studio can remix a winner
or rebrand a swipe, but the generator only knows a one-paragraph brand profile
and up to four reference images. It does not know the brand palette and fonts,
the product line (R1/R2/R3 and their differences), which ad lanes converted and
why, the testimonials by angle, or the audience's pain points. That material
exists as a folder of documents and product photos per client, and today the
generator cannot reach any of it. Variations produced without it look generic
or drift from what the resolution log already says works.

## Solution

Add a per-organization **context library** and a **variation agent** that
reads it. On a static creative's detail page a **Variations** tab offers a
"Make Variation" button; one press produces one image, with the agent's plan
(what it kept, what it changed, why, and which context it relied on) shown
beside it. The agent decides what to vary. The user may add a short note as a
constraint. Variations are ordinary Studio generations, so they inherit
Good/Bad marks, publishing, link-to-shipped-ad, Library visibility, and the
weekly generator's learning loop.

Phases:

- **Phase 0** — context library, seeding script, variation agent.
- **Phase 1** — Variations tab on `/creatives/<id>`.
- **Phase 2** — "Make Variation" on `/competitors/<id>` (single image ad
  selected), built after Phase 1 output has been judged good.

Out of scope: multi-image variation, an in-app upload UI for the context
library, video sources, carousel sources, retrieval via embeddings.

## User stories

1. As a media buyer, I open a static creative and see a Variations tab, so
   that I can spin a new version without leaving the ad's page.
2. As a media buyer, I press Make Variation and get one new image plus a
   plain-language plan of what changed and why, so that I can judge it.
3. As a media buyer, I can type a note ("try a testimonial angle") before
   pressing the button, so that I can steer without composing a brief.
4. As a media buyer, I see live progress ("reading testimonials",
   "generating image") while the agent works, so that a 60–120s wait is not
   silent.
5. As a media buyer, I mark each variation Good or Bad and can open it in
   Studio to publish and link it, so that variations feed the same loop as
   every other generation.
6. As a creative operator, I seed a client's context folder into the app with
   one command and re-run it safely when the folder changes, so that the agent
   always works from current material.
7. (Phase 2) As a media buyer, I select one competitor image ad and press Make
   Variation to get a rebranded version in our product context, so that
   competitor references become our ads without a manual composer step.

## Existing pieces this builds on

- Image generation: `trigger/generate-static-ads.ts` — `gpt-image-2` via the
  Vercel AI SDK with reference images, Vercel Blob storage under
  `${env}/create/`, claims guardrail (`classifyPromptClaims`,
  `buildClaimsConstraint`), moderation handling, `metadata` for realtime.
- Records: `studio_generation` / `studio_variant` (`src/schema/studio.ts`),
  `createStudioGeneration` in `src/lib/trpc/routers/studio.shared.ts`,
  `failStudioGeneration` / `finalizeStudioGenerationIfSettled` in
  `src/lib/studio-generation-status.ts`, stale-run reconcile.
- Brand profile: `studio_brand_profile` and `getStudioBrandProfile` — brand
  name, product description, offer, product notes, product photo, prohibited
  claims, required disclaimers. Unchanged by this design.
- Realtime: run-scoped `auth.createPublicToken` issued by tRPC and consumed by
  `useRealtimeRun`, with 4s polling as the canonical path.
- Creative detail page tabs: shadcn `Tabs` driven by nuqs `?tab`.
- Competitor ads grid: local selection state plus a floating action bar with
  Add to Shortlist / Deprioritise / Clear.

## Design

### 1. Context library (Phase 0)

Three org-scoped tables in `src/schema/studio.ts`.

**`studio_context_document`**

| column | notes |
|---|---|
| id, organizationId | |
| title | shown in the agent's index |
| description | one line; the agent chooses reads from this |
| kind | `guideline` \| `playbook` \| `product` \| `audience` \| `testimonials` \| `transcripts` \| `other` |
| tier | `core` (inlined every run) \| `reference` (index only, read on demand) |
| sourceFilename, mimeType | |
| content | full text (markdown or JSON) |
| createdAt, updatedAt | |

Unique on (organizationId, sourceFilename).

**`studio_context_section`** — id, documentId (cascade delete), ordinal,
heading, path (e.g. `Athletic Performance > Unknown 13`), content. Populated at
ingest for reference-tier documents: markdown splits on headings (path is the
heading chain), JSON splits on top-level keys or array items (for the
transcripts export, one section per page). Sections larger than 8,000
characters are split further with a ` (part n)` suffix on the path. Core
documents get no sections; they are read whole.

**`studio_context_image`** — id, organizationId, title, description, kind
(`product` \| `packaging` \| `before_after` \| `logo` \| `person` \| `other`),
imageUrl (Vercel Blob, `${env}/context/`), sourceFilename, width, height.
Unique on (organizationId, sourceFilename).

**Tiering for Reviv.** Core: brand guideline, ad-creative resolution log,
common questions and answers, both audience-principles scans, the biomechanics
summary, the audience-principles and pain-points JSON exports (about 12k tokens
together). Reference: testimonials by angle (1.1 MB) and the technique
transcripts JSON (580 KB). Images: product renders, packaging, before/after
pairs, logo, and the founder photo, each typed by kind.

**Seeding script** `scripts/seed-studio-context.ts`, run with
`bun scripts/seed-studio-context.ts --org <id> --dir <path>`.

- Reads `context-manifest.json` in the folder: an array of entries
  `{ file, title, description, kind, tier? }` (tier applies to documents;
  images use kind only). The Reviv manifest is authored with the
  implementation plan and lives beside the folder, outside git.
- Validates the whole manifest before writing anything: every file exists,
  kinds and tiers are legal, no duplicate filenames. Any error aborts.
- Skips files not in the manifest with a warning. PDFs are not ingested (the
  markdown and JSON files are already their extracted text).
- Upserts documents and images by (organizationId, sourceFilename). Sections
  are deleted and regenerated for every reference document on each run.
- Uploads images to Blob before inserting rows; a failed upload skips that
  image and is reported in the final summary rather than aborting.
- Prints a summary: documents by tier, section counts, images, skips.

### 2. Variation agent (Phase 0)

One Trigger.dev task `generate-variation` in `trigger/generate-variation.ts`:
`queue: { concurrencyLimit: 3 }`, `maxDuration: 600`, inherited retry config.

**Payload** — `organizationId`, `generationId`, `variantId`,
`source: { kind: "creative" | "competitor_ad", id }`, `note?: string`.

**Setup.** Load in parallel:

- Source: image URL (`ad_creative.assetUrl`, or
  `competitor_ad.mirroredImageUrl` in Phase 2) and source text (creative name
  and any stored copy; for competitor ads the body text, title, and CTA).
- Source performance, creative sources only: last 30 days of spend, ROAS,
  CTR, and purchases through the existing performance helpers.
- Brand profile, core documents, the reference-document index with section
  lists, and the image index.

**Standing context.** Sent once as the system prompt, in this order: role and
procedure; brand block and claims constraint (`buildClaimsConstraint`); each
core document inside an XML tag named by kind; the reference index (title,
description, section paths); the image index (title, description, kind). All
interpolated document text is escaped so tag-like content in a client file
cannot forge a section boundary. The user message carries the source image as
an attachment, the source text, performance (when present), and the note.

**Procedure the prompt states.** Identify the source's format lane and angle.
Check the resolution log for what worked and did not in that lane. Choose one
primary change and keep everything else. Prefer moves the playbook supports:
plain language, product-led composition, soft claims, ad-to-landing-page
continuity. Treat the user note as a constraint, not a suggestion. Cite the
documents and sections actually read in the plan's evidence. For competitor
sources (Phase 2): keep layout and composition, replace all branding, product,
likeness, and copy with ours, using the same wording the rebrand-from-swipe
prompt mandates.

**Loop.** `generateText` on `gpt-5.6-terra` with the tools below and a hard
stop at 12 steps.

- `readContext({ documentId, sectionId? })` — without `sectionId` returns
  that document's section list; with one returns the section content. Each
  call is capped at 8,000 characters; six calls per run. Over budget, the tool
  returns an error message and the loop continues.
- `generateImage({ prompt, referenceImageIds, keepSourceLayout })` — runs the
  prompt through `classifyPromptClaims` first; a flagged prompt returns a tool
  error naming the flagged claim so the model rewrites it. Otherwise it calls
  `gpt-image-2` through the existing image path with references in this
  order: source image when `keepSourceLayout` is true, the chosen context
  images, the brand product photo last. The result is uploaded to Blob under
  `${env}/create/`, then reviewed by a vision call against a fixed checklist:
  product matches the product photo (shape, openings, material, markings), all
  in-image text is legible and matches the prompt, no source branding or
  third-party logos, palette consistent with the brand guideline, no
  prohibited claims. Returns `{ attempt, imageUrl, review: { pass, notes } }`.
  Two attempts per run; a third call returns a budget error.
- `finish({ plan })` — ends the loop. Plan shape:
  `{ summary, kept: string[], changed: string[], rationale, evidence:
  { documentId, sectionId?, title }[], inImageCopy: string[], finalAttempt }`.

Trigger run metadata carries `status` and a `steps` array of short labels
(`reading testimonials`, `generating image (attempt 1)`, `reviewing`) for the
UI.

**Completion rules.**

- `finish` called and the final attempt exists: variant `ready` with that
  image, `plan`, and `attempts` stored.
- Loop ended without `finish` but at least one attempt passed review: variant
  `ready` with the last passing image and a synthesized plan whose summary
  says the agent did not write one.
- No image produced: variant `failed` with a reason (`no_image`, `claims`
  after two flagged prompts, or the moderation category from the image model
  in `moderationReason`).
- The generation is finalized through `finalizeStudioGenerationIfSettled`;
  `onFailure` marks variant and generation failed with an error summary.

### 3. Records and API

**Schema changes.**

- `studio_generation`: `kind` text, default `generation`, or `variation`;
  `sourceCompetitorAdId` nullable (Phase 2); `note` nullable text.
- `studio_variant`: `plan` jsonb (the `finish` payload or synthesized plan);
  `attempts` jsonb (`{ attempt, imageUrl, review }[]`).

Existing columns (`sourceCreativeId`, `referenceImageUrls`, status, `mark`,
`publishedAt`, `linkedCreativeId`, `moderationReason`) are reused unchanged.
Generation delete still cascades to variants.

**Entry point** `createVariationGeneration(organizationId, params)` beside
`createStudioGeneration` in `studio.shared.ts`:

1. Validate the source belongs to the org and is a static image: creatives
   need `format = static`, a non-empty `assetUrl`, and the URL is not a video
   file; competitor ads (Phase 2) need `mediaKinds` without `video` and a
   mirrored image URL.
2. Insert one generation: `kind = variation`, `count = 1`, `format` inferred
   from the source image's aspect ratio (portrait for taller than 1:1, square
   otherwise), `brief = "Variation of <source name>"`, `sourceCreativeId` or
   `sourceCompetitorAdId`, `note`, `referenceImageUrls = [sourceImageUrl]`.
3. Insert one pending variant.
4. Trigger `generate-variation`, store `runId`; on throw call
   `failStudioGeneration`.

**Router** `src/lib/trpc/routers/studio.variations.ts`, mounted under
`studio.variations`:

- `create({ sourceCreativeId, note? })` — `studioWriteProcedure`. Returns
  `{ generationId, variantId, realtime: { runId, publicAccessToken } }`.
- `listForCreative({ creativeId })` — `orgProcedure`. Variation generations
  for that source, newest first, each with `{ id, status, note, createdAt,
  variant: { id, status, imageUrl, plan, attempts, mark, publishedAt,
  moderationReason }, realtime }`, where `realtime` is a run-scoped token only
  while `status = generating`.
- `listForCompetitorAd({ competitorAdId })` — Phase 2, same shape.

Retry and marks reuse the existing `studio.retryVariant`, mark, publish, and
link procedures.

### 4. Phase 1 UI — Variations tab

`src/app/(protected)/creatives/[id]/page.tsx` gets a fifth `TabsTrigger`
(`value="variations"`, label "Variations"), rendered only when the creative is
a static image: `format === "static"`, `assetUrl` present, and not a video
file by the page's existing `isVideoFileUrl` check. The nuqs `?tab` state
needs no change. The tab is keyed on the creative id; `?from`/`?to` do not
affect it.

Tab content is `src/components/blocks/creatives/creative-variations-tab.tsx`:

- Header row: "Make Variation" button and an optional single-line note input.
  Read-only members see the button disabled with a tooltip, matching the
  page's role gating. Pressing calls `studio.variations.create`, clears the
  note, and invalidates `listForCreative`.
- Grid of variation cards, newest first, using the same aspect-ratio-boxed
  image and Good/Bad controls as `/studio/[id]`. Card states:
  - generating: spinner and the latest step label from run metadata;
  - ready: image, a "What changed" disclosure (summary, kept, changed,
    rationale, evidence titles, in-image copy), Good/Bad, and an "Open in
    Studio" link to `/studio/<generationId>`;
  - failed: the reason and the existing Retry / Retry without image actions.
- Polls every 4s while any generation is in flight and mounts the same
  render-nothing realtime component the Studio page uses, one per active run.
- Empty state: one paragraph on what a variation is and what context it uses,
  plus the button.

### 5. Phase 2 — competitors

- The floating selection bar in
  `src/components/blocks/competitor-signals/competitor-ads-grid.tsx` gains
  "Make Variation" on the inbox and shortlist tabs when exactly one visible ad
  is selected and that ad is an image (`!isVideo` and a thumbnail present).
  Clicking calls `create({ sourceCompetitorAdId })` and switches the grid's
  nuqs `status` to a new `variations` pill.
- The `variations` pill lists that competitor's variation generations via
  `listForCompetitorAd` grouped by source ad, using the same card component
  as Phase 1.
- Agent differences: rebrand procedure (see §2), no performance data, and the
  review checklist additionally rejects any surviving competitor branding or
  likeness.

### 6. Error handling

- Image-model moderation blocks set `moderationReason` as today; the card
  offers Retry and Retry without image.
- A claims-flagged prompt is a tool error; two consecutive flagged prompts
  fail the variant with reason `claims`.
- Context reads over budget return a tool error; the run continues.
- Task failure runs `onFailure` to mark the variant and generation failed with
  an error summary. The existing stale-generation reconcile handles runs that
  disappear.
- `create` rejects non-static, video, cross-org, and missing sources with a
  clear message, so a stale UI cannot queue one.
- Seeding script: manifest validation aborts before any write; a failed image
  upload skips that image and is reported at the end.

### 7. Testing

Behavior at seams, never prompt internals. No UI tests except where prior art
exists.

- Pure functions (`src/lib/studio-context.ts`, `src/lib/variation-agent.ts`):
  markdown and JSON sectioning (heading paths, 8,000-character split with
  part suffixes); standing-context assembly (core inlined, reference index
  only, tag-like text escaped); tool handlers (read cap and six-call budget,
  claims-flag repair path, two-attempt limit); plan schema parsing and the
  no-`finish` fallback.
- tRPC seam: `create` rejects non-static, video, and cross-org sources and
  inserts `kind = variation` with `count = 1`; `listForCreative` returns only
  that source's generations newest first and omits realtime tokens for settled
  runs.
- Seeding: manifest validation and upsert planning as a pure function, not
  against Blob.
- Component test for the competitor selection bar showing "Make Variation"
  only for a single selected image ad (Phase 2), beside the grid's existing
  component tests.
- The Trigger task stays untested directly, per convention.

## Cost and limits

Per variation: one or two `gpt-image-2` calls, one or two vision reviews, and
a `gpt-5.6-terra` loop of at most 12 steps over roughly 15k tokens of standing
context plus reads. Expect well under $0.50 per press. Generated images are
public-URL blobs and are not garbage-collected, the same as every other Studio
output today; that gap is pre-existing and not addressed here.

## Open items deferred

- In-app upload and editing for the context library (Studio › Brand).
- Multi-image variation.
- Blob retention for Studio output.
