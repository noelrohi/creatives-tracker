import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

// --- Mocked DB: same chainable harness as signals.test.ts. The plan writes run
// inside one transaction, so the mock hands the same object to the callback and
// records every write; `delete` gained a `returning` because the
// replace-proposed-only pass counts the rows it removed.
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
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      limit: vi.fn(async () => dbState.selectRows.shift() ?? []),
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
    Object.assign(chain, {
      where: vi.fn(() => chain),
      returning: vi.fn(async () => dbState.returningRows.shift() ?? []),
    });
    dbState.deletes.push(table);
    return thenable(chain, () => undefined);
  }),
};

Object.assign(mockDb, {
  transaction: vi.fn(async (callback: (tx: typeof mockDb) => Promise<unknown>) =>
    callback(mockDb),
  ),
});

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(async () => ({ id: "run_1" })) },
}));

const { createMockCaller } = await import("../test-helpers");
const { testPlanAds, testPlanConcepts } = await import(
  "@/schema/competitor-signals"
);

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

const HOOKS = ["Hook A", "Hook B", "Hook C"];

/** One §9-shaped concept: 3 hooks × 2 formats = 6 ad rows. */
function concept(overrides: Row = {}) {
  return {
    title: "Fit that stays put",
    angle: "problem_solution",
    audience: "Wrestlers replacing a boil-and-bite guard",
    evidenceClusterIds: ["cluster-1", "cluster-2"],
    evidenceCitation: "The longest-running cluster leads on retention.",
    measurementPlan: "CTR at 7 days, decided against the control ad set.",
    claimGuardrail: null,
    hooks: HOOKS,
    ads: HOOKS.flatMap((hook) => [
      { hook, format: "static" as const },
      { hook, format: "video" as const },
    ]),
    ...overrides,
  };
}

const insertsInto = (table: unknown) =>
  dbState.inserts.filter((entry) => entry.table === table);

/**
 * Queue the reads/returns ingestTestPlan makes after validation, in call order:
 * the deleted proposed ads, the org's concepts, the ads that survived.
 */
function queueReplacePass(input: {
  deletedAds?: Row[];
  concepts?: Row[];
  survivingAds?: Row[];
  insertedConceptIds?: string[];
}) {
  dbState.returningRows.push(input.deletedAds ?? []);
  dbState.selectRows.push(input.concepts ?? [], input.survivingAds ?? []);
  dbState.returningRows.push(
    (input.insertedConceptIds ?? ["concept-new-1"]).map((id) => ({ id })),
  );
}

