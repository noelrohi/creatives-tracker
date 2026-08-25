import { describe, expect, it, vi } from "vitest";
import type { KlaviyoCompoundPage } from "@/lib/klaviyo/client";
import {
  classifyMetric,
  prepareKlaviyoDiscoveryRun,
  requireUniqueNativeOrderMetrics,
  runKlaviyoDiscovery,
} from "@/lib/klaviyo/discovery";
import type { ConnectionRecord } from "@/lib/klaviyo/source-store";

const shopifyMetric = (id: string, name: string) => ({
  id,
  name,
  integrationName: "Shopify",
  integrationCategory: "ecommerce",
});

function metricResource(
  id: string,
  name: string,
  integrationName: string | null,
  integrationCategory: string | null,
) {
  return {
    type: "metric",
    id,
    attributes: {
      name,
      integration:
        integrationName === null && integrationCategory === null
          ? null
          : { name: integrationName, category: integrationCategory },
    },
  };
}

function makeDiscoveryDependencies(input: {
  persistedAccountId: string | null;
  expectedAccountId: string;
  returnedAccountIds: string[];
  metricPages?: KlaviyoCompoundPage[];
  keyringError?: Error;
}) {
  const scope = {
    organizationId: "org-1",
    storeId: "store-1",
    connectionId: "connection-1",
  };
  const syncRunId = "sync-run-1";

  const connection: ConnectionRecord = {
    ...scope,
    shopDomain: "reviv.example.myshopify.com",
    storeTimezone: "America/New_York",
    accountTimezone: null,
    klaviyoAccountId: input.persistedAccountId,
    initialSourceFrom: null,
    initialSourceTo: null,
    credentialReference: "reviv_environment",
    status: "pending",
  };

  const metricPages: KlaviyoCompoundPage[] = input.metricPages ?? [
    {
      data: [
        metricResource("placed-1", "Placed Order", "Shopify", "ecommerce"),
        metricResource("ordered-1", "Ordered Product", "Shopify", "ecommerce"),
        metricResource("custom-1", "Placed Order Copy", "API", "custom"),
      ],
      included: [],
      nextCursor: null,
      apiRevision: "2026-07-15",
    },
  ];

  const loadIdentityKeyring = vi.fn(() => {
    if (input.keyringError) throw input.keyringError;
    return {};
  });
  const loadConnection = vi.fn(async () => connection);
  const renewHeartbeat = vi
    .fn<(input: unknown) => Promise<{ changed: true }>>()
    .mockResolvedValue({ changed: true });
  const commitDiscovery = vi
    .fn<(input: unknown) => Promise<undefined>>()
    .mockResolvedValue(undefined);

  const credentialProvider = {
    getPilotBinding: vi.fn(async () => ({
      expectedAccountId: input.expectedAccountId,
      shopDomain: "reviv.example.myshopify.com",
      allowedUrlHosts: ["reviv.example.myshopify.com"],
    })),
    resolve: vi.fn(async () => ({
      privateApiKey: "pk_secret",
      reference: "reviv_environment" as const,
      expectedAccountId: input.expectedAccountId,
      allowedUrlHosts: ["reviv.example.myshopify.com"],
    })),
  };

  const listAccounts = vi.fn(async (): Promise<KlaviyoCompoundPage> => ({
    data: input.returnedAccountIds.map((id) => ({
      type: "account",
      id,
      attributes: {
        contact_information: { organization_name: "Reviv" },
        timezone: "America/New_York",
        preferred_currency: "USD",
      },
    })),
    included: [],
    nextCursor: null,
    apiRevision: "2026-07-15",
  }));
  let metricPageIndex = 0;
  const listMetrics = vi.fn(async (): Promise<KlaviyoCompoundPage> => {
    const page = metricPages[metricPageIndex];
    if (!page) throw new Error("Metric page fixture exhausted");
    metricPageIndex += 1;
    return page;
  });
  const clientFactory = vi.fn(() => ({ listAccounts, listMetrics }));

  return {
    scope,
    syncRunId,
    commitDiscovery,
    renewHeartbeat,
    listAccounts,
    listMetrics,
    clientFactory,
    loadIdentityKeyring,
    credentialProvider,
    services: {
      credentialProvider,
      clientFactory,
      loadIdentityKeyring,
      loadConnection,
      renewHeartbeat,
      commitDiscovery,
    },
  };
}

