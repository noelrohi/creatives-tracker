import { describe, expect, it } from "vitest";
import {
  type ScoredAdInput,
  scoreCluster,
  scoreCompetitorClusters,
  tierForScore,
} from "./score";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function ad(overrides: Partial<ScoredAdInput> = {}): ScoredAdInput {
  return {
    startDate: daysAgo(0),
    variantCount: 0,
    displayFormat: "IMAGE",
    hasVideo: false,
    hasImage: true,
    linkUrl: "https://acme.test/sleep",
    ...overrides,
  };
}

function points(input: Parameters<typeof scoreCluster>[0]) {
  return scoreCluster(input, NOW).points;
}

describe("scoreCluster (competitor-signals v1 §8)", () => {
  describe("longevity — 35 pts on a log curve", () => {
    // The spec's calibration checkpoints: linear was rejected because it gave
    // the best real cluster 2.4/35.
    it.each([
      [30, 19.1],
      [105, 25.9],
      [547, 35],
    ])("scores a %i-day-old cluster at ~%f", (days, expected) => {
      const result = points({ ads: [ad({ startDate: daysAgo(days) })], verdict: null });

      expect(result.longevity).toBeCloseTo(expected, 1);
    });

    it("caps longevity at 18 months", () => {
      const capped = points({ ads: [ad({ startDate: daysAgo(2000) })], verdict: null });

      expect(capped.longevity).toBe(35);
    });

    it("takes the oldest member ad, not the newest", () => {
      const result = points({
        ads: [ad({ startDate: daysAgo(1) }), ad({ startDate: daysAgo(105) })],
        verdict: null,
      });

      expect(result.longevity).toBeCloseTo(25.9, 1);
    });

    it("scores a brand-new cluster at 0", () => {
      expect(points({ ads: [ad()], verdict: null }).longevity).toBe(0);
    });
  });

  describe("variant multiplication — 25 pts", () => {
    it("counts primary + variants across member ads", () => {
      // 2 ads, 3 variants each → c = 8.
      const result = points({
        ads: [ad({ variantCount: 3 }), ad({ variantCount: 3 })],
        verdict: null,
      });

      expect(result.variant).toBeCloseTo(
        (Math.log(9) / Math.log(31)) * 25,
        6,
      );
    });

    it("caps the creative count at 30", () => {
      const atCap = points({ ads: [ad({ variantCount: 29 })], verdict: null });
      const overCap = points({ ads: [ad({ variantCount: 500 })], verdict: null });

      expect(atCap.variant).toBe(25);
      expect(overCap.variant).toBe(25);
    });
  });

  describe("strategic relevance — 15 pts", () => {
    it.each([
      ["high" as const, 15],
      ["medium" as const, 8],
      ["low" as const, 3],
    ])("maps verdict %s to %i pts", (verdict, expected) => {
      expect(points({ ads: [ad()], verdict }).strategic).toBe(expected);
    });

    it("scores a missing verdict at 0", () => {
      expect(points({ ads: [ad()], verdict: null }).strategic).toBe(0);
    });
  });

  describe("format breadth — 15 pts, 5 per distinct format", () => {
    it("counts distinct formats, not ads", () => {
      const one = points({ ads: [ad(), ad()], verdict: null });
      const two = points({
        ads: [ad(), ad({ displayFormat: "VIDEO", hasVideo: true })],
        verdict: null,
      });
      const three = points({
        ads: [
          ad(),
          ad({ displayFormat: "VIDEO", hasVideo: true }),
          ad({ displayFormat: "CAROUSEL" }),
        ],
        verdict: null,
      });

      expect(one.format).toBe(5);
      expect(two.format).toBe(10);
      expect(three.format).toBe(15);
    });

    it("resolves DCO to video when the ad carries video media", () => {
      const result = points({
        ads: [ad({ displayFormat: "DCO", hasVideo: true, hasImage: true })],
        verdict: null,
      });

      // Resolved to video only — pairing it with a VIDEO ad adds nothing.
      const withVideoAd = points({
        ads: [
          ad({ displayFormat: "DCO", hasVideo: true, hasImage: true }),
          ad({ displayFormat: "VIDEO", hasVideo: true }),
        ],
        verdict: null,
      });

      expect(result.format).toBe(5);
      expect(withVideoAd.format).toBe(5);
    });

    it("resolves DPA to image when the ad has no video", () => {
      const withImageAd = points({
        ads: [
          ad({ displayFormat: "DPA", hasVideo: false, hasImage: true }),
          ad({ displayFormat: "IMAGE" }),
        ],
        verdict: null,
      });

      expect(withImageAd.format).toBe(5);
    });

    it("ignores a container ad with no mirrored media at all", () => {
      const result = points({
        ads: [ad({ displayFormat: "DCO", hasVideo: false, hasImage: false })],
        verdict: null,
      });

      expect(result.format).toBe(0);
    });
  });

  describe("landing-page focus — 10 pts", () => {
    it("scores a single shared destination at the full 10", () => {
      expect(points({ ads: [ad(), ad()], verdict: null }).landing).toBe(10);
    });

    it("strips query strings and fragments before comparing", () => {
      const result = points({
        ads: [
          ad({ linkUrl: "https://acme.test/sleep?utm_source=fb" }),
          ad({ linkUrl: "https://acme.test/sleep?utm_source=ig&fbclid=123" }),
          ad({ linkUrl: "https://acme.test/sleep#reviews" }),
        ],
        verdict: null,
      });

      expect(result.landing).toBe(10);
    });

    it("scores the modal URL's share when ads split across pages", () => {
      const result = points({
        ads: [
          ad({ linkUrl: "https://acme.test/sleep" }),
          ad({ linkUrl: "https://acme.test/sleep?utm=1" }),
          ad({ linkUrl: "https://acme.test/sleep" }),
          ad({ linkUrl: "https://acme.test/other" }),
        ],
        verdict: null,
      });

      expect(result.landing).toBe(7.5);
    });

    it("counts an ad with no link against the share", () => {
      const result = points({
        ads: [ad(), ad({ linkUrl: null })],
        verdict: null,
      });

      expect(result.landing).toBe(5);
    });
  });

  describe("tiers", () => {
    it("puts exactly 65 in high and exactly 40 in moderate", () => {
      expect(tierForScore(65)).toBe("high");
      expect(tierForScore(64.999)).toBe("moderate");
      expect(tierForScore(40)).toBe("moderate");
      expect(tierForScore(39.999)).toBe("watch");
      expect(tierForScore(0)).toBe("watch");
    });

    it("derives the cluster's tier from its total score", () => {
      const strong = scoreCluster(
        {
          ads: [
            ad({ startDate: daysAgo(400), variantCount: 20 }),
            ad({ displayFormat: "VIDEO", hasVideo: true }),
            ad({ displayFormat: "CAROUSEL" }),
          ],
          verdict: "high",
        },
        NOW,
      );

      expect(strong.score).toBeGreaterThanOrEqual(65);
      expect(strong.tier).toBe("high");
      expect(strong.score).toBe(
        strong.points.longevity +
          strong.points.variant +
          strong.points.strategic +
          strong.points.format +
          strong.points.landing,
      );
    });
  });

  it("scores an empty cluster from the strategic verdict alone", () => {
    const result = scoreCluster({ ads: [], verdict: "high" }, NOW);

    expect(result.points).toEqual({
      longevity: 0,
      variant: 0,
      strategic: 15,
      format: 0,
      landing: 0,
    });
    expect(result.score).toBe(15);
    expect(result.tier).toBe("watch");
  });

  it("scores an empty, unjudged cluster at 0", () => {
    const result = scoreCluster({ ads: [], verdict: null }, NOW);

    expect(result.score).toBe(0);
    expect(result.tier).toBe("watch");
  });
});

