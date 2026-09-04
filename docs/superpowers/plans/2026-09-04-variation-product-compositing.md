# Variation Product Compositing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make variations keep the source's product pixel-for-pixel by generating them as masked edits of the source image, per `docs/superpowers/specs/2026-09-04-variation-product-compositing-design.md`.

**Architecture:** A vision call locates the product in the source before the loop. A pure PNG mask writer turns that box into an OpenAI edit mask (opaque = keep, transparent = regenerate). The agent core gains an `edit` mode for `generateImage` (default when a product was found and the source layout is in use) that sends only the source plus mask; the review compares the protected region against the source; the plan records the kept region. Everything with a rule stays in `src/lib/` with tests; the Trigger task wires IO.

**Tech Stack:** Vercel AI SDK 6 (`generateImage` with `prompt: { images, mask, text }`, `generateObject`), Node `zlib` (deflate) for the PNG encoder, Zod v4, Vitest.

**Conventions on this branch:** commits are title only. Tests via `bun run test` (never `bun test`). No direct tests for Trigger tasks. Icons from `@/components/icons`.

---

## File map

| Path | Responsibility |
|---|---|
| `src/lib/image-mask.ts` (+ test) | Pure: `ProductRegion` type and validation, region expansion/clamping, minimal PNG encoder, `buildKeepMask` |
| `src/lib/variation-agent-types.ts` | Modify: `VariationAttempt` gains `mode` and `keepRegion`; `VariationPlan` gains `keptProductRegion` |
| `src/lib/variation-agent.ts` (+ test) | Modify: input gains `sourceProductRegion`; `generateImage` gains `mode` / `keepRegion` with default selection; deps carry mode and region; `finish` stamps `keptProductRegion`; system prompt explains edit mode |
| `trigger/generate-variation.ts` | Modify: product locator call, mask build, edit-mode image call, edit-mode review with the source attached |
| `src/components/blocks/creatives/creative-variations-tab.tsx` | Modify: "Product kept from the source" line in the plan disclosure |

---

### Task 1: Mask writer (pure)

**Files:**
- Create: `src/lib/image-mask.ts`
- Test: `src/lib/image-mask.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildKeepMask,
  clampRegion,
  encodePng,
  expandRegion,
  MASK_MARGIN,
  productRegionSchema,
} from "./image-mask";

/** Test-only PNG reader for the exact encoder this module writes (8-bit RGBA, filter 0). */
function readRgba(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect(png[offset + 16]).toBe(8); // bit depth
      expect(png[offset + 17]).toBe(6); // RGBA
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const stride = width * 4 + 1;
  const alphaAt = (x: number, y: number) => raw[y * stride + 1 + x * 4 + 3];
  return { width, height, alphaAt };
}

describe("productRegionSchema", () => {
  it("accepts a normalized box and rejects empty or out-of-range ones", () => {
    expect(productRegionSchema.safeParse({ x: 0.5, y: 0.6, w: 0.3, h: 0.3 }).success).toBe(true);
    expect(productRegionSchema.safeParse({ x: 0.5, y: 0.6, w: 0, h: 0.3 }).success).toBe(false);
    expect(productRegionSchema.safeParse({ x: 0.9, y: 0.6, w: 0.3, h: 0.3 }).success).toBe(false);
    expect(productRegionSchema.safeParse({ x: -0.1, y: 0, w: 0.5, h: 0.5 }).success).toBe(false);
  });
});

describe("expandRegion / clampRegion", () => {
  it("expands by the margin on every side and clamps to the canvas", () => {
    expect(expandRegion({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toEqual({
      x: 0.5 - MASK_MARGIN, y: 0.5 - MASK_MARGIN, w: 0.2 + 2 * MASK_MARGIN, h: 0.2 + 2 * MASK_MARGIN,
    });
    expect(expandRegion({ x: 0.9, y: 0, w: 0.1, h: 0.1 })).toEqual({
      x: 0.9 - MASK_MARGIN, y: 0, w: 0.1 + MASK_MARGIN, h: 0.1 + MASK_MARGIN,
    });
    expect(clampRegion({ x: -0.2, y: 0.5, w: 2, h: 1 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});

describe("encodePng", () => {
  it("round-trips a tiny RGBA image", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]); // 2x1: opaque red, transparent
    const { width, height, alphaAt } = readRgba(encodePng(2, 1, rgba));
    expect([width, height]).toEqual([2, 1]);
    expect([alphaAt(0, 0), alphaAt(1, 0)]).toEqual([255, 0]);
  });
});

describe("buildKeepMask", () => {
  it("is opaque inside the expanded keep box and transparent outside", () => {
    const png = buildKeepMask({ width: 100, height: 200, keep: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } });
    const { width, height, alphaAt } = readRgba(png);
    expect([width, height]).toEqual([100, 200]);
    expect(alphaAt(60, 120)).toBe(255); // inside
    expect(alphaAt(48, 120)).toBe(255); // inside the 3% margin (x from 47 to 73)
    expect(alphaAt(10, 10)).toBe(0); // outside
    expect(alphaAt(99, 199)).toBe(0);
  });

  it("is fully transparent when there is nothing to keep", () => {
    const { alphaAt } = readRgba(buildKeepMask({ width: 4, height: 4, keep: null }));
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(3, 3)).toBe(0);
  });

  it("inverts polarity when asked (edit only inside the box)", () => {
    const { alphaAt } = readRgba(
      buildKeepMask({ width: 100, height: 100, keep: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, invert: true }),
    );
    expect(alphaAt(60, 60)).toBe(0);
    expect(alphaAt(10, 10)).toBe(255);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test -- src/lib/image-mask.test.ts`
