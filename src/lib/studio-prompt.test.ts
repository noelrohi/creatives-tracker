import { describe, expect, it } from "vitest";
import {
  ART_DIRECTIONS,
  artDirectionFor,
  buildPrompt,
  buildPromptRewrite,
  isSupportedStudioSize,
  studioDimensions,
  studioSizeFor,
} from "./studio-prompt";

describe("Studio image dimensions", () => {
  it("maps the primary aspect-ratio presets to model dimensions", () => {
    expect(studioSizeFor("square")).toBe("1024x1024");
    expect(studioSizeFor("widescreen")).toBe("1536x864");
    expect(studioSizeFor("vertical")).toBe("864x1536");
  });

  it.each(["1536x864", "1024x1536", "2048x2048", "3840x2160"])(
    "accepts supported custom size %s",
    (size) => expect(isSupportedStudioSize(size)).toBe(true),
  );

  it.each([
    "1537x864",
    "4096x2160",
    "3840x1024",
    "512x512",
    "3840x3840",
  ])("rejects unsupported custom size %s", (size) => {
    expect(isSupportedStudioSize(size)).toBe(false);
  });

  it("returns custom dimensions unchanged", () => {
    expect(studioDimensions("1280x800")).toEqual({ width: 1280, height: 800 });
  });
});

describe("Studio prompt building", () => {
  it("keeps the fallback prompt free of pixel sizes and generic style words", () => {
    const prompt = buildPrompt({
      brief: "Compression sleeve for runners",
      angle: "creams don't work",
      format: "portrait",
    });

    expect(prompt).toContain("Brief: Compression sleeve for runners");
    expect(prompt).toContain("Angle: creams don't work");
    expect(prompt).not.toContain("1024");
    expect(prompt).not.toMatch(/premium|polished/i);
  });

  it("rotates art directions only for multi-variant runs without references", () => {
    expect(artDirectionFor(2, 4, false)).toBe(ART_DIRECTIONS[2]);
    expect(artDirectionFor(0, 1, false)).toBeNull();
    expect(artDirectionFor(2, 4, true)).toBeNull();
  });

  it("tells the rewriter to keep the reference layout when references exist", () => {
    const withReference = buildPromptRewrite({
      brief: "Recreate this ad for our brand.",
      count: 3,
      hasReferenceImages: true,
    });
    const withoutReference = buildPromptRewrite({
      brief: "Compression sleeve for runners",
      count: 4,
      awarenessLevel: "problem_aware",
      hasReferenceImages: false,
    });

    expect(withReference.system).toContain("Return exactly 3 prompts");
    expect(withReference.system).toMatch(/keeps the reference's layout/);
    expect(withReference.system).toMatch(/never the layout/);
    expect(withReference.prompt).toContain("REFERENCE IMAGES PROVIDED: yes");

    expect(withoutReference.system).toContain("Return exactly 4 prompts");
    expect(withoutReference.system).toMatch(/distinct concept/);
    expect(withoutReference.system).not.toMatch(/keeps the reference's layout/);
    expect(withoutReference.prompt).toContain("AWARENESS LEVEL: problem aware");
    expect(withoutReference.prompt).toContain("REFERENCE IMAGES PROVIDED: no");
  });

  it("hands the rewriter the brand profile and product-photo rule", () => {
    const { system, prompt } = buildPromptRewrite({
      brief: "Recreate this ad for Tahan.",
      count: 3,
      hasReferenceImages: true,
      brand: {
        brandName: "Tahan",
        productDescription: "A solo-living starter kit",
        offer: "20% off",
        productNotes: 'Shallow "Tahan" wordmark debossed on the lid',
      },
      hasProductImage: true,
    });

    expect(system).toMatch(/BRAND section describes the advertiser/);
    expect(system).toMatch(/advertiser's own product photo/);
    expect(system).toMatch(/markings from the product notes/);
    expect(prompt).toContain("Tahan — A solo-living starter kit");
    expect(prompt).toContain("Offer: 20% off");
    expect(prompt).toContain(
      'Product notes: Shallow "Tahan" wordmark debossed on the lid',
    );
    expect(prompt).toContain("PRODUCT PHOTO PROVIDED: yes");
  });

  it("adds brand details to the fallback prompt", () => {
    const prompt = buildPrompt({
      brief: "Compression sleeve for runners",
      brand: {
        brandName: "Tahan",
        productDescription: "A solo-living starter kit",
      },
    });

    expect(prompt).toContain("Brand: Tahan — A solo-living starter kit");
  });
});
