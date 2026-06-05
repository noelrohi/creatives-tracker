# Launchpad v2 Implementation Plan

## Goal

Build the missing pre-launch creation layer for routine Meta creative launches:

```txt
Approved existing campaign/ad set template
→ selected creatives
→ Launch Plan dry-run
→ create paused campaign/ad set/ads
→ review/activate in Meta Ads Manager
→ monitor/pause in Adsolute
```

This is not a blank Meta Ads Manager replacement in the first milestone. It is a beginner-safe wrapper for creating complete paused Meta drafts from approved existing campaign/ad set templates.

## Current codebase assets to reuse

- `src/schema/launchpad.ts`
  - `launchpad_publish_run`
  - `launchpad_publish_item`
  - manifest/hash/idempotency/reconciliation fields
- `src/lib/launchpad-ledger.ts`
  - hashing
  - validation summaries
  - PAUSED-only safety gates
  - status aggregation
- `src/lib/launchpad-planner.ts`
  - useful prior art for current ad-only dry-run
- `src/lib/launchpad-destinations.ts`
  - account/ad set readiness patterns
- `src/lib/launchpad-meta-publish.ts`
  - image/video upload
  - creative creation
  - paused ad creation
  - ad reconciliation
- `src/lib/trpc/routers/launchpad.ts`
  - current Launchpad API seam
- `trigger/launchpad-publish.ts`
  - Trigger execution pattern
- Existing post-launch layer:
  - Meta sync/status refresh
  - performance dashboard
  - creative/ad performance views
  - pause selected Meta ads

## Product principles

1. New users should not choose pixels, attribution, placements, audience, optimization, or bid strategy manually.
2. Dangerous Meta settings should be copied from approved existing campaign/ad set templates.
3. All created Meta objects are PAUSED.
4. Dry-run/Launch Plan is required before publish.
5. Publish must execute a locked manifest, not mutable UI state.
6. Partial failure must be visible and retry-safe.
7. Current ad-only Launchpad backend can remain as legacy/reusable infrastructure, but v2 should replace the primary UX.

---

# Milestone 1 — Dry-run only demo

No Meta writes yet.

## Deliverable

A user can:

1. Pick an approved existing campaign/ad set template.
2. Select creatives.
3. Enter launch name and destination URL.
4. Generate a Launch Plan preview showing:
   - source campaign/ad set
   - planned new campaign
   - planned new ad set
   - planned ads
   - selected creatives
   - copied settings summary
   - budget/currency summary
   - URL/UTM summary
   - warnings/blockers
   - “all objects will be created paused”

## Schema

### Add source template table

New table suggestion: `launchpad_source_template`

Fields:

```ts
id
organizationId
accountId
sourceCampaignId
sourceCampaignMetaId
sourceAdSetId
sourceAdSetMetaId
label
notes
status // approved | disabled | needs_review
approvedByUserId
approvedAt
lastValidatedAt
expiresAt
metadata jsonb // warnings, source summary, supported profile
createdAt
updatedAt
```

Minimal first version can be manually managed/admin-only.

### Add campaign account linkage

File: `src/schema/campaign.ts`

Add nullable:

```ts
accountId: text("account_id").references(() => adAccounts.id, { onDelete: "set null" })
```

Backfill later only when all child ad sets agree.

## New modules

### `src/lib/launchpad-source-templates.ts`

Responsibilities:

- list approved templates
- validate template belongs to org
- return source campaign/ad set summary
- expose plain-English readiness

### `src/lib/launchpad-clone-classifier.ts`

Responsibilities:

- classify source campaign/ad set as:
  - `eligible`
  - `eligible_with_warning`
  - `blocked`
  - `manual_review_required`
- return blockers/warnings with plain-English messages
- v1 allowlist should be intentionally narrow

Initial blocker examples:

- missing Meta account token
- missing source campaign/ad set Meta ID
- missing Facebook Page identity
- unsupported creative format
- source template disabled/not approved
- missing destination URL

