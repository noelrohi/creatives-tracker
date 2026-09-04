import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodePng } from "./image-mask";
import { matteProduct } from "./image-matte";

/** width x height tile filled by `background(x, y)` with a red disc of radius r at (cx, cy). */
function tile(
  width: number,
  height: number,
  background: (x: number, y: number) => [number, number, number],
  disc?: { cx: number; cy: number; r: number },
) {
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

async function sizeOf(png: Uint8Array) {
  const { width, height } = await sharp(png).metadata();
  return { width, height };
}

const full = { x: 0, y: 0, w: 1, h: 1 };

describe("matteProduct", () => {
  it("removes a flat background around the product and keeps the product opaque", async () => {
    const source = tile(60, 60, () => [245, 240, 232], { cx: 30, cy: 30, r: 15 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    // The patch is cropped to the disc (15..45 on both axes) plus a pixel of slack.
    expect(result.box).toEqual({ left: 14, top: 14, width: 33, height: 33 });
    expect(await alphaAt(result.patch, 2, 2)).toBe(0); // corner of the crop, outside the disc
    expect(await alphaAt(result.patch, 16, 16)).toBe(255); // disc centre (30,30) in the crop
    expect(result.coverage).toBeGreaterThan(0.15);
    expect(result.coverage).toBeLessThan(0.3);
  });

  it("tolerates slight background noise and softens the product edge", async () => {
    const source = tile(60, 60, (x, y) => [245 - ((x + y) % 3), 240, 232], { cx: 30, cy: 30, r: 15 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    expect(await alphaAt(result.patch, 16, 16)).toBe(255); // disc centre (30,30) in the crop
    const edge = await alphaAt(result.patch, 16, 1); // top of the disc, a pixel below the crop edge
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it("falls back to an opaque rectangle when the box border is not flat", async () => {
    // Half the border is dark and half is light, so no reference colour has a
    // majority and the box cannot be treated as a product on a background.
    const source = tile(60, 60, (x) => (x < 30 ? [40, 40, 40] : [230, 230, 230]), { cx: 30, cy: 30, r: 15 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(false);
    expect(result.box).toEqual({ left: 0, top: 0, width: 60, height: 60 });
    expect(result.region).toEqual(full);
    expect(await alphaAt(result.patch, 2, 2)).toBe(255);
  });

  it("tolerates a few off-colour border pixels", async () => {
    // A label crossing the bottom edge takes 24 of the 236 border pixels (~10%),
    // which the majority rule absorbs; the label itself is not background.
    const label = (x: number, y: number) => x >= 18 && x <= 41 && y >= 52;
    const source = tile(60, 60, (x, y) => (label(x, y) ? [30, 40, 60] : [245, 240, 232]), {
      cx: 30,
      cy: 30,
      r: 15,
    });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    // The label is well over 1% of the box, so it survives as part of the product
    // and the crop runs from the top of the disc to the clamped bottom edge.
    expect(await sizeOf(result.patch)).toEqual({ width: 33, height: 46 });
    expect(result.box).toEqual({ left: 14, top: 14, width: 33, height: 46 });
    // Label interior at (30,55); the crop starts at (14,14) so the patch keeps it opaque.
    expect(await alphaAt(result.patch, 16, 41)).toBe(255);
  });

  it("drops stray specks so the crop stays tight", async () => {
    // Two 2x2 specks the flood cannot reach, each ~0.1% of the box: one near a
    // corner, which would otherwise drag the crop back out to the whole tile,
    // and one beside the disc, which stays inside the crop so its alpha is
    // readable. Both are dropped, so the crop is the disc-only one above.
    const speck = (x: number, y: number) =>
      (x >= 4 && x <= 5 && y >= 4 && y <= 5) || (x >= 16 && x <= 17 && y >= 44 && y <= 45);
    const source = tile(60, 60, (x, y) => (speck(x, y) ? [30, 40, 60] : [245, 240, 232]), {
      cx: 30,
      cy: 30,
      r: 15,
    });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    expect(result.box).toEqual({ left: 14, top: 14, width: 33, height: 33 });
    expect(await alphaAt(result.patch, 2, 30)).toBe(0); // the speck at (16,44) in the crop
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
    expect(result.matted).toBe(true);
    // Extracted box {50,50,50,50}, then cropped to the disc (60..80) plus slack.
    expect(result.box).toEqual({ left: 59, top: 59, width: 23, height: 23 });
    expect(await alphaAt(result.patch, 11, 11)).toBe(255); // disc centre (70,70) in the crop
    expect(await alphaAt(result.patch, 2, 2)).toBe(0);
  });

  it("crops the patch to the product bounds and reports its region", async () => {
    const source = tile(100, 100, () => [245, 240, 232], { cx: 35, cy: 60, r: 12 });
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    // Disc bbox is 25px across (23..47 by 48..72); the crop pads it by a pixel.
    expect(await sizeOf(result.patch)).toEqual({ width: 27, height: 27 });
    expect(result.box).toEqual({ left: 22, top: 47, width: 27, height: 27 });
    expect(result.region).toEqual({ x: 0.22, y: 0.47, w: 0.27, h: 0.27 });
  });

  it("mattes a product on a vignetted background", async () => {
    // The background drifts far from the border reference toward the centre, so
    // a single global threshold would leave an opaque halo of it around the disc.
    const maxDist = Math.hypot(40, 40);
    const source = tile(
      80,
      80,
      (x, y) => {
        const shade = Math.round(60 * (1 - Math.hypot(x - 40, y - 40) / maxDist));
        return [245 - shade, 240 - shade, 232 - shade];
      },
      { cx: 40, cy: 40, r: 10 },
    );
    const result = await matteProduct({ source, region: full });
    expect(result.matted).toBe(true);
    expect(result.coverage).toBeGreaterThan(0.04);
    expect(result.coverage).toBeLessThan(0.08);
    // The crop is the disc (30..50) plus slack, so its corner is the deepest
    // vignette pixel left in the patch: shade 45 against a border of 0-18.
    expect(await alphaAt(result.patch, 1, 1)).toBe(0);
    expect(await alphaAt(result.patch, 11, 11)).toBe(255); // disc centre (40,40) in the crop
  });
});
