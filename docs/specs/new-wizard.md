# New Ad Wizard — Unified Creation Flow

## Problem

Setting up a full ad requires 5 dialogs across 3+ pages: create creative (dialog) → create campaign (dialog) → create landing page (dialog) → add LP version (separate dialog on detail page) → create ad set (dialog, link all three). Every entity starts as an empty shell with just a name, then requires a second editing step on the detail page. This is the single biggest friction point in the app.

## Solution

One full-page wizard that creates a complete ad (creative + landing page + campaign + ad set) in a single flow. Each step lets you either pick an existing entity or create one inline. One submit at the end batch-creates everything and links it.

---

## Route

`src/app/(dashboard)/ads/new/page.tsx`

Accessible from:
- Dashboard CTA: "New Ad" button (primary action)
- Sidebar: "New Ad" link
- Ad Sets list page: "New Ad" button (replaces current "New Ad Set" dialog)

---

## Flow

### Step 1: Creative

Two modes via toggle at top:

**Use existing:**
- Searchable dropdown of existing creatives (name + thumbnail + format)
- Shows resolution tags inline so user can verify it's the right one
- Selected creative is read-only in the wizard

**Create new:**
- Asset upload (image/video) — Vercel Blob
- Required fields: `name`, `format`
- Optional fields grouped as "Resolution Tags": `angle`, `hook`, `tone[]`, `persona`, `awarenessLevel`, `cta`, `notes`
- Resolution fields collapsed by default with "Add resolution tags" expand toggle
- If V2.0 auto-suggest is active: uploading an asset triggers AI suggestion for resolution fields (ghost values, click to accept)

### Step 2: Landing Page

Two modes:

**Use existing:**
- Searchable dropdown of existing landing pages
- On select: shows versions table, user picks a version
- If LP has only one version, auto-selects it

**Create new:**
- Required fields: `name`, `url`
- Inline version creation (no separate step):
  - `pageType`, `heroCopy`, `funnelPosition`
  - Optional: `benefits[]`, `socialProofType[]`
