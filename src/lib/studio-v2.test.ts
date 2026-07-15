import { describe, expect, it } from "vitest";
import { rebrandElementSpecSchema } from "@/lib/studio-suggestions";
import {
  buildRebrandBrief,
  buildRebrandPrompt,
  buildWeeklySuggestionPrompt,
} from "@/lib/studio-v2";

describe("Studio v2 prompt builders", () => {
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
    });

    expect(prompt).toMatch(/replace ALL branding, logos, products/i);
    expect(prompt).toMatch(/recognizable likenesses/i);
    expect(prompt).toMatch(/offers, and copy with ours/i);
    expect(prompt).toMatch(/Never preserve or redraw the competitor/i);
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
      },
    });

    expect(prompt).toContain("Element spec: headline — change: Use our headline");
    expect(prompt).toContain("background — keep: keep from the reference");
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
      }),
    ).toMatchObject({
      background: { action: "keep" },
      brandMarks: { action: "change" },
    });
  });
});
