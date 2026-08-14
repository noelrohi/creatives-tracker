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
});
