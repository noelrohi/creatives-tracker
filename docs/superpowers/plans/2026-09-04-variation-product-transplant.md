# Variation Product Transplant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In generate mode, replace the image model's own rendering of the product with the source's real product, cut out with an alpha matte and pasted over wherever the model drew it, per `docs/superpowers/specs/2026-09-04-variation-product-transplant-design.md`.

**Architecture:** Generate mode stays the base. After the image comes back, the existing vision locator runs on the output to find where the model put the product. A pure matte module cuts the product out of the source (flood fill over a flat background, rectangle fallback), and a patch paster composites it uniform-fit over the output's product box. The agent core records the transplant on the attempt and the plan; the review checks the paste; the card says so. All rules live in `src/lib/` with tests; the Trigger task wires IO.

**Tech Stack:** sharp 0.34.5 (raw RGBA in/out), Vercel AI SDK `generateObject` (the existing locator), Zod v4, Vitest.

**Conventions on this branch:** commits are title only. Tests via `bun run test` (never `bun test`). No direct tests for Trigger tasks. Never stage `.gitignore`, `rands/`, or `.studio-local/`.

---

## File map

| Path | Responsibility |
|---|---|
| `src/lib/image-composite.ts` (+ test) | Modify: export `pixelBox`; add `pastePatch` (uniform-fit an alpha patch into a normalized box of the output) |
| `src/lib/image-matte.ts` (+ test) | Create: `matteProduct` (flatness check, flood-fill background removal, soft edge, rectangle fallback) |
| `src/lib/variation-agent-types.ts` | Modify: `VariationTransplant` type on attempts and plans |
| `src/lib/variation-agent.ts` (+ test) | Modify: `produceImage` dep may return a transplant; attempt/plan carry it; generate-mode prompt guidance |
| `trigger/generate-variation.ts` | Modify: output locator, matte cache, transplant paste, review premise and checklist |
| `src/components/blocks/creatives/creative-variations-tab.tsx` | Modify: "Product transplanted from the source" line |

---

### Task 1: `pastePatch` and a shared `pixelBox`

**Files:**
- Modify: `src/lib/image-composite.ts`
- Test: `src/lib/image-composite.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing describe or add a new one)

```ts
describe("pastePatch", () => {
  it("uniform-fits an alpha patch into the output box and keeps the output visible where the patch is transparent", async () => {
    // 4x4 patch: opaque red left half, fully transparent right half.
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) rgba.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0], (y * 4 + x) * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(20, 20, [0, 255, 0]);
    const { bytes, box } = await pastePatch({ output, patch, region: { x: 0.5, y: 0.5, w: 0.4, h: 0.2 } });
    // Output box is 8x4; a 4x4 patch fits uniformly as 4x4 centred: left 10+2, top 10.
    expect(box).toEqual({ left: 12, top: 10, width: 4, height: 4 });
    expect(await pixel(bytes, 12, 11)).toEqual([255, 0, 0]); // opaque half
    expect(await pixel(bytes, 15, 11)).toEqual([0, 255, 0]); // transparent half shows the output
    expect(await pixel(bytes, 10, 11)).toEqual([0, 255, 0]); // band left of the centred patch
  });
});
```

Import `pastePatch` alongside `pasteSourceRegion`.

- [ ] **Step 2: Run to verify failure**: `bun run test -- src/lib/image-composite.test.ts` fails on the missing export.

- [ ] **Step 3: Implement.** Export `pixelBox` (`export function pixelBox(...)`) and add:

```ts
/**
 * Composites an already-prepared patch (PNG, alpha allowed) into the output at
 * `region`, uniform-scaled to fit the region's pixel box and centred. Used by
 * the product transplant: the patch is the matted source product and `region`
 * is where the model drew its own product.
 */