Expected: FAIL, cannot resolve `./image-mask`.

- [ ] **Step 3: Implement**

Create `src/lib/image-mask.ts`:

```ts
// Builds the PNG mask an image-edit call needs to protect the product region
// of a source ad: opaque pixels are kept, transparent pixels are regenerated
// (the OpenAI edit convention). Written by hand with Node's zlib so no image
// library is needed; the encoder covers exactly the 8-bit RGBA, filter-0 case.

import { deflateSync } from "node:zlib";
import { z } from "zod";

/** Normalized bounding box (0-1) of the product in the source image. */
export type ProductRegion = { x: number; y: number; w: number; h: number };

export const productRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .refine((r) => r.x + r.w <= 1 && r.y + r.h <= 1, "Region must stay inside the canvas");

/** Extra margin on every side so anti-aliased product edges are not cut. */
export const MASK_MARGIN = 0.03;

export function clampRegion(region: ProductRegion): ProductRegion {
  const x = Math.min(Math.max(region.x, 0), 1);
  const y = Math.min(Math.max(region.y, 0), 1);
  const w = Math.min(Math.max(region.w, 0), 1 - x);
  const h = Math.min(Math.max(region.h, 0), 1 - y);
  return { x, y, w, h };
}

export function expandRegion(region: ProductRegion, margin = MASK_MARGIN): ProductRegion {
  // Each edge moves outward independently and stops at the canvas, so a box
  // on the top or left border does not gain the lost margin on the far side.
  const left = Math.max(region.x - margin, 0);
  const top = Math.max(region.y - margin, 0);
  const right = Math.min(region.x + region.w + margin, 1);
  const bottom = Math.min(region.y + region.h + margin, 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes 8-bit RGBA pixels (row-major, 4 bytes per pixel) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const stride = width * 4;
  const scanlines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (stride + 1)] = 0; // filter type 0 (none)
    scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // bit depth 8, RGBA, deflate, filter 0, no interlace
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(scanlines))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type KeepMaskInput = {
  width: number;
  height: number;
  /** Region to protect (normalized). `null` protects nothing: the whole image is editable. */
  keep: ProductRegion | null;
  /** When true the box is the only editable area (the Phase 2 polarity). */
  invert?: boolean;
};

/** A PNG the size of the source where kept pixels are opaque white and editable pixels are transparent. */
export function buildKeepMask({ width, height, keep, invert = false }: KeepMaskInput): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const box = keep ? expandRegion(keep) : null;
  const left = box ? Math.floor(box.x * width) : 0;
  const top = box ? Math.floor(box.y * height) : 0;
  const right = box ? Math.ceil((box.x + box.w) * width) : 0;
  const bottom = box ? Math.ceil((box.y + box.h) * height) : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = box !== null && x >= left && x < right && y >= top && y < bottom;
      const opaque = invert ? !inside : inside;
      const i = (y * width + x) * 4;
      rgba[i] = 255;
      rgba[i + 1] = 255;
      rgba[i + 2] = 255;
      rgba[i + 3] = opaque ? 255 : 0;
    }
  }
  return encodePng(width, height, rgba);
}
```

Note on the second expand test: with `x: 0.9, w: 0.1` the right edge stops at 1, giving `w = 0.1 + MASK_MARGIN`; with `y: 0` the top edge stays at 0 and only the bottom gains the margin, giving `h = 0.1 + MASK_MARGIN`. Clamping origin and extent separately would wrongly give `h = 0.1 + 2 * MASK_MARGIN`.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test -- src/lib/image-mask.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/image-mask.ts src/lib/image-mask.test.ts
git commit -m "feat(studio): write product keep masks as PNG"
```

---

### Task 2: Agent core: edit mode, kept region, prompt

**Files:**
- Modify: `src/lib/variation-agent-types.ts`
- Modify: `src/lib/variation-agent.ts`
- Test: `src/lib/variation-agent.test.ts`

- [ ] **Step 1: Extend the shared types**

In `src/lib/variation-agent-types.ts` add at the top:

```ts
import type { ProductRegion } from "@/lib/image-mask";
```

(`image-mask.ts` imports only `zod` and `node:zlib`; the schema file that imports these types is server-only, so this stays safe.)

Add to `VariationPlan` after `synthesized?`:

```ts
  /** Set by the core on finish: the source region protected in the shipped edit, if any. */
  keptProductRegion?: ProductRegion | null;
