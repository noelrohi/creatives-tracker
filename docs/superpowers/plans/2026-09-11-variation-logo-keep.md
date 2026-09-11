# Variation Logo Keep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every variation carry the advertiser's real logo as pixels instead of the image model's redraw of it, failing the run rather than shipping a mark-less ad.

**Architecture:** A keep-list of preserved regions, with the logo as its only entry, resolved before the agent runs the way the product patch already is. Logo pixels come from the brand's uploaded logo asset (lockup-verified against the source) or a cut from the advertiser's own source ad. The prompt forbids the model drawing any mark; at paste time a pure placement chooser picks the target box, and a feather-only composite stamps the mark without touching its colours.

**Tech Stack:** TypeScript, Trigger.dev v4, AI SDK (`generateObject` on `gpt-5.6-terra`, `experimental_generateImage` on `gpt-image-2`), sharp, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-11-variation-logo-keep-design.md`

## Global Constraints

- Branch `feat/variation-logo-keep`, based on `origin/main`. Conventional-commit **titles only** — no body, NO trailers of any kind (no `Co-Authored-By`).
- Run tests with `npm run test` (never `bun test`); typecheck with `npx tsc --noEmit`; lint touched files with `npx eslint <files>`. Never stage `.gitignore`.
- The logo's composite is **feather only**: no colour cast, no contact shadow. The product transplant's blending is untouched.
- Scale cap: a pasted mark may not exceed `1.25×` the width it had in the source.
- Safe-area insets, normalized: `0.06` on all edges, except a format taller than 1:1, which reserves `0.12` top and bottom for the platform's own chrome. `StudioFormat` admits arbitrary `WxH` strings as well as the named presets, so the insets are resolved by a function, never a `Record` over the union.
- Contrast floor `3.0`; minimum mark width `0.04` of canvas.
- A source cut is forbidden unless `source.kind === "creative"` and the run is not a rebrand.
- A located source mark with no obtainable logo fails the run with reason `logo_unavailable`; a source with no mark proceeds normally.
- In rebrand mode the advertiser's asset is placed and the source's mark is never reused.

## File Structure

**Pure modules (new)**
- Create `src/lib/logo-placement.ts` — safe areas, collision, the placement chooser, the scale cap, contrast maths. No IO.
- Create `src/lib/logo-placement.test.ts`.
- Create `src/lib/logo-match.ts` — the lockup-check prompt and its per-feature verdict reducer (mirrors `product-match.ts`). No IO.
- Create `src/lib/logo-match.test.ts`.

**Existing modules (modified)**
- Modify `src/lib/variation-agent-types.ts` — `VariationKeep`, `VariationKeepKind`, plan and attempt fields.
- Modify `src/lib/image-composite.ts` — `pasteLogo`, `feather`, `ringContrast`.
- Modify `src/lib/image-composite.test.ts`.
- Modify `src/lib/variation-agent.ts` — run-input field, the logo prompt clause, `logo_unavailable`, review input.
- Modify `src/lib/variation-agent.test.ts`.
- Modify `trigger/generate-variation.ts` — `locateMarks`, `resolveLogoPatch`, the paste inside `produceImage`, the review block, persistence.
- Modify `src/components/blocks/creatives/creative-variations-tab.tsx` — the card line.

---

### Task 1: Keep types and the placement chooser

**Files:**
- Modify: `src/lib/variation-agent-types.ts`
- Create: `src/lib/logo-placement.ts`, `src/lib/logo-placement.test.ts`

**Interfaces:**
- Produces:

```ts
// variation-agent-types.ts
export type VariationKeepKind = "logo";
export type KeepPlacement = "drawn" | "source_position" | "anchor";
export type VariationKeep = {
  kind: VariationKeepKind;
  patchSource: "asset" | "source";
  assetImageId: string | null;
  from: ProductRegion;
  to: ProductRegion;
  placement: KeepPlacement;
  contrast: { ratio: number; variant: "light" | "dark" | "only" };
};

// logo-placement.ts
export type SafeArea = { top: number; right: number; bottom: number; left: number };
export function safeAreaFor(format: StudioFormat): SafeArea;
export const LOGO_SCALE_CAP = 1.25;
export const LOGO_MIN_WIDTH = 0.04;
export const LOGO_CONTRAST_FLOOR = 3;
export function insideSafeArea(box: ProductRegion, format: StudioFormat): boolean;
export function overlaps(a: ProductRegion, b: ProductRegion): boolean;
export function relativeLuminance(rgb: [number, number, number]): number;
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number;
export function chooseLogoPlacement(input: {
  drawn: ProductRegion | null;
  sourceBox: ProductRegion;
  copyRegions: ProductRegion[];
  format: StudioFormat;
}): { box: ProductRegion; placement: KeepPlacement } | null;
```

- [ ] **Step 1: Write the failing placement tests**

`src/lib/logo-placement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  chooseLogoPlacement,
  contrastRatio,
  insideSafeArea,
  overlaps,
  relativeLuminance,
  safeAreaFor,
} from "./logo-placement";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("safeAreaFor", () => {
  it("reserves a deeper band top and bottom on anything taller than square", () => {
    expect(safeAreaFor("square")).toEqual({ top: 0.06, right: 0.06, bottom: 0.06, left: 0.06 });
    expect(safeAreaFor("portrait")).toEqual({ top: 0.12, right: 0.06, bottom: 0.12, left: 0.06 });
    // StudioFormat also admits raw sizes; those classify by aspect, not by name.
    expect(safeAreaFor("1024x1536")).toEqual(safeAreaFor("portrait"));
    expect(safeAreaFor("1536x1024")).toEqual(safeAreaFor("square"));
  });
});

