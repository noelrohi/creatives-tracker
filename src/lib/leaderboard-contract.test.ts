import { describe, expect, it } from "vitest";
import { leaderboardMetadata, leaderboardMetadataSchema } from "./leaderboard-contract";

const input = {
  sortBy: "roas" as const, limit: 3, includeSurviving: false,
  includePortfolio: false, fairShotSpend: null, topIds: ["a"],
  survivingCount: 0, bottomCount: 0,
};

describe("leaderboard qualification and sample contract", () => {
  it("labels observedDays as reporting starts rather than calendar coverage", () => {
    const description = leaderboardMetadataSchema.shape.samples.element.shape.observedDays.description;
    expect(description).toContain("distinct observed performance_log.date_start");
    expect(description).toContain("not calendar-day coverage");
    expect(description).toContain("does not establish gap-free ingestion");
  });

  it.each([null, 0, 1, 9, 10, 100])("discloses conversion sample %s without treating a warning as qualification", (conversions) => {
    const result = leaderboardMetadataSchema.parse(leaderboardMetadata({
      ...input, rankingMode: "historical",
      topSamples: [{ creativeId: "a", conversions, impressions: null, observedDays: 2, adCount: 1 }],
    }));
    expect(result.samples[0]).toEqual({
      creativeId: "a", conversions, impressions: null, observedDays: 2, adCount: 1,
      warnings: conversions === null ? ["unknown_conversion_sample"] : conversions < 10 ? ["low_conversion_sample"] : [],
    });
    expect(result.qualification.minConversions).toBeNull();
    expect(result.topPerformers.returnedCount).toBe(1);
    expect(result.topPerformers.appliedFilters).not.toContain("statuses");
  });

  it("preserves default operational qualification and deterministic ordering", () => {
    const result = leaderboardMetadataSchema.parse(leaderboardMetadata(input));
    expect(result.rankingMode).toBe("current_active");
    expect(result.qualification.requiresCurrentlyActiveAd).toBe(true);
    expect(result.topPerformers.appliedFilters).toContain("statuses");
    expect(result.topPerformers.ordering.map((item) => item.metric)).toEqual(["roas", "conversions", "creativeId"]);
    expect(result.samples).toEqual([]);
  });
});
