import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  CREATIVE_VARIANT_PROMPT_VERSION,
  buildVariantGenerationPrompt,
  isWinnerCandidate,
  normalizeGeneratedVariants,
} from "./creative-recommendations";
import {
  creativeFormatMergeSql,
  mergeCreativeFormat,
  normalizeIncomingCreativeFormat,
} from "./creative-recommendation-policy";

function compileSql(query: SQL): string {
  return new PgDialect().sqlToQuery(query).sql;
}

const validVariant = {
  variantName: "Hook shift",
  primaryText: "You noticed the problem. This is the next step.",
  headline: "A cleaner daily routine",
  hook: "Stop ignoring the signal",
  cta: "Shop Now",
  visualDirection: "Single-frame product close-up with a concise benefit overlay.",
  changeSummary: "Leads with the pain point instead of the benefit.",
  rationale: "Tests a more urgent opening while preserving the winning premise.",
};

describe("creative recommendation helpers", () => {
  describe("creative format merge policy", () => {
    it.each([
      [null, "static", undefined, "static"],
      [null, "ugc", undefined, "ugc"],
      [null, "carousel", undefined, "carousel"],
      ["static", "video", undefined, "video"],
      ["static", "static", "https://cdn.example.com/video.mp4", "video"],
      ["video", "static", undefined, "video"],
      ["ugc", "static", undefined, "ugc"],
      ["static", "carousel", undefined, "static"],
    ])(
      "merges existing=%s incoming=%s videoUrl=%s as %s",
      (existingFormat, incomingFormat, incomingVideoUrl, expected) => {
        expect(
          mergeCreativeFormat({ existingFormat, incomingFormat, incomingVideoUrl }),
        ).toBe(expected);
      },
    );

    it("normalizes incoming video URLs as video evidence", () => {
      expect(
        normalizeIncomingCreativeFormat({
          format: "static",
          videoUrl: " https://cdn.example.com/video.mp4 ",
        }),
      ).toBe("video");
    });

    it("promotes incoming video format in the SQL merge policy even without a video URL", () => {
      const expression = creativeFormatMergeSql({
        existingFormat: sql.raw("format"),
        incomingFormat: sql.raw("'video'"),
      });

      expect(compileSql(expression)).toContain("WHEN 'video' = $1 THEN $2::format");
    });
  });

  describe("isWinnerCandidate", () => {
    it("accepts active profitable ads with spend, conversions, and source context", () => {
      expect(
        isWinnerCandidate({
          format: "static",
          status: "active",
          spend: 50,
          roas: 1,
          conversions: 1,
          hasSourceContext: true,
          impressions: 1000,
          videoViews3s: 0,
          videoThruplay: 0,
          hasVideoAsset: false,
        }),
      ).toBe(true);
    });

    it("accepts tiny video-view noise on otherwise static creatives", () => {
      expect(
        isWinnerCandidate({
          format: "static",
          status: "active",
          spend: 100,
          roas: 2,
          conversions: 4,
          impressions: 8616,
          videoViews3s: 8,
          videoThruplay: 0,
          hasSourceContext: true,
          hasVideoAsset: false,
        }),
      ).toBe(true);
    });

    it.each([
      ["paused", { format: "static", status: "paused", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["low spend", { format: "static", status: "active", spend: 49.99, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["zero conversions", { format: "static", status: "active", spend: 100, roas: 2, conversions: 0, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["low ROAS", { format: "static", status: "active", spend: 100, roas: 0.99, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["missing context", { format: "static", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: false, hasVideoAsset: false }],
      ["static with video asset", { format: "static", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: true }],
      ["static with enough 3s views", { format: "static", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 10000, videoViews3s: 50, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["static with high 3s view rate", { format: "static", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 10, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["static with thruplay", { format: "static", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 1, videoThruplay: 1, hasSourceContext: true, hasVideoAsset: false }],
      ["video creative", { format: "video", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 50, videoThruplay: 1, hasSourceContext: true, hasVideoAsset: true }],
      ["UGC creative", { format: "ugc", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 50, videoThruplay: 1, hasSourceContext: true, hasVideoAsset: true }],
      ["carousel creative", { format: "carousel", status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
      ["unknown format", { format: null, status: "active", spend: 100, roas: 2, conversions: 4, impressions: 1000, videoViews3s: 0, videoThruplay: 0, hasSourceContext: true, hasVideoAsset: false }],
    ])("rejects %s", (_label, input) => {
      expect(isWinnerCandidate(input)).toBe(false);
    });
  });

  describe("normalizeGeneratedVariants", () => {
    it("accepts complete 3-4 variant payloads", () => {
      const variants = normalizeGeneratedVariants({
        variants: [validVariant, validVariant, validVariant, validVariant],
      });

      expect(variants).toHaveLength(4);
      expect(variants[0]).toMatchObject({ variantName: "Hook shift" });
    });

    it("rejects malformed or too-short outputs", () => {
      expect(() => normalizeGeneratedVariants({ variants: [validVariant, validVariant] }))
        .toThrow();
      expect(() => normalizeGeneratedVariants({ variants: [{ ...validVariant, headline: "" }, validVariant, validVariant] }))
        .toThrow();
    });

    it("rejects non-static visual directions", () => {
      expect(() =>
        normalizeGeneratedVariants({
          variants: [
            {
              ...validVariant,
              visualDirection: "UGC video script with a 0-3s hook, voiceover, and B-roll.",
            },
            validVariant,
            validVariant,
          ],
        }),
      ).toThrow(/static image or layout/);
    });
  });

  describe("buildVariantGenerationPrompt", () => {
    it("uses the static prompt version and asks for static creative directions", () => {
      const prompt = buildVariantGenerationPrompt({
        source: {
          creativeName: "Winning static",
          adName: "Winning ad",
          caption: "A source caption",
          format: "static",
          angle: "sleep quality",
          persona: "busy professionals",
          awarenessLevel: "problem_aware",
          hook: "Stop waking up tired",
          tone: ["clinical"],
          cta: "Shop Now",
          assetUrl: "https://example.com/source.jpg",
          videoUrl: null,
        },
        performance: {
          from: "2026-06-01",
          to: "2026-06-30",
          spend: 150,
          revenue: 450,
          roas: 3,
          conversions: 9,
          cpa: 16.67,
          ctr: 1.25,
        },
      });

      expect(CREATIVE_VARIANT_PROMPT_VERSION).toBe("static-winner-variant-v1");
      expect(prompt).toContain("static paid social ad variants");
      expect(prompt).toContain("Source static winner");
      expect(prompt).toContain("Asset URL: https://example.com/source.jpg");
      expect(prompt).toContain("visualDirection must describe one static creative direction");
      expect(prompt).toContain("Do not write video concepts, UGC scripts, carousel frames");
    });
  });
});
