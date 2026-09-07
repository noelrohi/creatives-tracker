# Variation transplant: empty scene and product-photo fallback

Date: 2026-09-07. Status: proposed, awaiting approval. Follows
`2026-09-04-variation-product-transplant-design.md` and applies two
recommendations from the Buzz agent's questionnaire answers
(`rands/BUZZ_AGENT_STATIC_AD_WORKFLOW_QUESTIONNAIRE_2026_09_07.md`, §5.3 and
§5.4).

## What we have and what still hurts

The transplant works on R3: the source product is matted, the model's own
product is located in the output, and the matte is pasted over it. Two
weaknesses remain:

1. **Covering a drawn product leaves traces.** The model's product has its own
   silhouette, shadow, and occlusion; our paste hides most of it, but the
   review still catches remnants at the edges, and the model sometimes draws a
   second product elsewhere.
2. **Busy sources never matte.** R1 (glowing pod) and R2 (product over black
   packaging) have no flat border to flood from, so the transplant is skipped
   and the model's approximation ships.

## Proposal

### 1. Ask for an empty scene, then place the product

When a product patch is known to be available (see "Decide before the agent
runs"), the generate-mode prompt no longer asks the model to draw the product.
It asks for a **product-ready scene**: an empty, evenly lit landing area
(pedestal top, plain card, flat surface) about the size the product has in the
source ad, with nothing overlapping it, and explicitly **no product, no
product-like object, no packaging, no logo** in that area. The product photo is
**not** attached as a reference on these runs (attaching it invites the model
to draw it); the source ad stays attached last as the layout reference, so the
model still sees the product's scale and placement.

The output locator gains a second target. Its schema becomes
`{ product, landing, tile }`:

- `product`: the product, if the model drew one anyway (tight box, as now).
- `landing`: the empty area clearly reserved for the product, boxed as the
  product's intended footprint so that its bottom edge rests on the surface.
- `tile`: unchanged.

The paste target is `product ?? landing`. Pasting over a drawn product keeps
today's behaviour; pasting into the landing box has nothing underneath to
leak. If neither is returned, the transplant is skipped and the review is told
so (existing path).

Placement inside the landing box: the patch is uniform-fit into the box and
**bottom-aligned** (the product sits on the surface) rather than centred, with
the same `pastePatch` primitive gaining an `align: "center" | "bottom"` option.
No synthetic contact shadow in this pass; the review reports lighting and
"floating" and the agent's retry can ask for a softer surface. A shadow is a
follow-up if reviews keep flagging it.

### 2. Product photo as the matte fallback

When the source matte fails (border not flat at any margin), try the brand's
product imagery before giving up:

1. Candidates are the brand profile's `productImageUrl` plus the context
   library images with `kind: "product"`.
2. One vision call (`gpt-5.6-terra`, structured output) receives the source's
   tight product crop and the candidate images and answers
   `{ match: index | null, confidence }`: which candidate shows the **same
   product (same model, colour, and markings)** as the crop, or none. Below
   confidence 0.7, or with no candidates, there is no fallback.
3. The chosen candidate goes through the existing locator (label `"asset"`) and
   `matteProduct` with the same margin ladder. Product photos on studio
   backgrounds matte reliably; if this also fails, the transplant is skipped.

`VariationTransplant` gains `patchSource: "source" | "asset"` and, for
assets, `assetImageUrl`. The card line reads "Product transplanted from the
source." or "Product transplanted from the product photo."

### 3. Decide before the agent runs

The prompt must not promise an empty-scene transplant that cannot happen (an
empty pedestal with no product is worse than a redrawn product). So the trigger
resolves the patch **before** building the agent input: locate the source
product, matte it, and if that fails run the asset fallback. The result is one
of:

- `patch ready` (`source` or `asset`): the agent gets the empty-scene
  TRANSPLANT block and no product photo reference; every generate attempt
  transplants.
- `no patch`: the agent gets today's draw-the-product prompt with the product
  photo first (pre-transplant behaviour); no transplant runs; the review judges
  the model's product with the existing "the paste did not run" line.

This costs nothing extra on the happy path (the matte was already computed
once per run) and moves the asset fallback's two vision calls to before the
first image call, where their outcome can still change the prompt.

`VariationRunInput.sourceProductRegion` keeps feeding edit mode. A new
`productPatch: { source: "source" | "asset" } | null` drives the TRANSPLANT
block and the reference list; the brand block text follows it.

### 4. Review

Transplant premise and checklist unchanged except: "the real product was pasted
into the area the model left for it" when the target was `landing`; and a new
check "the product rests on the surface rather than floating or sinking".

## What it needs

- `pastePatch` `align` option (2 tests).
- Locator: `landing` box, label `"asset"`, tile sanity unchanged.
- `src/lib/product-match.ts` (or inside the trigger): the candidate-matching
  call, pure prompt builder and schema tested; the call itself lives in the
  trigger like the locator.
- Trigger: resolve the patch up front; asset fallback; paste target
  `product ?? landing` with bottom alignment for `landing`; review text.
- Agent core: `productPatch` on the input; TRANSPLANT block rewritten for the
  empty scene; reference list drops the product photo when a patch is ready;
  brand block text; tests.
- Types and card line: `patchSource`, `assetImageUrl`, card wording.
- Live check: R3 (source patch, landing paste), R1 and R2 (asset fallback if
  the library holds a matching product photo; otherwise "no patch" and the
  old prompt), plus one run with a note that forces edit mode to confirm it is
  untouched.

## Risks

- The model may still draw a product despite the instruction. Covered: the
  locator returns `product` and we paste over it as today.
- The landing box may be a poor size. The uniform fit caps the product at the
  box; the review reports implausible size and the agent can restate the size
  on retry.
- Asset matching can pick the wrong SKU on look-alike products (R1 vs R2). The
  0.7 confidence floor and the "same model, colour, and markings" wording are
  the guard; a wrong match is visible in the review's side-by-side with the
  source and in the card line, and the human can retry.
- Two extra vision calls only when the source matte fails.

## Out of scope

Deterministic text rendering, synthetic shadows, run-level logging beyond the
existing attempt records, the fidelity benchmark.