Later blocker examples:

- CBO/Advantage campaign budget
- lifetime budget
- dynamic creative
- catalog/product sets
- special ad categories
- missing/unreadable promoted object
- unsupported placements/objectives

### `src/lib/launchpad-clone-planner.ts`

Responsibilities:

- input: template + creatives + launch inputs
- output: manifest v2 / Launch Plan
- no Meta writes
- no local campaign/ad set/ad shell creation

Manifest v2 shape:

```ts
{
  version: 2,
  kind: "creative_launchpad.clone_setup_manifest",
  launchMode: "clone_setup",
  requestedStatus: "PAUSED",
  sourceTemplate: {...},
  sourceSnapshot: {...},
  plannedCampaign: {...},
  plannedAdSet: {...},
  plannedAds: [...],
  copiedSettings: [...],
  notCopiedSettings: [...],
  budget: {...},
  tracking: {...},
  identity: {...},
  url: {...},
  validation: {
    status,
    blockers,
    warnings
  },
  safety: {
    dryRunOnly: true,
    localObjectsCreatedDuringValidation: false,
    metaObjectsCreatedDuringValidation: false,
    allCreatedObjectsPaused: true
  }
}
```

### `src/lib/launchpad-url.ts`

Responsibilities:

- validate HTTPS URL
- normalize required UTMs
- show final URL
- show UTM merge behavior

Keep first version simple: syntax + HTTPS + preview, no server-side live URL fetching.

## tRPC endpoints

Add to `src/lib/trpc/routers/launchpad.ts` or a new internal module imported by it:

```ts
listSourceTemplates()
getSourceTemplate({ templateId })
createCloneDryRun({
  sourceTemplateId,
  launchName,
  destinationUrl,
  defaultPrimaryText?,
  defaultHeadline?,
  defaultCta?,
  creativeIds: string[]
})
```

Return persisted `launchpad_publish_run` with `manifest.version = 2` and status `validated` or `failed`.

## UI

Prefer new component split instead of continuing to grow `launchpad-page-client.tsx`.

Suggested files:

```txt
src/components/launchpad-v2/source-template-step.tsx
src/components/launchpad-v2/creative-selection-step.tsx
src/components/launchpad-v2/launch-details-step.tsx
src/components/launchpad-v2/launch-plan-review.tsx
src/components/launchpad-v2/buyer-handoff-card.tsx
```

MVP UI flow:

```txt
Source campaign/ad set template
→ Creatives
→ Launch details
→ Launch Plan preview
```

No publish button until Milestone 2, or show disabled “Create paused setup” with explanation.

## Tests

Add:

```txt
src/lib/launchpad-clone-planner.test.ts
src/lib/launchpad-clone-classifier.test.ts
src/lib/launchpad-url.test.ts
src/lib/trpc/routers/launchpad-clone.test.ts
```

Test cases:

- dry-run creates no local campaign/ad set/ad rows
- approved template required
- source template org scoping
- missing creative blocked
- unsupported creative format blocked
- invalid URL blocked
- manifest hash deterministic
- v1 and v2 manifests are distinct
- all planned objects request PAUSED

---

# Milestone 2 — Paused campaign/ad set creation

## Deliverable

From a validated v2 dry-run, worker creates:

1. local paused campaign shell
2. Meta paused campaign
3. local paused ad set shell
4. Meta paused ad set
5. records external IDs
6. reconciles created objects

No ads yet, or ads can remain Milestone 3 if needed.

## Schema additions

Either add setup fields to `launchpad_publish_run`:

```ts
createdCampaignId
createdCampaignMetaId
createdAdSetId
createdAdSetMetaId
setupStatus
setupReconciliationStatus
setupErrorCategory
setupErrorCode
setupErrorMessage
setupErrorDetails
```

Or add a general operation table.

Preferred cleaner option:

### New table: `launchpad_publish_step`