```

Add to `VariationAttempt` after `prompt`:

```ts
  mode: "edit" | "generate";
  /** The protected source region for an edit attempt. */
  keepRegion?: ProductRegion | null;
```

- [ ] **Step 2: Write the failing tests**

Append to the existing `describe("createVariationRun.generateImage")` block in `src/lib/variation-agent.test.ts`, and add a new describe for the prompt. First extend the shared fixture: after `const input: VariationRunInput = { ... }` add

```ts
const region = { x: 0.55, y: 0.6, w: 0.3, h: 0.3 };
const editInput: VariationRunInput = { ...input, sourceProductRegion: region };
```

Then the tests:

```ts
  it("defaults to edit mode when a product region exists and sends only the source with the region", async () => {
    const d = deps();
    const run = createVariationRun(editInput, d);
    const result = await run.generateImage({ prompt: "p", referenceImageIds: ["img_r3"], keepSourceLayout: true });
    expect(d.produceImage).toHaveBeenCalledWith({
      prompt: "p",
      mode: "edit",
      keepRegion: region,
      referenceImageUrls: ["https://cdn.test/source.png"],
      format: "portrait",
      attempt: 1,
    });
    expect(d.reviewImage).toHaveBeenCalledWith({ imageUrl: "https://blob.test/out-1.png", prompt: "p", mode: "edit", keepRegion: region });
    expect(result).toMatchObject({ mode: "edit", keepRegion: region });
    expect(run.state.attempts[0]).toMatchObject({ mode: "edit", keepRegion: region });
  });

  it("uses generate mode when no region was found, and records it on the attempt", async () => {
    const d = deps();
    const run = createVariationRun(input, d);
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ mode: "generate", keepRegion: null }));
    expect(run.state.attempts[0]).toMatchObject({ mode: "generate" });
  });

  it("honours an explicit generate mode and a keepRegion override in edit mode", async () => {
    const d = deps();
    const run = createVariationRun(editInput, d);
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true, mode: "generate" });
    expect(d.produceImage).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "generate" }));
    const override = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 };
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true, keepRegion: override });
    expect(d.produceImage).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "edit", keepRegion: override }));
  });

  it("rejects edit mode when it is unavailable without spending an attempt", async () => {
    const d = deps();
    const run = createVariationRun({ ...editInput, useSourceLayout: false }, d);
    await expect(run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true, mode: "edit" })).resolves.toEqual({
      error: "Edit mode is not available on this run (no product region, the source is not in use, or the source is a competitor ad). Use mode \"generate\".",
    });
    expect(d.produceImage).not.toHaveBeenCalled();
    expect(run.state.imageCalls).toBe(0);
  });
```

Add to `describe("createVariationRun.finish")`:

```ts
  it("stamps the kept region of the final attempt onto the plan", async () => {
    const run = createVariationRun(editInput, deps());
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    await run.finish({ plan });
    expect(run.state.plan?.keptProductRegion).toEqual(region);
  });
```

Add to `describe("buildVariationSystemPrompt")`:

```ts
  it("explains edit mode and states the protected region when a product was located", () => {
    const system = buildVariationSystemPrompt(editInput);
    expect(system).toContain("EDIT MODE");
    expect(system).toContain("55% to 85% across and 60% to 90% down");
    expect(buildVariationSystemPrompt(input)).not.toContain("EDIT MODE");
  });
```

Also update the existing "passes references in order" and "does not attach the product photo twice" tests: they use `input` (no region), so they stay in generate mode; extend their `toHaveBeenCalledWith` objects with `mode: "generate", keepRegion: null`. Update `resolveVariationOutcome` attempt fixtures (`attempt(n, pass)`) to include `mode: "generate" as const`.

- [ ] **Step 3: Run to verify failure**

Run: `bun run test -- src/lib/variation-agent.test.ts`
Expected: FAIL on the new tests (unknown `mode`, missing `sourceProductRegion`, no EDIT MODE text).

- [ ] **Step 4: Implement in `src/lib/variation-agent.ts`**

Imports: add

```ts
import { productRegionSchema, type ProductRegion } from "@/lib/image-mask";
```

`VariationRunInput`: add after `sourceImage?`:

```ts
  /**
   * Where the product sits in the source (normalized box), from the locator.
   * `null` when the locator found none; `undefined` when it did not run.
   */
  sourceProductRegion?: ProductRegion | null;
```

`VariationRunDeps`: change the two signatures to

```ts
  produceImage: (input: {
    prompt: string;
    mode: "edit" | "generate";
    /** The protected source region in edit mode; null in generate mode. */
    keepRegion: ProductRegion | null;
    referenceImageUrls: string[];
    format: StudioFormat;
    attempt: number;
  }) => Promise<{ imageUrl: string }>;
  reviewImage: (input: {
    imageUrl: string;
    prompt: string;
    mode: "edit" | "generate";
    keepRegion: ProductRegion | null;
  }) => Promise<VariationReview>;
