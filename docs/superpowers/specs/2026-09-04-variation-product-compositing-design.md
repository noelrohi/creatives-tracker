# Variation product compositing — design addendum

Date: 2026-09-04. Status: proposed, awaiting approval. Extends
`2026-09-03-static-ad-variations-design.md` §2.

## Problem

Every variation produced so far keeps the source's layout and copy discipline
but re-renders the mouthguard. The image model treats the attached product
photo and the source as inspiration, not as pixels to preserve: across seven
attempts on three sources the guard came back opaque, saturated, taller, or
with a different opening pattern, and the automatic review rejected all of
them. Stronger "reproduce exactly" wording and putting the product photo first
in the reference order did not change the outcome. For a product where shape,
translucency, and openings are the whole point, a variation that alters the
product is not shippable.

## Solution

Stop asking the model to redraw the product. When the source already shows the
product, the agent generates the variation as a **masked edit of the source**:
the product region is protected and copied through pixel-for-pixel, and
everything else (headline, subhead, badges, CTA, background, props) is
regenerated from the prompt. The Vercel AI SDK already supports this shape
(`generateImage({ prompt: { images: [source], mask, text } })`), so no new
dependency is needed beyond a small PNG mask writer.

The agent still decides what to change and writes the prompt. The difference is
one extra decision per image call: which region of the source to keep.

## Design

### 1. Locate the product in the source

A vision call (`gpt-5.6-terra`, `generateObject`) runs once per run, before
the loop, on the source image:

```
{ product: { x, y, w, h } | null, confidence: number, note: string }
```

Coordinates are normalized (0–1) bounding boxes of the product and, when the
product sits in or on packaging that must stay with it (the Repod, a box), the
box covers both. `null` when no product is visible (a pure text or lifestyle
ad). The result is stored in run state and shown in the plan as
`keptProductRegion` so the card can explain it.

### 2. Build the mask

`src/lib/image-mask.ts` (pure, tested) writes a PNG the same size as the source
where the protected box is opaque and everything else is transparent, which is
the convention the image edit endpoint expects (transparent = editable). It
encodes RGBA with Node's `zlib` deflate; no image library. The box is expanded
by 3% on each side so anti-aliased edges are not cut, and clamped to the
canvas.

Because an edit returns the source's own dimensions, the generation `format`
is taken from the source as today, and `studioSizeFor` is not passed on the
edit path.

### 3. `generateImage` gains a mode

The tool input gets `mode: "edit" | "generate"` (default `"edit"` whenever a
product region was found and `useSourceLayout` is true; `"generate"`
otherwise). In `edit` mode the task calls the image model with
`{ images: [sourceBytes], mask, text: prompt }` and no other references; the
product photo is not attached because the product is preserved from the
source. In `generate` mode the current behaviour applies (product photo first,
context images, source last).

The system prompt explains the mode to the agent: in edit mode the prompt
describes only what changes outside the protected region, must not describe
the product, and must keep the composition; the protected box is stated in
plain words ("the product in the lower-right tile is kept as is").

### 4. Review

The review checklist keeps its product-fidelity item, but in edit mode it
compares the output against the **source** rather than the product photo and
expects a near-exact match inside the protected region. A failed fidelity
check in edit mode is a signal that the mask was wrong (too small, wrong box),
so the agent's second attempt may call `generateImage` with an explicit
`keepRegion` override (`{ x, y, w, h }`) to widen or move the box.

### 5. Retry without image

"Retry without image" already sets `useSourceLayout: false`, which disables
edit mode and falls back to `generate`. No change.

### 6. Out of scope

Compositing a catalog render onto a generated scene (paste-in) is the
alternative when the source has no product; it needs matting and lighting
work and is not part of this addendum. Competitor sources (Phase 2) never use
edit mode, since their product must be replaced, not kept.

## Testing

- `image-mask.ts`: pure tests that the PNG has the source dimensions, the
  protected box is opaque, the rest transparent, the 3% expansion and clamping
  hold, and a `null` region yields a fully transparent mask.
- `variation-agent.ts`: mode selection (edit when region and source layout,
  generate otherwise), the edit-mode reference list (source only, no product
  photo), `keepRegion` override validation (0–1, non-empty), and the plan
  carrying `keptProductRegion`.
- Router and Trigger task stay untested directly, per convention.

## Cost

One extra vision call per run (the locator). Edits cost the same as
generations. Expect the same or fewer attempts per variation, since fidelity
failures should mostly disappear.

## Open question for approval

Whether the locator should also run for competitor sources later so Phase 2
can invert the mask (regenerate only the product region with ours). Not needed
now; noting so the mask writer is built with both polarities.
