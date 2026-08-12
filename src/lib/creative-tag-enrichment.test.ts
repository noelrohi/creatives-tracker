import { describe, expect, it } from "vitest";
import {
  buildCreativeTagUpdate,
  clampConfidence,
  resolveFunnelStageVerdicts,
  type AttributesMeta,
  type CreativeTagModelOutput,
} from "./creative-tag-enrichment";
import type { CreativeAttributes } from "@/schema/ad-creative";

function modelOutput(
  overrides: Partial<CreativeTagModelOutput> = {},
): CreativeTagModelOutput {
  return {
    persona: "post-partum mothers",
    angle: "problem_solution",
    awarenessLevel: "problem_aware",
    confidence: { persona: 0.8, angle: 0.9, awarenessLevel: 0.6 },
    attributes: {
      visualElements: ["product shot", "before/after"],
      visualStyle: "ugc_photo",
      mode: "light",
      hook: "Creams did nothing.",
      supportingTexts: ["Visible in 4 weeks"],
      cta: "Shop now",
      promos: "20% off",
      disclaimer: "Results vary",
      ...(overrides.attributes ?? {}),
    },
    ...overrides,
    ...(overrides.confidence ? { confidence: overrides.confidence } : {}),
  };
}

function existing(
  overrides: Partial<{
    persona: string | null;
    angle: string | null;
    awarenessLevel: string | null;
    attributes: CreativeAttributes | null;
    attributesMeta: AttributesMeta | null;
  }> = {},
) {
  return {
    persona: null,
    angle: null,
    awarenessLevel: null,
    attributes: {},
    attributesMeta: {},
    ...overrides,
  };
}

