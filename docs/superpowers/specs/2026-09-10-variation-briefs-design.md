# Variation briefs: funnel, axis, hypothesis

Date: 2026-09-10. Status: implemented (plan
`docs/superpowers/plans/2026-09-10-variation-briefs.md`). Extends
`2026-09-03-static-ad-variations-design.md` §2 (the agent) and applies the
process parts of the Buzz agent's questionnaire answers
(`rands/BUZZ_AGENT_STATIC_AD_WORKFLOW_QUESTIONNAIRE_2026_09_07.md` §2.1, §2.4,
§3.1, §4.2, §6.1 G).

## Implementation notes and live results (2026-09-10)

Four runs on the local test creatives after the wiring landed (the first
batch produced no images at all because OpenAI had started rejecting
`response_format` for gpt-image-2; `@ai-sdk/openai` was bumped to 3.0.112):

- **R3, no note → axis `proof`, funnel tof.** Source attached (proof keeps
  it). Review passed on attempt 1. Visually a near-copy of the source with a
  "30,000+ users" pill added: the axis is visible but only just. The weakest
  result; a proof-axis change on an attached source stays small by design.
- **R3 again, no note → axis `angle`.** Rotation avoided proof and the two
  axes from the failed first batch. Source not attached; new headline, CTA
  moved above the grid, every tile re-shot in a sunlit room. Attempt 1 was
  rejected for an unprompted extra copy line; attempt 2 passed.
- **R1, note "change the scene to a bright morning bathroom" → axis
  `scene`.** The dark studio became a sunlit tiled bathroom with the copy
  preserved; attempt 1 was rejected for an oversized floating transplant,
  attempt 2 passed with the product shrunk. Product photo fallback used.
- **R2, no note → axis `proof`.** The named testimonial became a stat bar
  (visible change), but the model left a flat ivory card with no locatable
  landing area, the transplant never ran, both reviews said "no product
  visible", the agent re-sent an identical prompt on attempt 2, and shipped
  the rejected attempt through the finish override.

No review failed on "only the words changed"; no axis repeated; the source
was attached exactly when the axis rules say. Follow-ups made from the R2
run: `generateImage` now rejects a prompt identical to a rejected attempt's;
the TRANSPLANT block asks for a landing surface with a visible edge or
footprint, described explicitly; and the user content states the FORMAT
(three runs had opened their prompt with "9:16" for a square source).

## Problem

Variations come back as the source ad with rewritten words. The prompt causes
it: "choose ONE primary change and keep everything else" with no menu of
changes makes a headline swap the cheapest compliant move; the source is always
attached as the layout reference, so the image model copies the composition;
the transplant asks for the landing area "at about the position and size the
product has in the source"; the prompt is capped at 120 words; and the review
never asks whether the result differs from the source at all. Nothing
classifies the source (funnel, lane, what makes it work) or states what the
variation is testing.

## Proposal

### 1. A brief before any image: the `setBrief` tool

The agent gains a fourth tool, called once before the first `generateImage`
(which errors with "Set the brief first" until it has been called):

```ts
setBrief({
  funnel: "tof" | "mof" | "bof",
  lane: string,                 // product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc
  mechanics: string,            // one sentence: what creates stopping power, comprehension, and purchase intent in the source
  locked: string[],             // elements that must not change: product, offer, disclaimer, logo, a user constraint
  axis: "hook" | "angle" | "funnel" | "offer" | "proof" | "scene" | "layout" | "colour" | "copy",
  hypothesis: string,           // "By changing X while keeping Y and Z, we expect A because B."
})
```

The brief is stored on the plan (`funnel`, `axis`, `hypothesis`, `lane`) at
`finish` and on the synthesized plan when the loop ends without one; the card
shows "Testing: <axis> — <hypothesis>" under the summary and the funnel next
to the lane.

