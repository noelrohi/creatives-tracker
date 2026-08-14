import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const connection = {
    id: "connection-1",
    organizationId: "org-1",
    storeId: "store-1",
    googleCustomerId: "123-456-7890",
    descriptiveName: "Reviv Ads",
    currencyCode: "USD",
    timezone: "America/New_York",
    status: "ready" as const,
    lastDiscoverySyncedAt: null,
    lastFactsSyncedAt: null,
    backfillCompletedAt: null,
  };
  return {
    connection,
    getPilotGoogleAdsConnectionForOrganization: vi.fn(),
    ensurePilotGoogleAdsConnection: vi.fn(),
    createGoogleAdsSyncRun: vi.fn(),
    connectionScope: vi.fn(),
    failGoogleAdsSyncRun: vi.fn(),
    listGoogleAdsSyncRuns: vi.fn(),
    prepareGoogleAdsFactsRun: vi.fn(),
    prepareGclidProbeRun: vi.fn(),
    failGclidProbeReport: vi.fn(),
    listCampaignFactsSummary: vi.fn(),
    getGoogleBucketNetSales: vi.fn(),
    getLatestGclidProbeReport: vi.fn(),
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
vi.mock("@/lib/google-ads/sync-store", () => ({
  getPilotGoogleAdsConnectionForOrganization:
    mocks.getPilotGoogleAdsConnectionForOrganization,
  ensurePilotGoogleAdsConnection: mocks.ensurePilotGoogleAdsConnection,
  createGoogleAdsSyncRun: mocks.createGoogleAdsSyncRun,
  connectionScope: mocks.connectionScope,
  failGoogleAdsSyncRun: mocks.failGoogleAdsSyncRun,
  listGoogleAdsSyncRuns: mocks.listGoogleAdsSyncRuns,
}));
vi.mock("@/lib/google-ads/facts-runner", () => ({
  prepareGoogleAdsFactsRun: mocks.prepareGoogleAdsFactsRun,
}));
vi.mock("@/lib/google-ads/gclid-probe", () => ({
  prepareGclidProbeRun: mocks.prepareGclidProbeRun,
  failGclidProbeReport: mocks.failGclidProbeReport,
}));
vi.mock("@/lib/google-ads/queries", () => ({
  listCampaignFactsSummary: mocks.listCampaignFactsSummary,
  getGoogleBucketNetSales: mocks.getGoogleBucketNetSales,
  getLatestGclidProbeReport: mocks.getLatestGclidProbeReport,
}));

const { createCallerFactory } = await import("../init");
const { googleAdsRouter } = await import("./google-ads");

const createCaller = createCallerFactory(googleAdsRouter);

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
  mocks.getPilotGoogleAdsConnectionForOrganization.mockResolvedValue(
    mocks.connection,
  );
  mocks.ensurePilotGoogleAdsConnection.mockResolvedValue(mocks.connection);
  mocks.connectionScope.mockImplementation((connection: typeof mocks.connection) => ({
    organizationId: connection.organizationId,
    storeId: connection.storeId,
    connectionId: connection.id,
  }));
  mocks.createGoogleAdsSyncRun.mockResolvedValue({
    id: "discovery-run-1",
    organizationId: "org-1",
    storeId: "store-1",
    connectionId: "connection-1",
    operation: "discovery",
  });
  mocks.listGoogleAdsSyncRuns.mockResolvedValue([]);
  mocks.prepareGoogleAdsFactsRun.mockResolvedValue({
    id: "facts-run-1",
    organizationId: "org-1",
    storeId: "store-1",
    connectionId: "connection-1",
    operation: "facts",
  });
  mocks.prepareGclidProbeRun.mockResolvedValue({
    id: "probe-1",
    organizationId: "org-1",
    storeId: "store-1",
  });
  mocks.failGoogleAdsSyncRun.mockResolvedValue(undefined);
  mocks.failGclidProbeReport.mockResolvedValue(undefined);
  mocks.listCampaignFactsSummary.mockResolvedValue([]);
  mocks.getGoogleBucketNetSales.mockResolvedValue({ netSales: 0, orderCount: 0 });
  mocks.getLatestGclidProbeReport.mockResolvedValue(null);
  mocks.idempotencyCreate.mockImplementation(async (key: string) => ({ key }));
  mocks.taskTrigger.mockResolvedValue({ id: "trigger-run-1" });
});

