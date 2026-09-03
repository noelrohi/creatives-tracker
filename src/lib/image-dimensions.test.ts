import { describe, expect, it } from "vitest";
import { readImageDimensions, studioFormatForDimensions } from "./image-dimensions";

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
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
});

describe("studioFormatForDimensions", () => {
  it("maps taller than square to portrait", () => {
    expect(studioFormatForDimensions({ width: 1080, height: 1920 })).toBe("portrait");
  });
  it("maps near-square to square", () => {
    expect(studioFormatForDimensions({ width: 1080, height: 1080 })).toBe("square");
    expect(studioFormatForDimensions({ width: 1080, height: 1120 })).toBe("square");
  });
  it("maps wider than square to landscape", () => {
    expect(studioFormatForDimensions({ width: 1200, height: 628 })).toBe("landscape");
  });
  it("defaults to portrait when dimensions are unknown", () => {
    expect(studioFormatForDimensions(null)).toBe("portrait");
  });
});
