import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

// --- Mocked DB: the signals router runs select/insert/update/delete chains
// inside one transaction, so the mock hands the same chainable object to the
// transaction callback and records every write for assertions.
const dbState = {
  selectRows: [] as Row[][],
  returningRows: [] as Row[][],
  inserts: [] as Array<{ table: unknown; values: Row[]; conflictSet?: Row }>,
  updates: [] as Array<{ table: unknown; set: Row }>,
  deletes: [] as unknown[],
};

function thenable<T extends Row>(chain: T, resolve: () => unknown): T {
  return Object.assign(chain, {
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  });
}

const mockDb = {
  select: vi.fn(() => {
    const chain: Row = {};
    Object.assign(chain, {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      limit: vi.fn(async () => dbState.selectRows.shift() ?? []),
    });
    return thenable(chain, () => dbState.selectRows.shift() ?? []);
  }),
  selectDistinctOn: vi.fn(() => {
    const chain: Row = {};
    Object.assign(chain, {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
    });
    return thenable(chain, () => dbState.selectRows.shift() ?? []);
  }),
  insert: vi.fn((table: unknown) => {
    const record: { table: unknown; values: Row[]; conflictSet?: Row } = {
      table,
      values: [],
    };
    const chain: Row = {};
    Object.assign(chain, {
      values: vi.fn((values: Row | Row[]) => {
        record.values = Array.isArray(values) ? values : [values];
        dbState.inserts.push(record);
        return chain;
      }),
      onConflictDoUpdate: vi.fn((config: { set: Row }) => {
        record.conflictSet = config.set;
        return chain;
      }),
      returning: vi.fn(async () => dbState.returningRows.shift() ?? []),
    });
    return thenable(chain, () => undefined);
  }),
  update: vi.fn((table: unknown) => {
    const chain: Row = {};
    Object.assign(chain, {
      set: vi.fn((values: Row) => {
        dbState.updates.push({ table, set: values });
        return chain;
      }),
      where: vi.fn(() => chain),
      returning: vi.fn(async () => dbState.returningRows.shift() ?? []),
    });
    return thenable(chain, () => undefined);
  }),
  delete: vi.fn((table: unknown) => {
    const chain: Row = {};
    Object.assign(chain, { where: vi.fn(() => chain) });
    dbState.deletes.push(table);
    return thenable(chain, () => undefined);
  }),
};

Object.assign(mockDb, {
  transaction: vi.fn(async (callback: (tx: typeof mockDb) => Promise<unknown>) =>
    callback(mockDb),
  ),
});

const triggerMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(
  async () => ({ id: "run_mirror_1" }),
);

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => triggerMock(...args) },
}));

const { createMockCaller } = await import("../test-helpers");
const { competitorAds, copyClusters } = await import(
  "@/schema/competitor-signals"
);

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

function normalizedAd(overrides: Row = {}) {
  return {
    archiveId: "ad-1",
    pageId: "page-1",
    pageName: "Acme",
    isActive: true,
    startDate: new Date("2026-07-01"),
    bodyText: "Sleep better tonight",
    linkUrl: "https://acme.test/sleep",
    displayFormat: "IMAGE" as const,
    publisherPlatforms: ["FACEBOOK"],
    raw: { id: "ad-1" },
    title: null,
    endDate: null,
    ctaText: null,
    ctaType: null,
    linkDescription: null,
    collationId: null,
    collationCount: null,
    imageUrl: null,
    videoHdUrl: null,
    videoSdUrl: null,
    videoPreviewImageUrl: null,
    variants: null,
    ...overrides,
  };
}

function cluster(overrides: Row = {}) {
  return {
    label: "Sleep quality proof",
    angle: "social_proof",
    summary: "Reviews-led claims about falling asleep faster.",
    memberArchiveIds: ["ad-1"],
    verdict: "high",
    verdictRationale: "Longest-running cluster with the most variants.",
    ...overrides,
  };
}

