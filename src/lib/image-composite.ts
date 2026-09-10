// Puts the source's product back into an edited output. The image model treats
// an edit mask as guidance and re-renders the whole canvas at a preset size,
// so the only way to guarantee the product is to copy the source's region over
// the output ourselves, scaled to the output's pixel size.

import sharp from "sharp";
import { clampRegion, type ProductRegion } from "@/lib/image-mask";

export type PasteBox = { left: number; top: number; width: number; height: number };

export function pixelBox(region: ProductRegion, width: number, height: number): PasteBox {
  const left = Math.round(region.x * width);
  const top = Math.round(region.y * height);
  const right = Math.round((region.x + region.w) * width);
  const bottom = Math.round((region.y + region.h) * height);
  return { left, top, width: right - left, height: bottom - top };
}

export type PasteAlign = "center" | "bottom";

/**
 * Uniform-scales the source box into the output box so the product keeps its
 * proportions. The two boxes differ in aspect whenever the source's shape
 * differs from the output preset's (a 1080x1350 source into a 1024x1536
 * portrait is a 17% vertical stretch), and stretching the one thing this
 * module exists to preserve defeats the point; a thin band of the model's own
 * render is left at the box edge instead.
 */
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

/**
 * Extracts `region` from `source`, uniform-scales it to fit the same
 * normalized box in `output`'s pixel size, centred, composites it there, and
 * returns PNG bytes plus the box it landed in. The region is clamped to the canvas first; an empty box
 * throws so the caller never ships an output that silently kept nothing.
 */
export async function pasteSourceRegion(input: {
  source: Uint8Array;
  output: Uint8Array;
  region: ProductRegion;
}): Promise<{ bytes: Uint8Array; box: PasteBox }> {
  const region = clampRegion(input.region);
  const [sourceMeta, outputMeta] = await Promise.all([
    sharp(input.source, { failOn: "none" }).metadata(),
    sharp(input.output).metadata(),
  ]);
  // EXIF-rotated JPEGs report their stored, unrotated size and `extract` works
  // on those stored pixels. The region describes the image as the locator and
  // the model saw it, so orient first and box against the oriented size.
  const sourceSize = sourceMeta.autoOrient;
  const outputSize = outputMeta.autoOrient;
  if (!sourceSize?.width || !sourceSize.height || !outputSize?.width || !outputSize.height) {
    throw new Error("pasteSourceRegion: could not read image dimensions");
  }
  const from = pixelBox(region, sourceSize.width, sourceSize.height);
  const to = pixelBox(region, outputSize.width, outputSize.height);
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) {
    throw new Error("pasteSourceRegion: the region is empty after clamping");
  }
  const paste = fitBox(from, to);
  const patch = await sharp(input.source, { failOn: "none" })
    .autoOrient()
    .extract(from)
    .resize(paste.width, paste.height, { fit: "fill" })
    .png()
    .toBuffer();
  const bytes = await sharp(input.output)
    .autoOrient()
    .composite([{ input: patch, left: paste.left, top: paste.top }])
    .png()
    .toBuffer();
  return { bytes: new Uint8Array(bytes), box: paste };
}

export type PasteBlend = {
  /** The brightness gain applied to the patch; 1 when `matchLight` is off. */
  lightGain: number;
  /** The per-channel gains actually applied, brightness and cast together; [1, 1, 1] when `matchLight` is off. */
  channelGains: [number, number, number];
  /** The contact shadow ellipse's opacity; 0 when `shadow` is off or the ellipse falls entirely off the output. */
  shadowOpacity: number;
};

/** Rec. 709 luma: the perceived brightness of an sRGB triple. */
const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** How far past the box each side of the sampling ring reaches. */
const RING_MARGIN = 0.25;
/**
 * The gain bounds. Brightening stops at a quarter stop so a pale product does
 * not wash out; darkening may go to a half, because a lamp-lit night scene
 * sits three to four times darker than a studio patch and a quarter stop left
 * the product glowing (measured on the R3 nightstand run).
 */
const GAIN_MIN = 0.5;
const GAIN_MAX = 1.25;
/** How far the patch travels toward the room's colour balance: enough to feel lit by it, not enough to recolour it. */
const CAST_STRENGTH = 0.15;
/** Contact shadow geometry, all relative to the pasted width. */
const SHADOW_WIDTH = 0.9; // a little narrower than the product, as a footprint is
const SHADOW_HEIGHT = 0.16; // an ellipse seen from a normal camera height
const SHADOW_BLUR = 0.05; // soft enough to read as contact, tight enough to anchor
const SHADOW_RISE = 0.06; // the ellipse's centre sits just above the product's bottom edge
/** Opacity floor and range: light surfaces cast visible shadows, dark ones almost none. */
const SHADOW_OPACITY_BASE = 0.2;
const SHADOW_OPACITY_RANGE = 0.35;