export async function pastePatch(input: {
  output: Uint8Array;
  patch: Uint8Array;
  region: ProductRegion;
}): Promise<{ bytes: Uint8Array; box: PasteBox }> {
  const region = clampRegion(input.region);
  const [outputMeta, patchMeta] = await Promise.all([
    sharp(input.output).metadata(),
    sharp(input.patch).metadata(),
  ]);
  const outputSize = outputMeta.autoOrient;
  if (!outputSize?.width || !outputSize?.height || !patchMeta.width || !patchMeta.height) {
    throw new Error("pastePatch: could not read image dimensions");
  }
  const to = pixelBox(region, outputSize.width, outputSize.height);
  if (to.width <= 0 || to.height <= 0) throw new Error("pastePatch: the region is empty after clamping");
  const paste = fitBox({ left: 0, top: 0, width: patchMeta.width, height: patchMeta.height }, to);
  const resized = await sharp(input.patch).resize(paste.width, paste.height, { fit: "fill" }).png().toBuffer();
  const bytes = await sharp(input.output)
    .autoOrient()
    .composite([{ input: resized, left: paste.left, top: paste.top }])
    .png()
    .toBuffer();
  return { bytes: new Uint8Array(bytes), box: paste };
}
```

- [ ] **Step 4: Run to verify pass** (4 tests), `bun run typecheck`, `bun run lint`.

- [ ] **Step 5: Commit**: `git add src/lib/image-composite.ts src/lib/image-composite.test.ts && git commit -m "feat(studio): paste an alpha patch uniform-fit into an output region"`

---

### Task 2: Matte the product out of the source

**Files:**
- Create: `src/lib/image-matte.ts`
- Test: `src/lib/image-matte.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodePng } from "./image-mask";
import { matteProduct } from "./image-matte";

/** width x height tile filled by `background(x, y)` with a red disc of radius r at (cx, cy). */
function tile(width: number, height: number, background: (x: number, y: number) => [number, number, number], disc?: { cx: number; cy: number; r: number }) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inDisc = disc && (x - disc.cx) ** 2 + (y - disc.cy) ** 2 <= disc.r ** 2;
      const c = inDisc ? [220, 30, 30] : background(x, y);
      rgba.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return encodePng(width, height, rgba);
}

async function alphaAt(png: Uint8Array, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3];
}

const full = { x: 0, y: 0, w: 1, h: 1 };

