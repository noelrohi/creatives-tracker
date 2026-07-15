import { describe, expect, it } from "vitest";
import {
  rebrandElementSpecSchema,
  selectRotatingUntriedSwipes,
} from "@/lib/studio-suggestions";
import {
  ART_DIRECTIONS,
  artDirectionFor,
  buildPrompt,
  buildPromptRewrite,
  buildRebrandBrief,
  buildRebrandPrompt,
  buildWeeklySuggestionPrompt,
  classifyPromptClaims,
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
        prohibitedClaims: ["guaranteed cure"],
        requiredDisclaimers: ["Results vary"],
      },
      hasProductImage: true,
    });

    expect(system).toMatch(/BRAND section describes the advertiser/);
    expect(system).toMatch(/advertiser's own product photo/);
    expect(system).toMatch(/markings from the product notes/);
    expect(system).toContain("CLAIMS GUARDRAIL");
    expect(system).toContain("guaranteed cure");
    expect(system).toContain("Results vary");
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

describe("Weekly and rebrand prompt builders", () => {
  it("includes skips, Good/Bad tallies, untried swipes, and angle copy as tone reference", () => {
    const prompt = buildWeeklySuggestionPrompt({
      winners: [
        { name: "Winner A", angle: "Problem first", roas: "4.2", trend: "rising" },
      ],
      skips: [{ title: "Skipped testimonial", angle: "Social proof" }],
      tallies: [
        { angle: "Problem first", style: "Us vs. them", good: 4, bad: 1 },
      ],
      untriedSwipes: [
        {
          id: "swipe_1",
          brandName: "Competitor",
          angle: "Vs. the expensive fix",
          style: "Before / after",
        },
      ],
      copyPackages: [
        {
          angle: "Problem first",
          name: "Winner voice",
          primaryText: "This is the proven primary text.",
          headline: "Proven headline",
          description: "Proven description",
        },
      ],
      visualStyles: ["Before / after", "Us vs. them"],
    });

    expect(prompt).toContain("recent 14 days with the prior 14");
    expect(prompt).toContain('"trend": "rising"');
    expect(prompt).toContain("SKIP HISTORY");
    expect(prompt).toContain("Skipped testimonial");
    expect(prompt).toContain("GOOD/BAD TALLIES");
    expect(prompt).toContain('"good": 4');
    expect(prompt).toContain('"bad": 1');
    expect(prompt).toContain("UNTRIED SWIPES");
    expect(prompt).toContain("swipe_1");
    expect(prompt).toContain("AVAILABLE VISUAL STYLES");
    expect(prompt).toContain("Us vs. them");
    expect(prompt).toContain("ANGLE COPY PACKAGES (TONE REFERENCE)");
    expect(prompt).toContain("This is the proven primary text.");
  });

  it("includes the brand profile when one exists", () => {
    const prompt = buildWeeklySuggestionPrompt({
      winners: [],
      skips: [],
      tallies: [],
      untriedSwipes: [],
      copyPackages: [],
      brand: {
        brandName: "Tahan",
        productDescription: "A solo-living starter kit",
        offer: "20% off the first order",
      },
    });

    expect(prompt).toContain("BRAND");
    expect(prompt).toContain("Tahan — A solo-living starter kit");
    expect(prompt).toContain("Offer: 20% off the first order");
  });

  it("includes freshness, granular market, hook tallies, and claims context", () => {
    const prompt = buildWeeklySuggestionPrompt({
      winners: [],
      skips: [],
      tallies: [
        {
          angle: "Problem first",
          style: "Native",
          hook: "Question",
          good: 2,
          bad: 1,
        },
      ],
      untriedSwipes: [],
      copyPackages: [],
      brand: {
        brandName: "Reviv",
        productDescription: "A wellness sleeve",
        prohibitedClaims: ["cures arthritis"],
        requiredDisclaimers: ["Results vary"],
      },
      marketResults: [
        { angle: "Problem first", shipped: 2, avgRoas: 2.4, spend: 500 },
      ],
      topVariants: [
        {
          creativeName: "REVIV-ST-problem-first-abc123",
          roas: 3.1,
          purchases: 18,
          trend: "rising",
        },
      ],
      recentMade: [
        { angle: "Problem first", style: "Native", hook: "Question" },
      ],
      notTriedLately: [
        { kind: "hook_type", name: "Curiosity" },
      ],
    });

    expect(prompt).toContain('"hook": "Question"');
    expect(prompt).toContain("RECENTLY MADE");
    expect(prompt).toContain("do not re-propose near-duplicates");
    expect(prompt).toContain("NOT TRIED LATELY");
    expect(prompt).toContain("about one exploration card per week");
    expect(prompt).toContain("TOP PROVEN VARIANTS");
    expect(prompt).toContain('"creativeName": "REVIV-ST-problem-first-abc123"');
    expect(prompt).toContain("CLAIMS GUARDRAIL");
    expect(prompt).toContain("Never state or imply: cures arthritis");
    expect(prompt).toContain("Results vary");
  });

  it("rotates untried swipes as two newest plus two oldest without duplicates", () => {
    const rows = ["new-1", "new-2", "middle", "old-2", "old-1"].map(
      (id) => ({ id }),
    );
    expect(selectRotatingUntriedSwipes(rows).map((row) => row.id)).toEqual([
      "new-1",
      "new-2",
      "old-1",
      "old-2",
    ]);
    expect(
      selectRotatingUntriedSwipes(rows.slice(0, 3)).map((row) => row.id),
    ).toEqual(["new-1", "new-2", "middle"]);
  });

  it("classifies a first claims hit as retry and a second hit as claims failure", () => {
    const first = classifyPromptClaims({
      prompts: ["A sleeve that cures arthritis."],
      prohibitedClaims: ["cures arthritis"],
      retried: false,
    });
    expect(first).toMatchObject({
      action: "retry",
      violations: ["cures arthritis"],
    });
    expect(first.retryInstruction).toContain('"cures arthritis"');

    expect(
      classifyPromptClaims({
        prompts: ["Still cures arthritis."],
        prohibitedClaims: ["cures arthritis"],
        retried: true,
      }),
    ).toMatchObject({ action: "claims" });
  });

  it("includes shipped market results and tells the model to trust them", () => {
    const prompt = buildWeeklySuggestionPrompt({
      winners: [],
      skips: [],
      tallies: [],
      untriedSwipes: [],
      copyPackages: [],
      marketResults: [
        { angle: "jaw health", shipped: 2, avgRoas: 2.8, spend: 640 },
      ],
    });

    expect(prompt).toContain("MARKET RESULTS (SHIPPED STUDIO IMAGES)");
    expect(prompt).toContain('"avgRoas": 2.8');
    expect(prompt).toContain("trust the market results");

    const withoutMarket = buildWeeklySuggestionPrompt({
      winners: [],
      skips: [],
      tallies: [],
      untriedSwipes: [],
      copyPackages: [],
    });
    expect(withoutMarket).not.toContain("MARKET RESULTS (SHIPPED STUDIO IMAGES)");
  });

  it("rebrands toward our brand, away from the swiped brand", () => {
    const brief = buildRebrandBrief({
      brandName: "Tahan",
      sourceBrandName: "Competitor",
    });

    expect(brief).toBe(
      "Recreate this Competitor ad for Tahan using our own product, offer, and customer imagery.",
    );
    expect(buildRebrandBrief()).toContain("for our brand");
  });

  it("makes replacement of reference branding, product, likeness, and copy explicit", () => {
    const prompt = buildRebrandPrompt({
      brief: "Recreate this ad for our brand.",
      elements: {
        headline: { action: "change", value: "Use our headline" },
        heroImage: { action: "change", value: "Use our customer" },
        background: { action: "keep" },
        offer: { action: "change", value: "Use our guarantee" },
        cta: { action: "change", value: "Use our CTA" },
        brandMarks: { action: "change", value: "Use our logo" },
      },
      brand: {
        prohibitedClaims: ["pain free forever"],
        requiredDisclaimers: ["Results vary"],
      },
    });

    expect(prompt).toMatch(/replace ALL branding, logos, products/i);
    expect(prompt).toMatch(/recognizable likenesses/i);
    expect(prompt).toMatch(/offers, and copy with ours/i);
    expect(prompt).toMatch(/Never preserve or redraw the competitor/i);
    expect(prompt).toContain("CLAIMS GUARDRAIL");
    expect(prompt).toContain("pain free forever");
    expect(prompt).toContain("Results vary");
  });

  it("writes the element spec as prose, not JSON", () => {
    const prompt = buildRebrandPrompt({
      brief: "Recreate this ad for our brand.",
      elements: {
        headline: { action: "change", value: "Use our headline" },
        heroImage: { action: "change", value: "Use our customer" },
        background: { action: "keep" },
        offer: { action: "change", value: "Use our guarantee" },
        cta: { action: "change", value: "Use our CTA" },
        socialProof: { action: "change", value: "Use 2,000 reviews" },
        priceFraming: { action: "keep", value: "$1 per day" },
      },
    });

    expect(prompt).toContain("Element spec: headline — change: Use our headline");
    expect(prompt).toContain("background — keep: keep from the reference");
    expect(prompt).toContain("social proof — change: Use 2,000 reviews");
    expect(prompt).toContain("price framing — keep: $1 per day");
    expect(prompt).not.toContain('"action"');
  });

  it("parses the vision-written element spec shape", () => {
    expect(
      rebrandElementSpecSchema.parse({
        headline: { action: "change", value: "Our hook" },
        heroImage: { action: "change", value: "Our customer" },
        background: { action: "keep", value: "Keep the split layout" },
        offer: { action: "change", value: "Our offer" },
        cta: { action: "change", value: "Our CTA" },
        brandMarks: { action: "change", value: "Remove every source logo" },
        product: { action: "change", value: "Use our product" },
        copy: { action: "change", value: "Use our words" },
        socialProof: null,
        priceFraming: null,
      }),
    ).toMatchObject({
      background: { action: "keep" },
      brandMarks: { action: "change" },
      socialProof: null,
      priceFraming: null,
    });
  });
});
