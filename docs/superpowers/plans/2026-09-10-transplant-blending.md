# Transplant Blending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transplanted product sit in its new scene: a contact shadow, a bounded light match, a scale cap from the source, and no pedestal unless the source has one.

**Architecture:** `pastePatch` gains `matchLight`, `shadow`, and `maxWidth` options implemented with sharp (ring and patch sampling, per-channel linear gains, an SVG ellipse blurred and composited under the patch). The trigger passes them on generate-mode transplants and logs the blend. The agent prompt and the locator stop suggesting pedestals; the review notes an added stand.

**Tech Stack:** sharp 0.34, Vitest, Vercel AI SDK, Trigger.dev.

Design: `docs/superpowers/specs/2026-09-10-transplant-blending-design.md`. Branch: `feat/transplant-blending` (cut from main). Commits title-only. Do not touch `.gitignore`.

---

### Task 1: `pastePatch` blend options

**Files:**
- Modify: `src/lib/image-composite.ts`
- Test: `src/lib/image-composite.test.ts`

- [ ] **Step 1: Failing tests.** Append inside `describe("pastePatch")` (helpers `solid`, `encodePng`, `pixel` exist):

```ts
  it("caps the fitted width at maxWidth of the output", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(40, 40, [0, 255, 0]);
    // Box is 20x20 at (10,10); a 4x4 patch would fit to 20 wide; the cap 0.25 allows 10.
    const { box } = await pastePatch({ output, patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, align: "bottom", maxWidth: 0.25 });
    expect(box).toEqual({ left: 15, top: 20, width: 10, height: 10 });
  });

  it("draws a soft shadow under the patch when asked and leaves the output alone otherwise", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(60, 60, [240, 240, 240]);
    const region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const plain = await pastePatch({ output, patch, region, align: "bottom" });
    const shaded = await pastePatch({ output, patch, region, align: "bottom", shadow: true });
    // Just below the patch's bottom edge, inside the ellipse: darker with the shadow.
    const below = shaded.box.top + shaded.box.height + 1;
    const [r] = await pixel(shaded.bytes, 30, below);
    expect(r).toBeLessThan(200);
    const [plainR] = await pixel(plain.bytes, 30, below);
    expect(plainR).toBe(240);
    // Far from the patch: untouched.
    expect(await pixel(shaded.bytes, 2, 2)).toEqual([240, 240, 240]);
    expect(shaded.blend.shadowOpacity).toBeGreaterThan(0.4); // light surface => visible shadow
  });

  it("brightens or darkens the patch toward the surrounding light within bounds", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([200, 200, 200, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const dark = await pastePatch({ output: solid(60, 60, [20, 20, 20]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    const [darkR] = await pixel(dark.bytes, 30, 30);
    expect(darkR).toBeLessThan(200);
    expect(darkR).toBeGreaterThanOrEqual(150); // 0.75 floor
    expect(dark.blend.lightGain).toBeCloseTo(0.75, 2);
    const bright = await pastePatch({ output: solid(60, 60, [255, 255, 255]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    const [brightR] = await pixel(bright.bytes, 30, 30);
    expect(brightR).toBeGreaterThan(200);
    expect(brightR).toBeLessThanOrEqual(250); // 1.25 ceiling
  });

  it("picks up a mild colour cast from the surroundings without changing the product's hue", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([200, 200, 200, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const warm = await pastePatch({ output: solid(60, 60, [200, 150, 100]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    const [r, g, b] = await pixel(warm.bytes, 30, 30);
    expect(r).toBeGreaterThan(b); // warmer
    expect(r - b).toBeLessThan(40); // but only mildly (15% of the way)
  });
```

- [ ] **Step 2: Run** `bun run test -- src/lib/image-composite.test.ts` → the four fail.

- [ ] **Step 3: Implement** in `image-composite.ts`:

```ts
export type PasteBlend = { lightGain: number; shadowOpacity: number };

/** Mean RGB of the output in a ring around `box` (25% wider each side, the box itself excluded). */
async function ringMean(output: sharp.Sharp, size: { width: number; height: number }, box: PasteBox): Promise<[number, number, number]>
/** Mean RGB of the patch's opaque pixels (alpha > 200). */
async function patchMean(patch: Uint8Array): Promise<[number, number, number]>
const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
```

`pastePatch` input gains `maxWidth?: number` (fraction of the output width; doc: "Cap on the fitted width so a generous target box cannot inflate the product; the source's relative width with headroom."), `shadow?: boolean`, `matchLight?: boolean`; result gains `blend: PasteBlend` (`{ lightGain: 1, shadowOpacity: 0 }` when the options are off).