describe("insideSafeArea", () => {
  it("keeps a mark clear of the platform's own UI bands", () => {
    expect(insideSafeArea(box(0.07, 0.07, 0.2, 0.08), "square")).toBe(true);
    expect(insideSafeArea(box(0.02, 0.07, 0.2, 0.08), "square")).toBe(false);
    // Portrait reserves 12% top and bottom for the platform's chrome.
    expect(insideSafeArea(box(0.07, 0.08, 0.2, 0.08), "portrait")).toBe(false);
    expect(insideSafeArea(box(0.07, 0.13, 0.2, 0.08), "portrait")).toBe(true);
    expect(insideSafeArea(box(0.07, 0.84, 0.2, 0.08), "portrait")).toBe(false);
  });
});

describe("overlaps", () => {
  it("is true only when the rectangles actually intersect", () => {
    expect(overlaps(box(0.1, 0.1, 0.2, 0.2), box(0.25, 0.25, 0.2, 0.2))).toBe(true);
    expect(overlaps(box(0.1, 0.1, 0.2, 0.2), box(0.31, 0.1, 0.2, 0.2))).toBe(false);
    // Edge contact is not an overlap.
    expect(overlaps(box(0.1, 0.1, 0.2, 0.2), box(0.3, 0.1, 0.2, 0.2))).toBe(false);
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG extremes", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 1);
    expect(contrastRatio([128, 128, 128], [128, 128, 128])).toBeCloseTo(1, 5);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
  });
});

