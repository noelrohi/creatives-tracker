# Transplant blending: shadow, light match, scale cap, no default pedestal

Date: 2026-09-10. Status: proposed. Extends
`2026-09-07-variation-empty-scene-transplant-design.md`.

## Problem

Now that variations change scene and layout, the transplanted product is the
weak spot: it reads as a sticker. Three causes, seen on the live runs:

1. **No shadow and no light match.** The patch keeps the source's lighting and
   sits on the new surface with a hard footprint and no contact shadow, so it
   floats (the dusk bedside and the bathroom counter runs).
2. **Scale from the box, not the scene.** The patch is uniform-fit into
   whatever landing box the locator returns; a generous box makes the product
   huge (the bathroom counter run needed a retry to shrink it).
3. **A pedestal in most scenes.** The transplant prompt tells the model to
   leave "an evenly lit plain surface (pedestal top, flat card area,
   tabletop)", so the model adds a round stand even in a bedroom or bathroom.

## Proposal

### 1. Blend the patch into the scene (deterministic, no model call)

`pastePatch` gains three options, all applied by sharp before compositing:

- **`matchLight`.** Sample the output around the paste box (a ring 25% wider
  on each side, excluding the box) and the patch's opaque pixels. Apply a
  brightness gain `clamp(ringLuma / patchLuma, 0.75, 1.25)` to the patch,
  plus a mild colour cast: 15% of the way toward the ring's channel ratios.
  Bounded so the product keeps its colour and only picks up the room's light.
- **`shadow`.** Composite a soft contact shadow under the patch before the
  patch: a black ellipse centred on the patch's horizontal centre at its
  bottom edge, width 90% of the paste width, height 16% of the paste width,
  blurred with sigma 5% of the width, opacity `0.2 + 0.35 * ringLuma / 255`
  (stronger on light surfaces, subtle on dark ones).
- **`maxWidth`** (fraction of the output width). Caps the uniform fit so the
  product never exceeds the cap; alignment unchanged.

The result reports `{ bytes, box, blend: { lightGain, shadowOpacity } }` for
logging.

### 2. Scale from the source

The trigger passes `maxWidth = sourceProductBox.w * 1.25` (the product's
relative width in the source ad, with a quarter of headroom) for both patch
sources. The landing box still positions the product and bounds it from
above; the cap stops a generous box from inflating it.

### 3. No default pedestal

The TRANSPLANT block asks for a landing area **on a surface that already
belongs to the scene** (a nightstand, a tray, a counter, a shelf, the
surface the source uses) and says not to add a stand, pedestal, or platform
unless the source has one. The locator's `landing` description drops
"pedestal" as its first example. The review gets a note-level line: an added
stand or pedestal the source does not have is reported as a note, not a
failure.

### 4. Where it applies

Generate-mode transplants only (both `product` and `landing` targets, both
patch sources). Edit mode's rectangle paste is untouched.

## What it needs

- `src/lib/image-composite.ts`: the three options, ring and patch sampling,
  shadow SVG, per-channel gains via `sharp.linear` on RGB with alpha kept;
  tests with synthetic tiles (shadow pixels darker below the patch; gain
  bounded; cap respected; options off = unchanged output).
- `src/lib/variation-agent.ts`: TRANSPLANT wording; test.
- `trigger/generate-variation.ts`: pass the options and `maxWidth`, log the
  blend, locator `landing` wording, review note line.
- Live check on R1 (bathroom note), R3 ("put it on a nightstand at night"),
  R2 (no note): shadow visible, no pedestal unless asked, product not
  oversized.

## Risks

- A brightness gain on a translucent or pale product can wash it out; the
  bounds keep it within a quarter stop.
- The ellipse shadow assumes the product rests on a horizontal surface; a
  product held in a hand or standing on edge gets a slightly wrong shadow.
  The review already checks "rests on the surface".
- Removing the pedestal hint may make the model leave no locatable landing
  area more often; the earlier fix (a surface with a visible edge, described
  explicitly) stays.

## Out of scope

Generative harmonization (a masked edit around the product) is deferred until
these measures are seen on a few runs; multi-route batches; format
recomposition.
