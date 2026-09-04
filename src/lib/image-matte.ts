// Cuts the product out of a source ad so it can be pasted into a generated
// scene without dragging the source's background along. Works on the common
// case (a product on a flat card or pedestal): flood-fills the background from
// the box border, keeps everything it cannot reach, and softens the edge one
// pixel. The border counts as background when at least 85% of its pixels sit
// close to its median colour, so a label or a piece of trim clipping a few
// border pixels does not veto the matte. The flood spreads by
// neighbour-to-neighbour similarity rather than a single global threshold, so a
// vignette or spotlight that darkens toward the centre still floods; an overall
// drift bound keeps it from walking into the product through a soft edge. Stray
// blobs the flood could not reach are dropped, and the matted patch is cropped
// to the product it found, so a caller fitting it into a target box does not
// spend that box on transparent margins. Anything else falls back to an opaque
// rectangle so callers always get a usable patch.

import sharp from "sharp";
import { pixelBox, type PasteBox } from "@/lib/image-composite";
import { clampRegion, type ProductRegion } from "@/lib/image-mask";

/**
 * Share of border pixels that must sit within BACKGROUND_DISTANCE of the border
 * median for the border to count as background.
 */
const FLAT_BORDER_SHARE = 0.85;
/** A pixel this close to the border's reference colour is background. */
const BACKGROUND_DISTANCE = 32;
/**
 * How far the background may drift from the border reference overall, so a
 * smooth vignette floods but the flood cannot walk into a product through a
 * soft edge.
 */
const BACKGROUND_DRIFT = 96;
/**
 * Foreground blobs smaller than this share of the box are stray pixels, not
 * product; dropping them keeps the crop tight.
 */
const MIN_COMPONENT_SHARE = 0.01;
/** Foreground share outside this band means the matte is not trustworthy. */
const MIN_COVERAGE = 0.02;
const MAX_COVERAGE = 0.9;
const EDGE_ALPHA = 150;

export type MatteResult = {
  /** PNG with alpha, the size of `box`. */
  patch: Uint8Array;
  /** Pixel box of `patch` in the (oriented) source: the crop when matted, the requested region when not. */
  box: PasteBox;
  /** Normalized region of `box`; the clamped input region in the fallback, which `pixelBox` rounding may place up to a pixel off `box`. */
  region: ProductRegion;
  /** False when the rectangle fallback was used. */
  matted: boolean;
  /** Foreground share of the extracted region, measured before the crop (0 when not matted). */
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
    region,
    matted: false,
    coverage: 0,
  });

  // Border ring: do at least FLAT_BORDER_SHARE of it sit close to its own median
  // colour? The median ignores the handful of pixels an outline or a label
  // crosses, which a mean (and a max-spread test around it) would let veto the
  // whole matte.
  const border: number[] = [];
  for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) border.push(y * width, y * width + width - 1);
  const reference: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const channel = border.map((i) => data[i * 4 + c]).sort((a, b) => a - b);
    reference[c] = channel[Math.floor(channel.length / 2)];
  }
  let flat = 0;
  for (const i of border) if (distance(rgbAt(i), reference) <= BACKGROUND_DISTANCE) flat += 1;
  if (flat / border.length < FLAT_BORDER_SHARE) return rectangle();

  // Flood fill background from the border. A neighbour joins when it matches
  // the pixel it was reached from, which follows a gradient, and when it is
  // still within the overall drift bound, which stops the walk at the product.
  const background = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const i of border) {
    if (distance(rgbAt(i), reference) <= BACKGROUND_DISTANCE && !background[i]) {
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
      if (distance(colour, reference) > BACKGROUND_DRIFT) continue;
      background[n] = 1;
      queue.push(n);
    }
  }

  // Drop stray blobs the flood could not reach: a couple of unflooded pixels
  // near a corner would otherwise stretch the crop back to the whole box. Every
  // component above the threshold stays, since a product may be several pieces.
  const minComponent = MIN_COMPONENT_SHARE * width * height;
  const visited = new Uint8Array(width * height);
  for (let start = 0; start < width * height; start += 1) {
    if (background[start] || visited[start]) continue;
    visited[start] = 1;
    const component = [start];
    for (let head = 0; head < component.length; head += 1) {
      const i = component[head];
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of neighbours) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (background[n] || visited[n]) continue;
        visited[n] = 1;
        component.push(n);
      }
    }
    if (component.length < minComponent) for (const i of component) background[i] = 1;
  }

  let foreground = 0;
  for (let i = 0; i < width * height; i += 1) if (!background[i]) foreground += 1;
  const coverage = foreground / (width * height);
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return rectangle();

  // Alpha: background 0, product edge soft, product 255.
  const out = Buffer.from(data);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
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
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Crop to the product plus a pixel of slack: callers fit the patch into the
  // output's product box, so transparent margins would shrink the product.
  const left = Math.max(minX - 1, 0);
  const top = Math.max(minY - 1, 0);
  const right = Math.min(maxX + 1, width - 1);
  const bottom = Math.min(maxY + 1, height - 1);
  const crop = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const patch = new Uint8Array(
    await sharp(out, { raw: { width, height, channels: 4 } }).extract(crop).png().toBuffer(),
  );
  const cropped: PasteBox = {
    left: box.left + crop.left,
    top: box.top + crop.top,
    width: crop.width,
    height: crop.height,
  };
  return {
    patch,
    box: cropped,
    region: {
      x: cropped.left / size.width,
      y: cropped.top / size.height,
      w: cropped.width / size.width,
      h: cropped.height / size.height,
    },
    matted: true,
    coverage,
  };
}