describe("chooseLogoPlacement", () => {
  const sourceBox = box(0.06, 0.06, 0.2, 0.08);

  it("covers a drawn mark, because leaving it would ship two logos", () => {
    const drawn = box(0.7, 0.8, 0.22, 0.09);
    expect(chooseLogoPlacement({ drawn, sourceBox, copyRegions: [], format: "square" })).toEqual({
      box: drawn,
      placement: "drawn",
    });
  });

  it("reuses the source's own position when the new layout still fits it", () => {
    expect(
      chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [box(0.1, 0.5, 0.8, 0.2)], format: "square" }),
    ).toEqual({ box: sourceBox, placement: "source_position" });
  });

  it("moves to an anchor when the source's position now collides with copy", () => {
    const result = chooseLogoPlacement({
      drawn: null,
      sourceBox,
      copyRegions: [box(0.04, 0.04, 0.5, 0.2)],
      format: "square",
    });
    expect(result?.placement).toBe("anchor");
    expect(overlaps(result!.box, box(0.04, 0.04, 0.5, 0.2))).toBe(false);
    expect(insideSafeArea(result!.box, "square")).toBe(true);
  });

  it("moves to an anchor when the source's position falls outside the new format's safe area", () => {
    // A square source mark at 6% down lands inside portrait's 12% top band.
    const result = chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [], format: "portrait" });
    expect(result?.placement).toBe("anchor");
    expect(insideSafeArea(result!.box, "portrait")).toBe(true);
  });

  it("keeps the mark's size and aspect whichever rule chose the box", () => {
    const result = chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [box(0.04, 0.04, 0.5, 0.2)], format: "square" });
    expect(result!.box.w).toBeCloseTo(sourceBox.w, 5);
    expect(result!.box.h).toBeCloseTo(sourceBox.h, 5);
  });

  it("gives up when every corner is taken", () => {
    // Copy covering the whole safe area leaves nowhere legal to sit.
    expect(
      chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [box(0, 0, 1, 1)], format: "square" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/logo-placement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `logo-placement.ts`**

```ts
// Where a preserved brand mark may sit in a generated variation. Pure: the
// locator and the compositor supply boxes, this module only decides.
import type { ProductRegion } from "@/lib/image-mask";
import { clampRegion } from "@/lib/image-mask";
import { STUDIO_FORMATS, type StudioFormat } from "@/lib/studio-prompt";
import type { KeepPlacement } from "@/lib/variation-agent-types";

export type SafeArea = { top: number; right: number; bottom: number; left: number };

const SIDE_INSET = 0.06;
/** A feed's own chrome sits over the top and bottom of anything taller than square. */
const TALL_BAND = 0.12;

/**
 * Normalized insets the mark must stay inside, resolved by aspect rather than
 * by name: `StudioFormat` admits raw "WxH" strings as well as the presets, so
 * a lookup table over the union would not compile and would miss those sizes.
 */
export function safeAreaFor(format: StudioFormat): SafeArea {
  const size = (STUDIO_FORMATS as Record<string, string>)[format] ?? format;
  const match = /^(\d+)x(\d+)$/.exec(size);
  const tall = match ? Number(match[2]) > Number(match[1]) : false;
  return {
    top: tall ? TALL_BAND : SIDE_INSET,
    right: SIDE_INSET,
    bottom: tall ? TALL_BAND : SIDE_INSET,
    left: SIDE_INSET,
  };
}

/** A pasted mark may not exceed this multiple of the width it had in the source. */
export const LOGO_SCALE_CAP = 1.25;
/** Below this share of canvas width a mark is not legible at feed size. */
export const LOGO_MIN_WIDTH = 0.04;
/** WCAG-style ratio the mark must reach against the background behind it. */
export const LOGO_CONTRAST_FLOOR = 3;

export function insideSafeArea(box: ProductRegion, format: StudioFormat): boolean {
  const safe = safeAreaFor(format);
  return (
    box.x >= safe.left &&
    box.y >= safe.top &&
    box.x + box.w <= 1 - safe.right &&
    box.y + box.h <= 1 - safe.bottom
  );
}

export function overlaps(a: ProductRegion, b: ProductRegion): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** sRGB relative luminance, the WCAG definition. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The four corners of the safe area, as boxes of `size`, nearest-first from `from`. */
function corners(size: { w: number; h: number }, format: StudioFormat, from: ProductRegion): ProductRegion[] {
  const safe = safeAreaFor(format);
  const left = safe.left;
  const right = 1 - safe.right - size.w;
  const top = safe.top;
  const bottom = 1 - safe.bottom - size.h;
  const candidates = [
    { x: left, y: top, w: size.w, h: size.h },
    { x: right, y: top, w: size.w, h: size.h },
    { x: left, y: bottom, w: size.w, h: size.h },
    { x: right, y: bottom, w: size.w, h: size.h },
  ];
  const distance = (box: ProductRegion) =>
    (box.x - from.x) ** 2 + (box.y - from.y) ** 2;
  return candidates.sort((a, b) => distance(a) - distance(b));
}

/**
 * Picks where the real mark goes, in this order: over a mark the model drew
 * anyway (it must be covered, or the ad ships two logos); the source's own
 * position when the new layout still admits it, so the variation reads as a
 * sibling of its source; otherwise the nearest safe-area corner that clears
 * the copy. Null when nothing legal is left, which the caller treats as a
 * failed run rather than a bad paste.
 */
export function chooseLogoPlacement(input: {
  drawn: ProductRegion | null;
  sourceBox: ProductRegion;
  copyRegions: ProductRegion[];
  format: StudioFormat;
}): { box: ProductRegion; placement: KeepPlacement } | null {
  if (input.drawn) return { box: clampRegion(input.drawn), placement: "drawn" };
  const size = { w: input.sourceBox.w, h: input.sourceBox.h };
  const clear = (box: ProductRegion) =>
    insideSafeArea(box, input.format) && !input.copyRegions.some((copy) => overlaps(box, copy));
  if (clear(input.sourceBox)) {
    return { box: clampRegion(input.sourceBox), placement: "source_position" };
  }
  const anchor = corners(size, input.format, input.sourceBox).find(clear);
  return anchor ? { box: clampRegion(anchor), placement: "anchor" } : null;
}
```

If `StudioFormat` is not exported from `@/lib/studio-format`, find its module with `grep -rn "export type StudioFormat" src/lib` and import from there.

- [ ] **Step 4: Add the keep types**

In `src/lib/variation-agent-types.ts`, after `VariationTransplant`:

```ts
export type VariationKeepKind = "logo";
/** Which rule chose the box: a mark the model drew, the source's own position, or a safe-area corner. */
export type KeepPlacement = "drawn" | "source_position" | "anchor";

/** A preserved region pasted back into a generated variation. The logo is the only kind today. */
export type VariationKeep = {
  kind: VariationKeepKind;
  /** Where the pixels came from: the brand's logo asset, or a cut of the source ad. */
  patchSource: "asset" | "source";
  /** The context image the asset came from, when `patchSource` is "asset". */
  assetImageId: string | null;
  /** The mark's box in whatever image it was cut from. */
  from: ProductRegion;
  /** The output box it landed in. */
  to: ProductRegion;
  placement: KeepPlacement;
  /** Measured contrast against the background behind `to`, and which asset variant was used. */
  contrast: { ratio: number; variant: "light" | "dark" | "only" };
};
```

Add to `VariationAttempt`: `/** The brand marks pasted into this attempt. */ keeps?: VariationKeep[] | null;` and to `VariationPlan`: `/** Set by the core on finish: the marks preserved in the shipped attempt. */ keptMarks?: VariationKeep[] | null;`.

- [ ] **Step 5: Run, typecheck, commit**

Run: `npm run test -- --run src/lib/logo-placement.test.ts && npx tsc --noEmit && npx eslint src/lib/logo-placement.ts src/lib/logo-placement.test.ts src/lib/variation-agent-types.ts`
Expected: PASS, clean.

```bash
git add src/lib/logo-placement.ts src/lib/logo-placement.test.ts src/lib/variation-agent-types.ts
git commit -m "feat(studio): decide where a preserved brand mark may sit"
```

---

### Task 2: The lockup check

**Files:**
- Create: `src/lib/logo-match.ts`, `src/lib/logo-match.test.ts`

**Interfaces:**
- Produces:

```ts
export const logoMatchSchema: z.ZodType<LogoMatch>;
export type LogoMatch = {
  wordmark: "same" | "different" | "absent_in_both";
  icon: "same" | "different" | "absent_in_both";
  orientation: "same" | "different";
  colourway: "same" | "different";
  note: string;
};
export function buildLogoMatchPrompt(brandName: string | null): string;
export function assetIsSameLockup(result: LogoMatch): boolean;
```

- [ ] **Step 1: Write the failing tests**

`src/lib/logo-match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assetIsSameLockup, buildLogoMatchPrompt, logoMatchSchema } from "./logo-match";

const verdict = (over: Partial<Parameters<typeof assetIsSameLockup>[0]> = {}) => ({
  wordmark: "same" as const,
  icon: "same" as const,
  orientation: "same" as const,
  colourway: "same" as const,
  note: "",
  ...over,
});

describe("assetIsSameLockup", () => {
  it("accepts the asset when the wordmark and icon composition agree", () => {
    expect(assetIsSameLockup(verdict())).toBe(true);
    expect(assetIsSameLockup(verdict({ wordmark: "absent_in_both", icon: "same" }))).toBe(true);
  });

  it("accepts a variant that differs only in orientation or colourway", () => {
    // Those are exactly the variants the contrast step chooses between, so
    // they must not disqualify the asset.
    expect(assetIsSameLockup(verdict({ orientation: "different" }))).toBe(true);
    expect(assetIsSameLockup(verdict({ colourway: "different" }))).toBe(true);
  });

  it("rejects a different mark", () => {
    expect(assetIsSameLockup(verdict({ wordmark: "different" }))).toBe(false);
    expect(assetIsSameLockup(verdict({ icon: "different" }))).toBe(false);
  });

  it("rejects a lockup that drops an element the source shows", () => {
    expect(assetIsSameLockup(verdict({ icon: "absent_in_both", wordmark: "same" }))).toBe(true);
  });
});

describe("buildLogoMatchPrompt", () => {
  it("asks for each feature separately rather than one similarity score", () => {
    const prompt = buildLogoMatchPrompt("Reviv");
    expect(prompt).toContain("Reviv");
    for (const feature of ["wordmark", "icon", "orientation", "colourway"]) {
      expect(prompt).toContain(feature);
    }
    expect(prompt.toLowerCase()).not.toContain("confidence");
  });
});

describe("logoMatchSchema", () => {
  it("rejects an unknown verdict", () => {
    expect(logoMatchSchema.safeParse({ ...verdict(), wordmark: "maybe" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/logo-match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `logo-match.ts`**

```ts
// Decides whether the brand's uploaded logo asset is the same lockup as the
// mark in the source ad. Per feature rather than one similarity score: a
// single number confidently rates the wrong mark as close. Pure: the vision
// call lives in the trigger.
import { z } from "zod";

const agreement = z.enum(["same", "different", "absent_in_both"]);

export const logoMatchSchema = z.object({
  wordmark: agreement.describe("The brand name set as type."),
  icon: agreement.describe("The symbol, monogram, or emblem, if any."),
  orientation: z.enum(["same", "different"]).describe("Horizontal lockup versus stacked."),
  colourway: z.enum(["same", "different"]).describe("Full colour, mono, reversed."),
  note: z.string(),
});

export type LogoMatch = z.infer<typeof logoMatchSchema>;

export function buildLogoMatchPrompt(brandName: string | null) {
  return [
    `Image 1 is a crop of the brand mark from an existing ad${brandName ? ` for ${brandName}` : ""}. Image 2 is the brand's uploaded logo file.`,
    "Compare them feature by feature and answer each separately.",
    "wordmark: does image 2 set the same brand name in the same typeface as image 1? absent_in_both when neither shows type.",
    "icon: does image 2 show the same symbol, monogram, or emblem? absent_in_both when neither shows one.",
    "orientation: same when both are laid out the same way (both horizontal, or both stacked), different otherwise.",
    "colourway: same when both use the same colours, different for a mono, reversed, or recoloured version of the same mark.",
    "note: one sentence on anything that would make a designer call these different marks.",
  ].join("\n");
}

/**
 * The asset stands in for the source's mark when the wordmark and the icon
 * agree. Orientation and colourway may differ: those are the variants the
 * contrast step chooses between, and disqualifying them would reject a brand's
 * own reversed logo.
 */
export function assetIsSameLockup(result: LogoMatch): boolean {
  return result.wordmark !== "different" && result.icon !== "different";
}
```

- [ ] **Step 4: Run and commit**

Run: `npm run test -- --run src/lib/logo-match.test.ts && npx tsc --noEmit && npx eslint src/lib/logo-match.ts src/lib/logo-match.test.ts`
Expected: PASS, clean.

```bash
git add src/lib/logo-match.ts src/lib/logo-match.test.ts
git commit -m "feat(studio): compare a logo asset to the source mark feature by feature"
```

---

### Task 3: The logo composite

**Files:**
- Modify: `src/lib/image-composite.ts`
- Modify: `src/lib/image-composite.test.ts`

**Interfaces:**
- Consumes: Task 1 `contrastRatio`, `LOGO_SCALE_CAP`.
- Produces:

```ts
export async function ringLuminance(output: Uint8Array, region: ProductRegion): Promise<[number, number, number]>;
export async function pasteLogo(input: {
  output: Uint8Array;
  patch: Uint8Array;
  region: ProductRegion;
  /** The mark's width in the source, normalized; the paste is capped at 1.25x it. */
  sourceWidth: number;
}): Promise<{ bytes: Uint8Array; box: PasteBox; contrast: number }>;
```

- [ ] **Step 1: Write the failing composite tests**

Append to `src/lib/image-composite.test.ts`:

```ts
describe("pasteLogo", () => {
  it("keeps the mark's own colours: no cast toward the scene", async () => {
    // A pure red mark pasted onto a deep blue canvas must stay red. The
    // product path would drag it toward the blue; a brand mark may not move.
    const output = solid(40, 40, [0, 0, 200]);
    const patch = solid(10, 10, [255, 0, 0]);
    const { bytes } = await pasteLogo({
      output,
      patch,
      region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      sourceWidth: 0.5,
    });
    const [r, g, b] = await pixel(bytes, 20, 20);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(15);
    expect(b).toBeLessThan(15);
  });

  it("composites no contact shadow under the mark", async () => {
    // The row just below the paste box stays the canvas colour; the product
    // path would darken it with an ellipse.
    const output = solid(40, 40, [255, 255, 255]);
    const patch = solid(10, 10, [0, 0, 0]);
    const { bytes, box } = await pasteLogo({
      output,
      patch,
      region: { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
      sourceWidth: 0.25,
    });
    const below = await pixel(bytes, box.left + Math.floor(box.width / 2), box.top + box.height + 2);
    expect(below[0]).toBeGreaterThan(250);
    expect(below[1]).toBeGreaterThan(250);
    expect(below[2]).toBeGreaterThan(250);
  });

  it("caps the paste at 1.25x the mark's source width", async () => {
    // A generous drawn box must not inflate the mark.
    const output = solid(100, 100, [255, 255, 255]);
    const patch = solid(10, 10, [0, 0, 0]);
    const { box } = await pasteLogo({
      output,
      patch,
      region: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      sourceWidth: 0.2,
    });
    expect(box.width).toBeLessThanOrEqual(Math.round(0.2 * 1.25 * 100));
  });

  it("reports the contrast between the mark and the background it landed on", async () => {
    const dark = solid(40, 40, [0, 0, 0]);
    const light = solid(40, 40, [255, 255, 255]);
    const white = solid(10, 10, [255, 255, 255]);
    const onDark = await pasteLogo({ output: dark, patch: white, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, sourceWidth: 0.5 });
    const onLight = await pasteLogo({ output: light, patch: white, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, sourceWidth: 0.5 });
    expect(onDark.contrast).toBeGreaterThan(10);
    expect(onLight.contrast).toBeLessThan(1.5);
  });
});
```

Add `pasteLogo` to the file's import from `./image-composite`.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/image-composite.test.ts`
Expected: FAIL — `pasteLogo` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/image-composite.ts`, export a luminance helper built on the existing `ringMean` (rename nothing; add a thin wrapper that opens the bytes), and add:

```ts
/** How far the mark's alpha edge is softened, relative to its pasted width. */
const LOGO_FEATHER = 0.004;

/**
 * Stamps a brand mark into the output. Unlike the product transplant this
 * applies no colour cast and no contact shadow: a logo is flat art, not a lit
 * object, and casting its colours toward the scene would corrupt the brand's
 * own palette. The only softening is a sub-pixel alpha feather so the paste
 * does not read as a hard cut; a transparent PNG asset already carries its
 * own edge and gains almost nothing from it.
 *
 * Returns the measured contrast between the mark and the ring of output
 * around it, which the caller compares against the legibility floor.
 */
export async function pasteLogo(input: {
  output: Uint8Array;
  patch: Uint8Array;
  region: ProductRegion;
  sourceWidth: number;
}): Promise<{ bytes: Uint8Array; box: PasteBox; contrast: number }> {
  // Fit uniformly into the region, then cap at 1.25x the source width, the
  // same guard the product uses so a generous box cannot inflate the mark.
  // Feather via a blurred alpha channel, composite, then sample the ring for
  // contrast using the already-present ringMean and the WCAG ratio.
}
```

Implementation notes for the body: read the output's metadata for its pixel size; `pixelBox(region, …)`; `fitBox(patchBox, targetBox)`; `capWidth(fitted, targetBox, Math.round(input.sourceWidth * LOGO_SCALE_CAP * width))`; build the feathered patch by `ensureAlpha().blur(Math.max(0.3, LOGO_FEATHER * fitted.width))` applied to the alpha channel only (extract, blur, rejoin) or, when that proves awkward with sharp, by compositing the resized patch onto a transparent canvas and blurring that canvas's alpha; composite with no `linear` call and no shadow overlay; then `ringMean(sharp(bytes), size, box)` for the background and `patchMean(sharp(patch))` for the mark, and `contrastRatio` from `@/lib/logo-placement`.

- [ ] **Step 4: Run and commit**

Run: `npm run test -- --run src/lib/image-composite.test.ts && npx tsc --noEmit && npx eslint src/lib/image-composite.ts src/lib/image-composite.test.ts`
Expected: PASS (13 existing plus 4 new), clean.

```bash
git add src/lib/image-composite.ts src/lib/image-composite.test.ts
git commit -m "feat(studio): stamp a brand mark without relighting it"
```

---

### Task 4: Locating marks and resolving the patch

**Files:**
- Modify: `trigger/generate-variation.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (module-local, not exported):

```ts
async function locateMarks(bytes, brandName, label: "source" | "output"): Promise<{ logo: ProductRegion | null; copy: ProductRegion[] } | null>;
async function resolveLogoPatch(input: {
  sourceBytes: Uint8Array;
  sourceMark: ProductRegion | null;
  sourceKind: "creative" | "competitor";
  rebrand: boolean;
  brandName: string | null;
  library: StudioContextLibrary;
}): Promise<
  | { kind: "none" }                                                   // the source had no mark
  | { kind: "unavailable" }                                            // it had one and we cannot honour it
  | { kind: "patch"; bytes: Uint8Array; from: ProductRegion; patchSource: "asset" | "source"; assetImageId: string | null; variants: Array<{ imageId: string; bytes: Uint8Array }> }
>;
```

- [ ] **Step 1: Add the mark locator**

Model it on `locateProduct`. One `generateObject` call on `LOCATOR_MODEL` with a schema of `{ logo: region | null, copy: region[], confidence, note }`. System prompt:

```
Locate the advertiser's own brand mark in this static ad.
logo: one normalized bounding box (x, y, w, h in 0-1 from the top-left) covering the logo, wordmark, or brand badge as tightly as you can. Exclude taglines, CTAs, and any product packaging that merely carries the mark. Null when no brand mark is visible.
copy: normalized boxes for every block of set text — headline, subhead, CTA, offer, price, legal disclaimer — so a pasted mark can avoid them. Empty when the ad has no text.
Ignore third-party marks, retailer logos, and platform badges: only the advertiser's own mark counts.
```

Gates, mirroring `locateProduct`: `confidence >= 0.4`; logo area between `0.0005` and `0.25` (a mark filling a quarter of the canvas is not a logo); clamp every region. Log the same shape as the product locator, with `label`.

- [ ] **Step 2: Add the sourcing ladder**

```ts
/**
 * The pixels that will stand in for the advertiser's mark, highest fidelity
 * first: the uploaded logo asset when it is the same lockup as the source's
 * mark, else a cut of the source ad, and only when that source is the
 * advertiser's own creative — cutting a competitor's ad copies their mark, and
 * cutting an AI-generated one copies a pseudo-logo.
 */
```

Body order:
1. `if (!input.sourceMark) return { kind: "none" }`.
2. Collect `library.images.filter((image) => image.kind === "logo")`. Fetch their bytes with the existing remote-image helper (`grep -n "fetchImageBytes\|remote-image" trigger/generate-variation.ts` for the name in use).
3. When at least one asset exists: crop the source mark (`cropRegion`, already in the file, upscaled to ≥512px), and run the lockup check on `[crop, assetBytes]` with `buildLogoMatchPrompt`/`logoMatchSchema`, taking the newest asset as the candidate. On `assetIsSameLockup`, prepare that asset: if it already has an alpha channel use it as-is; otherwise run it through `matteWithMargins`. Return `kind: "patch"` with `patchSource: "asset"`, `from` = the asset's own full box `{x:0,y:0,w:1,h:1}` when used whole or the matte's crop, and `variants` = every logo asset's bytes, for the contrast step.
4. Rebrand or a competitor source: skip step 5 entirely. `if (input.rebrand || input.sourceKind !== "creative") return { kind: "unavailable" }`.
5. Source cut: `matteWithMargins(sourceBytes, sourceMark)`. On success return `patchSource: "source"`. On failure return `{ kind: "unavailable" }` — a mark that will not cut cleanly is never pasted.

- [ ] **Step 3: Wire it into the run**

Beside the existing product resolution (around `generate-variation.ts:627-669`), add the mark locate and `resolveLogoPatch`. Pass a `logoKeep: { patchSource } | null` flag into the agent input alongside `productPatch`, and hold the resolved patch in the closure the way `productPatch` is held.

When the result is `kind: "unavailable"`, do not start the agent: mark the variant failed with reason `logo_unavailable` and return. This is the §8 rule, and failing before spending an image call is the cheap place to do it.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit && npx eslint trigger/generate-variation.ts`
Expected: clean. (This task adds no unit test of its own: it is IO wiring over units tested in Tasks 1–3, and the behaviours it introduces are covered by Task 6's agent tests.)

```bash
git add trigger/generate-variation.ts
git commit -m "feat(studio): resolve the real brand mark before a variation runs"
```

---

### Task 5: Pasting the mark into every attempt

**Files:**
- Modify: `trigger/generate-variation.ts` (`produceImage`)

- [ ] **Step 1: Paste after the product transplant**

Inside `produceImage`, after the product transplant block and before the return, when `mode === "generate"` and a logo patch exists:

1. `onStep(\`locating the brand mark in attempt ${attempt}\`)`, then `locateMarks(produced, brandName, "output")`.
2. `chooseLogoPlacement({ drawn: located?.logo ?? null, sourceBox: sourceMark, copyRegions: located?.copy ?? [], format })`.
3. When the chooser returns null, log and leave the image unpasted with `keeps: []`; Task 6 turns that into a failed review note rather than a silent ship.
4. Otherwise pick the variant: when `variants.length > 1`, paste each candidate's mean colour against the background ring and keep the higher `contrastRatio`; with one asset the variant is `"only"`.
5. `pasteLogo({ output: produced, patch, region: placement.box, sourceWidth: sourceMark.w })`, then record the `VariationKeep` with the measured contrast.
6. Every failure here is recoverable the way the product's is: log, keep the unpasted bytes, record no keep.

- [ ] **Step 2: Return the keeps**

Widen `produceImage`'s return to `{ imageUrl, transplant?, keeps?: VariationKeep[] }` in both `variation-agent.ts`'s `VariationRunDeps` and the trigger's implementation, and store `keeps` on the attempt.

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit && npx eslint trigger/generate-variation.ts src/lib/variation-agent.ts`
Expected: clean.

```bash
git add trigger/generate-variation.ts src/lib/variation-agent.ts
git commit -m "feat(studio): paste the real brand mark into every generated attempt"
```

---

### Task 6: Prompt, failure reason, review, and the card

**Files:**
- Modify: `src/lib/variation-agent.ts`, `src/lib/variation-agent.test.ts`
- Modify: `trigger/generate-variation.ts` (review prompt, persistence)
- Modify: `src/components/blocks/creatives/creative-variations-tab.tsx`

- [ ] **Step 1: Write the failing agent tests**

Append to `src/lib/variation-agent.test.ts` (follow the file's existing harness for building a run input and a fake deps object):

```ts
describe("logo keep", () => {
  it("forbids the model drawing a mark when a real one will be pasted", () => {
    const prompt = buildVariationSystemPrompt(runInput({ logoKeep: { patchSource: "asset" } }));
    expect(prompt).toContain("Do not draw a logo");
    expect(prompt).toContain("leave clear space");
  });

  it("says nothing about marks when the source had none", () => {
    const prompt = buildVariationSystemPrompt(runInput({ logoKeep: null }));
    expect(prompt).not.toContain("Do not draw a logo");
  });

  it("tells the review which marks were pasted", async () => {
    const seen: unknown[] = [];
    const run = await runAgent({
      input: runInput({ logoKeep: { patchSource: "asset" } }),
      deps: deps({
        produceImage: async () => ({ imageUrl: "u", keeps: [keep()] }),
        reviewImage: async (args) => {
          seen.push(args.keeps);
          return { pass: true, notes: [] };
        },
      }),
    });
    expect(run.kind).toBe("ready");
    expect(seen[0]).toEqual([keep()]);
  });

  it("records the shipped attempt's marks on the plan", async () => {
    const run = await runAgent({
      input: runInput({ logoKeep: { patchSource: "asset" } }),
      deps: deps({ produceImage: async () => ({ imageUrl: "u", keeps: [keep()] }) }),
    });
    expect(run.kind === "ready" && run.plan.keptMarks).toEqual([keep()]);
  });
});
```

with a local `keep()` helper returning a `VariationKeep` literal.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/variation-agent.test.ts`
Expected: FAIL — `logoKeep` is not an input field and the prompt has no logo clause.

- [ ] **Step 3: Implement the agent side**

- `VariationRunInput` gains `logoKeep?: { patchSource: "asset" | "source" } | null`.
- `buildVariationSystemPrompt` gains a block, rendered only when `logoKeep` is set, in the voice of the existing TRANSPLANT block:

```
LOGO KEEP: the advertiser's real logo is pasted into the image after it is generated. Do not draw a logo, wordmark, or brand badge anywhere in the scene, and do not describe one in the prompt. Leave clear space where a mark belongs — a plain area of background, inside the safe margins, away from the headline, CTA, and any disclaimer. A mark you draw will be covered.
```

- `VariationFailureReason` gains `"logo_unavailable"`.
- `VariationRunDeps.produceImage` returns `keeps`; `reviewImage` takes `keeps: VariationKeep[]`.
- `finish` copies the shipped attempt's `keeps` onto `plan.keptMarks`, beside `transplantedProduct`.

- [ ] **Step 4: The review block**

In the trigger's `reviewImage` system prompt, when `keeps` is non-empty, add:

```
The advertiser's logo was pasted into this image as real artwork, not drawn by the model. Fail when: the mark is distorted, stretched, cropped, or recoloured; a second logo the model drew is still visible anywhere; the mark overlaps the headline, CTA, or disclaimer; or the mark is too small or too low in contrast to read at feed size.
```

When the paste did not run because no legal placement was found, tell the review so plainly (mirroring the existing "the paste did not run" note) and have it fail the attempt, so the agent retries with a different composition instead of shipping a mark-less ad.

- [ ] **Step 5: Persistence and the card**

- `markVariant` already stores `plan` and `attempts`; both now carry keeps with no schema change, since the columns are JSONB.
- Map `logo_unavailable` through the variant's failure display the way the other reasons are mapped (`grep -n "moderationReason\|reason" src/components/blocks/creatives/creative-variations-tab.tsx`).
- The card gains a line beside the existing "Product transplanted…": `Logo kept from the brand asset` or `Logo kept from the source ad`, driven by `plan.keptMarks?.[0]?.patchSource`.

- [ ] **Step 6: Verify and commit**

Run: `npm run test -- --run src/lib/variation-agent.test.ts && npm run test:components && npx tsc --noEmit && npx eslint src/lib/variation-agent.ts src/lib/variation-agent.test.ts trigger/generate-variation.ts src/components/blocks/creatives/creative-variations-tab.tsx`
Expected: PASS, clean.

```bash
git add src/lib/variation-agent.ts src/lib/variation-agent.test.ts trigger/generate-variation.ts src/components/blocks/creatives/creative-variations-tab.tsx
git commit -m "feat(studio): keep the advertiser's logo out of the model's hands"
```

---

### Task 7: Full verification and PR body

**Files:**
- Create: `rands/pr-body-variation-logo-keep.md` (git-ignored; never staged)

- [ ] **Step 1: Battery**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL' .env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')"
npm run test 2>&1 | tail -5
npm run test:components 2>&1 | tail -3
npx tsc --noEmit && echo TSC-CLEAN
npm run lint 2>&1 | tail -3
```

Expected: all green. The integration suites need the local Postgres (`docker compose up -d db`); if it is unreachable, separate those failures from genuine ones and say so.

- [ ] **Step 2: A real run, if credentials allow**

With `bun run trigger:dev` running and a creative that has a visible logo, generate one variation and confirm from the run log: the mark locator found the source's logo; the ladder chose asset or source; the placement rule that fired; the measured contrast. Record the outcome in the report, or state plainly that no live run was possible.

- [ ] **Step 3: PR body**

Write `rands/pr-body-variation-logo-keep.md` following `rands/pr-body-static-ad-variations.md`: the problem (the model redrew the logo; the uploaded asset was only ever a reference), the ladder, the placement rules, the no-blending decision, the fail-rather-than-ship policy and its one exception, rebrand inversion, verification counts, and a Follow-ups list naming the disclaimer as the next keep and the deterministic render layer as the destination.

- [ ] **Step 4: Report**

Reply with the commit list, counts, the live-run outcome, and the PR body path. Do not push.