describe("scoreCompetitorClusters", () => {
  it("maps DB rows onto per-cluster score updates", () => {
    const updates = scoreCompetitorClusters({
      clusters: [
        { id: "cluster-1", verdict: "high" },
        { id: "cluster-2", verdict: null },
      ],
      ads: [
        {
          copyClusterId: "cluster-1",
          startDate: daysAgo(105),
          displayFormat: "DCO",
          linkUrl: "https://acme.test/sleep?utm=1",
          variants: [{}, {}],
          mediaKinds: [],
          mirroredImageUrl: "https://blob.test/a.jpg",
          mirroredVideoUrl: "https://blob.test/a.mp4",
        },
        {
          copyClusterId: "cluster-2",
          startDate: daysAgo(30),
          displayFormat: "IMAGE",
          linkUrl: "https://acme.test/guard",
          variants: null,
          mediaKinds: [],
          mirroredImageUrl: "https://blob.test/b.jpg",
          mirroredVideoUrl: null,
        },
        // Unclustered ads contribute to nothing.
        {
          copyClusterId: null,
          startDate: daysAgo(500),
          displayFormat: "IMAGE",
          linkUrl: "https://acme.test/loose",
          variants: null,
          mediaKinds: [],
          mirroredImageUrl: null,
          mirroredVideoUrl: null,
        },
      ],
      now: NOW,
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      clusterId: "cluster-1",
      strategicPoints: 15,
      // DCO with video media → video only.
      formatPoints: 5,
      landingPoints: 10,
    });
    expect(updates[0].longevityPoints).toBeCloseTo(25.9, 1);
    // primary + 2 variants = 3 creatives.
    expect(updates[0].variantPoints).toBeCloseTo(
      (Math.log(4) / Math.log(31)) * 25,
      6,
    );

    expect(updates[1]).toMatchObject({
      clusterId: "cluster-2",
      strategicPoints: 0,
      formatPoints: 5,
      landingPoints: 10,
    });
    expect(updates[1].longevityPoints).toBeCloseTo(19.1, 1);
  });

  describe("container formats read the ad's own media, not the mirror", () => {
    // The bug this covers, seen on real data: the same 120 ads scored 5 points
    // higher in an org that had mirrored them on an earlier fill, because a DCO
    // resolved its format from the mirrored columns. Format breadth has to
    // describe the competitor, not our copy of their media.
    // A catalog-style container carrying only image creatives. This collector
    // returns no URL at all for images, so the mirror can never learn of them —
    // `mediaKinds` is the only thing that knows.
    const imageDco = (overrides: Record<string, unknown> = {}) => ({
      copyClusterId: "cluster-1",
      startDate: daysAgo(105),
      displayFormat: "DCO",
      linkUrl: "https://acme.test/sleep",
      variants: [{ media: null }],
      mediaKinds: ["image"],
      mirroredImageUrl: null,
      mirroredVideoUrl: null,
      ...overrides,
    });

    const videoAd = {
      copyClusterId: "cluster-1",
      startDate: daysAgo(105),
      displayFormat: "VIDEO",
      linkUrl: "https://acme.test/sleep",
      variants: null,
      mediaKinds: ["video"],
      mirroredImageUrl: null,
      mirroredVideoUrl: "https://blob.test/v.mp4",
    };

    const formatPointsFor = (...rows: Record<string, unknown>[]) =>
      scoreCompetitorClusters({
        clusters: [{ id: "cluster-1", verdict: null }],
        ads: rows as Parameters<typeof scoreCompetitorClusters>[0]["ads"],
        now: NOW,
      })[0].formatPoints;

    it("counts an image container the mirror never saw", () => {
      // Nothing mirrored at all, so the old code scored this cluster 5 (video
      // only, from the video ad). The competitor is plainly running both.
      expect(formatPointsFor(imageDco(), videoAd)).toBe(10);
    });

    it("scores the same ads identically whether or not they were mirrored", () => {
      // The regression itself: an org that mirrored on an earlier fill must not
      // out-score an org seeing the same ads for the first time.
      expect(formatPointsFor(imageDco(), videoAd)).toBe(
        formatPointsFor(
          imageDco({
            mirroredImageUrl: "https://blob.test/a.jpg",
            mirroredVideoUrl: "https://blob.test/a.mp4",
          }),
          videoAd,
        ),
      );
    });

    it("lets mediaKinds override what the mirror happens to hold", () => {
      // A mirrored video against an image-only ad: the ad wins.
      expect(
        formatPointsFor(
          imageDco({ mirroredVideoUrl: "https://blob.test/a.mp4" }),
          videoAd,
        ),
      ).toBe(10);
    });

    it("falls back to the mirror on rows filled before mediaKinds existed", () => {
      // Legacy rows keep their old score rather than silently losing points;
      // the next fill replaces them.
      expect(
        formatPointsFor(
          imageDco({
            mediaKinds: [],
            mirroredVideoUrl: "https://blob.test/a.mp4",
          }),
        ),
      ).toBe(5);
    });
  });

  it("still emits an update for a cluster with no member ads", () => {
    const updates = scoreCompetitorClusters({
      clusters: [{ id: "cluster-1", verdict: "medium" }],
      ads: [],
      now: NOW,
    });

    expect(updates).toEqual([
      {
        clusterId: "cluster-1",
        score: 8,
        tier: "watch",
        longevityPoints: 0,
        variantPoints: 0,
        strategicPoints: 8,
        formatPoints: 0,
        landingPoints: 0,
      },
    ]);
  });
});
