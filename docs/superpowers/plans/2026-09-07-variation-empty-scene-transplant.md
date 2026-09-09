# Variation Empty-Scene Transplant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the product transplant paste into an empty landing area the model leaves for it (instead of covering a drawn product), and fall back to the brand's product photo when the source product will not matte.

**Architecture:** The trigger resolves the product patch (source matte, else matched product photo matte) *before* the agent runs, so the prompt only promises an empty-scene transplant when a patch exists. The output locator returns a `landing` box next to `product`; the paste target is `product ?? landing`, bottom-aligned for a landing. Agent core gets a `productPatch` input that drives the TRANSPLANT block and the reference list. A small pure module builds the product-match prompt and picks the match.

**Tech Stack:** TypeScript, sharp, Vercel AI SDK `generateObject` (gpt-5.6-terra), Vitest, Trigger.dev task `trigger/generate-variation.ts`.

Design: `docs/superpowers/specs/2026-09-07-variation-empty-scene-transplant-design.md`. Branch: `feat/static-ad-variations`. Commits are title-only (no body, no trailers). Do not touch `.gitignore`.

---

## File map

- Modify `src/lib/image-composite.ts` (+ test): `pastePatch` gains `align`.
- Modify `src/lib/variation-agent-types.ts`: `VariationTransplant.patchSource`, `assetImageUrl`, `target`.
- Create `src/lib/product-match.ts` (+ test): prompt builder, schema, picker for the product-photo match.
- Modify `src/lib/variation-agent.ts` (+ test): `productPatch` input, empty-scene TRANSPLANT block, reference list, brand block.
- Modify `trigger/generate-variation.ts`: locator `landing` + `"asset"` label, up-front patch resolution, asset fallback, paste target, review text.
- Modify `src/components/blocks/creatives/creative-variations-tab.tsx`: card wording.
- Modify the design doc status line at the end.

---

### Task 1: `pastePatch` bottom alignment

**Files:**
- Modify: `src/lib/image-composite.ts`
- Test: `src/lib/image-composite.test.ts`

- [ ] **Step 1: Failing test.** Append inside `describe("pastePatch")`:

```ts
  it("bottom-aligns the patch inside the box when asked, so the product rests on the surface", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(20, 20, [0, 255, 0]);
    // Box is 4 wide by 8 tall at (10, 6); a 4x4 patch fits at width 4 and sits at the bottom: top 6+8-4.
    const { bytes, box } = await pastePatch({ output, patch, region: { x: 0.5, y: 0.3, w: 0.2, h: 0.4 }, align: "bottom" });
    expect(box).toEqual({ left: 10, top: 10, width: 4, height: 4 });
    expect(await pixel(bytes, 11, 12)).toEqual([255, 0, 0]);
    expect(await pixel(bytes, 11, 7)).toEqual([0, 255, 0]); // empty band above the bottom-aligned patch
  });
```

- [ ] **Step 2: Run** `bun run test -- src/lib/image-composite.test.ts` → the new test fails (`align` unknown / box top 8).

- [ ] **Step 3: Implement.** In `image-composite.ts`:

```ts
export type PasteAlign = "center" | "bottom";

function fitBox(from: PasteBox, to: PasteBox, align: PasteAlign = "center"): PasteBox {
  const scale = Math.min(to.width / from.width, to.height / from.height);
  const width = Math.max(1, Math.round(from.width * scale));
  const height = Math.max(1, Math.round(from.height * scale));
  return {
    left: to.left + Math.round((to.width - width) / 2),
    top: align === "bottom" ? to.top + to.height - height : to.top + Math.round((to.height - height) / 2),
    width,
    height,
  };
}
```

`pastePatch` input gains `align?: PasteAlign` (doc: "Where the fitted patch sits inside the box: centred, or resting on the box's bottom edge for a product placed on a surface.") and passes it to `fitBox`. `pasteSourceRegion` is unchanged (default centre).

