import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCaller } from "../test-helpers";

const mocks = vi.hoisted(() => ({
  selectRows: [] as Array<{ featureFlags: Record<string, boolean> | null }>,
  returnedRows: [] as Array<{ featureFlags: Record<string, boolean> | null }>,
  selectLimit: vi.fn(),
  insertValues: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  insertReturning: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(function (this: unknown) { return this; }),
      where: vi.fn(function (this: unknown) { return this; }),
      limit: mocks.selectLimit,
    })),
    insert: vi.fn(() => ({
      values: mocks.insertValues,
    })),
  },
}));

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

describe("orgSettings router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.returnedRows = [{ featureFlags: { attribution: true } }];
    mocks.selectLimit.mockImplementation(() =>
      Promise.resolve(mocks.selectRows),
    );
    mocks.insertValues.mockImplementation(() => ({
      onConflictDoUpdate: mocks.onConflictDoUpdate,
    }));
    mocks.onConflictDoUpdate.mockImplementation(() => ({
      returning: mocks.insertReturning,
    }));
    mocks.insertReturning.mockImplementation(() =>
      Promise.resolve(mocks.returnedRows),
    );
  });

  describe("getFeatureFlags", () => {
    it("returns an empty object when the org has no settings row", async () => {
      mocks.selectRows = [];

      await expect(memberCaller.orgSettings.getFeatureFlags()).resolves.toEqual(
        {},
      );
    });

    it("returns the stored flags when a row exists", async () => {
      mocks.selectRows = [
        { featureFlags: { attribution: true, creativeInsights: false } },
      ];

      await expect(memberCaller.orgSettings.getFeatureFlags()).resolves.toEqual({
        attribution: true,
        creativeInsights: false,
      });
    });
  });

  describe("setFeatureFlag", () => {
    it("inserts a row scoped to the caller's org with just the toggled key", async () => {
      mocks.returnedRows = [{ featureFlags: { attribution: true } }];

      const result = await adminCaller.orgSettings.setFeatureFlag({
        key: "attribution",
        enabled: true,
      });

      expect(mocks.insertValues).toHaveBeenCalledWith({
        organizationId: "test-org-id",
        featureFlags: { attribution: true },
      });
      expect(result).toEqual({ attribution: true });
    });

    it("merges the toggled key into the existing row on conflict", async () => {
      mocks.returnedRows = [
        { featureFlags: { attribution: true, creativeInsights: true } },
      ];

      const result = await adminCaller.orgSettings.setFeatureFlag({
        key: "creativeInsights",
        enabled: true,
      });

      expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
      const [conflict] = mocks.onConflictDoUpdate.mock.calls[0] as [
        {
          set: {
            featureFlags: { queryChunks: unknown[] };
            updatedAt: Date;
          };
        },
      ];
      // The merge must patch the stored jsonb (`||`), not replace it: the SQL
      // carries the existing column plus a one-key patch.
      const chunks = conflict.set.featureFlags.queryChunks;
      expect(chunks).toContain('{"creativeInsights":true}');
      expect(chunks).toContainEqual(
        expect.objectContaining({ name: "feature_flags" }),
      );
      expect(conflict.set.updatedAt).toBeInstanceOf(Date);
      expect(result).toEqual({ attribution: true, creativeInsights: true });
    });

    it("rejects an unknown flag key before touching the database", async () => {
      await expect(
        adminCaller.orgSettings.setFeatureFlag({
          key: "notAFlag" as never,
          enabled: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(mocks.insertValues).not.toHaveBeenCalled();
    });

    it("rejects a plain member", async () => {
      await expect(
        memberCaller.orgSettings.setFeatureFlag({
          key: "attribution",
          enabled: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(mocks.insertValues).not.toHaveBeenCalled();
    });
  });
});
