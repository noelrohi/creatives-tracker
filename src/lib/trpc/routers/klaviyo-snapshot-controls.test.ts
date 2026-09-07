import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ connection: vi.fn(), configure: vi.fn(), status: vi.fn(), history: vi.fn(), refresh: vi.fn(), prepare: vi.fn(), dispatch: vi.fn(), load: vi.fn() }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: m.connection }) }) }) } }));
vi.mock("@/lib/klaviyo/credential-provider", () => {
  throw new Error("Controls must not import credential resolution");
});
vi.mock("@/lib/klaviyo/snapshot-store", () => ({ configureSnapshotDefinition: m.configure, getSnapshotSyncStatus: m.status, listSnapshotRunSummaries: m.history, requestSnapshotRefresh: m.refresh, prepareSnapshotRun: m.prepare, loadSnapshotRun: m.load }));
vi.mock("@/lib/klaviyo/snapshot-dispatch", () => ({ dispatchSnapshotRun: m.dispatch }));
import { createCallerFactory } from "../init";
import { klaviyoSnapshotControlsRouter } from "./klaviyo-snapshot-controls";
const createCaller = createCallerFactory(klaviyoSnapshotControlsRouter);
function caller(role: "owner" | "admin" | "member" = "admin", principalType: "session" | "apiKey" | "worker" = "session") {
  return createCaller({ session: principalType === "session" ? { user: { id: "user" }, session: { id: "session", activeOrganizationId: "org" } } as never : null, principalType, userId: principalType === "session" ? "user" : null, organizationId: "org", orgRole: role, apiKeyId: null, apiKeyScopes: ["*"] } as Parameters<typeof createCaller>[0]);
}
beforeEach(() => {
  vi.clearAllMocks(); m.connection.mockResolvedValue([{ connectionId: "connection", storeId: "store", status: "ready", accountId: "account" }]);
  m.prepare.mockResolvedValue({ kind: "started", snapshotRunId: "run" }); m.refresh.mockResolvedValue({ kind: "reused", snapshotRunId: "run" });
  m.dispatch.mockResolvedValue({ triggerRunId: "trigger" }); m.status.mockResolvedValue({ definitions: [], datasets: [] }); m.history.mockResolvedValue({ items: [], nextCursor: null });
});
describe("snapshot controls", () => {
  const calls = [
    (c: ReturnType<typeof caller>) => c.configure({ dataset: "metrics", dailyEnabled: false }),
    (c: ReturnType<typeof caller>) => c.refresh({ dataset: "metrics" }),
    (c: ReturnType<typeof caller>) => c.retryDispatch({ snapshotRunId: "run" }),
    (c: ReturnType<typeof caller>) => c.status(),
    (c: ReturnType<typeof caller>) => c.history(),
  ];
  it("rejects members, API keys and workers on every control", async () => {
    for (const call of calls) for (const c of [caller("member"), caller("admin", "apiKey"), caller("admin", "worker")]) await expect(call(c)).rejects.toBeDefined();
    expect(m.connection).not.toHaveBeenCalled(); expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("permits owner/admin sessions and never dispatches status/history/configuration", async () => {
    for (const role of ["owner", "admin"] as const) {
      await caller(role).status(); await caller(role).history(); await caller(role).configure({ dataset: "metrics", dailyEnabled: false });
    }
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.configure).toHaveBeenCalledWith(expect.objectContaining({ scope: { organizationId: "org", storeId: "store", connectionId: "connection" }, dailyEnabled: false }));
  });
  it("inspects degraded stored state without provider credentials", async () => {
    m.connection.mockResolvedValue([{ connectionId: "connection", storeId: "store", status: "degraded", accountId: "account" }]);
    await expect(caller().status()).resolves.toBeDefined();
    await expect(caller().history()).resolves.toBeDefined();
    await expect(caller().refresh({ dataset: "metrics" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("rejects disabled or ambiguous stored bindings rather than choosing another store", async () => {
    for (const rows of [[], [{ status: "disabled" }], [{ status: "disabled" }, { status: "ready" }], [{ status: "ready" }, { status: "ready" }]]) {
      m.connection.mockResolvedValue(rows);
      await expect(caller().status()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(caller().configure({ dataset: "metrics", dailyEnabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(m.status).not.toHaveBeenCalled(); expect(m.configure).not.toHaveBeenCalled();
  });
  it("requires a stored account binding to dispatch", async () => {
    m.connection.mockResolvedValue([{ connectionId: "connection", storeId: "store", status: "ready", accountId: null }]);
    await expect(caller().refresh({ dataset: "metrics" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("refreshes catalogs without enrolling a definition", async () => {
    await expect(caller().refresh({ dataset: "metrics" })).resolves.toMatchObject({ snapshotRunId: "run", triggerRunId: "trigger" });
    expect(m.prepare).toHaveBeenCalledWith(expect.objectContaining({ definitionId: null, configurationVersion: 0 })); expect(m.configure).not.toHaveBeenCalled();
  });
  it("passes explicit oneoffs only to refresh, not configuration", async () => {
    const oneOff = { metricIds: ["M1"], since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" };
    await caller().refresh({ dataset: "events", oneOff });
    expect(m.refresh).toHaveBeenCalledWith(expect.objectContaining({ oneOff })); expect(m.configure).not.toHaveBeenCalled();
  });
  it("returns the durable run on ambiguous dispatch failure", async () => {
    m.dispatch.mockRejectedValue(new Error("private provider details"));
    await expect(caller().refresh({ dataset: "metrics" })).resolves.toEqual({ kind: "started", snapshotRunId: "run", triggerRunId: null, dispatchState: "pending" });
  });
  it("scopes handoff repair without creating a new rolling-window run", async () => {
    m.load.mockResolvedValue({ scope: { organizationId: "other", storeId: "store", connectionId: "connection" } });
    await expect(caller().retryDispatch({ snapshotRunId: "run" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.dispatch).not.toHaveBeenCalled();
    m.load.mockResolvedValue({ scope: { organizationId: "org", storeId: "store", connectionId: "connection" } });
    await caller().retryDispatch({ snapshotRunId: "run" });
    expect(m.dispatch).toHaveBeenCalledWith("run"); expect(m.prepare).not.toHaveBeenCalled();
  });
  it("rejects caller-owned connection scope", async () => {
    await expect(caller().refresh({ dataset: "metrics", connectionId: "other" } as never)).rejects.toBeDefined();
    expect(m.prepare).not.toHaveBeenCalled();
  });
});
