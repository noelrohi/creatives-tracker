# Test plan feedback & plan rules — design

**Date:** 2026-08-18
**Status:** Approved for implementation
**Design source:** Claude Design canvas "Test Plan Feedback"
(https://claude.ai/code/artifact/6212f894-485d-44bf-8ebf-444abfa86e84)
**Builds on:** `docs/spec/competitor-signals-v1.md` (§9 test plan)

## Goal

Turn the test plan at `/competitors/test-plan` from a read-mostly checklist
into a feedback loop. The screen gains richer per-hook ad copy, per-hook
ratings with reasons, a per-concept comment thread, and an org-scoped set of
standing **plan rules**. The device-side fill harness reads all of it before
generating the next plan, so the plan improves run over run — and rules are
the durable memory that survives regeneration.

The canvas is the layout and content contract; the app's real shadcn
components and Tailwind tokens are the building material.

## Scope

**In:**

- (A) Richer ad rows — per-hook headline/description/CTA, one row per hook in
  the UI with per-format status controls
- (B) Feedback — per-hook thumbs up/down with reason chips, per-concept
  comment thread
- (C) Plan rules — org-scoped rules table, promote-comment-to-rule, rules and
  feedback read by the next harness run

**Out (deferred to a follow-up spec):**

- (D) UGC briefs — competitor video transcripts captured at fill time and the
  per-row brief expander. The "UGC brief" button in the canvas is **not**
  built in this round.
- Deleting/editing comments and rules (toggling a rule off covers v1),
  per-user ratings, feedback history across regenerations.

## Lifecycle (decided)

Ratings and comments belong to their concept and **cascade-delete with it**.
The harness reads all current feedback at generation time (step 8) before
pushing, so feedback always informs exactly the next plan. Promoted and
hand-added rules are the only durable memory. This matches the UI caption
"Read by the next plan run."

Ratings are **org-shared, last-writer-wins** — tracking-sheet semantics, the
same reasoning as the existing status select (§9: "a tracking sheet, not an
approval system"). No per-user votes.

## Data model

All in `src/schema/competitor-signals.ts`. One additive migration via
`bun run db:generate` + `bun run db:migrate`: one new column, three new
tables, two new enums. No data migration.

### `test_plan_concept` — new column

- `hookCopy: jsonb` typed `{ hook: string; headline: string; description:
  string; cta: string }[]`, **nullable**. Old concepts have `null`; the UI
  degrades to a hook-only row. Each entry's `hook` must be one of the
  concept's `hooks` (validated at ingest, like `ads[].hook`).

### New table `test_plan_hook_feedback`

| column | type | notes |
|---|---|---|
| `id` | text pk | uuid default, repo pattern |
| `organizationId` | text | indexed |
| `conceptId` | text fk → `test_plan_concept` | **cascade delete** |
| `hook` | text | one of the concept's `hooks` |
| `rating` | enum `test_plan_hook_rating`: `up` \| `down` | |
| `reasons` | jsonb `string[]` | reason slugs; meaningful only while `down` |
| timestamps | | repo pattern |

Unique index on `(conceptId, hook)`. Clearing a rating deletes the row.
Server clears `reasons` whenever rating is not `down`.

Reason vocabulary is a code fixture (slugs stored, labels rendered from
`copy.ts`):

| slug | label |
|---|---|
| `too_generic` | Too generic |
| `off_brand_voice` | Off brand voice |
| `wrong_claim_risk` | Wrong claim risk |
| `weak_angle` | Weak angle |
| `weak_cta` | Weak CTA |
| `overlaps_live_ad` | Overlaps a live ad |

### New table `test_plan_comment`

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `organizationId` | text | indexed |
| `conceptId` | text fk → `test_plan_concept` | **cascade delete** |
| `authorUserId` | text fk → `user` | display name joined at read |
| `text` | text | |
| `promotedRuleId` | text fk → `plan_rule` | **set null**; non-null renders the promoted tag |
| timestamps | | |

### New table `plan_rule`

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `organizationId` | text | indexed |
| `text` | text | |
| `source` | enum `plan_rule_source`: `feedback` \| `manual` | |
| `active` | boolean default true | |
| `attributionName` | text | snapshotted at creation — comment author for promoted rules, creator for manual ones. Snapshot because comments cascade-delete. |
| `createdByUserId` | text fk → `user` | |
| timestamps | | |

### Built-in guardrail rule — code fixture, not a row

Same pattern as `BUDGET_ROUTING_NOTE` (§9: deterministic fixtures the LLM
cannot paraphrase away). Text, in `copy.ts` and carried verbatim by the
harness skill (the two must stay in sync — noted in both files):

> Never claim to diagnose, treat, or cure a condition — describe the product
> mechanism and subjective experience only.

It renders pinned first on the rules card with a shield badge and no switch,
and is **not** returned by the API — the skill carries it, so a DB wipe can
never silently drop the compliance rule.

## API

### `ingestTestPlan` (existing mutation — additive change)

`planConceptSchema` gains
`hookCopy: z.array(z.object({ hook, headline, description, cta })).nullable()`.
Every `hookCopy[].hook` must be one of the concept's `hooks`, else 400 —
mirroring the `ads[].hook` rule. Regeneration semantics (replace `proposed`
only, concept survives on the strength of its ads) are untouched.

### `testPlan` (existing query — richer output)

Each concept additionally returns:

- `hookCopy` (as stored, nullable)
- `feedback: { hook, rating, reasons }[]`
- `comments: { id, authorName, createdAt, text, promotedRuleId }[]`
  (author name joined from the Better Auth `user` table)

One extra grouped read per table — the same pattern as the ads read, never a
query per concept.

### New router file `src/lib/trpc/routers/signals.feedback.ts`

Composed into the signals router alongside `signals.plan.ts` (keeps the plan
file from growing further). All mutations on `orgWriteProcedure`, no extra
role gating — same reasoning as `setTestPlanAdStatus`.

- `rateTestPlanHook({ conceptId, hook, rating: 'up' | 'down' | null,
  reasons? })` — upsert; `null` deletes the row. Rejects a hook not in the
  concept's `hooks` and reason slugs outside the fixture list. Clears
  `reasons` unless rating is `down`.
- `addTestPlanComment({ conceptId, text })` — author is the session user.
- `promoteCommentToRule({ commentId })` — creates a `plan_rule`
  (`source: 'feedback'`, `text` = comment text, `attributionName` = comment
  author's name), sets `promotedRuleId`. No-op (returns the existing rule) if
  already promoted.
- `addPlanRule({ text })` — `source: 'manual'`.
- `setPlanRuleActive({ ruleId, active })`.
- `planRules` query — the org's rules, oldest first.

### New OpenAPI read `signals.planFeedback`

GET via `openApiQueryMeta`, `read` scope — the same exposure as
`rankedSignals`. One call returns everything harness step 8 needs:

```
{
  rules: { text, source, attributionName }[],        // active only; built-in NOT included
  concepts: {
    title, hooks,
    feedback: { hook, rating, reasons }[],           // reason slugs
    comments: { authorName, text, createdAt }[]
  }[]
}
```

## UI

All in `src/components/blocks/competitor-signals/`. Icons from
`@/components/icons` (Solar), never `lucide-react`. Statuses stay uncolored
(deliberate rule in `test-plan-status-select.tsx`). Mutations follow the
existing pattern: mutate → invalidate `signals.testPlan` (and `planRules`),
controls disabled while pending, `toast.error` on failure — no optimistic
updates.

### `test-plan-concept.tsx` — restructured (table → hook-grouped rows)

- Ads grouped by hook in `concept.hooks` order; a format chip renders only
  for ad rows that exist (asymmetric survivals render one chip).
- Hook row: index number · hook text (14px medium — deliberate emphasis) ·
  one **format status chip** per ad row (image/video icon + status + chevron;
  new `TestPlanFormatStatusSelect`, a shadcn `Select` styled as the chip,
  reusing the mutation/invalidate pattern of `TestPlanStatusSelect`) ·
  thumbs up/down.
- Below the hook: the ad-copy strip (headline, description, CTA chip) when
  `hookCopy` has an entry for the hook; omitted otherwise.
- Thumbs-down reveals the "What's off?" reason-chip panel; chips toggle via
  `rateTestPlanHook`; leaving `down` clears them (server-enforced, UI
  reflects).
- Header gains "{n} of {total} approved" (counting ad rows with status
  `approved`).
- Copy guardrail collapses behind a toggle (shadcn Collapsible), shield icon
  kept, collapsed by default.
- `BUDGET_ROUTING_NOTE` stays as the single footer caption.
- Card footer: **Feedback thread** — title "Feedback", subcaption "Read by
  the next plan run.", comment list (avatar initial, author, relative time),
  "Make this a rule" button → green "Plan rule — applies to every future
  generation" tag once promoted, composer (Textarea, placeholder "What
  should the next plan do differently?", Post button disabled when empty).

### New `plan-rules-card.tsx`

Rendered below the concepts on `test-plan/page.tsx`. Title "Plan rules",
subcaption "Standing instructions every plan generation follows. Rules stack
with each concept's copy guardrail." Built-in fixture rule pinned first
(shield badge, no switch), then DB rules — text, attribution line ("Promoted
from feedback · {name}" / "Added by {name}", with relative time) and an
on/off Switch; inactive rules dim. Add-rule composer at the bottom
(placeholder "Add a rule for every future plan…").

## Harness (`.claude/skills/fill-competitor-signals/SKILL.md`)

Step 8 changes:

1. Before generating, `GET $ADSOLUTE_URL/api/openapi/signals/planFeedback`.
2. The prompt contract gains, in order: the built-in guardrail rule verbatim
   (fixture text lives in the skill), every active plan rule, and the current
   plan's feedback — down-rated hooks with their reasons, up-rated hooks, and
   comments — with the instruction to address the feedback in the new
   concepts.
3. The output schema gains `hookCopy` per concept: one entry per hook —
   `{ hook, headline, description, cta }` — hook matched character for
   character (a drifted hook is a 400 on the whole push, same as `ads[].hook`).

Step 9's payload example gains `hookCopy`. The report section notes rules and
feedback consumed. The built-in rule text carries a sync note pointing at
`copy.ts`.

## Testing

Vitest via `bun run test`, mirroring `signals.plan.test.ts` style:

- `ingestTestPlan` accepts `hookCopy`, rejects an entry whose hook is not in
  the concept's `hooks`, accepts `null`.
- `testPlan` returns `hookCopy`, feedback, and comments grouped per concept.
- `rateTestPlanHook`: upsert, clear-deletes the row, rejects unknown hooks
  and off-fixture reason slugs, clears reasons when rating leaves `down`.
- Regeneration: replacing a concept cascade-deletes its feedback and
  comments; a promoted rule survives with its `attributionName`;
  `promotedRuleId` on a surviving comment nulls if its rule is ever deleted
  (fk behavior).
- `promoteCommentToRule` is idempotent.
- `planFeedback` returns active rules only and excludes the built-in fixture.

Component tests (`bun run test:components`): grouped hook rows with
per-format chips, copy strip presence/absence by `hookCopy`, reasons panel
visibility tied to rating, thread rendering and promoted tag, rules card
(built-in pinned, switch toggling, composer).

## Decisions log

- Scope A+B+C now; D (UGC briefs/transcripts) deferred — it changes the
  collection harness itself.
- Feedback dies with its concept; rules are the durable memory.
- Rules live on the test-plan page, not a separate route.
- Data model: hooks stay `string[]`; per-hook copy as jsonb on the concept;
  feedback keyed `(conceptId, hook)` — chosen over a first-class hook table
  (churn) and over per-ad-row copy columns (divergence, per-format rating
  mismatch).
- Ratings org-shared, not per-user.
- Built-in rule is a code fixture, excluded from the API on purpose.
- UI built from the app's shadcn components — canvas is the contract for
  layout, wording, and tokens; dropdown/icon internals follow the codebase.
