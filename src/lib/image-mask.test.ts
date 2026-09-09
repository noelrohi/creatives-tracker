import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildKeepMask,
  clampRegion,
  encodePng,
  expandRegion,
  MASK_MARGIN,
  productRegionSchema,
} from "./image-mask";

/** Test-only PNG reader for the exact encoder this module writes (8-bit RGBA, filter 0). */
function readRgba(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect(png[offset + 16]).toBe(8); // bit depth
      expect(png[offset + 17]).toBe(6); // RGBA
    }
    if (type === "IDAT") idat.push(data);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0).toBe(
      view.getUint32(offset + 8 + length),
    );
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const stride = width * 4 + 1;
  const alphaAt = (x: number, y: number) => raw[y * stride + 1 + x * 4 + 3];
  return { width, height, alphaAt };
}

describe("productRegionSchema", () => {
  it("accepts a normalized box and rejects empty or out-of-range ones", () => {
    expect(productRegionSchema.safeParse({ x: 0.5, y: 0.6, w: 0.3, h: 0.3 }).success).toBe(true);
    expect(productRegionSchema.safeParse({ x: 0.5, y: 0.6, w: 0, h: 0.3 }).success).toBe(false);
    expect(productRegionSchema.safeParse({ x: 0.9, y: 0.6, w: 0.3, h: 0.3 }).success).toBe(false);
    expect(productRegionSchema.safeParse({ x: -0.1, y: 0, w: 0.5, h: 0.5 }).success).toBe(false);
  });
});

describe("expandRegion / clampRegion", () => {
  it("expands by the margin on every side and clamps to the canvas", () => {
    expect(expandRegion({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toEqual({
      x: 0.5 - MASK_MARGIN, y: 0.5 - MASK_MARGIN, w: 0.2 + 2 * MASK_MARGIN, h: 0.2 + 2 * MASK_MARGIN,
    });
    expect(expandRegion({ x: 0.9, y: 0, w: 0.1, h: 0.1 })).toEqual({
      x: 0.9 - MASK_MARGIN, y: 0, w: 0.1 + MASK_MARGIN, h: 0.1 + MASK_MARGIN,
    });
    expect(clampRegion({ x: -0.2, y: 0.5, w: 2, h: 1 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});

describe("encodePng", () => {
  it("round-trips a tiny RGBA image", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]); // 2x1: opaque red, transparent
    const { width, height, alphaAt } = readRgba(encodePng(2, 1, rgba));
    expect([width, height]).toEqual([2, 1]);
    expect([alphaAt(0, 0), alphaAt(1, 0)]).toEqual([255, 0]);
  });

  it("rejects zero or non-integer dimensions", () => {
    expect(() => encodePng(0, 0, new Uint8Array(0))).toThrow(/positive integer/);
    expect(() => encodePng(10.5, 10, new Uint8Array(420))).toThrow(/positive integer/);
  });
});

describe("buildKeepMask", () => {
  it("is opaque inside the expanded keep box and transparent outside", () => {
    const png = buildKeepMask({ width: 100, height: 200, keep: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } });
    const { width, height, alphaAt } = readRgba(png);
    expect([width, height]).toEqual([100, 200]);
    expect(alphaAt(60, 120)).toBe(255); // inside
    expect(alphaAt(48, 120)).toBe(255); // inside the 3% margin (x from 47 to 73)
    expect(alphaAt(10, 10)).toBe(0); // outside
    expect(alphaAt(99, 199)).toBe(0);
  });

  it("is fully transparent when there is nothing to keep", () => {
    const { alphaAt } = readRgba(buildKeepMask({ width: 4, height: 4, keep: null }));
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(3, 3)).toBe(0);
  });

  it("inverts polarity when asked (edit only inside the box)", () => {
    const { alphaAt } = readRgba(
      buildKeepMask({ width: 100, height: 100, keep: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, invert: true }),
    );
    expect(alphaAt(60, 60)).toBe(0);
    expect(alphaAt(10, 10)).toBe(255);
  });

  it("clamps an out-of-range region before expanding it", () => {
    const empty = readRgba(
      buildKeepMask({ width: 20, height: 20, keep: { x: 2, y: 2, w: 0.1, h: 0.1 } }),
    );
    expect(empty.alphaAt(0, 0)).toBe(0);
    expect(empty.alphaAt(19, 19)).toBe(0);

    const cornered = readRgba(
      buildKeepMask({ width: 20, height: 20, keep: { x: 0.9, y: 0.9, w: 5, h: 5 } }),
    );
    expect(cornered.alphaAt(19, 19)).toBe(255);
    expect(cornered.alphaAt(0, 0)).toBe(0);

    // A negative origin is the case only the clamp fixes: without it the
    // expanded box inverts and protects nothing.
    const offCanvas = readRgba(
      buildKeepMask({ width: 20, height: 20, keep: { x: -0.5, y: 0.5, w: 0.2, h: 0.2 } }),
    );
    expect(offCanvas.alphaAt(0, 10)).toBe(255); // clamped back onto the left edge
    expect(offCanvas.alphaAt(3, 10)).toBe(255);
    expect(offCanvas.alphaAt(6, 10)).toBe(0);
    expect(offCanvas.alphaAt(0, 0)).toBe(0);
  });
});