/** Queue the lookups ingestFill makes before its writes. */
function queueKnownCompetitor() {
  dbState.selectRows.push([{ id: "competitor-1" }]);
  dbState.returningRows.push([{ id: "snapshot-1" }]);
}

const insertsInto = (table: unknown) =>
  dbState.inserts.filter((entry) => entry.table === table);

describe("signals router (competitor-signals v1 §4/§5, Phase 1)", () => {
  beforeEach(() => {
    dbState.selectRows = [];
    dbState.returningRows = [];
    dbState.inserts = [];
    dbState.updates = [];
    dbState.deletes = [];
    vi.clearAllMocks();
    triggerMock.mockResolvedValue({ id: "run_mirror_1" });
  });

  describe("write access", () => {
    it("rejects a member on addCompetitor", async () => {
      await expect(
        memberCaller.signals.addCompetitor({
          name: "Acme",
          metaPageId: "page-1",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a member on ingestFill", async () => {
      await expect(
        memberCaller.signals.ingestFill({
          competitorPageId: "page-1",
          source: "scrapecreators",
          ads: [],
          clusters: null,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("addCompetitor", () => {
    it("creates the competitor when the page is not tracked yet", async () => {
      dbState.selectRows.push([]);
      dbState.returningRows.push([{ id: "competitor-1", name: "Acme" }]);

      const result = await adminCaller.signals.addCompetitor({
        name: "Acme",
        metaPageId: "page-1",
      });

      expect(result).toMatchObject({ id: "competitor-1" });
    });

    it("rejects a duplicate meta page with CONFLICT", async () => {
      dbState.selectRows.push([{ id: "competitor-1" }]);

      await expect(
        adminCaller.signals.addCompetitor({
          name: "Acme again",
          metaPageId: "page-1",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(dbState.inserts).toHaveLength(0);
    });
  });

  describe("archiveCompetitor", () => {
    it("sets status archived", async () => {
      dbState.returningRows.push([{ id: "competitor-1", status: "archived" }]);

      await adminCaller.signals.archiveCompetitor({
        competitorId: "competitor-1",
      });

      expect(dbState.updates[0].set).toMatchObject({ status: "archived" });
    });

    it("throws NOT_FOUND for an unknown competitor", async () => {
      dbState.returningRows.push([]);

      await expect(
        adminCaller.signals.archiveCompetitor({ competitorId: "nope" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("ingestFill", () => {
    it("throws NOT_FOUND for an untracked page", async () => {
      dbState.selectRows.push([]);

      await expect(
        adminCaller.signals.ingestFill({
          competitorPageId: "unknown-page",
          source: "meta_ads_collector",
          ads: [normalizedAd()],
          clusters: null,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(dbState.inserts).toHaveLength(0);
    });

    // §4: "zero ads is a valid fill" — the run is still recorded and the
    // absent-marking pass still runs, which is how a competitor goes dark.
    it("records the snapshot and marks every live ad absent on a zero-ad fill", async () => {
      queueKnownCompetitor();

      const result = await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "scrapecreators",
        ads: [],
        clusters: null,
      });

      expect(result).toEqual({ snapshotId: "snapshot-1", adCount: 0 });
      expect(dbState.inserts).toHaveLength(1);
      expect(dbState.inserts[0].values[0]).toMatchObject({
        adCount: 0,
        // Nothing to mirror, so the fill is already complete.
        pipelineStatus: "complete",
        source: "scrapecreators",
      });
      expect(triggerMock).not.toHaveBeenCalled();
      expect(dbState.inserts[0].values[0].filledAt).toBeInstanceOf(Date);
      expect(insertsInto(competitorAds)).toHaveLength(0);
      expect(dbState.updates).toHaveLength(1);
      expect(dbState.updates[0].set.noLongerSeenAt).toBeInstanceOf(Date);
    });

    it("clears noLongerSeenAt on reappearance and stamps it on absent ads", async () => {
      queueKnownCompetitor();

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: null,
      });

      const [adInsert] = insertsInto(competitorAds);
      expect(adInsert.values[0]).toMatchObject({ archiveId: "ad-1" });
      expect(adInsert.values[0].firstSeenAt).toBeInstanceOf(Date);
      expect(adInsert.values[0].lastSnapshotId).toBe("snapshot-1");
      // Reappearance: the upsert clears the tombstone but leaves firstSeenAt
      // at whatever the original insert wrote.
      expect(adInsert.conflictSet).toBeDefined();
      expect(adInsert.conflictSet).not.toHaveProperty("firstSeenAt");
      expect(JSON.stringify(adInsert.conflictSet?.noLongerSeenAt)).toContain(
        "null",
      );

      // Absence: anything still live and not in this payload is tombstoned.
      const absenceUpdate = dbState.updates.find(
        (entry) =>
          entry.table === competitorAds &&
          entry.set.noLongerSeenAt instanceof Date,
      );
      expect(absenceUpdate).toBeDefined();
    });

    it("is idempotent — the same payload upserts rather than duplicating", async () => {
      queueKnownCompetitor();
      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: null,
      });
      queueKnownCompetitor();
      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: null,
      });

      const adInserts = insertsInto(competitorAds);
      expect(adInserts).toHaveLength(2);
      for (const entry of adInserts) {
        expect(entry.conflictSet).toBeDefined();
      }
    });

    it("rejects a payload that repeats an archiveId", async () => {
      queueKnownCompetitor();

      await expect(
        adminCaller.signals.ingestFill({
          competitorPageId: "page-1",
          source: "meta_ads_collector",
          ads: [normalizedAd(), normalizedAd()],
          clusters: null,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(dbState.inserts).toHaveLength(0);
    });

    it("caps a fill at 200 ads", async () => {
      queueKnownCompetitor();

      await expect(
        adminCaller.signals.ingestFill({
          competitorPageId: "page-1",
          source: "meta_ads_collector",
          ads: Array.from({ length: 201 }, (_, index) =>
            normalizedAd({ archiveId: `ad-${index}` }),
          ),
          clusters: null,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  // §6: one parent mirror job per fill, fired after the transaction commits.
  describe("ingestFill mirror pipeline", () => {
    it("triggers the mirror job with the media payload and a per-competitor concurrency key", async () => {
      queueKnownCompetitor();

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [
          normalizedAd({ imageUrl: "https://cdn.test/a.jpg" }),
          normalizedAd({
            archiveId: "ad-2",
            videoHdUrl: "https://cdn.test/b.mp4",
            videoPreviewImageUrl: "https://cdn.test/b.jpg",
          }),
          // No media at all — excluded from the job payload.
          normalizedAd({ archiveId: "ad-3" }),
        ],
        clusters: null,
      });

      expect(triggerMock).toHaveBeenCalledTimes(1);
      const [taskId, payload, options] = triggerMock.mock.calls[0];
      expect(taskId).toBe("mirror-competitor-media");
      expect(payload).toEqual({
        organizationId: "test-org-id",
        competitorId: "competitor-1",
        snapshotId: "snapshot-1",
        media: [
          {
            archiveId: "ad-1",
            imageUrl: "https://cdn.test/a.jpg",
            videoHdUrl: null,
            videoSdUrl: null,
            videoPreviewImageUrl: null,
          },
          {
            archiveId: "ad-2",
            imageUrl: null,
            videoHdUrl: "https://cdn.test/b.mp4",
            videoSdUrl: null,
            videoPreviewImageUrl: "https://cdn.test/b.jpg",
          },
        ],
      });
      expect(options).toEqual({ concurrencyKey: "competitor-1" });
      expect(dbState.inserts[0].values[0].pipelineStatus).toBe("received");
    });

    it("skips the job when there is neither media nor clusters", async () => {
      queueKnownCompetitor();

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: null,
      });

      expect(triggerMock).not.toHaveBeenCalled();
      expect(dbState.inserts[0].values[0].pipelineStatus).toBe("complete");
    });

    // §8: clusters need scoring even when there is nothing left to mirror.
    it("triggers the job for a media-less fill that carries clusters", async () => {
      queueKnownCompetitor();
      dbState.returningRows.push([{ id: "cluster-1" }]);

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: [cluster()],
      });

      expect(triggerMock).toHaveBeenCalledTimes(1);
      const [, payload] = triggerMock.mock.calls[0];
      expect(payload).toMatchObject({ snapshotId: "snapshot-1", media: [] });
      expect(dbState.inserts[0].values[0].pipelineStatus).toBe("received");
    });

    it("skips the job when the payload sends an empty cluster list", async () => {
      queueKnownCompetitor();

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: [],
      });

      expect(triggerMock).not.toHaveBeenCalled();
      expect(dbState.inserts[0].values[0].pipelineStatus).toBe("complete");
    });

    it("marks the snapshot failed when the job cannot be started", async () => {
      queueKnownCompetitor();
      triggerMock.mockRejectedValueOnce(new Error("trigger.dev unreachable"));

      await expect(
        adminCaller.signals.ingestFill({
          competitorPageId: "page-1",
          source: "meta_ads_collector",
          ads: [normalizedAd({ imageUrl: "https://cdn.test/a.jpg" })],
          clusters: null,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

      const failure = dbState.updates.find(
        (entry) => entry.set.pipelineStatus === "failed",
      );
      expect(failure?.set.error).toBe("trigger.dev unreachable");
    });
  });

  // §5 gatekeeper: bad vocabulary degrades the field, it never rejects the fill.
  describe("ingestFill gatekeeper", () => {
    async function fillWithCluster(overrides: Row) {
      queueKnownCompetitor();
      dbState.returningRows.push([{ id: "cluster-1" }]);

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: [cluster(overrides)],
      });

      return insertsInto(copyClusters)[0].values[0];
    }

    it("passes valid angle and verdict through", async () => {
      const row = await fillWithCluster({});

      expect(row).toMatchObject({
        angle: "social_proof",
        verdict: "high",
        verdictRationale: "Longest-running cluster with the most variants.",
        adCount: 1,
        snapshotId: "snapshot-1",
      });
    });

    it("normalizes loosely-cased angles from the harness", async () => {
      const row = await fillWithCluster({ angle: "Problem Solution" });

      expect(row.angle).toBe("problem_solution");
    });

    it("nulls an angle outside ANGLE_TYPES", async () => {
      const row = await fillWithCluster({ angle: "vibes-based" });

      expect(row.angle).toBeNull();
      expect(row.verdict).toBe("high");
    });

    it("nulls both verdict and rationale when the verdict is off-enum", async () => {
      const row = await fillWithCluster({ verdict: "extremely high" });

      expect(row.verdict).toBeNull();
      expect(row.verdictRationale).toBeNull();
      expect(row.angle).toBe("social_proof");
    });

    it("wipes and rebuilds this competitor's clusters, then re-points members", async () => {
      queueKnownCompetitor();
      dbState.returningRows.push([{ id: "cluster-1" }]);

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd(), normalizedAd({ archiveId: "ad-2" })],
        clusters: [cluster({ memberArchiveIds: ["ad-1"] })],
      });

      expect(dbState.deletes).toContain(copyClusters);
      const clusterUpdates = dbState.updates.filter((entry) =>
        Object.hasOwn(entry.set, "copyClusterId"),
      );
      expect(clusterUpdates.map((entry) => entry.set.copyClusterId)).toEqual([
        null,
        "cluster-1",
      ]);
    });

    it("leaves clusters untouched when the payload sends clusters: null", async () => {
      queueKnownCompetitor();

      await adminCaller.signals.ingestFill({
        competitorPageId: "page-1",
        source: "meta_ads_collector",
        ads: [normalizedAd()],
        clusters: null,
      });

      expect(dbState.deletes).toHaveLength(0);
      expect(insertsInto(copyClusters)).toHaveLength(0);
    });
  });

  // §9/§11 step 7: the harness reads back the cross-competitor ranking plus
  // the per-competitor fill status it polls on.
  describe("rankedSignals", () => {
    function clusterRow(overrides: Row = {}) {
      return {
        id: "cluster-1",
        competitorId: "competitor-1",
        label: "Sleep quality proof",
        angle: "social_proof",
        summary: "Reviews-led claims.",
        adCount: 2,
        score: 70,
        tier: "high",
        longevityPoints: 25,
        variantPoints: 20,
        strategicPoints: 15,
        formatPoints: 5,
        landingPoints: 5,
        verdict: "high",
        verdictRationale: "Longest-running cluster.",
        ...overrides,
      };
    }

    function adRow(overrides: Row = {}) {
      return {
        copyClusterId: "cluster-1",
        bodyText: "Sleep better tonight",
        startDate: new Date("2026-06-01"),
        displayFormat: "IMAGE",
        linkUrl: "https://acme.test/sleep?utm_source=fb",
        variants: [],
        mirroredImageUrl: null,
        mirroredVideoUrl: null,
        ...overrides,
      };
    }

    /** Queue the four reads rankedSignals makes, in call order. */
    function queueRanked(input: {
      competitors?: Row[];
      clusters?: Row[];
      fills?: Row[];
      ads?: Row[];
    }) {
      dbState.selectRows.push(
        input.competitors ?? [
          { id: "competitor-1", name: "Acme", metaPageId: "page-1" },
        ],
        input.clusters ?? [],
        input.fills ?? [],
        input.ads ?? [],
      );
    }

    it("returns nothing when the org tracks no active competitor", async () => {
      dbState.selectRows.push([]);

      await expect(memberCaller.signals.rankedSignals()).resolves.toEqual({
        signals: [],
        fills: [],
      });
    });

    it("sorts by score desc and keeps unscored clusters at the bottom", async () => {
      queueRanked({
        clusters: [
          clusterRow({ id: "cluster-mid", score: 44, tier: "moderate" }),
          clusterRow({ id: "cluster-unscored", score: null, tier: null }),
          clusterRow({ id: "cluster-top", score: 70 }),
        ],
        ads: [],
      });

      const result = await memberCaller.signals.rankedSignals();

      expect(result.signals.map((signal) => signal.id)).toEqual([
        "cluster-top",
        "cluster-mid",
        "cluster-unscored",
      ]);
      expect(result.signals[2].score).toBeNull();
    });

    it("derives the §9 evidence extras from the member ads", async () => {
      queueRanked({
        clusters: [clusterRow({ adCount: 4 })],
        ads: [
          adRow(),
          adRow({
            startDate: new Date("2026-05-01"),
            bodyText: "The oldest ad still running",
            linkUrl: "https://acme.test/sleep#reviews",
          }),
          adRow({
            displayFormat: "DCO",
            mirroredVideoUrl: "https://cdn.test/a.mp4",
            linkUrl: "https://acme.test/other",
          }),
          adRow({ displayFormat: "CAROUSEL", linkUrl: null }),
        ],
      });

      const [signal] = (await memberCaller.signals.rankedSignals()).signals;

      // DCO resolves to its underlying media, so all three formats show up.
      expect(signal.formatsObserved).toEqual(["image", "video", "carousel"]);
      // Query strings and fragments collapse into one modal destination.
      expect(signal.landingFocusUrl).toBe("https://acme.test/sleep");
      expect(signal.landingFocusShare).toBeCloseTo(0.5);
      // Longest-running member = earliest start date.
      expect(signal.representativeCopy).toBe("The oldest ad still running");
      expect(signal.competitor).toEqual({
        id: "competitor-1",
        name: "Acme",
        metaPageId: "page-1",
      });
    });

    it("empties the evidence extras for a cluster with no member ads", async () => {
      queueRanked({ clusters: [clusterRow()], ads: [] });

      const [signal] = (await memberCaller.signals.rankedSignals()).signals;

      expect(signal.formatsObserved).toEqual([]);
      expect(signal.landingFocusUrl).toBeNull();
      expect(signal.landingFocusShare).toBe(0);
      expect(signal.representativeCopy).toBeNull();
    });

    it("returns the latest fill per competitor for the poll loop", async () => {
      const filledAt = new Date("2026-08-14T09:00:00Z");
      queueRanked({
        fills: [
          {
            competitorId: "competitor-1",
            snapshotId: "snapshot-9",
            pipelineStatus: "complete",
            error: null,
            filledAt,
          },
        ],
      });

      const result = await memberCaller.signals.rankedSignals();

      expect(result.fills).toEqual([
        {
          competitorId: "competitor-1",
          snapshotId: "snapshot-9",
          pipelineStatus: "complete",
          error: null,
          filledAt,
        },
      ]);
    });

    it("drops clusters whose competitor is not an active tracked competitor", async () => {
      queueRanked({
        clusters: [clusterRow(), clusterRow({ id: "c2", competitorId: "gone" })],
      });

      const result = await memberCaller.signals.rankedSignals();

      expect(result.signals.map((signal) => signal.id)).toEqual(["cluster-1"]);
    });
  });

  // §2: the score is a pure function over stored inputs, so rescore runs
  // in-app and synchronously — no Trigger.dev.
  describe("rescore", () => {
    it("rejects a member", async () => {
      await expect(memberCaller.signals.rescore()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("writes all seven score columns and returns the count", async () => {
      dbState.selectRows.push(
        [{ id: "competitor-1" }],
        [
          { id: "cluster-1", competitorId: "competitor-1", verdict: "high" },
          { id: "cluster-2", competitorId: "competitor-1", verdict: null },
        ],
        [
          {
            copyClusterId: "cluster-1",
            startDate: new Date("2026-06-01"),
            displayFormat: "IMAGE",
            linkUrl: "https://acme.test/sleep",
            variants: [{}, {}],
            mirroredImageUrl: "https://cdn.test/a.jpg",
            mirroredVideoUrl: null,
          },
        ],
      );

      const result = await adminCaller.signals.rescore();

      expect(result).toEqual({ clustersRescored: 2 });
      expect(dbState.updates).toHaveLength(2);
      expect(Object.keys(dbState.updates[0].set).sort()).toEqual([
        "formatPoints",
        "landingPoints",
        "longevityPoints",
        "score",
        "strategicPoints",
        "tier",
        "variantPoints",
      ]);
      // Scored cluster: evidence + a high verdict; the memberless one is 0.
      expect(dbState.updates[0].set.strategicPoints).toBe(15);
      expect(dbState.updates[0].set.score).toBeGreaterThan(0);
      expect(dbState.updates[1].set.score).toBe(0);
      expect(dbState.updates[1].set.tier).toBe("watch");
      expect(triggerMock).not.toHaveBeenCalled();
    });

    it("does nothing when the org has no active competitor", async () => {
      dbState.selectRows.push([]);

      await expect(adminCaller.signals.rescore()).resolves.toEqual({
        clustersRescored: 0,
      });
      expect(dbState.updates).toHaveLength(0);
    });

    it("does nothing when no competitor has clusters", async () => {
      dbState.selectRows.push([{ id: "competitor-1" }], []);

      await expect(adminCaller.signals.rescore()).resolves.toEqual({
        clustersRescored: 0,
      });
      expect(dbState.updates).toHaveLength(0);
    });
  });
});
