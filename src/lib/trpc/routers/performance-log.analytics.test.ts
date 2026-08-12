import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { formatDateOnly } from "@/lib/date";
import { baseWindowStart, breakdownWindowStart } from "@/lib/retention/policy";

const mockState = {
  executeRows: [] as Array<Record<string, unknown>[]>,
  executedSql: [] as unknown[],
  selectWhere: [] as unknown[],
  selectRows: [] as Array<Record<string, unknown>[]>,
  insertedValues: [] as unknown[],
  updatedValues: [] as unknown[],
};

/** Chainable stand-in for a drizzle select/insert/update builder. */
function chain(result: unknown, onWhere?: (where: unknown) => void) {
  const builder: Record<string, unknown> = {};
  const passthrough = [
    "from",
    "innerJoin",
    "leftJoin",
    "values",
    "set",
    "onConflictDoUpdate",
    "orderBy",
  ];
  for (const method of passthrough) {
    builder[method] = vi.fn(() => builder);
  }
  builder.where = vi.fn((where: unknown) => {
    onWhere?.(where);
    return builder;
  });
  builder.returning = vi.fn(async () => result);
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

const mockDb = {
  execute: vi.fn(async (query: unknown) => {
    mockState.executedSql.push(query);
    return { rows: mockState.executeRows.shift() ?? [] };
  }),
  select: vi.fn(() =>
    chain(mockState.selectRows.shift() ?? [], (where) =>
      mockState.selectWhere.push(where),
    ),
  ),
  insert: vi.fn(() => {
    const builder = chain([{ id: "log-1" }]);
    builder.values = vi.fn((values: unknown) => {
      mockState.insertedValues.push(values);
      return builder;
    });
    return builder;
  }),
  update: vi.fn(() => {
    const builder = chain([{ id: "log-1" }]);
    builder.set = vi.fn((values: unknown) => {
      mockState.updatedValues.push(values);
      return builder;
    });
    return builder;
  }),
};

function compileSql(query: unknown): string {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));

const { createMockCaller } = await import("../test-helpers");

const today = formatDateOnly(new Date());
/** Inside every window. */
const IN_WINDOW = today;
/** Older than the 14-day breakdown window, inside the 180-day base window. */
const BEFORE_BREAKDOWN_WINDOW = subDaysYmd(breakdownWindowStart(today), 1);
/** Older than the 180-day base window. */
const BEFORE_BASE_WINDOW = subDaysYmd(baseWindowStart(today), 1);

function subDaysYmd(ymd: string, days: number) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateOnly(date);
}

/**
 * The write procedures return a full performance_log row, which the mocked db
 * can't produce — output validation fails after the guard has already run.
 * These tests only care that the guard let the call through to the db.
 */
async function callPastGuards(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error) {
    expect(error).not.toMatchObject({ code: "BAD_REQUEST" });
  }
}

