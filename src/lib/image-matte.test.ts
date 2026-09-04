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

  it("mattes a product on a vignetted background", async () => {
    // The background drifts far from the border mean toward the centre, so a
    // single global threshold would leave an opaque halo of it around the disc.
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
    expect(await alphaAt(result.patch, 40, 22)).toBe(0); // 18px above the disc, deep in the vignette
    expect(await alphaAt(result.patch, 40, 40)).toBe(255);
  });
});
