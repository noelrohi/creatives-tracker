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

/**
 * Uniform-scales the source box into the output box so the product keeps its
 * proportions. The two boxes differ in aspect whenever the source's shape
 * differs from the output preset's (a 1080x1350 source into a 1024x1536
 * portrait is a 17% vertical stretch), and stretching the one thing this
 * module exists to preserve defeats the point; a thin band of the model's own
 * render is left at the box edge instead.
 */
function fitBox(from: PasteBox, to: PasteBox): PasteBox {
  const scale = Math.min(to.width / from.width, to.height / from.height);
  const width = Math.max(1, Math.round(from.width * scale));
  const height = Math.max(1, Math.round(from.height * scale));
  return {
    left: to.left + Math.round((to.width - width) / 2),
    top: to.top + Math.round((to.height - height) / 2),
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
