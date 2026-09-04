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

// Each edge moves outward independently and stops at the canvas, so a box on
// the top or left border does not gain the lost margin on the far side.
export function expandRegion(region: ProductRegion, margin = MASK_MARGIN): ProductRegion {
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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: expected positive integer dimensions, got ${width}x${height}`);
  }
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
    chunk("IDAT", deflateSync(scanlines)),
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
  /**
   * When true the box is the only editable area (the Phase 2 polarity).
   * Meaningless without `keep`: with no box, everything would be protected.
   */
  invert?: boolean;
};

/** A PNG the size of the source where kept pixels are opaque white and editable pixels are transparent. */
export function buildKeepMask({ width, height, keep, invert = false }: KeepMaskInput): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  // Clamp before expanding so an out-of-range region cannot silently produce
  // a bad mask. A region that clamps down to zero area has nothing left to
  // keep, so it is treated the same as no region at all rather than letting
  // the margin expand a single point into a phantom sliver.
  const clamped = keep ? clampRegion(keep) : null;
  const box = clamped && clamped.w > 0 && clamped.h > 0 ? expandRegion(clamped) : null;
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