- URL field lives on the version, not the LP (resolves the URL hierarchy confusion from issue #4)

**Skip:**
- Optional step. Some ad sets don't have landing pages (e.g., lead gen forms, app installs)
- "No landing page" checkbox

### Step 3: Campaign

Two modes:

**Use existing:**
- Searchable dropdown of existing campaigns (name + objective + status)
- Most common flow — media buyers usually run multiple creatives under one campaign

**Create new:**
- Required fields: `name`, `objective`
- Optional: `costCap`, `dailyBudget`, `geos[]` (with autocomplete, fixes issue #13), `targetingMethod[]`, `placements[]`
- `demographics` field replaced with structured inputs: age range (min/max number inputs), gender (select: all/male/female), interests (tag input) — fixes issue #14

### Step 4: Review & Create

Summary card showing:
- Creative: thumbnail + name + format + angle
- Landing Page: name + version label + URL (or "None")
- Campaign: name + objective + budget
- Ad Set name: auto-generated as `{creative.name} × {campaign.name}` (editable)
- Optional: add to existing A/B test (dropdown)

Single "Create Ad" button.

---

## Backend

### tRPC Mutation

`src/lib/trpc/routers/ad-wizard.ts`

```ts
adWizard.create
  input: {
    // Creative — either existing ID or new data
    creative:
      | { mode: 'existing'; id: string }
      | { mode: 'new'; data: NewCreativeInput }

    // Landing Page — existing, new, or none
    landingPage:
      | { mode: 'existing'; pageId: string; versionId: string }
      | { mode: 'new'; data: NewLandingPageInput & { version: NewVersionInput } }
      | { mode: 'none' }

    // Campaign — existing or new
    campaign:
      | { mode: 'existing'; id: string }
      | { mode: 'new'; data: NewCampaignInput }

    // Ad Set
    adSet: {
      name: string
      abTestId?: string       // optional: link to existing A/B test
      variantLabel?: string   // optional: "control", "v1", etc.
    }
  }
```

**Transaction:** All creates happen in a single DB transaction. If any step fails, nothing is committed. Returns the created ad set ID for redirect.

**Post-create redirect:** `/ad-sets/{newAdSetId}` — user lands on the ad set detail page with everything linked.

---

## Frontend Architecture

### State Management

Multi-step form state managed with `useReducer`:

```ts
type WizardState = {
  step: 1 | 2 | 3 | 4
  creative: ExistingRef | NewCreativeData | null
  landingPage: ExistingRef | NewLPData | 'none' | null
  campaign: ExistingRef | NewCampaignData | null
  adSet: { name: string; abTestId?: string; variantLabel?: string }
}
```

No URL state needed — wizard is ephemeral. If user navigates away, state is lost (with a "discard changes?" confirm dialog).

### Components

```
src/app/(dashboard)/ads/new/
  page.tsx                    — layout + step navigation
  _components/
    wizard-provider.tsx       — context + reducer
    step-creative.tsx         — step 1
    step-landing-page.tsx     — step 2
    step-campaign.tsx         — step 3
    step-review.tsx           — step 4
    entity-picker.tsx         — reusable searchable dropdown for existing entities
    step-indicator.tsx        — progress bar (1 of 4)
```

### Step Navigation

- Steps shown as horizontal progress bar at top
- "Back" and "Next" buttons at bottom of each step
- "Next" validates required fields for current step before proceeding
- Steps 1-3 can be visited in any order (click progress bar to jump)
- Step 4 (Review) only accessible when all required data is filled
- Keyboard: Enter advances to next step

---

## Interaction with Existing Flows

### What stays
- Detail pages for all entities remain unchanged
- Individual entity creation dialogs remain accessible from their respective list pages (power users who just want to create a standalone creative)
- Inline editing on detail pages still the primary editing surface post-creation

### What changes
- "New Ad Set" button on ad sets list → becomes "New Ad" and opens the wizard
- Dashboard gets a prominent "New Ad" CTA
- Sidebar gets "New Ad" link under a top-level "Ads" section

### What's removed
- Nothing. Existing dialogs stay for standalone entity creation. The wizard is an additional, faster path — not a replacement.

---

## Handling Issue Backlog

This spec addresses these issues from the product friction list:

| Issue | How it's resolved |
|---|---|
| #1 — Too many sequential steps | Single wizard flow, one submit |
| #2 — Forms create empty shells | Wizard collects real fields upfront, not just name |
| #3 — Relationships only via ad sets | Wizard creates relationships as part of the flow |
| #4 — URL hierarchy confusion | URL lives on version only in the wizard's LP creation |
| #5 — A/B test variants one at a time | Review step has "add to A/B test" option |
| #10 — Creative form overwhelming | Required/optional split with collapsed resolution tags |
| #13 — Geos no autocomplete | Wizard uses autocomplete geo input |
| #14 — Demographics freeform | Wizard uses structured age/gender/interests inputs |

---

## Effort Estimate

- Wizard page + step components: 2-3 days
- `adWizard.create` mutation with transaction: 1 day
- Entity picker (searchable dropdown, reusable): 1 day
- Geo autocomplete + structured demographics inputs: 1 day
- Testing full flow (create new, use existing, mixed): 1 day

**Total: ~6-7 days**

---

## Future Extensions

- **Quick duplicate:** From an existing ad set detail page, "Duplicate as new ad" opens the wizard pre-filled with that ad set's creative/LP/campaign. User swaps one thing (e.g., new creative, same campaign) and creates a variant in seconds.
- **Bulk creation:** Upload a CSV of creative × campaign combinations, wizard batch-creates all ad sets.
- **AI-assisted:** "Generate Ad" mode where the brief generator (V2.0) pre-fills the entire wizard based on what's performing well.
