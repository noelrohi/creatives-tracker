# Variation Logo Keep — Design

**Date:** 2026-09-11
**Status:** Approved
**Branch:** `feat/variation-logo-keep` (off `main`)

## 1. Goal

Stop the image model redrawing the advertiser's logo. A variation must carry
the real mark as pixels, not the model's impression of it.

The brand's logo file is already uploaded (`studio_context_image` with
`kind: "logo"`) and already reaches the model, but only through the image
index as a *reference* the model imitates. The agent's `setBrief` tool even
records a `locked` list whose own schema names the logo, and that field is
write-only: it never reaches the prompt, the compositor, or the review. The
product is the only element with pixel-level protection today.

This feature introduces a **keep-list** of preserved regions, with the logo as
its first and only entry, built so a second entry (the disclaimer) is
configuration rather than rework.

### Decisions taken during brainstorming

| Question | Decision |
| --- | --- |
| Scope | Logo only, but the locator, compositor, and persistence take a list of keeps |
| Pixel source | Brand logo asset first, verified as the same lockup as the source's mark; a cut from the source only when the source is the advertiser's own creative |
| Placement | The model is told not to draw a mark and to leave space; the source's own position is a candidate when it still fits; otherwise a safe-area anchor |
| Blending | Edge feather only. No colour cast, no contact shadow |
| Contrast | Measured thresholds, plus light/dark variant selection when the brand has both |
| Missing logo | A failed run, never a shipped logo-less variation |

### Verified against the agency workflow document

`rands/BUZZ_AGENT_STATIC_AD_WORKFLOW_QUESTIONNAIRE_2026_09_07.md` (git-ignored)
was reviewed against an earlier draft of this design and changed it in five
places. Each correction is marked **[Buzz]** where it appears below. The
document's own layout format marks `logo` and `disclaimer` as `locked: true`,
which is the keep-list shape this spec adopts.

## 2. Non-goals

- Preserving the disclaimer, offer badge, or any second element. The
  structure admits one; this spec ships only the logo.
- Co-branding, retailer logos, press logos, certification marks, and platform
  badges. The agency document does not mention them and no current creative
  uses them.
- Auto-recolouring or auto-inverting the mark. Brand guidelines permit
  specific variants only.
- The deterministic render layer (§11).

## 3. The keep-list model

A **keep** is one preserved region with its own sourcing, placement, and
compositing policy:

```ts
type VariationKeepKind = "logo";

type VariationKeep = {
  kind: VariationKeepKind;
  /** Where the pixels came from. */
  patchSource: "asset" | "source";
  assetImageId: string | null;
  /** The mark's box in whatever image it was cut from, normalized. */
  from: NormalizedBox;
  /** Where it landed in the output, normalized. */
  to: NormalizedBox;
  /** Which placement rule chose `to`. */
  placement: "drawn" | "source_position" | "anchor";
  anchor: KeepAnchor | null;
  contrast: { ratio: number; variant: "light" | "dark" | "only" };
};
```

The run resolves keeps before the agent starts, the same way the product
patch is resolved today, and carries them through the agent input. Nothing
about the product transplant changes.

## 4. Sourcing the logo pixels

A ladder, highest fidelity first.

1. **Brand logo asset.** The newest `studio_context_image` with
   `kind: "logo"` for the organization. A transparent PNG needs no cut-out at
   all, which skips the matte entirely. A flat-background image goes through
   the existing matte, whose flood-fill suits a mark on a solid panel.
2. **Lockup check.** One vision call compares the asset against the mark
   located in the source. It returns per-feature agreement (wordmark present,
   icon present, orientation, colourway) rather than a single confidence
   score, **[Buzz]** because the document warns that one similarity number
   confidently rates the wrong thing as close. The asset is used when the
   wordmark and icon composition agree; orientation or colourway differences
   alone do not disqualify it, since those are the variants §7 selects
   between.
3. **Source cut.** Used when there is no asset, or the lockup disagrees. It
   is allowed **only when the source is the advertiser's own creative**.
   **[Buzz]** A source that is AI-generated or a competitor ad may contain a
   pseudo-logo, and cutting it propagates a fake mark. The run already
   distinguishes a creative source from a competitor ad, and the existing
   `editModeAvailable` gate uses the same distinction.
4. **Failure.** See §8.

## 5. Placement

**The model is told not to draw a mark.** The transplant prompt block gains a
logo clause in the same voice as the product's: do not draw a logo, wordmark,
or brand badge anywhere; leave clear space where one would sit. **[Buzz]** The
document's production prompts carry "no generated logos" and "no fake logos"
for exactly this reason, and covering a generated element is called fragile
because its silhouette and surrounding occlusion survive underneath.

At paste time the target is chosen in this order:

1. **A drawn mark, if the model drew one anyway.** We must cover it, because
   leaving it would ship two logos. This is a compliance fallback, not the
   intended path.
