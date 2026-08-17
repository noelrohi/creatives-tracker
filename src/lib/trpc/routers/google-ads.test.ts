import { describe, expect, it, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

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
    resolvePilotProbeStore: vi.fn(),
    failGclidProbeReport: vi.fn(),
    listCampaignFactsSummary: vi.fn(),
    getGoogleBucketNetSales: vi.fn(),
    getLatestGclidProbeReport: vi.fn(),
    idempotencyCreate: vi.fn(),
    taskTrigger: vi.fn(),
    requireStore: vi.fn(),
    loadGoogleAdsRevenuePanel: vi.fn(),
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
  resolvePilotProbeStore: mocks.resolvePilotProbeStore,
  failGclidProbeReport: mocks.failGclidProbeReport,
}));
vi.mock("@/lib/google-ads/queries", () => ({
  listCampaignFactsSummary: mocks.listCampaignFactsSummary,
  getGoogleBucketNetSales: mocks.getGoogleBucketNetSales,
  getLatestGclidProbeReport: mocks.getLatestGclidProbeReport,
}));
vi.mock("@/lib/google-ads/revenue-panel", () => ({
  loadGoogleAdsRevenuePanel: mocks.loadGoogleAdsRevenuePanel,
}));
vi.mock("./attribution.shared", () => ({
  requireStore: mocks.requireStore,
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
  mocks.resolvePilotProbeStore.mockResolvedValue({
    id: "store-1",
    organizationId: "org-1",
    ianaTimezone: "America/New_York",
  });
  mocks.failGoogleAdsSyncRun.mockResolvedValue(undefined);
  mocks.failGclidProbeReport.mockResolvedValue(undefined);
  mocks.listCampaignFactsSummary.mockResolvedValue([]);
  mocks.getGoogleBucketNetSales.mockResolvedValue({
    netSalesCents: 0,
    orderCount: 0,
  });
  mocks.getLatestGclidProbeReport.mockResolvedValue(null);
  mocks.idempotencyCreate.mockImplementation(async (key: string) => ({ key }));
  mocks.taskTrigger.mockResolvedValue({ id: "trigger-run-1" });
  mocks.requireStore.mockResolvedValue({
    id: "store-1",
    organizationId: "org-1",
  });
  mocks.loadGoogleAdsRevenuePanel.mockResolvedValue({
    connection: null,
    googleCurrencyCode: null,
    ourSide: {
      bucketRevenueCents: 0,
      bucketOrders: 0,
      feedRevenueCents: 0,
      feedOrders: 0,
      paidRevenueCents: 0,
      paidOrders: 0,
      paidByCampaign: [],
    },
    googleSays: null,
  });
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
  [
    "revenuePanel",
    (caller) =>
      caller.revenuePanel({ dateFrom: "2026-07-01", dateTo: "2026-07-30" }),
  ],
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

  it("runProbe throws FORBIDDEN when the store belongs to a different org, without ever minting a probe report row", async () => {
    mocks.resolvePilotProbeStore.mockResolvedValue({
      id: "store-1",
      organizationId: "org-2",
      ianaTimezone: "America/New_York",
    });
    await expect(sessionCaller("admin").runProbe()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.prepareGclidProbeRun).not.toHaveBeenCalled();
    expect(mocks.failGclidProbeReport).not.toHaveBeenCalled();
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("startFactsSync dispatches with the exact first-dispatch idempotency key under global scope", async () => {
    await sessionCaller("admin").startFactsSync();
    expect(mocks.idempotencyCreate).toHaveBeenCalledWith(
      "google-ads-facts-batch:first:facts-run-1",
      { scope: "global" },
    );
    expect(mocks.taskTrigger).toHaveBeenCalledWith(
      "google-ads-facts-batch",
      { syncRunId: "facts-run-1" },
      expect.objectContaining({ idempotencyKeyTTL: "7d" }),
    );
  });

  it("campaignFacts scopes the summary and reference queries to the connection's ids", async () => {
    await sessionCaller("admin").campaignFacts({
      fromDay: "2026-07-01",
      toDay: "2026-07-30",
    });
    expect(mocks.listCampaignFactsSummary).toHaveBeenCalledWith({
      connectionId: "connection-1",
      fromDay: "2026-07-01",
      toDay: "2026-07-30",
    });
    expect(mocks.getGoogleBucketNetSales).toHaveBeenCalledWith({
      organizationId: "org-1",
      storeId: "store-1",
      fromDay: "2026-07-01",
      toDay: "2026-07-30",
    });
  });

  it("startDiscovery maps a concurrent (23505) run into CONFLICT", async () => {
    mocks.createGoogleAdsSyncRun.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
      }),
    );
    await expect(sessionCaller("admin").startDiscovery()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A Google Ads discovery run is already in progress",
    });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("startFactsSync maps an 'already running' prepare error into CONFLICT", async () => {
    mocks.prepareGoogleAdsFactsRun.mockRejectedValue(
      new Error("A Google Ads facts sync is already running for this connection"),
    );
    await expect(sessionCaller("admin").startFactsSync()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A Google Ads facts sync is already running for this connection",
    });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it("probeReport resolves via the store binding even when no connection exists yet", async () => {
    mocks.getPilotGoogleAdsConnectionForOrganization.mockResolvedValue(null);
    mocks.getLatestGclidProbeReport.mockResolvedValue({ id: "report-1" });
    const report = await sessionCaller("admin").probeReport();
    expect(mocks.getLatestGclidProbeReport).toHaveBeenCalledWith({
      organizationId: "org-1",
      storeId: "store-1",
    });
    expect(report).toEqual({ id: "report-1" });
  });

  it("probeReport returns null (not FORBIDDEN) for a store bound to a different organization", async () => {
    mocks.resolvePilotProbeStore.mockResolvedValue({
      id: "store-1",
      organizationId: "org-2",
      ianaTimezone: "America/New_York",
    });
    const report = await sessionCaller("admin").probeReport();
    expect(report).toBeNull();
    expect(mocks.getLatestGclidProbeReport).not.toHaveBeenCalled();
  });

  it("probeReport falls back to the connection-based lookup when store resolution errors", async () => {
    mocks.resolvePilotProbeStore.mockRejectedValue(new Error("env misconfigured"));
    await sessionCaller("admin").probeReport();
    expect(mocks.getLatestGclidProbeReport).toHaveBeenCalledWith({
      organizationId: "org-1",
      storeId: "store-1",
    });
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

  it("revenuePanel rejects dateFrom > dateTo with BAD_REQUEST", async () => {
    await expect(
      sessionCaller("admin").revenuePanel({
        dateFrom: "2026-07-30",
        dateTo: "2026-07-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.requireStore).not.toHaveBeenCalled();
    expect(mocks.loadGoogleAdsRevenuePanel).not.toHaveBeenCalled();
  });

  it("revenuePanel propagates NOT_FOUND when no Shopify store is connected, without calling the loader", async () => {
    mocks.requireStore.mockRejectedValue(
      new TRPCError({
        code: "NOT_FOUND",
        message: "No Shopify store is connected for this organization",
      }),
    );
    await expect(
      sessionCaller("admin").revenuePanel({
        dateFrom: "2026-07-01",
        dateTo: "2026-07-30",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.loadGoogleAdsRevenuePanel).not.toHaveBeenCalled();
  });

  it("revenuePanel loads the panel scoped to ctx's org and the resolved store, passing the dates through verbatim", async () => {
    const summary = {
      connection: { status: "ready", lastFactsSyncedAt: null, backfillCompletedAt: null },
      googleCurrencyCode: "USD",
      ourSide: {
        bucketRevenueCents: 1000,
        bucketOrders: 3,
        feedRevenueCents: 200,
        feedOrders: 1,
        paidRevenueCents: 800,
        paidOrders: 2,
        paidByCampaign: [],
      },
      googleSays: null,
    };
    mocks.loadGoogleAdsRevenuePanel.mockResolvedValue(summary);
    const result = await sessionCaller("admin").revenuePanel({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-30",
    });
    expect(mocks.requireStore).toHaveBeenCalledWith("org-1");
    expect(mocks.loadGoogleAdsRevenuePanel).toHaveBeenCalledWith({
      organizationId: "org-1",
      storeId: "store-1",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-30",
    });
    expect(result).toEqual(summary);
  });
});