/**
 * Mean RGB of the output in a ring around `box` (25% wider on each side,
 * clamped to the image, the box itself excluded). The ring is the light the
 * product is about to sit in — the surface under it and the wall behind it —
 * sampled without the model's own product, which the patch is about to cover.
 * A box that fills the canvas leaves no ring; the whole sampled rectangle is
 * used then rather than reporting no light at all.
 */
async function ringMean(
  output: sharp.Sharp,
  size: { width: number; height: number },
  box: PasteBox,
): Promise<[number, number, number]> {
  const marginX = Math.round(box.width * RING_MARGIN);
  const marginY = Math.round(box.height * RING_MARGIN);
  const left = Math.max(0, box.left - marginX);
  const top = Math.max(0, box.top - marginY);
  const right = Math.min(size.width, box.left + box.width + marginX);
  const bottom = Math.min(size.height, box.top + box.height + marginY);
  const { data, info } = await output
    .clone()
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  const all = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const rgb = [data[i], data[info.channels > 1 ? i + 1 : i], data[info.channels > 2 ? i + 2 : i]];
      for (let c = 0; c < 3; c += 1) all[c] += rgb[c];
      const inBox =
        left + x >= box.left &&
        left + x < box.left + box.width &&
        top + y >= box.top &&
        top + y < box.top + box.height;
      if (inBox) continue;
      for (let c = 0; c < 3; c += 1) sum[c] += rgb[c];
      count += 1;
    }
  }
  const total = info.width * info.height;
  const [source, n] = count > 0 ? [sum, count] : [all, Math.max(1, total)];
  return [source[0] / n, source[1] / n, source[2] / n];
}

/**
 * Mean RGB of the patch's opaque pixels (alpha > 200); null when the patch is
 * all transparent. A greyscale or palette patch decodes to one or two bands, so
 * the pipeline is normalized to sRGB with alpha before the raw pixels are read.
 */
async function patchMean(patch: sharp.Sharp): Promise<[number, number, number] | null> {
  const { data, info } = await patch
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += info.channels) {
    if (data[i + 3] <= 200) continue;
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
    count += 1;
  }
  if (count === 0) return null;
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

/**
 * A blurred black ellipse sitting under the patch's bottom edge, ready to
 * composite. It is drawn on a transparent canvas padded by three sigma so the
 * blur is not clipped at the ellipse's own edge, then trimmed to whatever part
 * of it falls on the output; null when none of it does.
 */