```

`generateImageInputSchema`:

```ts
export const generateImageInputSchema = z.object({
  prompt: z.string().min(1),
  referenceImageIds: z.array(z.string()).default([]),
  keepSourceLayout: z.boolean().default(true),
  /** edit: masked edit of the source keeping the product; generate: draw from references. Defaults to edit when available. */
  mode: z.enum(["edit", "generate"]).optional(),
  /** Override the protected region in edit mode (normalized 0-1 box). */
  keepRegion: productRegionSchema.optional(),
});
```

Add a helper near `escapeContextField`:

```ts
function describeRegion(region: ProductRegion) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return `${pct(region.x)} to ${pct(region.x + region.w)} across and ${pct(region.y)} to ${pct(region.y + region.h)} down`;
}

function editModeAvailable(input: VariationRunInput) {
  return Boolean(input.sourceProductRegion) && input.useSourceLayout && input.source.kind === "creative";
}
```

System prompt: in the `return [...]` array of `buildVariationSystemPrompt`, after the retry-without-image `<mode>` entry, add:

```ts
    editAvailable && input.sourceProductRegion
      ? `<mode>\nEDIT MODE is available and is the default for generateImage. The source is the canvas: the box ${describeRegion(input.sourceProductRegion)} of it holds the product and is kept pixel-for-pixel, and everything outside that box is redrawn from your prompt alone. The prompt is still the self-contained description step 4 asks for, minus the product: describe the whole scene outside the kept box (background, lighting, palette, mood) and re-quote every line of copy the finished ad shows, including lines you are not changing. Anything you leave out is lost. Never describe or restyle the product itself; refer to it in plain words if you must (for example "the product in the lower-right tile is kept as is"). Keep the source's composition. If the review says the kept region cut the product, call generateImage again with a wider keepRegion. Once in edit mode keepSourceLayout has no effect; to leave edit mode pass mode "generate" or keepSourceLayout false, and do that only when the variation must move or replace the product.\n</mode>`
      : null,
```

where `const editAvailable = editModeAvailable(input);` is declared at the top of `buildVariationSystemPrompt` and also passed to `brandBlock(input.brand, editAvailable)`, whose product-photo line becomes mode-aware: in edit mode it states that no product photo is attached and the product is preserved from the source, so the model must not describe, restyle, or match it; otherwise the existing "attached as the first reference" wording stays.

Two further rules shipped with this task (found in review): an explicit `keepSourceLayout: false` selects generate mode (`const mode = raw.mode ?? (editAvailable && raw.keepSourceLayout ? "edit" : "generate")`) and the moderation hint says `pass mode "generate"` in edit mode; and the tool result carries `ignoredReferenceReason` next to `ignoredReferenceIds` (edit mode: references are never attached; generate mode: unknown id). `resolveVariationOutcome`'s synthesized plan also records `keptProductRegion` from the passing attempt.

`generateImage` handler: replace the body from the `// Reference order` comment through the `deps.produceImage` call and the `state.attempts.push` line with:

```ts
    const editAvailable = editModeAvailable(input);
    const mode = raw.mode ?? (editAvailable ? "edit" : "generate");
    if (mode === "edit" && !editAvailable) {
      return {
        error:
          'Edit mode is not available on this run (no product region, the source is not in use, or the source is a competitor ad). Use mode "generate".',
      };
    }
    const keepRegion = mode === "edit" ? (raw.keepRegion ?? input.sourceProductRegion ?? null) : null;

    // Counted before the call: a blocked attempt still spent an image-model call.
    state.imageCalls += 1;
    const attempt = state.imageCalls;
    const ignoredReferenceIds: string[] = [];
    const referenceImageUrls: string[] = [];
    if (mode === "edit") {
      // The source is the canvas being edited; the product is preserved from
      // it, so no product photo or context images are sent.
      referenceImageUrls.push(input.source.imageUrl);
      ignoredReferenceIds.push(...raw.referenceImageIds);
    } else {
      // Reference order: product photo first, chosen context images, source
      // last. The image model leans on the first reference for the product and
      // the last for layout.
      const productImageUrl = input.brand?.productImageUrl;
      if (productImageUrl) referenceImageUrls.push(productImageUrl);
      for (const id of raw.referenceImageIds) {
        const image = imageById.get(id);
        if (!image) ignoredReferenceIds.push(id);
        else if (!referenceImageUrls.includes(image.imageUrl)) referenceImageUrls.push(image.imageUrl);
      }
      if (raw.keepSourceLayout && input.useSourceLayout) {
        referenceImageUrls.push(input.source.imageUrl);
      }
    }

    deps.onStep(`${mode === "edit" ? "editing source" : "generating image"} (attempt ${attempt})`);
    let imageUrl: string;
    try {
      ({ imageUrl } = await deps.produceImage({
        prompt: raw.prompt,
        mode,
        keepRegion,
        referenceImageUrls,
        format: input.format,
        attempt,
      }));
    } catch (error) {
      const reason = moderationReasonFromError(error);
      if (reason) {
        state.moderationReason = reason;
        return {
          error: `The image model blocked this attempt (${reason}). Try again without relying on people from the source, or set keepSourceLayout to false.`,
        };
      }
      throw error;
    }

    deps.onStep(`reviewing attempt ${attempt}`);
    const review = await deps.reviewImage({ imageUrl, prompt: raw.prompt, mode, keepRegion });
    state.attempts.push({ attempt, imageUrl, prompt: raw.prompt, mode, keepRegion, review });
```