describe("Klaviyo discovery", () => {
  it("does not accept a same-named custom metric", () => {
    expect(
      classifyMetric({
        id: "custom-1",
        name: "Placed Order",
        integrationName: "API",
        integrationCategory: "custom",
      }),
    ).toBeNull();
  });

  it("classifies journey metrics without requiring a Shopify integration", () => {
    expect(
      classifyMetric({
        id: "clicked-1",
        name: "Clicked Email",
        integrationName: "Klaviyo",
        integrationCategory: "internal",
      }),
    ).toBe("clicked_email");
    expect(
      classifyMetric({
        id: "unknown-1",
        name: "Some Custom Metric",
        integrationName: "Shopify",
        integrationCategory: "ecommerce",
      }),
    ).toBeNull();
  });

  it("classifies list consent metrics regardless of integration", () => {
    expect(
      classifyMetric({
        id: "m-sub",
        name: "Subscribed to List",
        integrationName: "klaviyo",
        integrationCategory: "internal",
      }),
    ).toBe("subscribed_to_list");
    expect(
      classifyMetric({
        id: "m-unsub",
        name: "Unsubscribed from List",
        integrationName: "klaviyo",
        integrationCategory: "internal",
      }),
    ).toBe("unsubscribed_from_list");
  });

  it("requires one Shopify-native metric of each order kind", () => {
    expect(
      requireUniqueNativeOrderMetrics([
        shopifyMetric("placed-1", "Placed Order"),
        shopifyMetric("ordered-1", "Ordered Product"),
      ]),
    ).toEqual({
      placed_order: "placed-1",
      ordered_product: "ordered-1",
    });
  });

  it("fails closed when a native order metric is duplicated", () => {
    expect(() =>
      requireUniqueNativeOrderMetrics([
        shopifyMetric("placed-1", "Placed Order"),
        shopifyMetric("placed-2", "Placed Order"),
        shopifyMetric("ordered-1", "Ordered Product"),
      ]),
    ).toThrow("Expected exactly one Shopify-native Placed Order metric");
  });

  it("fails closed when a native order metric is missing", () => {
    expect(() =>
      requireUniqueNativeOrderMetrics([
        shopifyMetric("placed-1", "Placed Order"),
      ]),
    ).toThrow("Expected exactly one Shopify-native Ordered Product metric");
  });

  it("verifies Accounts before binding a pending connection", async () => {
    const deps = makeDiscoveryDependencies({
      persistedAccountId: null,
      expectedAccountId: "account-reviv",
      returnedAccountIds: ["account-reviv"],
    });
    const result = await runKlaviyoDiscovery({
      scope: deps.scope,
      syncRunId: deps.syncRunId,
      ...deps.services,
    });
    expect(deps.commitDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAccountId: "account-reviv" }),
    );
    expect(result).toEqual({
      scope: deps.scope,
      accountId: "account-reviv",
      metricCount: 2,
      orderMetricIds: {
        placed_order: "placed-1",
        ordered_product: "ordered-1",
      },
    });
    const committed = deps.commitDiscovery.mock.calls[0]![0] as unknown as {
      account: Record<string, unknown>;
      metrics: Array<Record<string, unknown>>;
    };
    expect(committed.account).toEqual({
      id: "account-reviv",
      name: "Reviv",
      timezone: "America/New_York",
      currency: "USD",
    });
    expect(committed.metrics).toEqual([
      expect.objectContaining({
        externalMetricId: "placed-1",
        canonicalKind: "placed_order",
        ingestionEnabled: true,
        apiRevision: "2026-07-15",
      }),
      expect.objectContaining({
        externalMetricId: "ordered-1",
        canonicalKind: "ordered_product",
        ingestionEnabled: true,
        apiRevision: "2026-07-15",
      }),
    ]);
  });

  it("writes no account or metric rows when Accounts returns another account", async () => {
    const deps = makeDiscoveryDependencies({
      persistedAccountId: null,
      expectedAccountId: "account-reviv",
      returnedAccountIds: ["account-other"],
    });
    await expect(
      runKlaviyoDiscovery({
        scope: deps.scope,
        syncRunId: deps.syncRunId,
        ...deps.services,
      }),
    ).rejects.toThrow(
      "Discovered Klaviyo account does not match the Reviv binding",
    );
    expect(deps.commitDiscovery).not.toHaveBeenCalled();
  });

  it("fails before client construction, remote calls, or commit without HMAC secrets", async () => {
    const deps = makeDiscoveryDependencies({
      persistedAccountId: null,
      expectedAccountId: "account-reviv",
      returnedAccountIds: ["account-reviv"],
      keyringError: new Error("IDENTITY_HMAC_SECRET is required"),
    });
    await expect(
      runKlaviyoDiscovery({
        scope: deps.scope,
        syncRunId: deps.syncRunId,
        ...deps.services,
      }),
    ).rejects.toThrow("IDENTITY_HMAC_SECRET is required");
    expect(deps.clientFactory).not.toHaveBeenCalled();
    expect(deps.listAccounts).not.toHaveBeenCalled();
    expect(deps.listMetrics).not.toHaveBeenCalled();
    expect(deps.commitDiscovery).not.toHaveBeenCalled();
    expect(deps.renewHeartbeat).not.toHaveBeenCalled();
  });

  it("renews the prepared run heartbeat between remote metric pages", async () => {
    const deps = makeDiscoveryDependencies({
      persistedAccountId: "account-reviv",
      expectedAccountId: "account-reviv",
      returnedAccountIds: ["account-reviv"],
      metricPages: [
        {
          data: [
            metricResource("placed-1", "Placed Order", "Shopify", "ecommerce"),
          ],
          included: [],
          nextCursor: "cursor-2",
          apiRevision: "2026-07-15",
        },
        {
          data: [
            metricResource(
              "ordered-1",
              "Ordered Product",
              "Shopify",
              "ecommerce",
            ),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      ],
    });
    await runKlaviyoDiscovery({
      scope: deps.scope,
      syncRunId: deps.syncRunId,
      ...deps.services,
    });
    // One initial resolve renewal plus one renewal after each metric page.
    expect(deps.renewHeartbeat).toHaveBeenCalledTimes(3);
    expect(deps.listMetrics).toHaveBeenNthCalledWith(1, null);
    expect(deps.listMetrics).toHaveBeenNthCalledWith(2, "cursor-2");
    expect(
      deps.renewHeartbeat.mock.calls.every(
        ([call]) =>
          (call as { operation: string; syncRunId: string }).operation ===
            "discovery" &&
          (call as { operation: string; syncRunId: string }).syncRunId ===
            deps.syncRunId,
      ),
    ).toBe(true);
  });
});

