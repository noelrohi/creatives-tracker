import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const connection = {
    organizationId: "org-1",
    storeId: "store-1",
    connectionId: "connection-1",
    shopDomain: "reviv.example.myshopify.com",
    storeTimezone: "America/New_York",
    klaviyoAccountId: "account-reviv",
    initialSourceFrom: null,
    initialSourceTo: null,
    credentialReference: "reviv_environment" as const,
    status: "ready" as const,
  };
  return {
    connection,
    getKlaviyoHealthForOrganization: vi.fn(),
    getPilotConnectionForOrganization: vi.fn(),
    ensurePilotConnection: vi.fn(),
    listKlaviyoSyncRuns: vi.fn(),
    listKlaviyoProbeReview: vi.fn(),
    failKlaviyoSyncRunAfterRetryExhaustion: vi.fn(),
    prepareKlaviyoDiscoveryRun: vi.fn(),
    prepareKlaviyoProbeRun: vi.fn(),
    reviewProbeReport: vi.fn(),
    reviewJoinRule: vi.fn(),
    startOrResumeOrderCoreSync: vi.fn(),
    idempotencyCreate: vi.fn(),
    taskTrigger: vi.fn(),
  };
});

vi.mock("@/db", () => ({ db: {} }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  idempotencyKeys: { create: mocks.idempotencyCreate },
  tasks: { trigger: mocks.taskTrigger },
}));
vi.mock("@/lib/klaviyo/source-store", () => ({
  getKlaviyoHealthForOrganization: mocks.getKlaviyoHealthForOrganization,
  getPilotConnectionForOrganization: mocks.getPilotConnectionForOrganization,
  ensurePilotConnection: mocks.ensurePilotConnection,
  listKlaviyoSyncRuns: mocks.listKlaviyoSyncRuns,
  listKlaviyoProbeReview: mocks.listKlaviyoProbeReview,
  failKlaviyoSyncRunAfterRetryExhaustion:
    mocks.failKlaviyoSyncRunAfterRetryExhaustion,
}));
vi.mock("@/lib/klaviyo/discovery", () => ({
  prepareKlaviyoDiscoveryRun: mocks.prepareKlaviyoDiscoveryRun,
}));
vi.mock("@/lib/klaviyo/probe", () => ({
  prepareKlaviyoProbeRun: mocks.prepareKlaviyoProbeRun,
}));
vi.mock("@/lib/klaviyo/join-rules", () => ({
  reviewProbeReport: mocks.reviewProbeReport,
  reviewJoinRule: mocks.reviewJoinRule,
}));
vi.mock("@/lib/klaviyo/source-runner", () => ({
  startOrResumeOrderCoreSync: mocks.startOrResumeOrderCoreSync,
}));

const { createCallerFactory } = await import("../init");
const { klaviyoRouter } = await import("./klaviyo");

const createCaller = createCallerFactory(klaviyoRouter);

function sessionCaller(orgRole: "owner" | "admin" | "member") {
  return createCaller({
    session: {
      user: { id: "user-1" },
      session: { id: "session-1", activeOrganizationId: "org-1" },
    } as never,
    principalType: "session" as const,
    userId: "user-1",
    organizationId: "org-1",
    orgRole,
    apiKeyId: null,
    apiKeyScopes: [],
  });
}

function apiKeyCaller() {
  return createCaller({
    session: null,
    principalType: "apiKey" as const,
    userId: null,
    organizationId: "org-1",
    orgRole: null,
    apiKeyId: "key-1",
    apiKeyScopes: ["*"],
  });
}

