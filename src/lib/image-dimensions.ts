import type { StudioPreset } from "@/lib/studio-prompt";

export type ImageDimensions = { width: number; height: number };

function isPng(b: Uint8Array) {
  return b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isGif(b: Uint8Array) {
  return b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
}

function isJpeg(b: Uint8Array) {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;
}

function isWebp(b: Uint8Array) {
  return (
    b.length >= 30 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  );
}

function readJpeg(b: Uint8Array): ImageDimensions | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1];
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const length = view.getUint16(offset + 2);
    offset += 2 + length;
  }
  return null;
}

function readWebp(b: Uint8Array): ImageDimensions | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === "VP8 ") {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return null;
}

function positive(dimensions: ImageDimensions | null): ImageDimensions | null {
  if (!dimensions) return null;
  return dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

/** Reads width/height from the header of a PNG, JPEG, GIF, or WebP. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) return positive({ width: view.getUint32(16), height: view.getUint32(20) });
  if (isGif(bytes)) return positive({ width: view.getUint16(6, true), height: view.getUint16(8, true) });
  if (isJpeg(bytes)) return positive(readJpeg(bytes));
  if (isWebp(bytes)) return positive(readWebp(bytes));
  return null;
}

/**
 * Maps a source's shape to a Studio preset the way the variations design
 * specifies: portrait for anything taller than 1:1, square otherwise. The
 * fallback for unknown dimensions is portrait, the client's default for
 * statics.
 */
export function studioFormatForDimensions(
  dimensions: ImageDimensions | null,
): Extract<StudioPreset, "portrait" | "square"> {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return "portrait";
  return dimensions.height > dimensions.width ? "portrait" : "square";
}
