import { describe, expect, it } from "vitest";
import { isStaticImageCreative, isVideoFile } from "./studio-assets";

describe("isStaticImageCreative", () => {
  it("accepts a static creative with an image asset", () => {
    expect(isStaticImageCreative({ format: "static", assetUrl: "https://cdn.test/a.png" })).toBe(true);
  });
  it("rejects video formats, video files, missing assets, and missing creatives", () => {
    expect(isStaticImageCreative({ format: "video", assetUrl: "https://cdn.test/a.png" })).toBe(false);
    expect(isStaticImageCreative({ format: "static", assetUrl: "https://cdn.test/a.mp4?x=1" })).toBe(false);
    expect(isStaticImageCreative({ format: "static", assetUrl: null })).toBe(false);
    expect(isStaticImageCreative(null)).toBe(false);
    expect(isStaticImageCreative(undefined)).toBe(false);
  });
});

describe("isVideoFile", () => {
  it("matches mp4, mov, and webm with or without a query string", () => {
    expect(isVideoFile("https://x/a.mov")).toBe(true);
    expect(isVideoFile("https://x/a.webm?v=2")).toBe(true);
    expect(isVideoFile("https://x/a.png")).toBe(false);
    expect(isVideoFile(null)).toBe(false);
  });
});
