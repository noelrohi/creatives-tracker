const GUIDE = `# Adsolute Studio — Agent Guide

REST access to the full Image Studio loop. Every operation is documented in the
OpenAPI doc at \`/api/openapi\` (rendered at \`/reference\`); this guide covers the
semantics and multi-step workflows that don't fit a single endpoint description.

## Auth

Send an organization API key on every request:

    Authorization: Bearer <key>

Keys are org-scoped. \`read\` scope covers all GET operations; \`write\` (or a
full-access \`*\` key) is required for POST operations, including the upload
endpoint. Keys are managed in Settings → API Keys.

## Core semantics

- **Star, don't save.** Studio output never becomes an ad creative record.
  Marking a variant \`good\` (\`studio/setVariantMark\`) is the save action; the
  library is curated from marks, publishes, and links.
- **Weekly cadence.** Suggestions are generated for a Monday triage rhythm.
  Element tallies decay over ~90 days; a refresh expires unactioned proposals
  and generates a fresh batch. Thin-evidence winners (<10 purchases) sit in a
  collapsed "worth watching" set rather than the main queue.
- **Async = trigger, then poll.** Mutations that start jobs return the ids you
  poll. Poll \`studio/generation\` (or \`studio/generations\`) until \`status\` is
  \`ready\` or \`failed\`; poll the suggestion run state exposed by \`studio/home\`
  until \`completed\` or \`failed\`. Responses may also include a Trigger.dev
  \`runId\` + short-lived \`publicAccessToken\` — an optional realtime upgrade;
  polling is the supported path.
- **Duplicates are soft.** \`createSwipe\` hard-returns an existing swipe on a
  matching source URL and soft-warns (\`duplicateImage\`) on a matching image
  hash. Always pass the \`hash\` the upload endpoint returns.

## Recipes

### Swipe-dump session

1. \`POST /api/upload\` (multipart \`file\`) → \`{ url, hash }\`.
2. \`POST studio/createSwipe\` with \`imageUrl\`, \`imageHash\`, optional
   \`sourceUrl\`, \`brandName\`, \`angleId\`, \`visualStyleId\`, \`whyItWorks\`.
3. Tags are optional at capture — analysis runs automatically and untagged
   swipes still count as untried. Repeat per image.

### Monday triage

1. \`POST studio/refreshSuggestions\` → note \`suggestionRunId\`.
2. Poll \`GET studio/home\` until the latest run is \`completed\` (or \`failed\` —
   report the error summary and stop).
3. Review cards from \`GET studio/suggestions\`; for each, either
   \`POST studio/setSuggestionStatus\` (\`approved\` / \`skipped\`) or
   \`POST studio/approveSuggestion\`.
4. \`POST studio/generateApproved\` → per-suggestion generation ids.
5. Poll \`GET studio/generation\` per id until \`ready\`/\`failed\`; retry failures
   with \`POST studio/retry\` or \`POST studio/retryVariant\`.
6. Mark keepers \`good\` via \`POST studio/setVariantMark\`.

### Make more like a winner

1. \`GET studio/winningAngles\` / \`GET studio/topByPurchases\` for proven angles
   and linked variants; \`GET studio/remixSource\` for a concrete source.
2. \`POST studio/extendVariant\` on the winning variant → poll the returned
   generation to a terminal state.

### Publish → link

1. When an ad ships, \`GET studio/linkCandidates\` proposes name-matched ads
   (template \`{BRAND}-ST-{angle}-{id6}\`).
2. Confirm with \`POST studio/linkVariantToCreative\` — or do both steps at once
   with \`POST studio/publishAndLink\`. Linking is always human/agent-confirmed;
   nothing is inferred silently, and nothing writes back to Meta.

## Supporting config

Brand profile (\`studio/brandProfile\` / \`saveBrandProfile\`) carries voice,
prohibited claims, and required disclaimers enforced at generation time.
Taxonomies (\`studio/taxonomies\`, \`addTaxonomyValue\`, \`archiveTaxonomyValue\`)
hold the angle / visual-style / hook-type vocabulary. Copy packages live under
\`studio/copyPackages\` and friends.
`;

export function GET() {
  return new Response(GUIDE, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