async function contactShadow(
  paste: PasteBox,
  opacity: number,
  size: { width: number; height: number },
): Promise<sharp.OverlayOptions | null> {
  const width = SHADOW_WIDTH * paste.width;
  const height = SHADOW_HEIGHT * paste.width;
  const sigma = Math.max(0.3, SHADOW_BLUR * paste.width); // sharp's blur needs sigma >= 0.3
  const pad = Math.ceil(3 * sigma);
  const canvasWidth = Math.ceil(width) + 2 * pad;
  const canvasHeight = Math.ceil(height) + 2 * pad;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><ellipse cx="${canvasWidth / 2}" cy="${canvasHeight / 2}" rx="${width / 2}" ry="${height / 2}" fill="#000000" fill-opacity="${opacity}"/></svg>`;
  const blurred = await sharp(Buffer.from(svg)).blur(sigma).png().toBuffer();
  const left = Math.round(paste.left + paste.width / 2 - canvasWidth / 2);
  const top = Math.round(paste.top + paste.height - SHADOW_RISE * paste.width - canvasHeight / 2);
  const cropLeft = Math.max(0, -left);
  const cropTop = Math.max(0, -top);
  const visibleWidth = Math.min(canvasWidth - cropLeft, size.width - Math.max(0, left));
  const visibleHeight = Math.min(canvasHeight - cropTop, size.height - Math.max(0, top));
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;
  const clipped =
    cropLeft > 0 || cropTop > 0 || visibleWidth !== canvasWidth || visibleHeight !== canvasHeight
      ? await sharp(blurred)
          .extract({ left: cropLeft, top: cropTop, width: visibleWidth, height: visibleHeight })
          .png()
          .toBuffer()
      : blurred;
  return { input: clipped, left: Math.max(0, left), top: Math.max(0, top) };
}

/**
 * Shrinks an already-fitted box so its width stays within `cap` pixels,
 * uniformly and keeping the alignment: centred in the target box horizontally,
 * resting on its bottom edge or centred vertically.
 */
function capWidth(paste: PasteBox, to: PasteBox, cap: number, align: PasteAlign = "center"): PasteBox {
  if (!(cap > 0) || paste.width <= cap) return paste;
  const scale = cap / paste.width;
  const width = Math.max(1, Math.round(paste.width * scale));
  const height = Math.max(1, Math.round(paste.height * scale));
  return {
    left: to.left + Math.round((to.width - width) / 2),
    top: align === "bottom" ? to.top + to.height - height : to.top + Math.round((to.height - height) / 2),
    width,
    height,
  };
}

/**
 * Composites an already-prepared patch (PNG, alpha allowed) into the output at
 * `region`, uniform-scaled to fit the region's pixel box. Used by
 * the product transplant: the patch is the matted source product and `region`
 * is where the model drew its own product.
 *
 * With `shadow` and `matchLight` the patch is blended into the scene rather
 * than stamped on it: a soft contact shadow under it, and the surrounding
 * light's brightness and colour carried onto it within bounds. With both off
 * the output is the plain paste, unchanged.
 */
export async function pastePatch(input: {
  output: Uint8Array;
  patch: Uint8Array;
  region: ProductRegion;
  /** Where the fitted patch sits inside the box: centred, or resting on the box's bottom edge for a product placed on a surface. */
  align?: PasteAlign;
  /** Cap on the fitted width so a generous target box cannot inflate the product; the source's relative width with headroom. */
  maxWidth?: number;
  /** Draw a soft contact shadow under the patch so it rests on the surface instead of floating. */
  shadow?: boolean;
  /** Carry the surrounding light's brightness and colour onto the patch, within a quarter stop. */
  matchLight?: boolean;
}): Promise<{ bytes: Uint8Array; box: PasteBox; blend: PasteBlend }> {
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
  const fitted = fitBox({ left: 0, top: 0, width: patchMeta.width, height: patchMeta.height }, to, input.align);
  const paste = input.maxWidth
    ? capWidth(fitted, to, input.maxWidth * outputSize.width, input.align)
    : fitted;
  const base = sharp(input.output).autoOrient();
  const blend: PasteBlend = { lightGain: 1, channelGains: [1, 1, 1], shadowOpacity: 0 };
  const ring =
    input.matchLight || input.shadow
      ? await ringMean(base, { width: outputSize.width, height: outputSize.height }, paste)
      : null;

  // One resize pipeline, cloned for the plain paste and for the lit pass.
  const scaled = sharp(input.patch).resize(paste.width, paste.height, { fit: "fill" });
  let resized = await scaled.clone().png().toBuffer();
  if (input.matchLight && ring) {
    // A greyscale or palette patch decodes to one or two bands and sharp cannot
    // expand bands inside a `linear`, so the sRGB-with-alpha form is written out
    // once and both the sampling and the gains read four bands from it.
    const rgba = await scaled.clone().toColourspace("srgb").ensureAlpha().png().toBuffer();
    const mean = await patchMean(sharp(rgba));
    // An all-transparent patch has no tone to match; leave it alone.
    if (mean) {
      const ringLuma = luma(ring);
      const gain = clamp(ringLuma / Math.max(1, luma(mean)), GAIN_MIN, GAIN_MAX);
      // Each channel moves a fraction of the way toward the ring's own balance,
      // so a warm room warms the product without repainting it. A saturated or
      // black ring makes that ratio wild, so each channel stays inside the
      // quarter-stop envelope widened by the cast's own share.
      const gains = ring.map((channel) =>
        clamp(
          gain * (1 + CAST_STRENGTH * (channel / Math.max(1, ringLuma) - 1)),
          GAIN_MIN * (1 - CAST_STRENGTH),
          GAIN_MAX * (1 + CAST_STRENGTH),
        ),
      ) as [number, number, number];
      resized = await sharp(rgba)
        .linear([gains[0], gains[1], gains[2], 1], [0, 0, 0, 0]) // four bands: RGB gains, alpha untouched
        .png()
        .toBuffer();
      blend.lightGain = gain;
      blend.channelGains = gains;
    }
  }

  const layers: sharp.OverlayOptions[] = [];
  if (input.shadow && ring) {
    const opacity = SHADOW_OPACITY_BASE + SHADOW_OPACITY_RANGE * (luma(ring) / 255);
    const shadow = await contactShadow(paste, opacity, { width: outputSize.width, height: outputSize.height });
    if (shadow) {
      layers.push(shadow); // under the patch, so the product's own edge stays crisp
      blend.shadowOpacity = opacity;
    }
  }
  layers.push({ input: resized, left: paste.left, top: paste.top });

  const bytes = await base.composite(layers).png().toBuffer();
  return { bytes: new Uint8Array(bytes), box: paste, blend };
}
