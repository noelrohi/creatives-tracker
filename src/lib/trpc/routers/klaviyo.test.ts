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
    uninstallKlaviyoConnection: vi.fn(),
    idempotencyCreate: vi.fn(),
    taskTrigger: vi.fn(),
    runsRetrieve: vi.fn(),
    loadEvidenceCoverage: vi.fn(),
    listEvidenceOrders: vi.fn(),
    loadOrderExplanation: vi.fn(),
    loadOrderProducts: vi.fn(),
    listUnmatchedEvents: vi.fn(),
    loadOrderClaims: vi.fn(),
    loadOrderInspector: vi.fn(),
    loadOrderJourney: vi.fn(),
    failReportSync: vi.fn(),
    listCurrentReportFacts: vi.fn(),
    startOrResumeReportSync: vi.fn(),
    selectLatestMatchInputs: vi.fn(),
    triggerOrRepairMatchInvocation: vi.fn(),
  };
});

vi.mock("@/db", () => ({ db: {} }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  idempotencyKeys: { create: mocks.idempotencyCreate },
  tasks: { trigger: mocks.taskTrigger },
  runs: { retrieve: mocks.runsRetrieve },
}));
vi.mock("@/lib/klaviyo/queries", () => ({
  loadEvidenceCoverage: mocks.loadEvidenceCoverage,
  listEvidenceOrders: mocks.listEvidenceOrders,
  loadOrderExplanation: mocks.loadOrderExplanation,
  loadOrderProducts: mocks.loadOrderProducts,
  listUnmatchedEvents: mocks.listUnmatchedEvents,
  loadOrderClaims: mocks.loadOrderClaims,
  loadOrderInspector: mocks.loadOrderInspector,
  loadOrderJourney: mocks.loadOrderJourney,
}));
vi.mock("@/lib/klaviyo/report-repository", () => ({
  failReportSync: mocks.failReportSync,
  listCurrentReportFacts: mocks.listCurrentReportFacts,
  startOrResumeReportSync: mocks.startOrResumeReportSync,
}));
vi.mock("@/lib/klaviyo/match-service", () => ({
  selectLatestMatchInputs: mocks.selectLatestMatchInputs,
}));
vi.mock("@/lib/klaviyo/match-invocation", () => ({
  MATCH_INVOCATION_KEY_TTL: "7d",
  triggerOrRepairMatchInvocation: mocks.triggerOrRepairMatchInvocation,
}));
vi.mock("@/schema/klaviyo-match", () => ({ klaviyoMatchRuns: {} }));
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
vi.mock("@/lib/klaviyo/connection-lifecycle", () => ({
  uninstallKlaviyoConnection: mocks.uninstallKlaviyoConnection,
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
  mocks.uninstallKlaviyoConnection.mockResolvedValue({
    shopifyIdentity: { ordersCleared: 2, digestsDeleted: 2 },
  });
  mocks.loadEvidenceCoverage.mockResolvedValue({
    orders: {},
    events: {},
    boundaryWarnings: 0,
  });
  mocks.listEvidenceOrders.mockResolvedValue({ items: [], nextCursor: null });
  mocks.loadOrderExplanation.mockResolvedValue({
    orderId: "order-1",
    orderStatus: "confirmed",
    matchRunId: "run-1",
    matcherVersion: "klaviyo-v1",
    reasonCodes: [],
    boundaryWarning: false,
    candidates: [],
  });
  mocks.loadOrderProducts.mockResolvedValue({
    kind: "canonical",
    productStatus: "unavailable",
    links: [],
  });
  mocks.listUnmatchedEvents.mockResolvedValue({ items: [], nextCursor: null });
  mocks.selectLatestMatchInputs.mockResolvedValue({
    sourceRunId: "source-run-1",
    shopifyEvidenceRunId: "evidence-run-1",
    invocationFingerprint: "fingerprint-1",
    publicationScopeFingerprint: "scope-fp-1",
    window: {
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
    },
  });
  mocks.triggerOrRepairMatchInvocation.mockResolvedValue({
    triggerRunId: "trigger-run-match",
    key: "klaviyo-match:fingerprint-1",
  });
  mocks.runsRetrieve.mockResolvedValue({
    taskIdentifier: "klaviyo-match",
    status: "EXECUTING",
    payload: {
      connectionId: "connection-1",
      invocationFingerprint: "fingerprint-1",
    },
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
  ["uninstall", (caller) => caller.uninstall()],
  [
    "coverage",
    (caller) => caller.coverage({ dateFrom: "2026-07-01", dateTo: "2026-07-30" }),
  ],
  [
    "orders",
    (caller) => caller.orders({ dateFrom: "2026-07-01", dateTo: "2026-07-30" }),
  ],
  ["orderExplanation", (caller) => caller.orderExplanation({ orderId: "o" })],
  ["orderProducts", (caller) => caller.orderProducts({ orderId: "o" })],
  [
    "unmatchedEvents",
    (caller) =>
      caller.unmatchedEvents({ dateFrom: "2026-07-01", dateTo: "2026-07-30" }),
  ],
  ["recomputeMatches", (caller) => caller.recomputeMatches()],
  [
    "matchInvocationStatus",
    (caller) => caller.matchInvocationStatus({ triggerRunId: "run" }),
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

  it("uninstalls through the lifecycle service with server-derived scope only", async () => {
    const result = await sessionCaller("owner").uninstall();
    expect(result).toEqual({
      shopifyIdentity: { ordersCleared: 2, digestsDeleted: 2 },
    });
    expect(mocks.uninstallKlaviyoConnection).toHaveBeenCalledWith(
      mocks.connection,
    );
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

describe("klaviyo match procedures", () => {
  it("recomputeMatches delegates to the invocation repair chain", async () => {
    const result = await sessionCaller("admin").recomputeMatches();
    expect(result).toEqual({
      triggerRunId: "trigger-run-match",
      invocationFingerprint: "fingerprint-1",
    });
    expect(mocks.selectLatestMatchInputs).toHaveBeenCalledWith(mocks.connection);
    expect(mocks.triggerOrRepairMatchInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ invocationFingerprint: "fingerprint-1" }),
    );
  });

  it("maps invocation status into the closed safe union", async () => {
    await expect(
      sessionCaller("admin").matchInvocationStatus({ triggerRunId: "run-1" }),
    ).resolves.toEqual({
      status: "running",
      invocationFingerprint: "fingerprint-1",
    });

    mocks.runsRetrieve.mockResolvedValue({
      taskIdentifier: "klaviyo-match",
      status: "CANCELED",
      payload: {
        connectionId: "connection-1",
        invocationFingerprint: "fingerprint-1",
      },
    });
    await expect(
      sessionCaller("admin").matchInvocationStatus({ triggerRunId: "run-1" }),
    ).resolves.toEqual({
      status: "failed",
      invocationFingerprint: "fingerprint-1",
    });

    mocks.runsRetrieve.mockResolvedValue({
      taskIdentifier: "other-task",
      status: "EXECUTING",
      payload: {},
    });
    await expect(
      sessionCaller("admin").matchInvocationStatus({ triggerRunId: "run-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    mocks.runsRetrieve.mockResolvedValue({
      taskIdentifier: "klaviyo-match",
      status: "EXECUTING",
      payload: {
        connectionId: "other-connection",
        invocationFingerprint: "fingerprint-1",
      },
    });
    await expect(
      sessionCaller("admin").matchInvocationStatus({ triggerRunId: "run-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("derives windows server-side for evidence queries", async () => {
    await sessionCaller("admin").orders({
      dateFrom: "2026-03-08",
      dateTo: "2026-03-08",
    });
    const call = mocks.listEvidenceOrders.mock.calls[0]![0] as {
      window: { from: Date; to: Date };
    };
    // DST spring-forward day in America/New_York is 23 hours.
    expect(call.window.to.getTime() - call.window.from.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });
});

describe("claims, journey, inspector, and report procedures", () => {
  it("passes bounded lookbacks to orderJourney and rejects others", async () => {
    mocks.loadOrderJourney.mockResolvedValue({
      kind: "journey",
      label: "same_klaviyo_profile",
      events: [],
      clipped: false,
      caveats: [],
    });
    const caller = sessionCaller("admin");
    await caller.orderJourney({ orderId: "order-1", lookbackDays: 30 });
    expect(mocks.loadOrderJourney).toHaveBeenCalledWith({
      scope: mocks.connection,
      orderId: "order-1",
      lookbackDays: 30,
    });
    await expect(
      caller.orderJourney({
        orderId: "order-1",
        lookbackDays: 14 as unknown as 7,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns NOT_FOUND for cross-tenant claim and inspector candidates", async () => {
    mocks.loadOrderClaims.mockResolvedValue(null);
    mocks.loadOrderInspector.mockResolvedValue(null);
    const caller = sessionCaller("owner");
    await expect(
      caller.orderClaims({ orderId: "order-1", candidateId: "candidate-x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.orderInspector({ orderId: "order-1", candidateId: "candidate-x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.loadOrderClaims).toHaveBeenCalledWith({
      scope: mocks.connection,
      orderId: "order-1",
      candidateId: "candidate-x",
    });
  });

  it("reads report facts only through the current-slot query", async () => {
    mocks.listCurrentReportFacts.mockResolvedValue({
      generationId: "generation-1",
      publishedAt: new Date(),
      facts: [],
    });
    const caller = sessionCaller("admin");
    await caller.reports({ kind: "flow", limit: 10 });
    expect(mocks.listCurrentReportFacts).toHaveBeenCalledWith({
      scope: mocks.connection,
      kind: "flow",
      limit: 10,
      offset: undefined,
    });
  });

  it("refreshReports supplies server-derived manual reason and the exact global key", async () => {
    mocks.startOrResumeReportSync.mockResolvedValue({
      kind: "started",
      syncRunId: "report-run-1",
      asOf: "2026-08-05T00:00:00.000Z",
      stagedKinds: ["campaign"],
    });
    mocks.idempotencyCreate.mockResolvedValue("key-1");
    mocks.taskTrigger.mockResolvedValue({ id: "trigger-run-1" });
    const caller = sessionCaller("admin");
    const result = await caller.refreshReports({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      kinds: ["campaign"],
    });
    expect(result).toEqual({
      kind: "started",
      syncRunId: "report-run-1",
      stagedKinds: ["campaign"],
    });
    expect(mocks.startOrResumeReportSync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "manual", kinds: ["campaign"] }),
    );
    expect(mocks.idempotencyCreate).toHaveBeenCalledWith(
      "klaviyo:reports:first:report-run-1",
      { scope: "global" },
    );
    expect(mocks.taskTrigger).toHaveBeenCalledWith(
      "klaviyo-reports",
      { syncRunId: "report-run-1" },
      { idempotencyKey: "key-1", idempotencyKeyTTL: "7d" },
    );
  });

  it("short-circuits an all-fresh refresh without any trigger", async () => {
    mocks.startOrResumeReportSync.mockResolvedValue({ kind: "fresh" });
    const caller = sessionCaller("admin");
    const result = await caller.refreshReports({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      kinds: ["campaign", "flow"],
    });
    expect(result).toEqual({ kind: "fresh" });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("finalizes the exact report row on an ambiguous handoff error", async () => {
    mocks.startOrResumeReportSync.mockResolvedValue({
      kind: "started",
      syncRunId: "report-run-2",
      asOf: "2026-08-05T00:00:00.000Z",
      stagedKinds: ["flow"],
    });
    mocks.idempotencyCreate.mockResolvedValue("key-2");
    mocks.taskTrigger.mockRejectedValue(new Error("ambiguous handoff"));
    mocks.failReportSync.mockResolvedValue({ changed: true });
    const caller = sessionCaller("admin");
    await expect(
      caller.refreshReports({
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
        kinds: ["flow"],
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(mocks.failReportSync).toHaveBeenCalledWith(
      expect.objectContaining({ syncRunId: "report-run-2" }),
    );
  });

  it("never exposes connection or run authority supplied by the browser", async () => {
    mocks.loadOrderClaims.mockResolvedValue({ kind: "none", reason: "order_not_evaluated" });
    const caller = sessionCaller("admin");
    await caller.orderClaims({
      orderId: "order-1",
      // Hostile extra fields are stripped by the closed input schema.
      ...( { connectionId: "connection-evil", organizationId: "org-evil" } as object),
    });
    expect(mocks.loadOrderClaims).toHaveBeenCalledWith({
      scope: mocks.connection,
      orderId: "order-1",
      candidateId: null,
    });
  });
});
