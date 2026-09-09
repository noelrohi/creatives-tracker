# Variation product transplant — design proposal

Date: 2026-09-04. Status: implemented (plan
`docs/superpowers/plans/2026-09-04-variation-product-transplant.md`, Tasks 1-8).
Follows `2026-09-04-variation-product-compositing-design.md` §8.

Implementation notes that differ from the proposal below, all measured on the
three local test sources:

- The locator returns two boxes: `product` (tight, the product itself) and
  `tile` (the containing card, pedestal, or packaging, when any). Edit mode
  keeps protecting `tile ?? product`; the transplant cuts `product` and pastes
  into the output's `product`, so the model's own card and pedestal stay.
- The matte judges the border by an 85% majority around its median colour
  instead of a max spread, floods neighbour-to-neighbour with a drift bound so
  vignettes flood, drops stray blobs under 1% of the box, and crops the patch
  to the product. The source cut tries margins 1%, 2%, 3% and keeps the first
  that mattes; when no margin mattes, the transplant is skipped and the
  model's own product ships (the pre-transplant behaviour); the rectangle
  paste is edit mode's only.
- The edge feather is one pixel at alpha 150, not the two pixels proposed.
- Live result: R3 (mouthguard on a pedestal in a flat card) mattes
  (`matted: true`, coverage 0.64) and passed review on the first attempt with
  the source's exact product on the model's pedestal. R1 (product in a glowing
  pod) and R2 (product overlapping black packaging) never have a flat border,
  do not matte, so the transplant is skipped and the model's product ships,
  which is the pre-transplant behaviour and the known limit of a heuristic
  matte. When the model draws no product at all the output locator returns
  null and the transplant is skipped with `transplant: null`.

## What the batch taught us

Ten attempts across three sources, all with the masked edit plus paste, all
rejected for the same reason: the image model reflows the layout under an
edit mask, so a rectangle cut from the source lands a few percent off the
card the model redrew, and the model's own product stays visible beside it.
Two facts hold across every run:

1. The model does not hold layout. Any approach that assumes a region of the
   output sits where the same region sat in the source will misalign.
2. The model handles copy, palette, and composition well in plain generate
   mode, and it always draws *a* product somewhere sensible.

## Why "inverse paste" does not escape this

The copy-only idea (source as base, regenerate only the text boxes, paste the
model's output into them) needs the model's headline to sit where the
source's headline sat, so its box can be lifted and pasted back. That is the
same alignment assumption that just failed, moved from the product to the
text. It would also need the model to render legible copy inside small boxes,
which is its weakest skill. Rendering the copy ourselves with SVG would avoid
the model but needs the brand fonts on the worker and a way to erase the old
text cleanly. Either way it is a larger build with a lower ceiling than the
alternative below.

## Proposal: transplant the source product into the generated output

Let the model do what it is good at, then fix the one thing it cannot do:

1. **Generate mode as the base** (already the default): product photo first,
   context images, source last as a layout reference. The model composes the
   ad and draws its own product somewhere.
2. **Locate the product in the output** with the same vision locator used on
   the source (a second call, on the generated image). Now the paste target
   is where the model actually put the product, so alignment is by
   construction and there is no duplicate to hide.
3. **Cut the product out of the source with an alpha matte**, not a
   rectangle. A pure `image-matte.ts` (sharp raw pixels, no model) floods from
   the box edges over near-uniform background colour and marks everything
   reachable as transparent; the remainder is the product with soft edges.
   Product tiles on flat backgrounds (the R2 card, the R3 pedestal) matte
   cleanly; a busy scene (the R1 glowing pod) fails the flatness check and
   falls back to a rectangle paste of the whole product-plus-packaging box.
4. **Paste the matted product** over the output's product box, uniform-scaled
   to fit, centred. The model's product underneath is covered, the source's
   background never travels, and the surrounding composition is the model's
   own.
5. **Review** compares the pasted product against the source (shape and
   markings are exact by construction, so the check is scale, lighting fit,
   and whether any of the model's product still shows around the edges).

Edit mode with the rectangular paste stays available on request for the rare
source whose layout must not move at all; the transplant becomes the default
for every generate-mode run where both locators succeed.

## What it needs

- `image-matte.ts`: flatness check on the box border, flood-fill matte with a
  colour-distance threshold, 2 px edge feather; tests on synthetic tiles.
- A second locator call on the output (same prompt, same schema).
- `pasteSourceRegion` gains an optional alpha patch input (it already
  composites with alpha).
- The generate-mode prompt tells the model to draw the product on a plain
  surface roughly the size the source uses, so the box it produces is a good
  landing zone.
- Review checklist for the transplant case; plan field
  `transplantedProduct: { from, to }` replaces `keptProductRegion` on those
  runs; the card line says "Product transplanted from the source".

## Risks

- Matting is heuristic: reflective or translucent products on gradients skip
  the transplant more often and ship the model's own product. The fallback is
  the current behaviour, so nothing gets worse.
- Lighting mismatch between the source product and the generated scene is
  real and not fixable here; the review reports it and the agent can steer the
  prompt toward the source's lighting on its retry.
- Two extra vision calls per run (source locator already exists; output
  locator is new).

## Out of scope

Rendering copy ourselves; inverse paste of text boxes; competitor sources.
