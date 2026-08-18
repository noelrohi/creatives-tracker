import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

// --- Mocked DB: the same chainable harness as signals.plan.test.ts. Feedback
// writes are single statements rather than one transaction, so every call is
// fed from the queued rows in call order.
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
const { BUILT_IN_PLAN_RULE } = await import(
  "@/lib/competitor-signals/plan-feedback"
);
const { planRules, testPlanComments, testPlanHookFeedback } = await import(
  "@/schema/competitor-signals"
);

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

const HOOKS = ["Hook A", "Hook B", "Hook C"];

/** The concept lookup every hook write opens with. */
function queueConcept(hooks: string[] = HOOKS) {
  dbState.selectRows.push([{ id: "concept-1", hooks }]);
}

/** The `requireAuthor` lookup: the session user behind a comment or rule. */
function queueAuthor(name = "Ada") {
  dbState.selectRows.push([{ id: "test-user-id", name }]);
}

const insertsInto = (table: unknown) =>
  dbState.inserts.filter((entry) => entry.table === table);

describe("signals feedback router (test-plan feedback & plan rules)", () => {
  beforeEach(() => {
    dbState.selectRows = [];
    dbState.returningRows = [];
    dbState.inserts = [];
    dbState.updates = [];
    dbState.deletes = [];
    vi.clearAllMocks();
  });

  describe("write access", () => {
    it("rejects a member on rateTestPlanHook", async () => {
      await expect(
        memberCaller.signals.rateTestPlanHook({
          conceptId: "concept-1",
          hook: "Hook A",
          rating: "up",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("rateTestPlanHook", () => {
    it("upserts the rating on the (conceptId, hook) key", async () => {
      queueConcept();

      const result = await adminCaller.signals.rateTestPlanHook({
        conceptId: "concept-1",
        hook: "Hook A",
        rating: "down",
        reasons: ["too_generic", "weak_cta"],
      });

      expect(result).toEqual({
        conceptId: "concept-1",
        hook: "Hook A",
        rating: "down",
        reasons: ["too_generic", "weak_cta"],
      });

      const [insert] = insertsInto(testPlanHookFeedback);
      expect(insert.values[0]).toMatchObject({
        organizationId: "test-org-id",
        conceptId: "concept-1",
        hook: "Hook A",
        rating: "down",
        reasons: ["too_generic", "weak_cta"],
      });
      // Last-writer-wins: the same key overwrites rather than stacking rows.
      expect(insert.conflictSet).toMatchObject({
        rating: "down",
        reasons: ["too_generic", "weak_cta"],
      });
    });

    // Reasons answer "what's off?" — they mean nothing under a thumbs up.
    it("clears reasons when the rating is not down", async () => {
      queueConcept();

      const result = await adminCaller.signals.rateTestPlanHook({
        conceptId: "concept-1",
        hook: "Hook A",
        rating: "up",
        reasons: ["too_generic"],
      });

      expect(result.reasons).toEqual([]);
      expect(insertsInto(testPlanHookFeedback)[0].values[0]).toMatchObject({
        reasons: [],
      });
      expect(
        insertsInto(testPlanHookFeedback)[0].conflictSet,
      ).toMatchObject({ reasons: [] });
    });

    it("deletes the row when the rating is cleared", async () => {
      queueConcept();

      const result = await adminCaller.signals.rateTestPlanHook({
        conceptId: "concept-1",
        hook: "Hook A",
        rating: null,
      });

      expect(result).toEqual({
        conceptId: "concept-1",
        hook: "Hook A",
        rating: null,
        reasons: [],
      });
      expect(dbState.deletes).toEqual([testPlanHookFeedback]);
      expect(dbState.inserts).toHaveLength(0);
    });

    it("rejects a hook the concept does not carry", async () => {
      queueConcept();

      await expect(
        adminCaller.signals.rateTestPlanHook({
          conceptId: "concept-1",
          hook: "Hook Z",
          rating: "up",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Hook Z"),
      });
      expect(dbState.inserts).toHaveLength(0);
      expect(dbState.deletes).toHaveLength(0);
    });

    // The reason vocabulary is a code fixture — an unknown slug would render
    // as nothing at all, so the input schema's enum never lets it reach the
    // column.
    it("rejects a reason slug outside the fixture list", async () => {
      queueConcept();

      await expect(
        adminCaller.signals.rateTestPlanHook({
          conceptId: "concept-1",
          hook: "Hook A",
          rating: "down",
          reasons: ["vibes_off" as never],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(dbState.inserts).toHaveLength(0);
    });

    it("throws NOT_FOUND for a concept in another org", async () => {
      dbState.selectRows.push([]);

      await expect(
        adminCaller.signals.rateTestPlanHook({
          conceptId: "concept-other-org",
          hook: "Hook A",
          rating: "up",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("addTestPlanComment", () => {
    it("attributes the comment to the session user", async () => {
      const createdAt = new Date("2026-08-16T09:00:00Z");
      queueConcept();
      queueAuthor("Ada");
      dbState.returningRows.push([
        {
          id: "comment-1",
          createdAt,
          text: "Lean harder on the fit claim.",
          promotedRuleId: null,
        },
      ]);

      const result = await adminCaller.signals.addTestPlanComment({
        conceptId: "concept-1",
        text: "Lean harder on the fit claim.",
      });

      expect(result).toEqual({
        id: "comment-1",
        authorName: "Ada",
        createdAt,
        text: "Lean harder on the fit claim.",
        promotedRuleId: null,
      });
      expect(insertsInto(testPlanComments)[0].values[0]).toMatchObject({
        organizationId: "test-org-id",
        conceptId: "concept-1",
        authorUserId: "test-user-id",
      });
    });
  });

  describe("promoteCommentToRule", () => {
    it("snapshots the comment author's name onto the rule", async () => {
      const createdAt = new Date("2026-08-16T09:00:00Z");
      // The comment, joined to its author.
      dbState.selectRows.push([
        {
          id: "comment-1",
          text: "Never open on a price claim.",
          promotedRuleId: null,
          authorName: "Ada",
        },
      ]);
      queueAuthor("Grace");
      dbState.returningRows.push([
        {
          id: "rule-1",
          text: "Never open on a price claim.",
          source: "feedback",
          active: true,
          attributionName: "Ada",
          createdAt,
        },
      ]);

      const result = await adminCaller.signals.promoteCommentToRule({
        commentId: "comment-1",
      });

      expect(result).toMatchObject({
        id: "rule-1",
        source: "feedback",
        // Comments cascade-delete with their concept, so the rule keeps the
        // author's name rather than joining back to a row that may be gone.
        attributionName: "Ada",
      });
      expect(insertsInto(planRules)[0].values[0]).toMatchObject({
        organizationId: "test-org-id",
        text: "Never open on a price claim.",
        source: "feedback",
        attributionName: "Ada",
        createdByUserId: "test-user-id",
      });
      // The comment is stamped so the thread can render the promoted tag.
      expect(dbState.updates[0]).toMatchObject({
        table: testPlanComments,
        set: expect.objectContaining({ promotedRuleId: "rule-1" }),
      });
    });

    it("is idempotent — a promoted comment hands back its existing rule", async () => {
      const createdAt = new Date("2026-08-16T09:00:00Z");
      dbState.selectRows.push(
        [
          {
            id: "comment-1",
            text: "Never open on a price claim.",
            promotedRuleId: "rule-1",
            authorName: "Ada",
          },
        ],
        [
          {
            id: "rule-1",
            text: "Never open on a price claim.",
            source: "feedback",
            active: true,
            attributionName: "Ada",
            createdAt,
          },
        ],
      );

      const result = await adminCaller.signals.promoteCommentToRule({
        commentId: "comment-1",
      });

      expect(result.id).toBe("rule-1");
      expect(dbState.inserts).toHaveLength(0);
      expect(dbState.updates).toHaveLength(0);
    });

    it("throws NOT_FOUND for a comment in another org", async () => {
      dbState.selectRows.push([]);

      await expect(
        adminCaller.signals.promoteCommentToRule({
          commentId: "comment-other-org",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("addPlanRule and setPlanRuleActive", () => {
    it("writes a manual rule attributed to its creator", async () => {
      const createdAt = new Date("2026-08-16T09:00:00Z");
      queueAuthor("Grace");
      dbState.returningRows.push([
        {
          id: "rule-2",
          text: "Always name the sport in the headline.",
          source: "manual",
          active: true,
          attributionName: "Grace",
          createdAt,
        },
      ]);

      const result = await adminCaller.signals.addPlanRule({
        text: "Always name the sport in the headline.",
      });

      expect(result.source).toBe("manual");
      expect(insertsInto(planRules)[0].values[0]).toMatchObject({
        source: "manual",
        attributionName: "Grace",
        createdByUserId: "test-user-id",
      });
    });

    // Toggling off is the v1 stand-in for deleting a rule.
    it("toggles a rule off", async () => {
      dbState.returningRows.push([{ id: "rule-2", active: false }]);

      await expect(
        adminCaller.signals.setPlanRuleActive({
          ruleId: "rule-2",
          active: false,
        }),
      ).resolves.toEqual({ id: "rule-2", active: false });
      expect(dbState.updates[0]).toMatchObject({
        table: planRules,
        set: expect.objectContaining({ active: false }),
      });
    });

    it("throws NOT_FOUND for a rule in another org", async () => {
      dbState.returningRows.push([]);

      await expect(
        adminCaller.signals.setPlanRuleActive({
          ruleId: "rule-other-org",
          active: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("planRules", () => {
    it("returns the org's rules, active and inactive alike", async () => {
      const createdAt = new Date("2026-08-16T09:00:00Z");
      dbState.selectRows.push([
        {
          id: "rule-1",
          text: "Never open on a price claim.",
          source: "feedback",
          active: true,
          attributionName: "Ada",
          createdAt,
        },
        {
          id: "rule-2",
          text: "Always name the sport in the headline.",
          source: "manual",
          active: false,
          attributionName: "Grace",
          createdAt,
        },
      ]);

      const result = await memberCaller.signals.planRules();

      expect(result.rules.map((rule) => rule.id)).toEqual(["rule-1", "rule-2"]);
    });
  });

  describe("planFeedback", () => {
    it("returns active rules and the current plan's feedback", async () => {
      const createdAt = new Date("2026-08-16T09:00:00Z");
      dbState.selectRows.push(
        // rules — the query filters to active, so only those arrive
        [
          {
            text: "Never open on a price claim.",
            source: "feedback",
            attributionName: "Ada",
          },
        ],
        // concepts
        [{ id: "concept-1", title: "Fit that stays put", hooks: HOOKS }],
        // hook feedback
        [
          {
            conceptId: "concept-1",
            hook: "Hook A",
            rating: "down",
            reasons: ["weak_angle"],
          },
        ],
        // comments
        [
          {
            id: "comment-1",
            conceptId: "concept-1",
            authorName: "Ada",
            createdAt,
            text: "Lean harder on the fit claim.",
            promotedRuleId: "rule-1",
          },
        ],
      );

      const result = await memberCaller.signals.planFeedback();

      expect(result.rules).toEqual([
        {
          text: "Never open on a price claim.",
          source: "feedback",
          attributionName: "Ada",
        },
      ]);
      // The built-in guardrail is a code fixture the skill carries verbatim —
      // the API deliberately never returns it.
      expect(
        result.rules.some((rule) => rule.text === BUILT_IN_PLAN_RULE),
      ).toBe(false);
      expect(result.concepts).toEqual([
        {
          title: "Fit that stays put",
          hooks: HOOKS,
          feedback: [{ hook: "Hook A", rating: "down", reasons: ["weak_angle"] }],
          comments: [
            {
              authorName: "Ada",
              text: "Lean harder on the fit claim.",
              createdAt,
            },
          ],
        },
      ]);
    });

    it("returns the rules and skips the feedback reads when there is no plan", async () => {
      dbState.selectRows.push([], []);

      await expect(memberCaller.signals.planFeedback()).resolves.toEqual({
        rules: [],
        concepts: [],
      });
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });
  });
});