function workerCaller() {
  return createCaller({
    session: null,
    principalType: "worker" as const,
    userId: null,
    organizationId: "org-1",
    orgRole: null,
    apiKeyId: null,
    apiKeyScopes: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPilotConnectionForOrganization.mockResolvedValue(mocks.connection);
  mocks.ensurePilotConnection.mockResolvedValue(mocks.connection);
  mocks.getKlaviyoHealthForOrganization.mockResolvedValue({
    configured: true,
    store: {
      id: "store-1",
      shopDomain: "reviv.example.myshopify.com",
      ianaTimezone: "America/New_York",
      currency: "USD",
      todayInStoreTz: "2026-08-04",
    },
    connection: {
      status: "ready",
      accountName: "Reviv",
      timezone: "America/New_York",
      currency: "USD",
      todayInAccountTz: "2026-08-04",
      lastDiscoverySyncedAt: null,
      lastEventSyncedAt: null,
    },
  });
  mocks.listKlaviyoSyncRuns.mockResolvedValue({ runs: [], nextCursor: null });
  mocks.listKlaviyoProbeReview.mockResolvedValue({ reports: [], rules: [] });
  mocks.prepareKlaviyoDiscoveryRun.mockResolvedValue({
    syncRunId: "discovery-run-1",
    reused: false,
  });
  mocks.prepareKlaviyoProbeRun.mockResolvedValue({
    syncRunId: "probe-run-1",
    reused: false,
  });
  mocks.startOrResumeOrderCoreSync.mockResolvedValue({
    syncRunId: "events-run-1",
    resumed: false,
  });
  mocks.reviewProbeReport.mockResolvedValue(undefined);
  mocks.reviewJoinRule.mockResolvedValue(undefined);
  mocks.failKlaviyoSyncRunAfterRetryExhaustion.mockResolvedValue({
    changed: true,
  });
  mocks.idempotencyCreate.mockImplementation(async (key: string) => ({ key }));
  mocks.taskTrigger.mockResolvedValue({ id: "trigger-run-1" });
});

const PROCEDURE_CALLS: Array<[string, (caller: ReturnType<typeof sessionCaller>) => Promise<unknown>]> = [
  ["health", (caller) => caller.health()],
  ["syncRuns", (caller) => caller.syncRuns({ limit: 20 })],
  ["probe", (caller) => caller.probe()],
  ["startDiscovery", (caller) => caller.startDiscovery()],
  ["runProbe", (caller) => caller.runProbe({ sampleSize: 20 })],
  [
    "approveProbe",
    (caller) => caller.approveProbe({ reportId: "r", reviewNote: "note" }),
  ],
  [
    "rejectProbe",
    (caller) => caller.rejectProbe({ reportId: "r", reviewNote: "note" }),
  ],
  [
    "approveJoinRule",
    (caller) => caller.approveJoinRule({ ruleId: "j", reviewNote: "note" }),
  ],
  [
    "rejectJoinRule",
    (caller) => caller.rejectJoinRule({ ruleId: "j", reviewNote: "note" }),
  ],
  [
    "startOrderCoreSync",
    (caller) =>
      caller.startOrderCoreSync({
        dateFrom: "2026-07-01",
        dateTo: "2026-07-30",
      }),
  ],
];

describe("klaviyo router RBAC", () => {
  it("forbids member, API-key, and worker callers for every procedure", async () => {
    for (const [, call] of PROCEDURE_CALLS) {
      await expect(call(sessionCaller("member"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        call(apiKeyCaller() as unknown as ReturnType<typeof sessionCaller>),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        call(workerCaller() as unknown as ReturnType<typeof sessionCaller>),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("allows owner and admin sessions through every procedure", async () => {
    for (const [, call] of PROCEDURE_CALLS) {
      await expect(call(sessionCaller("admin"))).resolves.toBeDefined();
      await expect(call(sessionCaller("owner"))).resolves.toBeDefined();
    }
  });
});

describe("klaviyo router behavior", () => {
  it("returns safe store health before a connection exists", async () => {
    mocks.getKlaviyoHealthForOrganization.mockResolvedValue({
      configured: true,
      store: {
        id: "store-1",
        shopDomain: "reviv.example.myshopify.com",
        ianaTimezone: "America/New_York",
        currency: "USD",
        todayInStoreTz: "2026-08-04",
      },
      connection: null,
    });
    const health = await sessionCaller("admin").health();
    expect(health.connection).toBeNull();
    expect(health.store?.todayInStoreTz).toBe("2026-08-04");
    expect(mocks.getKlaviyoHealthForOrganization).toHaveBeenCalledWith("org-1");
    expect(JSON.stringify(health)).not.toContain("account-reviv");
  });

  it("returns todayInStoreTz and discovered todayInAccountTz server-side", async () => {
    const health = await sessionCaller("admin").health();
    expect(health.store?.todayInStoreTz).toBe("2026-08-04");
    expect(health.connection?.todayInAccountTz).toBe("2026-08-04");
  });

  it("returns empty probe review before a connection exists", async () => {
    mocks.getPilotConnectionForOrganization.mockResolvedValue(null);
    await expect(sessionCaller("admin").probe()).resolves.toEqual({
      reports: [],
      rules: [],
    });
    expect(mocks.listKlaviyoProbeReview).not.toHaveBeenCalled();
  });

  it("derives every scope server-side and ignores browser scope fields", async () => {
    await sessionCaller("admin").syncRuns({ limit: 5 });
    expect(mocks.listKlaviyoSyncRuns).toHaveBeenCalledWith({
      scope: mocks.connection,
      limit: 5,
      cursor: null,
    });
    await sessionCaller("admin").startOrderCoreSync({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-30",
    });
    const startCall = mocks.startOrResumeOrderCoreSync.mock.calls[0]![0] as {
      scope: { organizationId: string; storeId: string; connectionId: string };
    };
    expect(startCall.scope.organizationId).toBe("org-1");
    expect(startCall.scope.storeId).toBe("store-1");
    expect(startCall.scope.connectionId).toBe("connection-1");
  });

  it("startDiscovery prepares or resumes a discovery run before triggering by syncRunId", async () => {
    const result = await sessionCaller("admin").startDiscovery();
    expect(mocks.ensurePilotConnection).toHaveBeenCalledWith("org-1");
    expect(mocks.prepareKlaviyoDiscoveryRun).toHaveBeenCalledWith(
      expect.objectContaining({ scope: mocks.connection, triggerType: "manual" }),
    );
    expect(mocks.taskTrigger).toHaveBeenCalledWith(
      "klaviyo-discovery",
      { syncRunId: "discovery-run-1" },
      expect.objectContaining({ idempotencyKeyTTL: "7d" }),
    );
    expect(result).toEqual({
      runId: "trigger-run-1",
      syncRunId: "discovery-run-1",
    });
  });

  it("runProbe persists sampleSize 20 through 50 before triggering by syncRunId", async () => {
    await sessionCaller("admin").runProbe({ sampleSize: 50 });
    expect(mocks.prepareKlaviyoProbeRun).toHaveBeenCalledWith(
      expect.objectContaining({ sampleSize: 50, triggerType: "manual" }),
    );
    expect(mocks.taskTrigger).toHaveBeenCalledWith(
      "klaviyo-probe",
      { syncRunId: "probe-run-1" },
      expect.anything(),
    );
    await expect(
      sessionCaller("admin").runProbe({ sampleSize: 19 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      sessionCaller("admin").runProbe({ sampleSize: 51 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("splits probe and join-rule approval/rejection into stable mutations", async () => {
    await sessionCaller("admin").approveProbe({
      reportId: "report-1",
      reviewNote: "looks safe",
    });
    expect(mocks.reviewProbeReport).toHaveBeenCalledWith({
      scope: mocks.connection,
      reportId: "report-1",
      reviewerId: "user-1",
      decision: "passed",
      reviewNote: "looks safe",
    });
    await sessionCaller("admin").rejectProbe({
      reportId: "report-2",
      reviewNote: "unsafe",
    });
    expect(mocks.reviewProbeReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ reportId: "report-2", decision: "failed" }),
    );
    await sessionCaller("admin").approveJoinRule({
      ruleId: "rule-1",
      reviewNote: "zero collisions",
    });
    expect(mocks.reviewJoinRule).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "rule-1", decision: "approved" }),
    );
    await sessionCaller("admin").rejectJoinRule({
      ruleId: "rule-2",
      reviewNote: "ambiguous",
    });
    expect(mocks.reviewJoinRule).toHaveBeenLastCalledWith(
      expect.objectContaining({ ruleId: "rule-2", decision: "rejected" }),
    );
  });

  it("converts inclusive store days into one DST-correct half-open window", async () => {
    await sessionCaller("admin").startOrderCoreSync({
      dateFrom: "2026-03-08",
      dateTo: "2026-03-08",
    });
    const call = mocks.startOrResumeOrderCoreSync.mock.calls[0]![0] as {
      window: { from: Date; to: Date };
      triggerType: string;
    };
    expect(call.triggerType).toBe("manual_backfill");
    expect(call.window.from.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(call.window.to.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(
      call.window.to.getTime() - call.window.from.getTime(),
    ).toBe(23 * 60 * 60 * 1000);
  });

  it("rejects a pre-approved-floor source request before triggering", async () => {
    mocks.startOrResumeOrderCoreSync.mockRejectedValue(
      new Error(
        "Klaviyo source window cannot begin before the approved initial floor",
      ),
    );
    await expect(
      sessionCaller("admin").startOrderCoreSync({
        dateFrom: "2025-01-01",
        dateTo: "2026-07-30",
      }),
    ).rejects.toThrow("approved initial floor");
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("triggers an order batch with only syncRunId", async () => {
    await sessionCaller("admin").startOrderCoreSync({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-30",
    });
    expect(mocks.taskTrigger).toHaveBeenCalledWith(
      "klaviyo-order-core-batch",
      { syncRunId: "events-run-1" },
      expect.objectContaining({ idempotencyKeyTTL: "7d" }),
    );
    const payload = mocks.taskTrigger.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).toEqual(["syncRunId"]);
  });

  it("uses explicit global syncRunId idempotency keys for discovery probe and event handoffs", async () => {
    await sessionCaller("admin").startDiscovery();
    await sessionCaller("admin").runProbe({ sampleSize: 25 });
    await sessionCaller("admin").startOrderCoreSync({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-30",
    });
    expect(mocks.idempotencyCreate.mock.calls.map(([key]) => key)).toEqual([
      "klaviyo:discovery:first:discovery-run-1",
      "klaviyo:probe:first:probe-run-1",
      "klaviyo:events:first:events-run-1",
    ]);
    for (const [, options] of mocks.idempotencyCreate.mock.calls) {
      expect(options).toEqual({ scope: "global" });
    }
  });

  it("terminally fails the prepared row after an ambiguous handoff error", async () => {
    mocks.taskTrigger.mockRejectedValue(new Error("socket hang up: secret token"));
    await expect(sessionCaller("admin").startDiscovery()).rejects.toMatchObject(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: "Klaviyo task handoff failed",
      },
    );
    expect(mocks.failKlaviyoSyncRunAfterRetryExhaustion).toHaveBeenCalledWith({
      scope: mocks.connection,
      syncRunId: "discovery-run-1",
      operation: "discovery",
    });
    const finalizeArgs = JSON.stringify(
      mocks.failKlaviyoSyncRunAfterRetryExhaustion.mock.calls,
    );
    expect(finalizeArgs).not.toContain("secret token");
  });

  it("reuses a live identical handoff key when preparation resumes", async () => {
    mocks.prepareKlaviyoProbeRun.mockResolvedValue({
      syncRunId: "probe-run-1",
      reused: true,
    });
    await sessionCaller("admin").runProbe({ sampleSize: 25 });
    await sessionCaller("admin").runProbe({ sampleSize: 25 });
    expect(mocks.idempotencyCreate.mock.calls.map(([key]) => key)).toEqual([
      "klaviyo:probe:first:probe-run-1",
      "klaviyo:probe:first:probe-run-1",
    ]);
  });
});