2. **The source's own position**, expressed as a normalized box, when it
   still fits: inside the safe area, and not overlapping the headline, CTA,
   or disclaimer located in the *output*. Keeping the mark where it was makes
   a variation read as a sibling of its source.
3. **A safe-area anchor.** The corner nearest the source's original position
   that satisfies the safe area and the collision check.

**[Buzz]** Placement never uses raw source coordinates without revalidation:
layouts reflow between variations, and a mark replayed blindly lands
underscaled or inside a platform safe zone.

**Safe area** is a normalized inset per format, `0.06` on every edge for
square, and `0.06` sides with `0.12` top and bottom for portrait, reserving
the platform's own UI. **Collision** is checked against the copy regions the
output locator returns; the mark must not overlap them.

**Scale** is capped as the product's is: the pasted mark may not exceed
`1.25×` the width it had in the source, so a generous drawn box cannot
inflate it.

## 6. Compositing

The logo gets the product's geometry handling and none of its lighting.

- **Feather only.** A subpixel-to-two-pixel edge feather so the paste does
  not read as a hard cut. **[Buzz]** Their composite ladder begins with
  feathering before any colour work. A transparent PNG asset already carries
  its own alpha and needs none added.
- **No colour cast.** The product's 15% cast toward the scene's channel
  ratios would corrupt brand colours.
- **No contact shadow.** A logo is a flat graphic overlay, not an object
  resting on a surface.
- Uniform fit inside the target box, centred, preserving aspect ratio.

## 7. Contrast and legibility

Measured, not judged. **[Buzz]** The document treats legibility as a
deterministic threshold precisely because asking a generator to be legible is
avoidable risk, and it distinguishes "present" from "legible at served size".

- The existing ring sampler measures the output's luminance in a ring around
  the paste box.
- **Variant selection.** When the organization has more than one logo asset,
  the one whose contrast ratio against that background is higher wins.
- **Threshold.** The pasted mark must reach a contrast ratio of at least
  `3.0` against its background and occupy at least `0.04` of canvas width.
  Below either, the attempt is marked contrast-failed and the agent may
  retry; the placement rule then prefers a different anchor.
- The mark itself is never recoloured.

## 8. When no real logo is available

**A variation that should carry a logo and cannot is a failed run.** It is
not shipped without one. The failure reason is `logo_unavailable`, alongside
the existing `no_image | claims | review | likeness | logo | moderation`
reasons, and it surfaces on the variation card like any other failure.

**The exception:** when no mark is located in the source at all, the source
ad simply had no logo, there is nothing to preserve, and the run proceeds
normally. Adding a logo the original never had is a different change and
belongs to a different axis.

**[Buzz]** Their extraction ladder ends "if extraction is unreliable, do not
composite", and this spec goes one step further at the owner's instruction:
not compositing means the run fails rather than shipping a mark-less ad.

## 9. Rebrand mode

When the source is a competitor ad, the keep **inverts**. The source's mark
must not be preserved; the advertiser's asset is placed instead, and a source
cut is forbidden outright. **[Buzz]** Their rule is that all competitor
branding and trade dress must be replaced. If the advertiser has no logo
asset in rebrand mode, §8 applies and the run fails.

## 10. Review, QA, and persistence

- The review's system prompt gains a logo block: the mark must be the
  advertiser's real one, undistorted, not overlapping copy, and legible at
  feed size. **[Buzz]** Their QA checklist already carries "Official logo is
  correct; no typed or distorted substitute", but logo correctness is absent
  from their auto-fail list; this spec makes it a hard fail.
- The review already runs at two scales; the logo's legibility check belongs
  to the feed-size pass.
- `studio_variant.attempts[]` records the `VariationKeep` per attempt, and
  the shipped plan records the final one, so a card can say where the mark
  came from and which placement rule chose its position, the way it already
  says the product was transplanted.

## 11. What this is a step toward

**[Buzz]** The agency's target architecture renders the logo and the copy
deterministically, in a layout layer the image model never touches, with the
generated image used only as artwork beneath. This spec does not build that.
It reuses the transplant machinery that exists today to fix the mark that is
being mangled now. The destination is recorded here so the transplant is not
later mistaken for the finished design: the disclaimer, then the headline and
CTA, belong in the same layer, and each one added to the keep-list is a step
along that path.

## 12. Testing

- **Unit:** the placement chooser (drawn box, fitting source position,
  anchor selection, safe-area and collision rejection); the scale cap; the
  contrast threshold and variant selection; the lockup check's per-feature
  verdict.
- **Compositing:** a feathered paste leaves brand colours unchanged, which a
  colour-cast paste would not; no shadow is composited.
- **Sourcing ladder:** asset preferred; lockup disagreement falls to the
  source cut; an AI-generated or competitor source never yields a cut;
  rebrand mode never yields a cut.
- **Failure:** a source with a located mark and no obtainable logo fails with
  `logo_unavailable`; a source with no mark proceeds.
- **Persistence:** the keep is recorded per attempt and on the plan.