The PROCEDURE steps become: read the source → classify it (the analysis
checklist below, folded into the tool's field descriptions) → check the core
context for that lane → choose the axis and write the hypothesis → `setBrief`
→ prompt → review → finish.

Analysis checklist in the prompt (Miley §2.1, shortened): inventory what is
visible; classify the lane; classify the funnel (TOF = problem recognition or
curiosity, MOF = mechanism, education, comparison, objection handling, BOF =
price, offer, urgency, guarantee, strong proof); name the message sequence
(hook → explanation or proof → product → CTA); name what creates stopping
power, comprehension, and purchase intent; separate locked elements from the
test variable; flag factual risk (claims, prices, testimonials).

### 2. The axis menu and the diversity rule

Rules in the prompt, in priority order:

1. A CONSTRAINT FROM THE USER that names a change sets the axis.
2. Edit distance follows performance (Miley §2.4): a source with high ROAS or
   many purchases is a control, so keep its funnel, offer, and mechanics and
   test one entrance to them (hook, proof, colour); high CTR with low ROAS
   means attention without intent, so repair message match or proof; low CTR
   and low ROAS justify a larger change (scene, layout, angle); sparse data
   (few purchases) is a signal, not a winner.
3. Diversity: the user content lists EARLIER VARIATIONS of this creative
   (axis, hypothesis, human mark, review outcome; newest first, up to ten).
   Do not repeat an axis until every other sensible axis has been used;
   prefer axes whose earlier attempts were marked good; avoid ones marked bad
   with the same hypothesis.
4. `copy` is allowed only when the constraint asks for it or when `scene` and
   `layout` have both been used already. A synonym swap, a palette swap, or a
   reworded CTA is not a variation unless that is the deliberate test.
5. `funnel` keeps the source's funnel unless the constraint asks to move it;
   moving to TOF removes price, urgency, and hard CTA language; moving to BOF
   needs a verified offer from the brand profile.

### 3. Loosening the layout anchor

- For axes `scene`, `layout`, `funnel`, and `angle`, the core does not attach
  the source ad as a layout reference (the agent's `keepSourceLayout` is
  ignored and reported back as such); the prompt must describe the whole
  composition. For `hook`, `offer`, `proof`, `colour`, and `copy` the source
  stays attached last as today.
- The TRANSPLANT sentence about the landing area becomes axis-aware: with the
  source attached, "at about the position and size the product has in the
  source ad image"; without it, "wherever your composition places the
  product, sized to read at a glance".
- The prompt cap rises from 120 to 180 words, with Miley's structure spelled
  out: deliverable and format; funnel objective; hierarchy and composition;
  the product rule (landing area or match the photo); palette, lighting,
  mood; exact quoted copy; required logo, CTA, disclaimer; exclusions.

### 4. Strategic review

The review receives the brief (axis and hypothesis) and, for every generate
attempt, the source image as the second image (today only transplant and edit
attempts attach it). New checklist line:

> The variation declares axis "<axis>": <hypothesis>. Compare with the source:
> the change on that axis must be visible in the image, not only in the
> words. For scene, layout, angle, or funnel, the composition or setting must
> differ from the source; if only the copy changed, fail and say "only the
> words changed". For hook, offer, proof, colour, or copy, the named element
> must differ while the rest stays recognisably the same ad.

The agent's retry lever on that failure is stated in the prompt: redesign the
scene or layout in the prompt rather than rewording.

### 5. Memory: earlier variations and marks

The trigger loads the creative's earlier variations (`studio_generation` with
`kind = "variation"` and this `sourceCreativeId`, joined to their variant's
`plan`, `mark`, and status) and passes up to ten as lines in the user content:

```
EARLIER VARIATIONS (newest first):
- scene — "By moving the routine to a bathroom counter…" — marked good — review passed
- copy — "By replacing the headline with…" — no mark — review rejected
```

Runs made before this change have no axis; they are listed as "unclassified"
with their summary so the agent still sees them.

## What it needs

- Agent core: `setBrief` tool and schema; brief on state; `generateImage`
  guard; axis-aware reference list and TRANSPLANT sentence; PROCEDURE rewrite
  (checklist, axis rules, structure, 180 words); plan fields; tests.
- Types: `VariationPlan.funnel`, `lane`, `axis`, `hypothesis` (optional for
  old rows); `VariationRunInput.earlierVariations`.
- Trigger: load earlier variations; pass the brief to the review; attach the
  source to every generate review; strategic checklist line; `onStep("writing
  the brief")`.
- Card: "Testing" line and funnel.
- Docs: `AGENTS.md` Studio note; PR body.
- Live check on R3, R1, R2 twice each (second press must pick a different
  axis), plus one run with a note that names an axis.

## Risks

- More prompt text: about 400 words added to the system prompt; well inside
  budget.
- The strategic review can reject a good ad whose change is subtle. The agent
  gets the specific note and one retry, and finishing on a rejected attempt
  still works with the existing bounce.
- Dropping the source reference on scene and layout axes makes the composition
  less predictable; that is the point, and the transplant keeps the product
  exact regardless of where it lands.
- Old plans without a brief render without the "Testing" line.

## Out of scope

Multi-route batches with a test order; deterministic text rendering; format
recomposition (4:5, 9:16) beyond the current inferred format; a contact
shadow for the transplant.
