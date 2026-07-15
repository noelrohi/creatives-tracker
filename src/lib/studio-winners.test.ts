import { describe, expect, it } from "vitest";
import {
  classifyTrend,
  classifyWatchListAction,
  classifyWinnerEvidence,
  selectStudioWinners,
  WINNER_MAX_PER_ANGLE,
} from "@/lib/studio-winners";

type Candidate = {
  id: string;
  assetUrl: string | null;
  angle: string | null;
  format?: string | null;
  spend: number;
  purchases: number;
  roas: number;
};

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    assetUrl: `https://example.com/${id}.jpg`,
    angle: `Angle ${id}`,
    spend: 200,
    purchases: 4,
    roas: 2,
    ...overrides,
  };
}

describe("selectStudioWinners", () => {
  it("excludes a tiny-spend fluke when another candidate passes the floor", () => {
    const winners = selectStudioWinners([
      candidate("fluke", { spend: 20, purchases: 1, roas: 30 }),
      candidate("proven", { spend: 500, purchases: 8, roas: 3 }),
    ]);

    expect(winners.map((winner) => winner.id)).toEqual(["proven"]);
  });

  it("falls back to active candidates when none pass the floor", () => {
    const winners = selectStudioWinners([
      candidate("small", { spend: 30, purchases: 1 }),
      candidate("inactive", { spend: 0, purchases: 0, roas: 10 }),
    ]);

    expect(winners.map((winner) => winner.id)).toEqual(["small"]);
  });

  it("skips video and ugc creatives entirely, even in the fallback pool", () => {
    const winners = selectStudioWinners([
      candidate("video-top", { format: "video", spend: 5000, purchases: 40, roas: 6 }),
      candidate("ugc-top", { format: "ugc", spend: 4000, purchases: 30, roas: 5 }),
      candidate("static", { format: "static", spend: 300, purchases: 5, roas: 2 }),
    ]);
    expect(winners.map((winner) => winner.id)).toEqual(["static"]);

    const fallbackOnly = selectStudioWinners([
      candidate("video-small", { format: "video", spend: 40, purchases: 1, roas: 8 }),
      candidate("static-small", { format: "static", spend: 30, purchases: 1, roas: 2 }),
    ]);
    expect(fallbackOnly.map((winner) => winner.id)).toEqual(["static-small"]);
  });

  it("deduplicates asset URLs and keeps the higher-spend row", () => {
    const assetUrl = "https://example.com/shared.jpg";
    const winners = selectStudioWinners([
      candidate("lower", { assetUrl, spend: 200, roas: 5 }),
      candidate("higher", { assetUrl, spend: 600, roas: 2 }),
    ]);

    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe("higher");
  });

  it("caps winners from the same normalized angle bucket", () => {
    const winners = selectStudioWinners([
      candidate("one", { angle: "Problem first", roas: 6 }),
      candidate("two", { angle: " problem FIRST ", roas: 5 }),
      candidate("three", { angle: "PROBLEM FIRST", roas: 4 }),
      candidate("other", { angle: "Social proof", roas: 3 }),
    ]);

    expect(
      winners.filter(
        (winner) => winner.angle?.trim().toLowerCase() === "problem first",
      ),
    ).toHaveLength(WINNER_MAX_PER_ANGLE);
    expect(winners.map((winner) => winner.id)).toContain("other");
  });

  it("lets sustained spend outweigh a small high-ROAS result", () => {
    const winners = selectStudioWinners([
      candidate("small-high-roas", { spend: 100, roas: 10 }),
      candidate("scaled-moderate-roas", { spend: 10_000, roas: 6 }),
    ]);

    expect(winners[0].id).toBe("scaled-moderate-roas");
    expect(winners[0].score).toBeGreaterThan(winners[1].score);
  });
});

describe("winner evidence", () => {
  it("classifies 9 purchases as thin and 10 as confident", () => {
    expect(classifyWinnerEvidence(9)).toBe("thin");
    expect(classifyWinnerEvidence(10)).toBeNull();
  });

  it("keeps, promotes, or drops thin cards from current market evidence", () => {
    expect(classifyWatchListAction({ purchases: 9, trend: "stable" })).toBe(
      "keep",
    );
    expect(classifyWatchListAction({ purchases: 10, trend: "declining" })).toBe(
      "promote",
    );
    expect(classifyWatchListAction({ purchases: 9, trend: "declining" })).toBe(
      "drop",
    );
    expect(classifyWatchListAction({ purchases: 9, trend: "paused" })).toBe(
      "drop",
    );
  });
});

describe("classifyTrend", () => {
  it("classifies paused, rising, declining, and stable outcomes", () => {
    expect(classifyTrend({ recentRoas: 8, priorRoas: 4, recentSpend: 0.5 })).toBe(
      "paused",
    );
    expect(classifyTrend({ recentRoas: 2, priorRoas: 0, recentSpend: 10 })).toBe(
      "rising",
    );
    expect(classifyTrend({ recentRoas: 2.8, priorRoas: 4, recentSpend: 10 })).toBe(
      "declining",
    );
    expect(classifyTrend({ recentRoas: 4.4, priorRoas: 4, recentSpend: 10 })).toBe(
      "stable",
    );
  });
});
