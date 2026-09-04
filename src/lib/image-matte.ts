// Cuts the product out of a source ad so it can be pasted into a generated
// scene without dragging the source's background along. Works on the common
// case (a product on a flat card or pedestal): flood-fills the background from
// the box border, keeps everything it cannot reach, and softens the edge one
// pixel. The flood spreads by neighbour-to-neighbour similarity rather than a
// single global threshold, so a vignette or spotlight that darkens toward the
// centre still floods; an overall drift bound keeps it from walking into the
// product through a soft edge. Anything else falls back to an opaque rectangle
// so callers always get a usable patch.

import sharp from "sharp";
import { pixelBox, type PasteBox } from "@/lib/image-composite";
import { clampRegion, type ProductRegion } from "@/lib/image-mask";

/** Max spread of border colours (RGB Euclidean, 0-441) for the border to count as flat. */
const FLAT_BORDER_SPREAD = 40;
/** A pixel this close to the border's mean colour is background. */
const BACKGROUND_DISTANCE = 32;
/**
 * How far the background may drift from the border mean overall, so a smooth
 * vignette floods but the flood cannot walk into a product through a soft edge.
 */
const BACKGROUND_DRIFT = 96;
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
  // EXIF-rotated sources report their stored size, but the region describes the
  // image as it is seen, so orient first and box against the oriented size.
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
  let spread = 0;
  for (const i of border) spread = Math.max(spread, distance(rgbAt(i), mean));
  if (spread > FLAT_BORDER_SPREAD) return rectangle();

  // Flood fill background from the border. A neighbour joins when it matches
  // the pixel it was reached from, which follows a gradient, and when it is
  // still within the overall drift bound, which stops the walk at the product.
  const background = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const i of border) {
    if (distance(rgbAt(i), mean) <= BACKGROUND_DISTANCE && !background[i]) {
      background[i] = 1;
      queue.push(i);
    }
  }
  const neighbours = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (let i = queue.pop(); i !== undefined; i = queue.pop()) {
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of neighbours) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (background[n]) continue;
      const colour = rgbAt(n);
      if (distance(colour, rgbAt(i)) > BACKGROUND_DISTANCE) continue;
      if (distance(colour, mean) > BACKGROUND_DRIFT) continue;
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
      (x > 0 && background[i - 1] === 1) ||
      (x < width - 1 && background[i + 1] === 1) ||
      (y > 0 && background[i - width] === 1) ||
      (y < height - 1 && background[i + width] === 1);
    out[i * 4 + 3] = touchesBackground ? EDGE_ALPHA : 255;
  }
  const patch = new Uint8Array(await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return { patch, box, matted: true, coverage };
}
