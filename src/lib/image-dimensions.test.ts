import { describe, expect, it } from "vitest";
import { readImageDimensions, studioFormatForDimensions } from "./image-dimensions";

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number) {
  // SOI, then a SOF0 marker with height/width.
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
  ]);
  return bytes;
}

function gif(width: number, height: number) {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = width & 0xff;
  bytes[7] = width >> 8;
  bytes[8] = height & 0xff;
  bytes[9] = height >> 8;
  return bytes;
}

function jpegWithApp0(width: number, height: number) {
  // SOI, a JFIF APP0 segment the walk has to skip, then SOF0.
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
  ]);
}

function riffWebp(fourcc: string, payload: Uint8Array) {
  const bytes = new Uint8Array(Math.max(30, 20 + payload.length));
  const view = new DataView(bytes.buffer);
  const ascii = (text: string, at: number) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii("RIFF", 0);
  view.setUint32(4, bytes.length - 8, true);
  ascii("WEBP", 8);
  ascii(fourcc, 12);
  view.setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

function webpLossy(width: number, height: number) {
  // 3-byte frame tag, the keyframe start code, then 14-bit LE width/height.
  const payload = new Uint8Array(10);
  payload.set([0x9d, 0x01, 0x2a], 3);
  const view = new DataView(payload.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return riffWebp("VP8 ", payload);
}

function webpLossless(width: number, height: number) {
  // Signature byte, then width-1 and height-1 packed as 14 bits each.
  const payload = new Uint8Array(5);
  payload[0] = 0x2f;
  new DataView(payload.buffer).setUint32(1, (width - 1) | ((height - 1) << 14), true);
  return riffWebp("VP8L", payload);
}

function webpExtended(width: number, height: number) {
  // Flags and reserved bytes, then canvas width-1/height-1 as 24-bit LE.
  const payload = new Uint8Array(10);
  const w = width - 1;
  const h = height - 1;
  payload.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 4);
  payload.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 7);
  return riffWebp("VP8X", payload);
}

describe("readImageDimensions", () => {
  it("reads PNG", () => {
    expect(readImageDimensions(png(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  });
  it("reads JPEG SOF0", () => {
    expect(readImageDimensions(jpeg(1200, 628))).toEqual({ width: 1200, height: 628 });
  });
  it("reads GIF", () => {
    expect(readImageDimensions(gif(300, 250))).toEqual({ width: 300, height: 250 });
  });
  it("returns null for unknown bytes", () => {
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
  it("returns null when a header declares a zero dimension", () => {
    expect(readImageDimensions(png(0, 0))).toBeNull();
  });
  it("skips APP segments to reach SOF0", () => {
    expect(readImageDimensions(jpegWithApp0(1200, 628))).toEqual({ width: 1200, height: 628 });
  });
  it("returns null when the JPEG ends before SOF", () => {
    expect(readImageDimensions(jpegWithApp0(1200, 628).slice(0, 18))).toBeNull();
  });
  it("reads lossy WebP", () => {
    expect(readImageDimensions(webpLossy(1200, 628))).toEqual({ width: 1200, height: 628 });
  });
  it("reads lossless WebP", () => {
    expect(readImageDimensions(webpLossless(1080, 1080))).toEqual({ width: 1080, height: 1080 });
  });
  it("reads extended WebP", () => {
    expect(readImageDimensions(webpExtended(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  });
});

describe("studioFormatForDimensions", () => {
  it("maps taller than square to portrait", () => {
    expect(studioFormatForDimensions({ width: 1080, height: 1920 })).toBe("portrait");
  });
  it("maps square to square and anything slightly taller to portrait", () => {
    expect(studioFormatForDimensions({ width: 1080, height: 1080 })).toBe("square");
    expect(studioFormatForDimensions({ width: 1080, height: 1120 })).toBe("portrait");
  });
  it("maps wider than square to square, per the variations design", () => {
    expect(studioFormatForDimensions({ width: 1200, height: 628 })).toBe("square");
  });
  it("defaults to portrait when dimensions are unknown", () => {
    expect(studioFormatForDimensions(null)).toBe("portrait");
  });
});