```ts
id
runId
organizationId
objectType // campaign | ad_set | creative | ad
plannedKey
status // planned | creating | created | reconciled | failed | ambiguous | manual_intervention
payloadHash
idempotencyMarker
externalMetaId
localObjectId
attemptCount
errorCategory
errorCode
errorMessage
errorDetails
reconciliationStatus
reconciliationCheckedAt
createdAt
updatedAt
```

Unique:

```ts
unique(runId, objectType, plannedKey)
unique(organizationId, idempotencyMarker)
```

## Meta helper additions

File: `src/lib/launchpad-meta-publish.ts` or new `src/lib/launchpad-meta-setup-publish.ts`

Add:

```ts
createPausedMetaCampaign(...)
createPausedMetaAdSet(...)
fetchMetaCampaignSnapshot(...)
fetchMetaAdSetSnapshot(...)
reconcileCreatedMetaCampaign(...)
reconcileCreatedMetaAdSet(...)
```

Prefer copy endpoints where safe later; first implementation can use a narrow allowlisted create payload if source snapshot fields are sufficient.

## Worker

Add new Trigger task:

```txt
trigger/launchpad-clone-publish.ts
```

Payload must only include IDs:

```ts
{
  organizationId,
  runId,
  expectedManifestHash
}
```

Sequence:

```txt
load run
verify manifest hash
verify not expired
verify PAUSED-only
revalidate template/account/token/source access
create/reconcile campaign
create/reconcile ad set
stop after setup for M2
```

## Tests

- stale manifest rejected
- manifest hash mismatch rejected
- no token in Trigger payload
- campaign create persists local + Meta ID
- ambiguous campaign create becomes manual intervention
- ad set does not run if campaign failed
- readback must be PAUSED

---

# Milestone 3 — Ads from selected creatives

## Deliverable

After setup exists, create one paused ad per selected creative.

Reuse existing helpers:

- upload image/video
- create Meta creative
- create paused Meta ad
- reconcile Meta ad
- local paused ad shell

But target the newly created ad set from v2 manifest/run.

## Refactor

Extract current `workerExecuteLivePublish` item logic into reusable service:

```ts
publishLaunchpadAdItemToAdSet({
  organizationId,
  run,
  item,
  targetAdSetMetaId,
  account,
  pageId,
  instagramActorId
})
```

Current direct-ad-set flow and new clone flow can both use it.

## Tests

- mixed static/video batch
- failed video item does not fail successful static item
- retry only failed ads
- existing Meta creative/ad IDs are reconciled, not duplicated
- all created ads PAUSED
- local ad rows link to new v2 ad set

---

# Milestone 4 — Buyer handoff and run detail polish

## Deliverable

After publish, show:

- created campaign link
- created ad set link
- created ad links
- local object links
- selected creatives
- final URLs
- copied settings summary
- warnings
- activation checklist
- copyable buyer brief

Success copy:

> Created paused. No spend has started. Review and activate in Meta Ads Manager.

## UI states

Use action-oriented states:

- Draft
- Dry-run needs fixes
- Ready to create paused setup
- Creating paused setup
- Created paused for buyer review
- Partial/manual intervention
- Policy/review issue
- Failed before Meta creation

---

# Explicit non-goals for v2 MVP

Do not build yet:

- blank campaign builder
- pixel/event picker
- targeting editor
- placement editor
- bid strategy editor
- attribution editor
- CBO/Advantage campaign budget support
- dynamic creative/catalog/carousel/collection
- activation from Adsolute
- scheduling
- budget scaling
- rules/automation
- AI media-buying recommendations
- multi-source/multi-account launch

---

# Cofounder pitch

Adsolute already has the operating layer after ads exist:

```txt
sync → performance → status → pause
```

Launchpad v2 adds the missing creation layer:

```txt
approved campaign/ad set template → creatives → paused Meta draft
```

This is the fastest path toward replacing routine Meta Ads Manager usage without recreating every confusing Meta control before we know which controls matter.