const PROCEDURE_CALLS: Array<
  [string, (caller: ReturnType<typeof sessionCaller>) => Promise<unknown>]
> = [
  ["health", (caller) => caller.health()],
  ["probeReport", (caller) => caller.probeReport()],
  [
    "campaignFacts",
    (caller) =>
      caller.campaignFacts({ fromDay: "2026-07-01", toDay: "2026-07-30" }),
  ],
  ["startDiscovery", (caller) => caller.startDiscovery()],
  ["startFactsSync", (caller) => caller.startFactsSync()],
  ["runProbe", (caller) => caller.runProbe()],
];

describe("googleAds router RBAC", () => {
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

describe("googleAds router behavior", () => {
  it("campaignFacts rejects fromDay > toDay with BAD_REQUEST", async () => {
    await expect(
      sessionCaller("admin").campaignFacts({
        fromDay: "2026-07-30",
        toDay: "2026-07-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.listCampaignFactsSummary).not.toHaveBeenCalled();
  });

  it("health returns an empty shell when no connection is configured", async () => {
    mocks.getPilotGoogleAdsConnectionForOrganization.mockResolvedValue(null);
    const health = await sessionCaller("admin").health();
    expect(health).toEqual({ connection: null, syncRuns: [] });
    expect(mocks.listGoogleAdsSyncRuns).not.toHaveBeenCalled();
  });

  it("startDiscovery throws FORBIDDEN when the bootstrap connection belongs to a different org, without triggering a task", async () => {
    mocks.ensurePilotGoogleAdsConnection.mockResolvedValue({
      ...mocks.connection,
      organizationId: "org-2",
    });
    await expect(sessionCaller("admin").startDiscovery()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createGoogleAdsSyncRun).not.toHaveBeenCalled();
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("startFactsSync marks the run failed and rethrows when dispatch fails", async () => {
    mocks.taskTrigger.mockRejectedValue(new Error("socket hang up"));
    await expect(sessionCaller("admin").startFactsSync()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Google Ads task handoff failed",
    });
    expect(mocks.failGoogleAdsSyncRun).toHaveBeenCalledWith({
      scope: {
        organizationId: "org-1",
        storeId: "store-1",
        connectionId: "connection-1",
      },
      syncRunId: "facts-run-1",
      operation: "facts",
      error: {
        code: "trigger_dispatch_failed",
        message: "Google Ads facts dispatch failed",
      },
    });
  });

  it("startFactsSync rejects with PRECONDITION_FAILED when the connection has no timezone", async () => {
    mocks.getPilotGoogleAdsConnectionForOrganization.mockResolvedValue({
      ...mocks.connection,
      timezone: null,
    });
    await expect(sessionCaller("admin").startFactsSync()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(mocks.prepareGoogleAdsFactsRun).not.toHaveBeenCalled();
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("runProbe throws FORBIDDEN when the probe report belongs to a different org, without triggering a task", async () => {
    mocks.prepareGclidProbeRun.mockResolvedValue({
      id: "probe-1",
      organizationId: "org-2",
      storeId: "store-1",
    });
    await expect(sessionCaller("admin").runProbe()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("runProbe marks the report failed and rethrows when dispatch fails", async () => {
    mocks.taskTrigger.mockRejectedValue(new Error("socket hang up"));
    await expect(sessionCaller("admin").runProbe()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Google Ads task handoff failed",
    });
    expect(mocks.failGclidProbeReport).toHaveBeenCalledWith({
      probeReportId: "probe-1",
      code: "trigger_dispatch_failed",
      message: "gclid probe dispatch failed",
    });
  });
});