- Cap: after `fitBox`, if `maxWidth` and `paste.width > maxWidth * outputWidth`, rescale `width/height` uniformly to the cap and recompute `left` (centred in the box) and `top` (bottom-aligned when `align === "bottom"`, else centred).
- Light: `gain = clamp(luma(ring) / max(1, luma(patchMean)), 0.75, 1.25)`; cast per channel `cast_c = ring_c / max(1, luma(ring))`, `gain_c = gain * (1 + 0.15 * (cast_c - 1))`; apply with `sharp(patch).linear([g_r, g_g, g_b, 1], [0, 0, 0, 0])` on the resized RGBA patch (four bands: RGB gains and alpha untouched). Skip when the patch has no opaque pixels.
- Shadow: an SVG `<ellipse>` of width `0.9 * paste.width`, height `0.16 * paste.width`, black, rendered at `opacity = 0.2 + 0.35 * luma(ring) / 255`, blurred with `sharp(...).blur(0.05 * paste.width)` (render the ellipse on a transparent canvas padded by 3 sigma so the blur is not clipped), composited at the patch's bottom centre (ellipse centre at `paste.top + paste.height - 0.06 * paste.width`) **before** the patch in the same `composite([...])` call.
- Comment each constant with its intent (light surfaces cast visible shadows; a quarter stop keeps the product's colour).

- [ ] **Step 4: Run** the file (all pass), `bun run typecheck`, `bun run lint`.
- [ ] **Step 5: Commit** `feat(studio): blend a pasted product with a contact shadow, light match, and width cap`.

---

### Task 2: Prompt and locator wording

**Files:**
- Modify: `src/lib/variation-agent.ts`, `src/lib/variation-agent.test.ts`

- [ ] **Step 1: Test.** In the `buildVariationSystemPrompt` describe:

```ts
  it("asks for a landing surface that belongs to the scene and forbids an added pedestal", () => {
    const system = buildVariationSystemPrompt(patchInput);
    expect(system).toContain("a surface that already belongs to the scene");
    expect(system).toContain("Do not add a stand, pedestal, or platform unless the source ad has one");
    expect(system).not.toContain("(pedestal top, flat card area, tabletop)");
  });
```

- [ ] **Step 2: Implement.** In the TRANSPLANT block replace "Instead leave an empty landing area for it: an evenly lit, plain surface with a visible edge or footprint (a pedestal top, a shelf, a tabletop, a framed card area), described explicitly in the prompt so it can be located afterwards; a bare empty region of background is not enough." with "Instead leave an empty landing area for it on a surface that already belongs to the scene (a nightstand, a tray, a counter, a shelf, the surface the source ad uses), with a visible edge or footprint, described explicitly in the prompt so it can be located afterwards; a bare empty region of background is not enough. Do not add a stand, pedestal, or platform unless the source ad has one."
- [ ] **Step 3:** `bun run test -- src/lib/variation-agent.test.ts` (66), typecheck, lint; commit `fix(studio): stop asking for a pedestal under the transplanted product`.

---

### Task 3: Trigger wiring and review note

**Files:**
- Modify: `trigger/generate-variation.ts`

- [ ] **Step 1: Locator.** In the `landing` prompt line replace "(a bare pedestal top, an empty card, a clear tabletop)" with "(a clear patch of nightstand, tray, counter, shelf, or tabletop; a bare pedestal top; an empty card)".
- [ ] **Step 2: Paste.** In the transplant block:

```ts
                const pastedPatch = await pastePatch({
                  output: produced,
                  patch: productPatch.matte.patch,
                  region: to,
                  align: target === "landing" ? "bottom" : "center",
                  // The product's relative width in the source, with a quarter
                  // of headroom: a generous landing box must not inflate it.
                  maxWidth: sourceProductBox ? sourceProductBox.w * 1.25 : undefined,
                  shadow: true,
                  matchLight: true,
                });
```

and add `blend: pastedPatch.blend` to the "Transplanted product" log. `sourceProductBox` is the source locator's tight box (in scope; for an asset patch it is still the source's box, which is the scale we want).

- [ ] **Step 3: Review.** After the transplant checklist line add, when `transplant`: `"- If the scene shows a stand, pedestal, or platform under the product that the source ad does not have, say so in the notes; it is not a failure on its own."`
- [ ] **Step 4:** `bun run typecheck`, `bun run lint`, `bun run test -- src/lib/image-composite.test.ts src/lib/variation-agent.test.ts`; commit `feat(studio): blend the transplanted product into the generated scene`.

---

### Task 4: Live check, verification, docs

- [ ] Live check (recipe in `docs/superpowers/plans/2026-09-10-variation-briefs.md` Task 5; omit `note` when none): R1 with note "change the scene to a bright morning bathroom"; R3 with note "put the product on a nightstand at night"; R2 no note. For each: shipped PNG, whether a shadow is visible under the product, whether a pedestal was added, whether the product size looks right, the `blend` values from the stored attempt if logged, review pass and notes. Compare with the previous batch's PNGs for R1 and R3 (`.studio-local/dev/create/`).
- [ ] `bun run typecheck && bun run lint && bun run test`, `node scripts/check-migrations.mjs`.
- [ ] Design doc status → implemented with the live results; commit `docs(studio): record the transplant blending outcome`. Draft `rands/pr-body-transplant-blending.md` in the same shape as `rands/pr-body-variation-briefs.md`.

---

## Self-review

- Design §1 (three options, sampling, bounds, shadow geometry, `blend` result) → Task 1.
- Design §2 (`maxWidth` from the source box) → Task 3 Step 2.
- Design §3 (prompt, locator, review note) → Tasks 2 and 3.
- Design §4 (generate mode only) → Task 3 passes the options only in the transplant block; edit mode's `pasteSourceRegion` is untouched.
- Names: `PasteBlend`, `maxWidth`, `shadow`, `matchLight`, `blend` on the result.