describe("prepareKlaviyoDiscoveryRun", () => {
  it("inserts no run when the identity keyring is invalid", async () => {
    const prepareRun = vi.fn();
    await expect(
      prepareKlaviyoDiscoveryRun({
        scope: {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "connection-1",
        },
        triggerType: "manual",
        now: new Date("2026-08-01T00:00:00.000Z"),
        loadIdentityKeyring: () => {
          throw new Error("IDENTITY_HMAC_SECRET is required");
        },
        credentialProvider: {
          getPilotBinding: vi.fn(),
          resolve: vi.fn(),
        },
        prepareRun,
      }),
    ).rejects.toThrow("IDENTITY_HMAC_SECRET is required");
    expect(prepareRun).not.toHaveBeenCalled();
  });

  it("inserts no run when the credential binding is invalid", async () => {
    const prepareRun = vi.fn();
    await expect(
      prepareKlaviyoDiscoveryRun({
        scope: {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "connection-1",
        },
        triggerType: "manual",
        now: new Date("2026-08-01T00:00:00.000Z"),
        loadIdentityKeyring: () => ({}),
        credentialProvider: {
          getPilotBinding: vi.fn(async () => {
            throw new Error("KLAVIYO_PRIVATE_API_KEY is required");
          }),
          resolve: vi.fn(),
        },
        prepareRun,
      }),
    ).rejects.toThrow("KLAVIYO_PRIVATE_API_KEY is required");
    expect(prepareRun).not.toHaveBeenCalled();
  });

  it("prepares a scoped discovery run after both secret checks pass", async () => {
    const prepareRun = vi
      .fn()
      .mockResolvedValue({ syncRunId: "run-1", reused: false });
    const now = new Date("2026-08-01T00:00:00.000Z");
    await expect(
      prepareKlaviyoDiscoveryRun({
        scope: {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "connection-1",
        },
        triggerType: "manual",
        now,
        loadIdentityKeyring: () => ({}),
        credentialProvider: {
          getPilotBinding: vi.fn(async () => ({
            expectedAccountId: "account-reviv",
            shopDomain: "reviv.example.myshopify.com",
            allowedUrlHosts: [],
          })),
          resolve: vi.fn(),
        },
        prepareRun,
      }),
    ).resolves.toEqual({ syncRunId: "run-1", reused: false });
    expect(prepareRun).toHaveBeenCalledWith({
      scope: {
        organizationId: "org-1",
        storeId: "store-1",
        connectionId: "connection-1",
      },
      operation: "discovery",
      triggerType: "manual",
      requestParameters: {},
      now,
    });
  });
});