- [ ] **Step 4: Run** the file (all pastePatch tests pass), `bun run typecheck`, `bun run lint`.
- [ ] **Step 5: Commit** `feat(studio): let a pasted patch rest on the bottom of its box`.

---

### Task 2: Types and card wording

**Files:**
- Modify: `src/lib/variation-agent-types.ts`, `src/components/blocks/creatives/creative-variations-tab.tsx`

- [ ] **Step 1:** In `variation-agent-types.ts` replace `VariationTransplant` with:

```ts
export type VariationTransplant = {
  /** Where the product was cut from: a region of the source ad, or of the product photo when `patchSource` is "asset". */
  from: ProductRegion;
  /** The output box the product was pasted into. */
  to: ProductRegion;
  /** Whether `to` was the product the model drew (covered) or the empty landing area it left. */
  target: "product" | "landing";
  /** Where the patch came from: the source ad, or a matched brand product photo. */
  patchSource: "source" | "asset";
  /** The product photo the patch was cut from, when `patchSource` is "asset". */
  assetImageUrl?: string | null;
  /** True: a generate-mode transplant is only recorded when the matte held. */
  matted: boolean;
};
```

- [ ] **Step 2:** In the card (`PlanDisclosure`), replace the transplant line with:

```tsx
        {plan.transplantedProduct ? (
          <p className="text-muted-foreground">
            {plan.transplantedProduct.patchSource === "asset"
              ? "Product transplanted from the product photo."
              : "Product transplanted from the source."}
          </p>
        ) : null}
```

- [ ] **Step 3:** `bun run typecheck` will fail in `variation-agent.test.ts` and the trigger until Tasks 3 and 5 land; fix the test fixture's transplant literal now (add `target: "product", patchSource: "source"`) and in the trigger add `target: "product", patchSource: "source"` to the existing transplant literal so typecheck is clean at this commit. `bun run test -- src/lib/variation-agent.test.ts`.
- [ ] **Step 4: Commit** `feat(studio): record where a transplanted product came from and landed`.

---

### Task 3: Agent core: `productPatch`, empty-scene prompt, references

**Files:**
- Modify: `src/lib/variation-agent.ts`
- Test: `src/lib/variation-agent.test.ts`

- [ ] **Step 1: Failing tests.** Append to the `buildVariationSystemPrompt` describe (the fixture `editInput` has a located region; add `const patchInput = { ...editInput, productPatch: { source: "source" as const } };`):

```ts
  it("asks for an empty landing area and drops the draw-the-product text when a product patch is ready", () => {
    const system = buildVariationSystemPrompt(patchInput);
    expect(system).toContain("TRANSPLANT");
    expect(system).toContain("Do not draw the product");
    expect(system).toContain("landing area");
    expect(system).not.toContain("the product it draws is replaced");
    expect(system).toContain("No product photo is attached");
  });

  it("keeps the draw-the-product prompt when no patch is ready even though a product was located", () => {
    const system = buildVariationSystemPrompt(editInput);
    expect(system).not.toContain("TRANSPLANT");
    expect(system).toContain("must match the product photo exactly");
    expect(system).toContain("EDIT MODE");
  });
```

And in the `createVariationRun.generateImage` describe:

```ts
  it("leaves the product photo out of the references when a product patch is ready", async () => {
    const d = deps();
    const run = createVariationRun({ ...editInput, productPatch: { source: "asset" } }, d);
    await run.generateImage({ prompt: "p", referenceImageIds: ["img_r3"], keepSourceLayout: true });
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImageUrls: ["https://blob.test/r3.png", "https://cdn.test/source.png"] }),
    );
  });

  it("still sends the product photo first when no patch is ready", async () => {
    const d = deps();
    const run = createVariationRun(editInput, d);
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImageUrls: ["https://blob.test/product.png", "https://cdn.test/source.png"] }),
    );
  });
```