describe("signals plan router (competitor-signals v1 §9, Phase 3)", () => {
  beforeEach(() => {
    dbState.selectRows = [];
    dbState.returningRows = [];
    dbState.inserts = [];
    dbState.updates = [];
    dbState.deletes = [];
    vi.clearAllMocks();
  });

  describe("write access", () => {
    it("rejects a member on ingestTestPlan", async () => {
      await expect(
        memberCaller.signals.ingestTestPlan({
          generatedSnapshotId: null,
          concepts: [concept()],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("ingestTestPlan", () => {
    it("writes the full 3 × 3 × 2 matrix on a first-ever plan", async () => {
      queueReplacePass({
        insertedConceptIds: ["concept-1", "concept-2", "concept-3"],
      });

      const result = await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: null,
        concepts: [
          concept(),
          concept({ title: "Proof from the mat" }),
          concept({ title: "Breathe through the round" }),
        ],
      });

      expect(result).toEqual({
        conceptCount: 3,
        adCount: 18,
        replacedAdCount: 0,
        keptConceptCount: 0,
      });

      const [conceptInsert] = insertsInto(testPlanConcepts);
      expect(conceptInsert.values).toHaveLength(3);
      expect(conceptInsert.values[0]).toMatchObject({
        organizationId: "test-org-id",
        title: "Fit that stays put",
        angle: "problem_solution",
        evidenceClusterIds: ["cluster-1", "cluster-2"],
        generatedSnapshotId: null,
      });
      expect(conceptInsert.values[0].generatedAt).toBeInstanceOf(Date);

      const [adInsert] = insertsInto(testPlanAds);
      expect(adInsert.values).toHaveLength(18);
      // sortOrder restarts per concept and comes from the ad's index, never
      // from the payload; status is left to the column default.
      expect(adInsert.values.map((row) => row.sortOrder)).toEqual([
        0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5,
      ]);
      expect(adInsert.values.map((row) => row.conceptId)).toEqual([
        ...Array<string>(6).fill("concept-1"),
        ...Array<string>(6).fill("concept-2"),
        ...Array<string>(6).fill("concept-3"),
      ]);
      for (const row of adInsert.values) {
        expect(row).not.toHaveProperty("status");
      }
      // Nothing existed, so nothing was cleaned up.
      expect(dbState.deletes).toEqual([testPlanAds]);
    });

    it("stores the snapshot provenance when it belongs to the org", async () => {
      dbState.selectRows.push([{ id: "snapshot-1" }]);
      queueReplacePass({});

      await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: "snapshot-1",
        concepts: [concept()],
      });

      expect(insertsInto(testPlanConcepts)[0].values[0]).toMatchObject({
        generatedSnapshotId: "snapshot-1",
      });
    });

    it("throws NOT_FOUND for a snapshot outside the org", async () => {
      dbState.selectRows.push([]);

      await expect(
        adminCaller.signals.ingestTestPlan({
          generatedSnapshotId: "snapshot-other-org",
          concepts: [concept()],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(dbState.inserts).toHaveLength(0);
      expect(dbState.deletes).toHaveLength(0);
    });

    // §9: regeneration replaces `proposed` only — human decisions survive.
    it("deletes only proposed ads and only the concepts they emptied", async () => {
      queueReplacePass({
        // Two proposed rows went; the concepts they belonged to are known only
        // by what is left behind.
        deletedAds: [{ id: "ad-p1" }, { id: "ad-p2" }],
        concepts: [{ id: "concept-kept" }, { id: "concept-emptied" }],
        // concept-kept still holds an approved and a testing row.
        survivingAds: [
          { conceptId: "concept-kept" },
          { conceptId: "concept-kept" },
        ],
        insertedConceptIds: ["concept-new-1"],
      });

      const result = await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: null,
        concepts: [concept()],
      });

      expect(result).toEqual({
        conceptCount: 1,
        adCount: 6,
        replacedAdCount: 2,
        keptConceptCount: 1,
      });
      // The ad sweep, then exactly one concept sweep for the emptied concept.
      expect(dbState.deletes).toEqual([testPlanAds, testPlanConcepts]);
      // The surviving concept is never re-written — no update touches it.
      expect(dbState.updates).toHaveLength(0);
    });

    it("skips the concept sweep when every concept still has ads", async () => {
      queueReplacePass({
        deletedAds: [{ id: "ad-p1" }],
        concepts: [{ id: "concept-kept" }],
        survivingAds: [{ conceptId: "concept-kept" }],
      });

      const result = await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: null,
        concepts: [concept()],
      });

      expect(result).toMatchObject({ keptConceptCount: 1, replacedAdCount: 1 });
      expect(dbState.deletes).toEqual([testPlanAds]);
    });

    // Unlike a cluster angle, a concept's angle column is notNull — the
    // gatekeeper rejects instead of degrading to null.
    it("rejects an angle outside ANGLE_TYPES with BAD_REQUEST", async () => {
      await expect(
        adminCaller.signals.ingestTestPlan({
          generatedSnapshotId: null,
          concepts: [concept({ angle: "vibes-based" })],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(dbState.inserts).toHaveLength(0);
      expect(dbState.deletes).toHaveLength(0);
    });

    it("normalizes a loosely-cased angle from the harness", async () => {
      queueReplacePass({});

      await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: null,
        concepts: [concept({ angle: "Social Proof" })],
      });

      expect(insertsInto(testPlanConcepts)[0].values[0].angle).toBe(
        "social_proof",
      );
    });

    it("persists per-hook ad copy alongside the concept", async () => {
      queueReplacePass({});

      const hookCopy = HOOKS.map((hook) => ({
        hook,
        headline: `${hook} headline`,
        description: "Molded in five minutes, stays put all round.",
        cta: "Shop now",
      }));

      await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: null,
        concepts: [concept({ hookCopy })],
      });

      expect(insertsInto(testPlanConcepts)[0].values[0].hookCopy).toEqual(
        hookCopy,
      );
    });

    // Old plans predate the column, and a push may still leave it out.
    it("accepts a null hookCopy", async () => {
      queueReplacePass({});

      await adminCaller.signals.ingestTestPlan({
        generatedSnapshotId: null,
        concepts: [concept({ hookCopy: null })],
      });

      expect(insertsInto(testPlanConcepts)[0].values[0].hookCopy).toBeNull();
    });

    // Same rule as `ads[].hook`: the copy is keyed by the hook text, so a
    // drifted hook fails the whole push rather than rendering against nothing.
    it("rejects hook copy on a hook the concept does not carry", async () => {
      await expect(
        adminCaller.signals.ingestTestPlan({
          generatedSnapshotId: null,
          concepts: [
            concept({
              hookCopy: [
                {
                  hook: "Hook Z",
                  headline: "Drifted",
                  description: "Never matched a hook.",
                  cta: "Shop now",
                },
              ],
            }),
          ],
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Hook Z"),
      });
      expect(dbState.inserts).toHaveLength(0);
    });

    // One entry per hook: a duplicate would make the screen render whichever
    // entry it found first, so the push fails instead of storing the ambiguity.
    it("rejects two hook copy entries for the same hook", async () => {
      const entry = {
        hook: "Hook A",
        headline: "Written twice",
        description: "The second entry would never render.",
        cta: "Shop now",
      };

      await expect(
        adminCaller.signals.ingestTestPlan({
          generatedSnapshotId: null,
          concepts: [concept({ hookCopy: [entry, entry] })],
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("more than one hook copy entry"),
      });
      expect(dbState.inserts).toHaveLength(0);
    });

    it("rejects an ad on a hook the concept does not carry", async () => {
      await expect(
        adminCaller.signals.ingestTestPlan({
          generatedSnapshotId: null,
          concepts: [
            concept({
              ads: [{ hook: "Hook Z", format: "static" as const }],
            }),
          ],
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Hook Z"),
      });
      expect(dbState.inserts).toHaveLength(0);
    });
  });

  describe("testPlan", () => {
    it("groups ads under their concept in sortOrder", async () => {
      const generatedAt = new Date("2026-08-14T09:00:00Z");
      dbState.selectRows.push(
        [
          {
            id: "concept-1",
            title: "Fit that stays put",
            angle: "problem_solution",
            audience: "Wrestlers",
            evidenceClusterIds: ["cluster-1"],
            evidenceCitation: "Longest-running cluster.",
            measurementPlan: "CTR at 7 days.",
            claimGuardrail: null,
            hooks: HOOKS,
            hookCopy: null,
            generatedAt,
          },
          {
            id: "concept-2",
            title: "Proof from the mat",
            angle: "social_proof",
            audience: "Coaches",
            evidenceClusterIds: [],
            evidenceCitation: "Reviews-led claims.",
            measurementPlan: "CAC at 14 days.",
            claimGuardrail: "Never promise concussion protection.",
            hooks: HOOKS,
            hookCopy: null,
            generatedAt,
          },
        ],
        [
          {
            id: "ad-1",
            conceptId: "concept-1",
            hook: "Hook A",
            format: "static",
            status: "approved",
            sortOrder: 0,
          },
          {
            id: "ad-2",
            conceptId: "concept-2",
            hook: "Hook B",
            format: "video",
            status: "proposed",
            sortOrder: 0,
          },
          {
            id: "ad-3",
            conceptId: "concept-1",
            hook: "Hook A",
            format: "video",
            status: "proposed",
            sortOrder: 1,
          },
        ],
      );

      const result = await memberCaller.signals.testPlan();

      expect(result.concepts.map((entry) => entry.id)).toEqual([
        "concept-1",
        "concept-2",
      ]);
      expect(result.concepts[0].ads).toEqual([
        {
          id: "ad-1",
          hook: "Hook A",
          format: "static",
          status: "approved",
          sortOrder: 0,
        },
        {
          id: "ad-3",
          hook: "Hook A",
          format: "video",
          status: "proposed",
          sortOrder: 1,
        },
      ]);
      expect(result.concepts[1].ads).toHaveLength(1);
      expect(result.concepts[1].claimGuardrail).toBe(
        "Never promise concussion protection.",
      );
    });

    it("groups hook copy, feedback, and comments under their concept", async () => {
      const generatedAt = new Date("2026-08-14T09:00:00Z");
      const commentedAt = new Date("2026-08-15T10:00:00Z");
      const hookCopy = [
        {
          hook: "Hook A",
          headline: "Stays put all round",
          description: "Molded in five minutes.",
          cta: "Shop now",
        },
      ];

      dbState.selectRows.push(
        [
          {
            id: "concept-1",
            title: "Fit that stays put",
            angle: "problem_solution",
            audience: "Wrestlers",
            evidenceClusterIds: [],
            evidenceCitation: "Longest-running cluster.",
            measurementPlan: "CTR at 7 days.",
            claimGuardrail: null,
            hooks: HOOKS,
            hookCopy,
            generatedAt,
          },
          {
            id: "concept-2",
            title: "Proof from the mat",
            angle: "social_proof",
            audience: "Coaches",
            evidenceClusterIds: [],
            evidenceCitation: "Reviews-led claims.",
            measurementPlan: "CAC at 14 days.",
            claimGuardrail: null,
            hooks: HOOKS,
            hookCopy: null,
            generatedAt,
          },
        ],
        // ads
        [],
        // hook feedback — one grouped read for both concepts
        [
          {
            conceptId: "concept-1",
            hook: "Hook A",
            rating: "down",
            reasons: ["too_generic"],
          },
          {
            conceptId: "concept-2",
            hook: "Hook B",
            rating: "up",
            reasons: [],
          },
        ],
        // comments, author name joined from the Better Auth user table
        [
          {
            id: "comment-1",
            conceptId: "concept-1",
            authorName: "Ada",
            createdAt: commentedAt,
            text: "Lean harder on the fit claim.",
            promotedRuleId: "rule-1",
          },
        ],
      );

      const result = await memberCaller.signals.testPlan();

      // concepts, ads, feedback, comments — never a query per concept.
      expect(mockDb.select).toHaveBeenCalledTimes(4);
      expect(result.concepts[0].hookCopy).toEqual(hookCopy);
      expect(result.concepts[0].feedback).toEqual([
        { hook: "Hook A", rating: "down", reasons: ["too_generic"] },
      ]);
      expect(result.concepts[0].comments).toEqual([
        {
          id: "comment-1",
          authorName: "Ada",
          createdAt: commentedAt,
          text: "Lean harder on the fit claim.",
          promotedRuleId: "rule-1",
        },
      ]);
      expect(result.concepts[1].hookCopy).toBeNull();
      expect(result.concepts[1].feedback).toEqual([
        { hook: "Hook B", rating: "up", reasons: [] },
      ]);
      expect(result.concepts[1].comments).toEqual([]);
    });

    it("returns nothing and skips the ad read when there is no plan", async () => {
      dbState.selectRows.push([]);

      await expect(memberCaller.signals.testPlan()).resolves.toEqual({
        concepts: [],
      });
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it("leaves a concept with no ads as an empty checklist", async () => {
      dbState.selectRows.push(
        [
          {
            id: "concept-1",
            title: "Fit that stays put",
            angle: "problem_solution",
            audience: "Wrestlers",
            evidenceClusterIds: [],
            evidenceCitation: "Longest-running cluster.",
            measurementPlan: "CTR at 7 days.",
            claimGuardrail: null,
            hooks: HOOKS,
            hookCopy: null,
            generatedAt: new Date("2026-08-14T09:00:00Z"),
          },
        ],
        [],
      );

      const result = await memberCaller.signals.testPlan();

      expect(result.concepts[0].ads).toEqual([]);
    });
  });

  describe("setTestPlanAdStatus", () => {
    it("moves the status and returns the updated row", async () => {
      dbState.returningRows.push([{ id: "ad-1", status: "testing" }]);

      const result = await adminCaller.signals.setTestPlanAdStatus({
        adId: "ad-1",
        status: "testing",
      });

      expect(result).toEqual({ id: "ad-1", status: "testing" });
      expect(dbState.updates[0]).toMatchObject({
        table: testPlanAds,
        set: expect.objectContaining({ status: "testing" }),
      });
    });

    it("throws NOT_FOUND for an ad in another org", async () => {
      dbState.returningRows.push([]);

      await expect(
        adminCaller.signals.setTestPlanAdStatus({
          adId: "ad-other-org",
          status: "rejected",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