describe("performanceLog analytics procedures", () => {
  beforeEach(() => {
    mockState.executeRows = [];
    mockState.executedSql = [];
    mockState.selectWhere = [];
    mockState.selectRows = [];
    mockState.insertedValues = [];
    mockState.updatedValues = [];
    vi.clearAllMocks();
  });

  it("demographicBreakdown returns raw breakdown rows", async () => {
    mockState.executeRows.push([
      {
        label: "25-34",
        spend: "120.5",
        conversions: "3",
        roas: "2.4",
        impressions: "10000",
      },
    ]);

    const caller = createMockCaller({ role: "admin" });
    const result = await caller.performanceLog.demographicBreakdown({
      dimension: "age",
      from: breakdownWindowStart(today),
      to: IN_WINDOW,
      format: "video",
    });

    expect(result).toEqual([
      {
        label: "25-34",
        spend: "120.5",
        conversions: "3",
        roas: "2.4",
        impressions: "10000",
      },
    ]);
    const query = compileSql(mockState.executedSql[0]).toLowerCase();
    expect(query).toContain("join ad_creative ac");
    expect(query).toContain("ac.format =");
  });

  describe("breakdown window guard", () => {
    it("demographicBreakdown rejects a range older than the window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.performanceLog.demographicBreakdown({
          dimension: "age",
          from: BEFORE_BREAKDOWN_WINDOW,
          to: IN_WINDOW,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `Breakdown detail is retained for 14 days (since ${breakdownWindowStart(today)}). Request a range within that window or export base rows.`,
      });
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("creativeDemographicBreakdown requires from/to", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        // @ts-expect-error from/to are required now
        caller.performanceLog.creativeDemographicBreakdown({
          creativeId: "creative-1",
          dimension: "gender",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("creativeDemographicBreakdown rejects a range older than the window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.performanceLog.creativeDemographicBreakdown({
          creativeId: "creative-1",
          dimension: "gender",
          from: BEFORE_BREAKDOWN_WINDOW,
          to: IN_WINDOW,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("creativeDemographicBreakdown filters by date inside the window", async () => {
      mockState.executeRows.push([]);
      const caller = createMockCaller({ role: "admin" });
      await caller.performanceLog.creativeDemographicBreakdown({
        creativeId: "creative-1",
        dimension: "gender",
        from: breakdownWindowStart(today),
        to: IN_WINDOW,
      });
      const query = compileSql(mockState.executedSql[0]).toLowerCase();
      expect(query).toContain("pl.date_start <=");
      expect(query).toContain("pl.date_end >=");
    });
  });

  describe("exportByAccount scope", () => {
    it("rejects scope 'all' beyond the breakdown window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.performanceLog.exportByAccount({
          accountId: "account-1",
          dateFrom: BEFORE_BREAKDOWN_WINDOW,
          dateTo: IN_WINDOW,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("allows scope 'all' inside the breakdown window without a base filter", async () => {
      const caller = createMockCaller({ role: "admin" });
      await caller.performanceLog.exportByAccount({
        accountId: "account-1",
        dateFrom: breakdownWindowStart(today),
        dateTo: IN_WINDOW,
      });
      const where = compileSql(mockState.selectWhere[0]).toLowerCase();
      expect(where).not.toContain('"country" is null');
    });

    it("allows scope 'base' over any range and filters to base rows", async () => {
      const caller = createMockCaller({ role: "admin" });
      await caller.performanceLog.exportByAccount({
        accountId: "account-1",
        dateFrom: BEFORE_BASE_WINDOW,
        dateTo: IN_WINDOW,
        scope: "base",
      });
      const where = compileSql(mockState.selectWhere[0]).toLowerCase();
      for (const column of ["country", "platform", "placement", "device", "age", "gender"]) {
        expect(where).toContain(`"${column}" is null`);
      }
    });
  });

  describe("base window write guards", () => {
    it("create rejects a row older than the base window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.performanceLog.create({
          adId: "ad-1",
          dateStart: BEFORE_BASE_WINDOW,
          dateEnd: BEFORE_BASE_WINDOW,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `Performance rows are retained for 180 days (since ${baseWindowStart(today)}). ${BEFORE_BASE_WINDOW} is outside that window.`,
      });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("create accepts a row inside the base window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await callPastGuards(() =>
        caller.performanceLog.create({
          adId: "ad-1",
          dateStart: IN_WINDOW,
          dateEnd: IN_WINDOW,
        }),
      );
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("bulkCreate rejects when any row is older than the base window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.performanceLog.bulkCreate({
          adId: "ad-1",
          rows: [
            { dateStart: IN_WINDOW, dateEnd: IN_WINDOW },
            { dateStart: BEFORE_BASE_WINDOW, dateEnd: BEFORE_BASE_WINDOW },
          ],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("update rejects new dates before the base window", async () => {
      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.performanceLog.update({
          id: "log-1",
          dateStart: BEFORE_BASE_WINDOW,
          dateEnd: BEFORE_BASE_WINDOW,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("update accepts a metric-only edit", async () => {
      const caller = createMockCaller({ role: "admin" });
      await callPastGuards(() =>
        caller.performanceLog.update({ id: "log-1", spend: "12.34" }),
      );
      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });

    it("breakdown-aged rows are still writable — only the base window applies", async () => {
      const caller = createMockCaller({ role: "admin" });
      await callPastGuards(() =>
        caller.performanceLog.create({
          adId: "ad-1",
          dateStart: BEFORE_BREAKDOWN_WINDOW,
          dateEnd: BEFORE_BREAKDOWN_WINDOW,
        }),
      );
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });
  });
});
