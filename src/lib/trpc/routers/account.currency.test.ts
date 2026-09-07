import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), where: vi.fn(), set: vi.fn() }));
vi.mock("@/db", () => ({ db: { select: mocks.select, update: mocks.update } }));
const { createApiKeyCaller, createMockCaller } = await import("../test-helpers");
const row = {
  id: "account-a", name: "Account", metaAccountId: "123", metaAccessToken: "test-private-token",
  defaultFacebookPageId: null, defaultInstagramActorId: null, notes: null,
  isDisabled: false, lastImportedAt: null, dataDateEnd: null, timezone: "Asia/Tokyo",
  currency: "USD", organizationId: "org-a", createdAt: new Date(), updatedAt: new Date(),
};
const compile = (query: SQL) => new PgDialect().sqlToQuery(query);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) });
  mocks.where.mockReturnValue({ orderBy: async () => [row], returning: async () => [row] });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
});

describe("safe account currency", () => {
  it("exposes authoritative currency to read keys without exposing credentials", async () => {
    const caller = createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] });
    const result = await caller.adAccount.list();
    expect(result[0]).toMatchObject({ currency: "USD", timezone: "Asia/Tokyo", hasMetaAccessToken: true });
    expect(JSON.stringify(result)).not.toContain("test-private-token");
    expect(result[0]).not.toHaveProperty("metaAccessToken");
    expect(compile(mocks.where.mock.calls[0][0]).params).toContain("org-a");
  });

  it("returns null currency for accounts not yet observed from Meta", async () => {
    mocks.where.mockReturnValue({ orderBy: async () => [{ ...row, currency: null }] });
    const result = await createMockCaller({ role: "member" }).adAccount.list();
    expect(result[0].currency).toBeNull();
  });

  it("invalidates currency atomically only when Meta identity changes", async () => {
    await createMockCaller({ role: "admin", organizationId: "org-a" }).adAccount.update({ id: "account-a", metaAccountId: "456" });
    const query = compile(mocks.set.mock.calls[0][0].currency);
    expect(query.sql).toContain("CASE WHEN");
    expect(query.sql).toContain("ELSE NULL END");
    expect(query.params).toEqual(["456"]);
    expect(compile(mocks.where.mock.calls[0][0]).params).toEqual(["account-a", "org-a"]);
  });

  it("does not modify currency for unrelated updates", async () => {
    await createMockCaller({ role: "admin" }).adAccount.update({ id: "account-a", name: "Renamed" });
    expect(mocks.set).toHaveBeenCalledWith({ name: "Renamed" });
  });
});