Update the existing test "tells the model in generate mode that its product will be replaced when a source product was located" to use `patchInput` (the TRANSPLANT block is now gated on the patch, not on the located region).

- [ ] **Step 2: Run** the file → new tests fail.

- [ ] **Step 3: Implement.**
  - `VariationRunInput` gains:
    ```ts
    /**
     * Set when the trigger already holds a matted cut of the real product
     * (from the source ad or a matched product photo) that it will paste into
     * every generate attempt. Null when no cut exists: the model then draws the
     * product itself from the product photo.
     */
    productPatch?: { source: "source" | "asset" } | null;
    ```
  - Replace the TRANSPLANT `<mode>` block, now gated on `input.productPatch` (not `editAvailable`):
    ```ts
    input.productPatch
      ? "<mode>\nTRANSPLANT: the real product is pasted into your image afterwards, cut out of " +
        (input.productPatch.source === "asset" ? "the brand's product photo" : "the source ad") +
        ". Do not draw the product, and do not draw anything that looks like it (no product-shaped object, no packaging, no logo) anywhere in the image. Instead leave an empty landing area for it: an evenly lit, plain surface (pedestal top, flat card area, tabletop) at about the position and size the product has in the source ad image, with nothing overlapping it and no text inside it. Name the product in the prompt only to say where its landing area is. Everything else in the prompt is yours to design. This staging is a constraint on how you draw the scene, not your one change.\n</mode>"
      : null,
    ```
  - `brandBlock(brand, editAvailable)` becomes `brandBlock(brand, { editAvailable, patchReady })` with the sentence chosen as:
    - `patchReady`: "No product photo is attached in generate mode: the real product is pasted in afterwards (see TRANSPLANT), so do not describe its shape, colour, or markings. In edit mode no product photo is attached either: the product is preserved from the source itself, so do not describe it, restyle it, or ask for a match to the photo."
    - else the existing "A product photo is attached as the first reference on every image call; when the source image is attached it comes last. The product in the ad must match the product photo exactly; render only the markings the product notes describe." (also when `editAvailable` without a patch; the old TRANSPLANT-referencing branch is deleted).
  - In `generateImage`'s generate branch: push `productImageUrl` only when `!input.productPatch`.
  - Update the comment on reference order accordingly.

- [ ] **Step 4: Run** `bun run test -- src/lib/variation-agent.test.ts` (51 expected), `bun run typecheck`, `bun run lint`.
- [ ] **Step 5: Commit** `feat(studio): ask for an empty landing area when a product patch is ready`.

---

### Task 4: Product-photo match (pure module)

**Files:**
- Create: `src/lib/product-match.ts`
- Test: `src/lib/product-match.test.ts`

- [ ] **Step 1: Failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { buildProductMatchPrompt, pickProductMatch, productMatchSchema } from "./product-match";

const candidates = [
  { imageUrl: "https://blob.test/product.png", label: "brand product photo" },
  { imageUrl: "https://blob.test/r1.png", label: "R1 mouthguard: Hero render" },
];

describe("buildProductMatchPrompt", () => {
  it("numbers the candidates from 1 and asks for the same model, colour, and markings", () => {
    const prompt = buildProductMatchPrompt("Reviv", candidates);
    expect(prompt).toContain("Image 1 is a crop of the product from the source ad");
    expect(prompt).toContain("Image 2: brand product photo");
    expect(prompt).toContain("Image 3: R1 mouthguard: Hero render");
    expect(prompt).toContain("same model, colour, and markings");
    expect(prompt).toContain("Reviv");
  });
});

