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
