import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { syncMetaAccountTimezone } from "./meta-insights-sync";

const mocks = vi.hoisted(() => ({ update: vi.fn(), set: vi.fn(), where: vi.fn() }));
vi.mock("@/db", () => ({ db: { update: mocks.update } }));
const fetchMock = vi.fn();
const account = {
  id: "account-a", metaAccountId: "123", metaAccessToken: "test-token",
  timezone: "Asia/Tokyo", currency: null,
} as Parameters<typeof syncMetaAccountTimezone>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("authoritative Meta currency metadata", () => {
  it("fills currency for accounts that already have timezone metadata", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ currency: "USD" }) });
    await syncMetaAccountTimezone(account);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("fields")).toBe("timezone_name,currency");
    expect(mocks.set).toHaveBeenCalledWith({ currency: "USD" });
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
    expect(query.params).toEqual(["account-a", "123"]);
  });

  it("fills both fields from Meta without inferring currency from timezone", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ currency: "EUR", timezone_name: "Asia/Tokyo" }) });
    await syncMetaAccountTimezone({ ...account, timezone: null });
    expect(mocks.set).toHaveBeenCalledWith({ currency: "EUR", timezone: "Asia/Tokyo" });
  });

  it.each([undefined, null, "", "usd", "US", 123])("does not persist invalid or missing currency %s", async (currency) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ currency }) });
    await syncMetaAccountTimezone(account);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains known currency when only timezone is missing", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ timezone_name: "Europe/London" }) });
    await syncMetaAccountTimezone({ ...account, timezone: null, currency: "GBP" });
    expect(mocks.set).toHaveBeenCalledWith({ timezone: "Europe/London" });
  });

  it("skips complete metadata", async () => {
    await syncMetaAccountTimezone({ ...account, currency: "JPY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves failed metadata unknown and retries on the next call", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("offline"));
    await expect(syncMetaAccountTimezone(account)).resolves.toBeUndefined();
    await expect(syncMetaAccountTimezone(account)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