describe("pickProductMatch", () => {
  it("returns the candidate at the 1-based index when confident", () => {
    expect(pickProductMatch({ match: 2, confidence: 0.9, note: "" }, candidates)).toEqual(candidates[1]);
  });
  it("returns null below the confidence floor, for null, and for an out-of-range index", () => {
    expect(pickProductMatch({ match: 1, confidence: 0.5, note: "" }, candidates)).toBeNull();
    expect(pickProductMatch({ match: null, confidence: 1, note: "" }, candidates)).toBeNull();
    expect(pickProductMatch({ match: 3, confidence: 1, note: "" }, candidates)).toBeNull();
  });
  it("validates the model's answer shape", () => {
    expect(productMatchSchema.safeParse({ match: null, confidence: 0.2, note: "none" }).success).toBe(true);
    expect(productMatchSchema.safeParse({ match: 0, confidence: 0.2, note: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → fails (module missing).

- [ ] **Step 3: Implement** `src/lib/product-match.ts`:

```ts
// Picks the brand product photo that shows the same product as the source
// ad's crop, so the transplant can matte a clean photo when the source will
// not matte. Pure: the vision call lives in the trigger.
import { z } from "zod";

export const PRODUCT_MATCH_MIN_CONFIDENCE = 0.7;

export type ProductMatchCandidate = { imageUrl: string; label: string };

export const productMatchSchema = z.object({
  /** 1-based index of the matching candidate (image 2 is candidate 1), or null. */
  match: z.number().int().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});

export type ProductMatch = z.infer<typeof productMatchSchema>;

export function buildProductMatchPrompt(brandName: string | null, candidates: ProductMatchCandidate[]) {
  return [
    `Image 1 is a crop of the product from the source ad${brandName ? ` for ${brandName}` : ""}. The images after it are candidate product photos.`,
    ...candidates.map((candidate, index) => `Image ${index + 2}: ${candidate.label}`),
    "Answer which candidate shows the same product as image 1: the same model, colour, and markings, not merely the same category. Return match as the candidate number (image 2 is candidate 1), or null when none matches. Confidence is how sure you are of that answer.",
  ].join("\n");
}

export function pickProductMatch(result: ProductMatch, candidates: ProductMatchCandidate[]) {
  if (result.match == null || result.confidence < PRODUCT_MATCH_MIN_CONFIDENCE) return null;
  return candidates[result.match - 1] ?? null;
}
```

- [ ] **Step 4: Run** the test file (4 pass), typecheck, lint.
- [ ] **Step 5: Commit** `feat(studio): match the source product against the brand's product photos`.

---

### Task 5: Trigger: landing box, up-front patch, asset fallback, paste target, review

**Files:**
- Modify: `trigger/generate-variation.ts`

- [ ] **Step 1: Locator.**
  - Schema gains `landing: locatorBoxSchema.nullable().describe("On a generated scene with no product drawn: the empty area reserved for it, boxed as the product's footprint so its bottom edge rests on the surface; else null.")` (keep the `.nullable()` comment).
  - Label type `"source" | "output" | "asset"`. Prompt: keep the product/tile lines; add: `"landing: only when no product is drawn and the image clearly leaves an empty, plainly lit area for one (a bare pedestal top, an empty card, a clear tabletop): the box where the product should be placed, sized like its footprint and resting on the surface. Null otherwise."` and change the last line to `"Return product: null when no physical product is visible; tile is null then too; landing may still be set on a generated scene."` Same prompt for every label.
  - Return type `{ product: ProductRegion | null; tile: ProductRegion | null; landing: ProductRegion | null } | null`. `product` usable as now. `landing` is clamped and usable only when `label === "output"`, confidence ≥ 0.4, area within 0.005–0.95; when both `product` and `landing` come back, keep `product` and drop `landing` (log `landingDropped`). Return null when neither `product` nor `landing` is usable. Callers on the source and asset paths require `product` (treat a result without it as null there).
  - Doc comment: on an asset (a product photo), `product` is what the fallback matte cuts; on an output, `product ?? landing` is the paste target.

- [ ] **Step 2: Resolve the patch before the agent runs.** Replace the `matteSource` cache with an up-front resolution right after the source locator:

```ts
      // The transplant needs a matted cut of the real product. Resolve it now,
      // before the agent runs, so the prompt only promises an empty-scene
      // transplant when a cut exists: an empty pedestal with nothing pasted
      // is worse than a redrawn product.
      type ProductPatch = { matte: MatteResult; source: "source" | "asset"; assetImageUrl: string | null };
      let productPatch: ProductPatch | null = null;
      if (sourceProductBox) {
        onStep("cutting out the product");
        const cut = await matteWithMargins(sourceBytes, sourceProductBox);
        if (cut.matted) productPatch = { matte: cut, source: "source", assetImageUrl: null };
        else productPatch = await matteFromProductPhoto(sourceBytes, sourceProductBox);
      }
```

`matteWithMargins(bytes, box)` is the existing margin ladder lifted into a module-level async function (same log line "Matted the product" with a `label` argument `"source" | "asset"`). `matteFromProductPhoto` (module-level, takes `sourceBytes`, `sourceProductBox`, plus `brand`, `library`, `fetchBytes`, `onStep` via parameters or a small closure):

```ts
        // Candidates: the brand profile's product photo, then library product images.
        const candidates: ProductMatchCandidate[] = [
          ...(brand?.productImageUrl ? [{ imageUrl: brand.productImageUrl, label: "brand product photo" }] : []),
          ...library.images.filter((image) => image.kind === "product").map((image) => ({ imageUrl: image.imageUrl, label: `${image.title}: ${image.description}` })),
        ].filter((candidate, index, all) => all.findIndex((c) => c.imageUrl === candidate.imageUrl) === index);
        if (candidates.length === 0) { logger.info("No product photo to fall back to"); return null; }
        onStep("matching the product photo");
        const crop = await cropRegion(sourceBytes, expandRegion(sourceProductBox, 0.01)); // sharp autoOrient + extract(pixelBox) → png
        const result = await generateObject({
          model: openai(LOCATOR_MODEL),
          schema: productMatchSchema,
          system: buildProductMatchPrompt(brand?.brandName ?? null, candidates),
          messages: [{ role: "user", content: [{ type: "image", image: crop }, ...await Promise.all(candidates.map(async (c) => ({ type: "image" as const, image: await fetchBytes(c.imageUrl) })))] }],
        });
        const chosen = pickProductMatch(result.object, candidates);
        logger.info("Product photo match", { candidates: candidates.length, match: result.object.match, confidence: result.object.confidence, note: result.object.note, chosen: chosen?.imageUrl ?? null });
        if (!chosen) return null;
        const assetBytes = await fetchBytes(chosen.imageUrl);
        const located = await locateProduct(assetBytes, brand?.brandName ?? null, "asset");
        if (!located?.product) return null;
        const cut = await matteWithMargins(assetBytes, located.product, "asset");
        return cut.matted ? { matte: cut, source: "asset", assetImageUrl: chosen.imageUrl } : null;
```

Wrap the whole fallback in try/catch → warn and return null. Add a small `cropRegion(bytes, region)` helper next to `pct` (sharp `autoOrient().extract(pixelBox(clampRegion(region), w, h)).png()`; `pixelBox` is exported from `image-composite`). Import `buildProductMatchPrompt`, `pickProductMatch`, `productMatchSchema`, `type ProductMatchCandidate` from `@/lib/product-match`.

Set `input.productPatch = productPatch ? { source: productPatch.source } : null`.

- [ ] **Step 3: Transplant block.** Gate on `mode === "generate" && productPatch` (drop the `sourceProductBox`/kind/withoutSourceImage terms: the patch only exists under them). Target and alignment:

```ts
              const locatedOutput = await locateProduct(produced, brand?.brandName ?? null, "output");
              const to = locatedOutput?.product ?? locatedOutput?.landing ?? null;
              if (to) {
                const target = locatedOutput?.product ? "product" : "landing";
                const pastedPatch = await pastePatch({ output: produced, patch: productPatch.matte.patch, region: to, align: target === "landing" ? "bottom" : "center" });
                produced = pastedPatch.bytes;
                transplant = { from: productPatch.matte.region, to, target, patchSource: productPatch.source, assetImageUrl: productPatch.assetImageUrl, matted: true };
                logger.info("Transplanted product", { attempt, ...transplant, tile: locatedOutput?.tile ?? null, box: pastedPatch.box });
              } else {
                logger.warn("Transplant skipped: neither a product nor a landing area was located in the output", { attempt });
              }
```

The `matte.matted` branch and its warn go away (a patch is matted by construction). Update the block comment.

- [ ] **Step 4: Review.** `transplantExpected = mode === "generate" && Boolean(productPatch)`. Premise when `transplant`: `transplant.target === "landing" ? "...; the real product was cut out of ${transplant.patchSource === "asset" ? "the brand's product photo" : "the second image (the source)"} and pasted into the empty area the model left for it." : existing over-the-drawn-product sentence (with the same patchSource wording)`. Attach the source as the second image for every transplant (unchanged). Checklist line when `transplant`: existing text plus `"; and the product rests on the surface rather than floating above it or sinking into it"` before "Name which failed." The expected-but-absent line gains: "and the scene may show an empty landing area; do not fail it for that alone".

- [ ] **Step 5: Verify** `bun run typecheck`, `bun run lint`, `bun run test -- src/lib/variation-agent.test.ts src/lib/product-match.test.ts src/lib/image-composite.test.ts src/lib/image-matte.test.ts`.
- [ ] **Step 6: Commit** `feat(studio): paste the real product into the landing area the model leaves for it`.

- [ ] **Step 7: Live check** (same recipe as the previous plans: `bun dev` + `bun run trigger:dev`, sign in as `variation-smoke@example.com`, create via `studio.variations.create`, poll `studio_variant.attempts`; stop both servers after). Creatives: R3 `6a2c721d-4db5-4cbf-9e26-9555c96562d6`, R1 `f277659f-2965-488c-9b91-353dc25a5a5b`, R2 `c236089c-3a93-4323-a4fc-9d2cc0c53e86`. Expect: R3 → `patchSource: "source"`, target `landing` (or `product` if the model drew one anyway), review pass, and visually the exact source product on the model's surface; R1 and R2 → the fallback runs (log "Product photo match"); if the library holds a matching product photo, `patchSource: "asset"` and a pasted product, else `productPatch` null and the old draw-the-product prompt (attempts have `transplant: null`, the brand photo is attached first). Record per creative: patch source, target, review pass and notes, PNG path, and a visual judgement. If the landing paste floats or is badly sized, note the `to` box and the review note; do not tune thresholds inside this task.

---

### Task 6: Verification and docs

- [ ] `bun run typecheck && bun run lint && bun run test`, `node scripts/check-migrations.mjs`.
- [ ] Design doc: change the status line to "implemented" and add an implementation-notes block with the live-check results (patch source, target, review outcome per creative). Update `rands/pr-body-static-ad-variations.md` item 5 to describe the empty-scene transplant and the product-photo fallback (it is gitignored; edit anyway).
- [ ] Commit `docs(studio): record the empty-scene transplant outcome`.

---

## Self-review

- Design §1 (empty scene, landing box, `product ?? landing`, bottom alignment, no product photo reference) → Tasks 1, 3, 5.
- Design §2 (candidates, one match call, confidence 0.7, asset locator + matte, `patchSource`, card line) → Tasks 2, 4, 5.
- Design §3 (decide before the agent runs, two prompt states) → Tasks 3 and 5 Step 2.
- Design §4 (review wording) → Task 5 Step 4.
- Types used consistently: `productPatch: { source }` on the input; `VariationTransplant { from, to, target, patchSource, assetImageUrl?, matted }`; `pastePatch({ align })`; `locateProduct` returns `{ product | null, tile, landing }`.