and extend the returned object with `mode, keepRegion` (keep `attempt, imageUrl, review, attemptsRemaining` and the conditional `ignoredReferenceIds`). Keep the claims pre-check and the budget check above this block exactly as they are; the important ordering change is that the edit-availability error runs before `state.imageCalls += 1`.

The existing test "passes references in order" expects `ignoredReferenceIds: ["unknown"]` in generate mode; that still holds.

`finish`: after validating `finalAttempt`, stamp the region:

```ts
    const final = state.attempts.find((a) => a.attempt === raw.plan.finalAttempt);
    state.plan = { ...raw.plan, keptProductRegion: final?.mode === "edit" ? (final.keepRegion ?? null) : null };
```

(The existing "stores the plan" test uses `toEqual(plan)`; change it to `toMatchObject(plan)` so the added key does not fail it.)

`resolveVariationOutcome`: the synthesized plans (in this file and in the task's failure path) need no change; `keptProductRegion` is optional.

- [ ] **Step 5: Run to verify pass**

Run: `bun run test -- src/lib/variation-agent.test.ts`
Expected: PASS (all, including the six new cases).

Run: `bun run typecheck` — expected to fail only in `trigger/generate-variation.ts` (the deps signatures changed); Task 3 fixes that. If anything else fails, fix it here.

- [ ] **Step 6: Commit**

```bash
git add src/lib/variation-agent-types.ts src/lib/variation-agent.ts src/lib/variation-agent.test.ts
git commit -m "feat(studio): add edit mode with a kept product region to the variation agent"
```

---

### Task 3: Trigger task: locate, mask, edit, review

**Files:**
- Modify: `trigger/generate-variation.ts`

No direct test (convention). Read the whole file first.

- [ ] **Step 1: Imports and schema**

Add imports:

```ts
import { buildKeepMask, productRegionSchema, type ProductRegion } from "@/lib/image-mask";
```

(`readImageDimensions` is already imported.) Add after `reviewSchema`:

```ts
const LOCATOR_MODEL = "gpt-5.6-terra";

const productLocationSchema = z.object({
  product: productRegionSchema.nullable(),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});

/**
 * Finds the product in the source so an edit can protect it. Includes any
 * packaging the product sits in or on. Returns null on failure or when the
 * source shows no product, which sends the run down the generate path.
 */
async function locateSourceProduct(
  sourceBytes: Uint8Array,
  brandName: string | null,
): Promise<ProductRegion | null> {
  try {
    const result = await generateObject({
      model: openai(LOCATOR_MODEL),
      schema: productLocationSchema,
      system: [
        `Locate the advertised physical product${brandName ? ` (${brandName})` : ""} in this static ad.`,
        "Return one normalized bounding box (x, y, w, h in 0-1 from the top-left) that covers the whole product. When the product sits in, on, or beside its own packaging or case, cover both together. Do not include headline text, badges, or unrelated props.",
        "Return product: null when no physical product is visible (a text-only or lifestyle ad).",
      ].join("\n"),
      messages: [{ role: "user", content: [{ type: "image", image: sourceBytes }] }],
    });
    if (!result.object.product || result.object.confidence < 0.4) return null;
    return result.object.product;
  } catch (error) {
    logger.warn("Product locator failed; using generate mode", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return null;
  }
}
```

- [ ] **Step 2: Locate before the loop**

After the `format` is computed and written (the `studioGenerations` update), and before `const input: VariationRunInput = {...}`, add:

```ts
      const sourceDimensions = readImageDimensions(sourceBytes);
      let sourceProductRegion: ProductRegion | null = null;
      if (source.kind === "creative" && !payload.withoutSourceImage && sourceDimensions) {
        onStep("locating the product in the source");
        sourceProductRegion = await locateSourceProduct(sourceBytes, brand?.brandName ?? null);
      }
```

and add `sourceProductRegion,` to the `input` literal. (`readImageDimensions(sourceBytes)` is already called once for the format; reuse that value instead of calling twice: assign it to `sourceDimensions` first and pass it to `studioFormatForDimensions`.)

- [ ] **Step 3: Edit-mode image call**

Replace the `produceImage` dep with:

```ts
        produceImage: async ({ prompt, mode, keepRegion, referenceImageUrls, format, attempt }) => {
          const references: Uint8Array[] = [];
          for (const url of referenceImageUrls) references.push(await fetchBytes(url));
          const result = await logger.trace(`${mode === "edit" ? "Edit" : "Generate"} attempt ${attempt}`, () =>
            mode === "edit" && sourceDimensions
              ? generateImage({
                  model: openai.image(IMAGE_MODEL),
                  // references holds only the source in edit mode; the mask
                  // keeps the product region opaque so it is copied through.
                  prompt: {
                    images: references,
                    mask: buildKeepMask({
                      width: sourceDimensions.width,
                      height: sourceDimensions.height,
                      keep: keepRegion,
                    }),
                    text: prompt,
                  },
                  size: studioSizeFor(format),
                })
              : generateImage({
                  model: openai.image(IMAGE_MODEL),
                  prompt: references.length ? { text: prompt, images: references } : prompt,
                  size: studioSizeFor(format),
                }),
          );
          const stored = await putStudioObject(
            `${env}/create/${ctx.run.id}-${ctx.attempt.number}-${attempt}.png`,
            result.image.uint8Array,
            "image/png",
          );
          imageBytes.set(stored.url, result.image.uint8Array);
          return { imageUrl: stored.url };
        },
```

- [ ] **Step 4: Edit-mode review**

Change the `reviewImage` dep signature to `async ({ imageUrl, prompt, mode, keepRegion }) =>` and build the content as:

```ts
            const content: Array<
              { type: "text"; text: string } | { type: "image"; image: Uint8Array }
            > = [
              {
                type: "text",
                text: `Review this generated ad against the prompt below and the checklist.\n\nPROMPT:\n${prompt}`,
              },
              { type: "image", image: await fetchBytes(imageUrl) },
            ];
            if (mode === "edit") {
              content.push({ type: "image", image: sourceBytes });
            } else if (brand?.productImageUrl) {
              content.push({ type: "image", image: await fetchBytes(brand.productImageUrl) });
            }
```

and make the system checklist depend on the mode. Replace the first two lines of the `system` array with:

```ts
                mode === "edit"
                  ? "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad, produced by editing the second image (the source) while protecting the product region."
                  : "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the second, when present, is the advertiser's real product photo.",
                "Checklist (all must hold for pass = true):",
                mode === "edit" && keepRegion
                  ? `- The product inside the protected region (${Math.round(keepRegion.x * 100)}% to ${Math.round((keepRegion.x + keepRegion.w) * 100)}% across, ${Math.round(keepRegion.y * 100)}% to ${Math.round((keepRegion.y + keepRegion.h) * 100)}% down) matches the source pixel-for-pixel; if any part of the product was cut off or altered, say so and name which edge.`
                  : "- The product matches the product photo in shape, openings, material, and markings; no invented logos or text on it.",
```

keeping the remaining checklist lines as they are.

- [ ] **Step 5: Verify**

Run: `bun run typecheck` and `bun run lint`. Expected: clean.

Then a live run against the local setup (both servers, the local storage mode, and the "Testing Ads" org from the earlier session): trigger a variation on the R3 test creative and check that the run's `steps` metadata includes `locating the product in the source` and `editing source (attempt 1)`, that the stored attempt has `mode: "edit"` with a `keepRegion`, and, by viewing the output, that the mouthguard is unchanged from the source. If the locator returns `null` for that source, inspect its `note` by logging it once at `logger.info` level and adjust the system prompt wording; do not loosen the confidence threshold below 0.4.

- [ ] **Step 6: Commit**

```bash
git add trigger/generate-variation.ts
git commit -m "feat(studio): generate variations as masked edits that keep the source product"
```

---

### Task 4: Card shows the kept product

**Files:**
- Modify: `src/components/blocks/creatives/creative-variations-tab.tsx`

- [ ] **Step 1: Show the region in the plan disclosure**

In `PlanDisclosure`, after the `summary` paragraph, add:

```tsx
        {plan.keptProductRegion ? (
          <p className="text-muted-foreground">Product kept from the source (masked edit).</p>
        ) : null}
```

- [ ] **Step 2: Verify and commit**

Run: `bun run typecheck && bun run lint`. Expected: clean.

```bash
git add src/components/blocks/creatives/creative-variations-tab.tsx
git commit -m "feat(creatives): say when a variation kept the source product"
```

---

### Task 6: Paste the source region back (pure, sharp)

Added after the first live run: the provider re-renders the masked region, so
preservation is done here (addendum §7).

**Files:**
- Modify: `package.json` (`sharp` becomes a direct dependency), `trigger.config.ts`
- Create: `src/lib/image-composite.ts`
- Test: `src/lib/image-composite.test.ts`

- [ ] **Step 1: Dependency and Trigger build config**

Run: `bun add sharp@0.34.5` (the version already installed transitively). In `trigger.config.ts` add `build: { external: ["sharp"] }` to the `defineConfig` object so the native module is not bundled.

- [ ] **Step 2: Write the failing tests**

```ts
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodePng } from "./image-mask";
import { pasteSourceRegion } from "./image-composite";

function solid(width: number, height: number, rgb: [number, number, number], patch?: { box: [number, number, number, number]; rgb: [number, number, number] }) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inPatch = patch && x >= patch.box[0] && x < patch.box[0] + patch.box[2] && y >= patch.box[1] && y < patch.box[1] + patch.box[3];
      const c = inPatch ? patch.rgb : rgb;
      rgba.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return encodePng(width, height, rgba);
}

async function pixel(png: Uint8Array, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe("pasteSourceRegion", () => {
  it("pastes the source's region over the output at the same normalized box, scaled to the output", async () => {
    // 40x40 blue source with a red 20x20 block at (10,10); 20x20 green output.
    const source = solid(40, 40, [0, 0, 255], { box: [10, 10, 20, 20], rgb: [255, 0, 0] });
    const output = solid(20, 20, [0, 255, 0]);
    const { bytes, box } = await pasteSourceRegion({ source, output, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
    expect(box).toEqual({ left: 5, top: 5, width: 10, height: 10 });
    expect(await pixel(bytes, 10, 10)).toEqual([255, 0, 0]); // inside: red from the source
    expect(await pixel(bytes, 2, 2)).toEqual([0, 255, 0]); // outside: untouched output
    expect(await pixel(bytes, 14, 14)).toEqual([255, 0, 0]);
    expect(await pixel(bytes, 15, 15)).toEqual([0, 255, 0]);
    const meta = await sharp(bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([20, 20, "png"]);
  });

  it("clamps an out-of-range region and rejects an empty one", async () => {
    const source = solid(10, 10, [0, 0, 255]);
    const output = solid(10, 10, [0, 255, 0]);
    const { box } = await pasteSourceRegion({ source, output, region: { x: 0.8, y: 0.8, w: 1, h: 1 } });
    expect(box).toEqual({ left: 8, top: 8, width: 2, height: 2 });
    await expect(pasteSourceRegion({ source, output, region: { x: 2, y: 2, w: 0.1, h: 0.1 } })).rejects.toThrow(/empty/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun run test -- src/lib/image-composite.test.ts`
Expected: FAIL, cannot resolve `./image-composite`.

- [ ] **Step 4: Implement** `src/lib/image-composite.ts`:

```ts
// Puts the source's product back into an edited output. The image model treats
// an edit mask as guidance and re-renders the whole canvas at a preset size,
// so the only way to guarantee the product is to copy the source's region over
// the output ourselves, scaled to the output's pixel size.

import sharp from "sharp";
import { clampRegion, type ProductRegion } from "@/lib/image-mask";

export type PasteBox = { left: number; top: number; width: number; height: number };

function pixelBox(region: ProductRegion, width: number, height: number): PasteBox {
  const left = Math.round(region.x * width);
  const top = Math.round(region.y * height);
  const right = Math.round((region.x + region.w) * width);
  const bottom = Math.round((region.y + region.h) * height);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Extracts `region` from `source`, resizes it to the same normalized box in
 * `output`'s pixel size, composites it there, and returns PNG bytes plus the
 * box it landed in. The region is clamped to the canvas first; an empty box
 * throws so the caller never ships an output that silently kept nothing.
 */
export async function pasteSourceRegion(input: {
  source: Uint8Array;
  output: Uint8Array;
  region: ProductRegion;
}): Promise<{ bytes: Uint8Array; box: PasteBox }> {
  const region = clampRegion(input.region);
  const [sourceMeta, outputMeta] = await Promise.all([
    sharp(input.source).metadata(),
    sharp(input.output).metadata(),
  ]);
  if (!sourceMeta.width || !sourceMeta.height || !outputMeta.width || !outputMeta.height) {
    throw new Error("pasteSourceRegion: could not read image dimensions");
  }
  const from = pixelBox(region, sourceMeta.width, sourceMeta.height);
  const to = pixelBox(region, outputMeta.width, outputMeta.height);
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) {
    throw new Error("pasteSourceRegion: the region is empty after clamping");
  }
  const patch = await sharp(input.source)
    .extract(from)
    .resize(to.width, to.height, { fit: "fill" })
    .png()
    .toBuffer();
  const bytes = await sharp(input.output)
    .composite([{ input: patch, left: to.left, top: to.top }])
    .png()
    .toBuffer();
  return { bytes: new Uint8Array(bytes), box: to };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun run test -- src/lib/image-composite.test.ts`
Expected: PASS (2 tests). Then `bun run typecheck`, `bun run lint`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock trigger.config.ts src/lib/image-composite.ts src/lib/image-composite.test.ts
git commit -m "feat(studio): paste the source product back over an edited variation"
```

---

### Task 7: Wire the paste, fix the premise, harden the locator

**Files:**
- Modify: `trigger/generate-variation.ts`
- Modify: `src/lib/variation-agent.ts` (one prompt sentence) and its test if the sentence is asserted

- [ ] **Step 1: Paste in `produceImage`**

Import `pasteSourceRegion` from `@/lib/image-composite` and `clampRegion` from `@/lib/image-mask` (keep `buildKeepMask`, drop `productRegionSchema` once Step 3 lands). After `generateImage` returns and before `putStudioObject`:

```ts
          // The mask is guidance only: the provider regenerates the whole
          // canvas at `size` and re-renders the product. Paste the source's
          // region back so the product is preserved by construction, and store
          // and review those bytes.
          const produced =
            mode === "edit" && keepRegion && sourceDimensions
              ? (await pasteSourceRegion({ source: sourceBytes, output: result.image.uint8Array, region: keepRegion })).bytes
              : result.image.uint8Array;
```

and use `produced` for `putStudioObject` and `imageBytes.set`. Replace the edit-branch comment above `prompt: { images, mask, text }` with: `// references holds only the source in edit mode. The mask holds composition and placement; preservation happens in the paste below.`

- [ ] **Step 2: Paste-aware review line**

Replace the edit-mode fidelity line with:

```ts
                mode === "edit" && keepRegion
                  ? `- The product from the source has been pasted back into its box (${Math.round(keepRegion.x * 100)}% to ${Math.round((keepRegion.x + keepRegion.w) * 100)}% across, ${Math.round(keepRegion.y * 100)}% to ${Math.round((keepRegion.y + keepRegion.h) * 100)}% down). Check four things: its lighting, colour temperature, and perspective sit naturally against the new background; there is no visible rectangular seam or halo at the box edge; no second, re-rendered copy of the product appears anywhere outside the box; and the box does not cover copy or a focal element the prompt asked for. Name which of these failed.`
                  : "- The product matches the product photo in shape, openings, material, and markings; no invented logos or text on it.",
```

- [ ] **Step 3: Locator hardening**

Make the locator schema permissive and clamp in the task, with an area guard:

```ts
// The locator's own schema is permissive: a box that overshoots by a rounding
// hair should be clamped, not thrown away with the whole edit path.
const productLocationSchema = z.object({
  product: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});
```

and in `locateSourceProduct` after the call:

```ts
    const { product, confidence, note } = result.object;
    const region = product ? clampRegion(product) : null;
    const area = region ? region.w * region.h : 0;
    // Too small is noise; too large leaves the variation nothing to change.
    const usable = region !== null && confidence >= 0.4 && area >= 0.005 && area <= 0.7;
    logger.info("Product locator", { found: Boolean(product), confidence, area, usable, note });
    return usable ? region : null;
```

Also, before the `generateImage` call in `produceImage`, make the silent fallback audible:

```ts
          if (mode === "edit" && !sourceDimensions) {
            logger.warn("Edit mode without source dimensions; falling back to an unmasked call", { attempt });
          }
```

Move `LOCATOR_MODEL` up beside `AGENT_MODEL`/`REVIEW_MODEL`.

- [ ] **Step 4: Prompt premise**

In `src/lib/variation-agent.ts`'s EDIT MODE block replace `holds the product and is kept pixel-for-pixel, and everything outside that box is redrawn from your prompt alone` with `holds the product; after the edit the source's pixels for that box are pasted back, so the product is preserved exactly, and everything outside that box is redrawn from your prompt alone`. Update any test asserting the old phrase.

- [ ] **Step 5: Verify**

`bun run typecheck`, `bun run lint`, `bun run test -- src/lib/variation-agent.test.ts src/lib/image-mask.test.ts src/lib/image-composite.test.ts`. Then the live check from Task 3 Step 5 again: the product in the output must be the source's product (compare visually), the review should pass or name a seam, and `attempts[n].mode === "edit"`.

- [ ] **Step 6: Commit**

```bash
git add trigger/generate-variation.ts src/lib/variation-agent.ts src/lib/variation-agent.test.ts
git commit -m "feat(studio): preserve the source product by pasting it over the edited variation"
```

---

### Task 5: Full verification and docs (runs last)

- [ ] **Step 1:** `bun run typecheck && bun run lint && bun run test`. Expected: all green (Postgres-backed suites need the local database, which is up).

- [ ] **Step 2:** Append to the design spec `docs/superpowers/specs/2026-09-03-static-ad-variations-design.md`, under "Open items deferred", a pointer: `- Product compositing for variations: see 2026-09-04-variation-product-compositing-design.md (implemented).` Commit as `docs(studio): link the compositing addendum from the variations design`.

---

## Self-review against the addendum

- §1 locator: Task 3 step 1-2 (schema, confidence floor, packaging rule, creative-only, skipped on retry-without-image, region stored on the input and shown in the plan via Task 2's `finish` stamp and Task 4).
- §2 mask: Task 1 (PNG writer, 3% margin, clamp, null region, inverted polarity for Phase 2).
- §3 mode: Task 2 (default edit when available, explicit override, unavailable error before spending an attempt, source-only references in edit mode, product photo not attached, system prompt explanation with the region in words; step labels).
- §4 review: Task 3 step 4 (source attached in edit mode, region-specific fidelity line; the agent can widen via `keepRegion` in Task 2).
- §5 retry without image: `useSourceLayout: false` disables edit availability (Task 2 helper) and the locator is skipped (Task 3).
- §6 out of scope: competitor sources are excluded by `editModeAvailable`.
- Testing section: Task 1 and Task 2 cover the listed pure cases; router unchanged; task untested directly.