describe("matteProduct", () => {
  it("removes a flat background around the product and keeps the product opaque", async () => {
    const source = tile(60, 60, () => [245, 240, 232], { cx: 30, cy: 30, r: 15 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    expect(result.box).toEqual({ left: 0, top: 0, width: 60, height: 60 });
    expect(await alphaAt(result.patch, 2, 2)).toBe(0);
    expect(await alphaAt(result.patch, 30, 30)).toBe(255);
    expect(result.coverage).toBeGreaterThan(0.15);
    expect(result.coverage).toBeLessThan(0.3);
  });

  it("tolerates slight background noise and softens the product edge", async () => {
    const source = tile(60, 60, (x, y) => [245 - ((x + y) % 3), 240, 232], { cx: 30, cy: 30, r: 15 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    expect(await alphaAt(result.patch, 30, 30)).toBe(255);
    const edge = await alphaAt(result.patch, 30, 15); // top of the disc
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it("falls back to an opaque rectangle when the box border is not flat", async () => {
    const source = tile(60, 60, (x) => [Math.round((x / 60) * 255), 120, 120], { cx: 30, cy: 30, r: 15 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(false);
    expect(await alphaAt(result.patch, 2, 2)).toBe(255);
  });

  it("falls back when almost nothing or almost everything is background", async () => {
    const empty = await matteProduct({ source: tile(40, 40, () => [245, 240, 232]), region: full });
    expect(empty.matted).toBe(false);
    const solidRed = await matteProduct({ source: tile(40, 40, () => [220, 30, 30]), region: full });
    expect(solidRed.matted).toBe(false);
  });

  it("crops to the requested region before matting", async () => {
    const source = tile(100, 100, () => [245, 240, 232], { cx: 70, cy: 70, r: 10 });
    const result = await matteProduct({ source, region: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
    expect(result.box).toEqual({ left: 50, top: 50, width: 50, height: 50 });
    expect(result.matted).toBe(true);
    expect(await alphaAt(result.patch, 20, 20)).toBe(255); // disc centre at (70,70) -> (20,20) in the crop
    expect(await alphaAt(result.patch, 2, 2)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `bun run test -- src/lib/image-matte.test.ts` fails on the missing module.

- [ ] **Step 3: Implement** `src/lib/image-matte.ts`:

```ts
// Cuts the product out of a source ad so it can be pasted into a generated
// scene without dragging the source's background along. Works on the common
// case (a product on a flat card or pedestal): flood-fills the background from
// the box border, keeps everything it cannot reach, and softens the edge one
// pixel. Anything else falls back to an opaque rectangle so callers always get
// a usable patch.

import sharp from "sharp";
import { pixelBox, type PasteBox } from "@/lib/image-composite";
import { clampRegion, type ProductRegion } from "@/lib/image-mask";

/** Max spread of border colours (RGB Euclidean, 0-441) for the border to count as flat. */
const FLAT_BORDER_SPREAD = 40;
/** A pixel this close to the border's mean colour is background. */
const BACKGROUND_DISTANCE = 32;
/** Foreground share outside this band means the matte is not trustworthy. */
const MIN_COVERAGE = 0.02;
const MAX_COVERAGE = 0.9;
const EDGE_ALPHA = 150;

export type MatteResult = {
  /** PNG with alpha, the size of `box`. */
  patch: Uint8Array;
  /** Pixel box of the region in the (oriented) source. */
  box: PasteBox;
  /** False when the rectangle fallback was used. */
  matted: boolean;
  /** Foreground share of the box (0 when not matted). */
  coverage: number;
};

function distance(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export async function matteProduct(input: {
  source: Uint8Array;
  region: ProductRegion;
}): Promise<MatteResult> {
  const region = clampRegion(input.region);
  const meta = await sharp(input.source, { failOn: "none" }).metadata();
  const size = meta.autoOrient;
  if (!size?.width || !size?.height) throw new Error("matteProduct: could not read image dimensions");
  const box = pixelBox(region, size.width, size.height);
  if (box.width <= 0 || box.height <= 0) throw new Error("matteProduct: the region is empty after clamping");

  const { data, info } = await sharp(input.source, { failOn: "none" })
    .autoOrient()
    .extract(box)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rgbAt = (i: number): [number, number, number] => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];

  const rectangle = async (): Promise<MatteResult> => ({
    patch: new Uint8Array(await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()),
    box,
    matted: false,
    coverage: 0,
  });

  // Border ring: is it flat enough to treat as background?
  const border: number[] = [];
  for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) border.push(y * width, y * width + width - 1);
  const mean: [number, number, number] = [0, 0, 0];
  for (const i of border) for (let c = 0; c < 3; c += 1) mean[c] += data[i * 4 + c] / border.length;
  const spread = Math.max(...border.map((i) => distance(rgbAt(i), mean)));
  if (spread > FLAT_BORDER_SPREAD) return rectangle();

  // Flood fill background from the border.
  const background = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const i of border) {
    if (distance(rgbAt(i), mean) <= BACKGROUND_DISTANCE && !background[i]) {
      background[i] = 1;
      queue.push(i);
    }
  }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (background[n] || distance(rgbAt(n), mean) > BACKGROUND_DISTANCE) continue;
      background[n] = 1;
      queue.push(n);
    }
  }

  let foreground = 0;
  for (let i = 0; i < width * height; i += 1) if (!background[i]) foreground += 1;
  const coverage = foreground / (width * height);
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return rectangle();

  // Alpha: background 0, product edge soft, product 255.
  const out = Buffer.from(data);
  for (let i = 0; i < width * height; i += 1) {
    if (background[i]) {
      out[i * 4 + 3] = 0;
      continue;
    }
    const x = i % width;
    const y = (i - x) / width;
    const touchesBackground =
      (x > 0 && background[i - 1]) ||
      (x < width - 1 && background[i + 1]) ||
      (y > 0 && background[i - width]) ||
      (y < height - 1 && background[i + width]);
    out[i * 4 + 3] = touchesBackground ? EDGE_ALPHA : 255;
  }
  const patch = new Uint8Array(await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return { patch, box, matted: true, coverage };
}
```

Note for the implementer: the "tolerates slight noise" test's edge probe at (30, 15) sits on the disc's top boundary; if the disc rasterises so that (30, 15) is interior (alpha 255) or exterior (alpha 0), probe (30, 16) or (30, 14) instead and say so in the report. The gradient fallback test relies on the border spread exceeding 40 (the red channel spans 0–255 across the width), which it does.

- [ ] **Step 4: Run to verify pass** (5 tests), `bun run typecheck`, `bun run lint`.

- [ ] **Step 5: Commit**: `git add src/lib/image-matte.ts src/lib/image-matte.test.ts && git commit -m "feat(studio): matte the source product out of its flat background"`

---

### Task 3: Agent core records the transplant and guides generate mode

**Files:**
- Modify: `src/lib/variation-agent-types.ts`, `src/lib/variation-agent.ts`
- Test: `src/lib/variation-agent.test.ts`

- [ ] **Step 1: Types.** In `variation-agent-types.ts` add:

```ts
export type VariationTransplant = {
  /** Where the product was cut from in the source. */
  from: ProductRegion;
  /** Where the model drew its product in the output, now covered by the source's. */
  to: ProductRegion;
  /** False when the rectangle fallback was pasted instead of a matte. */
  matted: boolean;
};
```

Add `transplant?: VariationTransplant | null;` to `VariationAttempt` and `transplantedProduct?: VariationTransplant | null;` to `VariationPlan`.

- [ ] **Step 2: Tests** (append; import `VariationTransplant` if needed)

```ts
  it("records a transplant reported by produceImage and stamps it on the plan", async () => {
    const transplant = { from: region, to: { x: 0.5, y: 0.55, w: 0.3, h: 0.3 }, matted: true };
    const d = deps({ produceImage: vi.fn(async () => ({ imageUrl: "https://blob.test/out-1.png", transplant })) });
    const run = createVariationRun(editInput, d);
    const result = await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(result).toMatchObject({ mode: "generate", transplant });
    expect(run.state.attempts[0]).toMatchObject({ transplant });
    expect(d.reviewImage).toHaveBeenCalledWith(expect.objectContaining({ transplant }));
    await run.finish({ plan });
    expect(run.state.plan?.transplantedProduct).toEqual(transplant);
    expect(run.state.plan?.keptProductRegion).toBeNull();
  });

  it("tells the model in generate mode that its product will be replaced when a source product was located", () => {
    expect(buildVariationSystemPrompt(editInput)).toContain("TRANSPLANT");
    expect(buildVariationSystemPrompt(input)).not.toContain("TRANSPLANT");
  });
```

- [ ] **Step 3: Implement.**
  - `VariationRunDeps.produceImage` returns `Promise<{ imageUrl: string; transplant?: VariationTransplant | null }>`; `reviewImage` input gains `transplant: VariationTransplant | null`.
  - In `generateImage`, capture `const produced = await deps.produceImage(...)`, set `imageUrl = produced.imageUrl` and `const transplant = produced.transplant ?? null`; pass `transplant` to `reviewImage`; push `{ ..., transplant }` on the attempt; include `transplant` in the result.
  - In `finish` (and the synthesized plan in `resolveVariationOutcome`): `transplantedProduct: final.transplant ?? null` next to `keptProductRegion`.
  - System prompt: when `editModeAvailable(input)` (a source product was located, creative source, source in use), add a `<mode>` entry *before* the EDIT MODE one:

```ts
    editAvailable
      ? "<mode>\nTRANSPLANT: in generate mode the product you draw is replaced afterwards by the source's own product photo, cut out and pasted over it. So draw the product alone on a plain, evenly lit surface at roughly the size it has in the source, with nothing overlapping it and no second copy elsewhere; do not describe its shape, colour, or markings beyond naming it. Everything else in the prompt is yours to design.\n</mode>"
      : null,
```

- [ ] **Step 4: Run** `bun run test -- src/lib/variation-agent.test.ts` (46 expected), typecheck, lint.

- [ ] **Step 5: Commit**: `git add src/lib/variation-agent-types.ts src/lib/variation-agent.ts src/lib/variation-agent.test.ts && git commit -m "feat(studio): carry a product transplant through the variation agent"`

---

### Task 4: Task wiring: locate in the output, matte, paste, review

**Files:**
- Modify: `trigger/generate-variation.ts`

- [ ] **Step 1: Locator reuse.** Rename `locateSourceProduct` to `locateProduct(bytes, brandName, label: "source" | "output")` and include `label` in its info log; the output call uses the same prompt. Keep the source call as is.

- [ ] **Step 2: Matte cache.** Next to `imageBytes`, add:

```ts
      // The source product's matte is the same for every attempt; cut it once.
      let sourceMatte: Promise<MatteResult> | null = null;
      const matteSource = () =>
        (sourceMatte ??= matteProduct({ source: sourceBytes, region: sourceProductRegion! }));
```

(import `matteProduct`, `type MatteResult` from `@/lib/image-matte`, `pastePatch` from `@/lib/image-composite`).

- [ ] **Step 3: Transplant in the generate branch of `produceImage`.** After `generateImage` returns and before storage, when `mode === "generate" && sourceProductRegion && input.useSourceLayout && source.kind === "creative"`:

```ts
          let transplant: VariationTransplant | null = null;
          if (mode === "generate" && sourceProductRegion && source.kind === "creative" && !payload.withoutSourceImage) {
            try {
              onStep(`locating the product in attempt ${attempt}`);
              const to = await locateProduct(produced, brand?.brandName ?? null, "output");
              if (to) {
                const matte = await matteSource();
                const pasted = await pastePatch({ output: produced, patch: matte.patch, region: to });
                produced = pasted.bytes;
                transplant = { from: sourceProductRegion, to, matted: matte.matted };
                logger.info("Transplanted source product", { attempt, to, matted: matte.matted, coverage: matte.coverage, box: pasted.box });
              } else {
                logger.warn("Transplant skipped: product not located in the output", { attempt });
              }
            } catch (error) {
              logger.warn("Transplant failed; keeping the model's product", {
                attempt,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              });
            }
          }
```

Return `{ imageUrl: stored.url, transplant }` and record `transplant` in a `transplantByUrl` map keyed by `stored.url` for the review (replacing the `pastedUrls` pattern for this path; keep `pastedUrls` for edit mode). `produced` must be a `let` initialised from `result.image.uint8Array` before this block (the edit-mode paste block already does that; unify so both branches assign `produced`).

- [ ] **Step 4: Review.** `reviewImage` destructures `transplant`. When `transplant` is set: attach the source as the second image, opening line "The first image is the generated ad; the source's own product was cut out of the second image (the source) and pasted over the product the model drew.", and the fidelity line:

```ts
                transplant
                  ? `- The source's product now sits in the box ${pct(transplant.to)}. Check: it is a plausible size for the scene; its lighting and colour do not clash with the surroundings; no remnant of the model's own product shows around its edges; and nothing important is covered. Name which failed.`
                  : /* existing branches */
```

with a small `pct(region)` helper producing the "x% to y% across, …" text (reuse the arithmetic already in the edit line).

- [ ] **Step 5: Verify** `bun run typecheck`, `bun run lint`. Then the live check: start `bun dev` and `bun run trigger:dev` with the local storage mode, trigger a variation on the R3 test creative, and confirm in the stored attempt that `transplant` is set with `matted: true`, and visually that the pasted product is the source's and sits where the model composed it with no rectangle. Run one on R1 (busy background) and expect `matted: false` with a rectangle fallback. Stop both servers afterwards.

- [ ] **Step 6: Commit**: `git add trigger/generate-variation.ts && git commit -m "feat(studio): transplant the source product into generated variations"`

---

### Task 5: Card line

**Files:**
- Modify: `src/components/blocks/creatives/creative-variations-tab.tsx`

- [ ] In `PlanDisclosure`, next to the kept-region line, add:

```tsx
        {plan.transplantedProduct ? (
          <p className="text-muted-foreground">
            {plan.transplantedProduct.matted ? "Product transplanted from the source." : "Product transplanted from the source (rectangle fallback)."}
          </p>
        ) : null}
```

- [ ] `bun run typecheck && bun run lint`; commit `feat(creatives): say when a variation transplanted the source product`.

---

### Task 6: Verification and docs

- [ ] `bun run typecheck && bun run lint && bun run test`, `node scripts/check-migrations.mjs`.
- [ ] Append to the compositing addendum's §8 a one-line pointer to the transplant spec, and to the transplant spec a "Status: implemented" line with the live-check result. Commit `docs(studio): record the product transplant outcome`.

---

## Self-review against the spec

- Proposal steps 1-5 map to Tasks 3 (prompt guidance), 4 (output locator, matte, paste, review), 2 (matte), 1 (patch paste).
- "What it needs" bullets: matte module (Task 2), second locator (Task 4), alpha patch paste (Task 1), prompt (Task 3), review + plan field + card line (Tasks 3-5).
- Fallbacks: locator miss or matte/paste throw keep the model's product with a warning (Task 4); non-flat border or degenerate coverage returns a rectangle (Task 2).
- Edit mode untouched; competitor sources excluded by the same gate as before.