describe("buildCreativeTagUpdate", () => {
  it("writes the enforced trio with per-field ai provenance and confidence", () => {
    const update = buildCreativeTagUpdate({
      existing: existing(),
      output: modelOutput(),
    });

    expect(update.changed).toBe(true);
    expect(update.persona).toBe("post-partum mothers");
    expect(update.angle).toBe("problem_solution");
    expect(update.awarenessLevel).toBe("problem_aware");
    expect(update.attributesMeta.persona).toEqual({ source: "ai", confidence: 0.8 });
    expect(update.attributesMeta.angle).toEqual({ source: "ai", confidence: 0.9 });
    expect(update.attributesMeta.awarenessLevel).toEqual({
      source: "ai",
      confidence: 0.6,
    });
  });

  it("writes all eight captured attributes into the blob without confidence", () => {
    const update = buildCreativeTagUpdate({
      existing: existing(),
      output: modelOutput(),
    });

    expect(update.attributes).toEqual({
      visualElements: ["product shot", "before/after"],
      visualStyle: "ugc_photo",
      mode: "light",
      hook: "Creams did nothing.",
      supportingTexts: ["Visible in 4 weeks"],
      cta: "Shop now",
      promos: "20% off",
      disclaimer: "Results vary",
    });
    expect(update.attributesMeta.hook).toEqual({ source: "ai" });
    expect(update.attributesMeta.visualStyle).toEqual({ source: "ai" });
  });

  it("never overwrites a human-owned field, column or attribute", () => {
    const update = buildCreativeTagUpdate({
      existing: existing({
        persona: "hand written persona",
        angle: "education",
        attributes: { cta: "Human CTA" },
        attributesMeta: {
          persona: { source: "human" },
          angle: { source: "human" },
          cta: { source: "human" },
        },
      }),
      output: modelOutput(),
    });

    expect(update.persona).toBeUndefined();
    expect(update.angle).toBeUndefined();
    expect(update.attributes.cta).toBe("Human CTA");
    expect(update.attributesMeta.persona).toEqual({ source: "human" });
    expect(update.attributesMeta.cta).toEqual({ source: "human" });
    expect(update.skippedHuman).toEqual(
      expect.arrayContaining(["persona", "angle", "cta"]),
    );
    // The ai-owned awareness field is still refreshed.
    expect(update.awarenessLevel).toBe("problem_aware");
  });

  it("refreshes ai-sourced fields on a re-run", () => {
    const update = buildCreativeTagUpdate({
      existing: existing({
        angle: "education",
        attributesMeta: { angle: { source: "ai", confidence: 0.2 } },
      }),
      output: modelOutput(),
    });

    expect(update.angle).toBe("problem_solution");
    expect(update.attributesMeta.angle).toEqual({ source: "ai", confidence: 0.9 });
  });

  it("drops out-of-vocabulary values instead of storing them", () => {
    const update = buildCreativeTagUpdate({
      existing: existing(),
      output: modelOutput({
        angle: "fear_of_missing_out",
        awarenessLevel: "kinda_aware",
        attributes: {
          ...modelOutput().attributes,
          visualStyle: "watercolour",
          mode: "neon",
        },
      }),
    });

    expect(update.angle).toBeUndefined();
    expect(update.awarenessLevel).toBeUndefined();
    expect(update.attributes.visualStyle).toBeUndefined();
    expect(update.attributes.mode).toBeUndefined();
    expect(update.attributesMeta.angle).toBeUndefined();
    expect(update.rejected.map((entry) => entry.field).sort()).toEqual([
      "angle",
      "awarenessLevel",
      "mode",
      "visualStyle",
    ]);
    expect(update.rejected.find((entry) => entry.field === "angle")).toEqual({
      field: "angle",
      value: "fear_of_missing_out",
      confidence: 0.9,
    });
  });

  it("accepts vocabulary values in loose casing and separators", () => {
    const update = buildCreativeTagUpdate({
      existing: existing(),
      output: modelOutput({
        angle: "Social Proof",
        awarenessLevel: "Product-Aware",
        attributes: {
          ...modelOutput().attributes,
          visualStyle: "UGC photo",
          mode: "Coloured",
        },
      }),
    });

    expect(update.angle).toBe("social_proof");
    expect(update.awarenessLevel).toBe("product_aware");
    expect(update.attributes.visualStyle).toBe("ugc_photo");
    expect(update.attributes.mode).toBe("coloured");
  });

  it("records enforced null verdicts so they are not paid for again", () => {
    const update = buildCreativeTagUpdate({
      existing: existing({ attributes: { hook: "kept" } }),
      output: {
        persona: null,
        angle: null,
        awarenessLevel: null,
        confidence: { persona: null, angle: null, awarenessLevel: null },
        attributes: {
          visualElements: [],
          visualStyle: null,
          mode: null,
          hook: "   ",
          supportingTexts: null,
          cta: null,
          promos: null,
          disclaimer: null,
        },
      },
    });

    expect(update.changed).toBe(true);
    expect(update.attributes).toEqual({ hook: "kept" });
    expect(update.attributesMeta).toEqual({
      persona: { source: "ai" },
      angle: { source: "ai" },
      awarenessLevel: { source: "ai" },
    });
  });

  it("stores a confidence-free provenance when confidence is unusable", () => {
    const update = buildCreativeTagUpdate({
      existing: existing(),
      output: modelOutput({
        confidence: { persona: null, angle: Number.NaN, awarenessLevel: 4 },
      }),
    });

    expect(update.attributesMeta.persona).toEqual({ source: "ai" });
    expect(update.attributesMeta.angle).toEqual({ source: "ai" });
    expect(update.attributesMeta.awarenessLevel).toEqual({
      source: "ai",
      confidence: 1,
    });
  });
});

describe("clampConfidence", () => {
  it("bounds to 0–1 and rejects non-numbers", () => {
    expect(clampConfidence(0.5)).toBe(0.5);
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(9)).toBe(1);
    expect(clampConfidence(null)).toBeNull();
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("resolveFunnelStageVerdicts", () => {
  it("accepts known ad sets with a valid stage and drops the rest", () => {
    const { accepted, rejected } = resolveFunnelStageVerdicts({
      knownAdSetIds: ["set_a", "set_b", "set_c", "set_d"],
      verdicts: [
        { adSetId: "set_a", funnelStage: "BOF", confidence: 0.95 },
        { adSetId: "set_b", funnelStage: null, confidence: 0.1 },
        { adSetId: "set_c", funnelStage: "middle", confidence: 0.4 },
        { adSetId: "set_unknown", funnelStage: "tof", confidence: 0.9 },
        { adSetId: "set_a", funnelStage: "tof", confidence: 0.9 },
        { adSetId: "set_d", funnelStage: "mof", confidence: null },
      ],
    });

    expect(accepted).toEqual([
      { adSetId: "set_a", funnelStage: "bof", confidence: 0.95 },
      { adSetId: "set_b", funnelStage: null, confidence: 0.1 },
      { adSetId: "set_d", funnelStage: "mof", confidence: null },
    ]);
    expect(rejected).toEqual([
      { field: "funnelStage:set_c", value: "middle", confidence: 0.4 },
    ]);
  });
});
