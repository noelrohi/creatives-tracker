import { describe, expect, it, vi } from "vitest";
import { prepareKlaviyoProbeRun, summarizeProbe } from "@/lib/klaviyo/probe";

describe("summarizeProbe", () => {
  it("reports coverage and collisions without retaining sampled values", () => {
    const report = summarizeProbe({
      sampledShopifyOrderIds: ["1001", "1002"],
      observations: [
        {
          metricKind: "placed_order",
          occurredAt: new Date("2026-07-20T10:00:00.000Z"),
          sourceProperty: "OrderId",
          sourceType: "string",
          normalizedValue: "1001",
          productComparable: true,
          attributionKinds: ["campaign", "message"],
          fingerprint: [],
          warnings: [],
        },
        {
          metricKind: "placed_order",
          occurredAt: new Date("2026-07-20T11:00:00.000Z"),
          sourceProperty: "OrderId",
          sourceType: "string",
          normalizedValue: "1001",
          productComparable: false,
          attributionKinds: [],
          fingerprint: [],
          warnings: [],
        },
      ],
      redactionVerified: true,
    });

    expect(report.identifierCoverage.OrderId).toBe(2);
    expect(report.collisionSummary.OrderId).toBe(1);
    expect(report.bindingOverlapCount).toBe(2);
    expect(report.productCoverage.comparable).toBe(1);
    expect(report.attributionCoverage.campaign).toBe(1);
    expect(report.attributionCoverage.message).toBe(1);
    expect(JSON.stringify(report)).not.toContain("1001");
  });

  it("keeps only bounded day-level unmatched examples and verified redaction", () => {
    const report = summarizeProbe({
      sampledShopifyOrderIds: ["2001"],
      observations: Array.from({ length: 12 }, (_, index) => ({
        metricKind: "placed_order" as const,
        occurredAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T09:30:45.000Z`),
        sourceProperty: "OrderId",
        sourceType: "string" as const,
        normalizedValue: null,
        productComparable: false,
        attributionKinds: [],
        fingerprint: [
          { key: "OrderId", keyKind: "approved" as const, type: "string" as const },
        ],
        warnings: ["identifier_shaped_identifier_omitted"],
      })),
      redactionVerified: true,
    });

    expect(report.bindingOverlapCount).toBe(0);
    expect(report.unmatchedSummary.placed_order).toBe(12);
    expect(report.unmatchedExamples).toHaveLength(10);
    expect(report.unmatchedExamples[0]).toEqual({
      metricKind: "placed_order",
      occurredOnUtc: "2026-07-01",
      fingerprint: [{ key: "OrderId", keyKind: "approved", type: "string" }],
      warnings: ["identifier_shaped_identifier_omitted"],
    });
    expect(JSON.stringify(report)).not.toContain("09:30:45");
    expect(report.redactionVerified).toBe(true);
  });

  it("refuses to verify redaction when serialized output carries identity", () => {
    const report = summarizeProbe({
      sampledShopifyOrderIds: [],
      observations: [
        {
          metricKind: "placed_order",
          occurredAt: new Date("2026-07-20T10:00:00.000Z"),
          sourceProperty: "OrderId",
          sourceType: "string",
          normalizedValue: null,
          productComparable: false,
          attributionKinds: [],
          fingerprint: [],
          warnings: ["contact user@example.com"],
        },
      ],
      redactionVerified: true,
    });
    expect(report.redactionVerified).toBe(false);
  });
});

describe("prepareKlaviyoProbeRun", () => {
  const scope = {
    organizationId: "org-1",
    storeId: "store-1",
    connectionId: "connection-1",
  };
  const readyDeps = () => ({
    loadIdentityKeyring: () => ({}),
    credentialProvider: {
      getPilotBinding: vi.fn(async () => ({
        expectedAccountId: "account-reviv",
        shopDomain: "reviv.example.myshopify.com",
        allowedUrlHosts: [],
      })),
      resolve: vi.fn(),
    },
    loadProbeReadiness: vi.fn(async () => undefined),
    prepareRun: vi
      .fn<(input: unknown) => Promise<{ syncRunId: string; reused: boolean }>>()
      .mockResolvedValue({ syncRunId: "run-1", reused: false }),
  });

  it("rejects sample sizes outside the 20-50 gate before any write", async () => {
    for (const sampleSize of [19, 51, 0, Number.NaN]) {
      const deps = readyDeps();
      await expect(
        prepareKlaviyoProbeRun({
          scope,
          sampleSize,
          triggerType: "manual",
          now: new Date("2026-08-01T00:00:00.000Z"),
          ...deps,
        }),
      ).rejects.toThrow("Probe sample size must be between 20 and 50");
      expect(deps.prepareRun).not.toHaveBeenCalled();
    }
  });

  it("inserts no run when identity or credential configuration is invalid", async () => {
    const keyringDeps = readyDeps();
    await expect(
      prepareKlaviyoProbeRun({
        scope,
        sampleSize: 20,
        triggerType: "manual",
        now: new Date("2026-08-01T00:00:00.000Z"),
        ...keyringDeps,
        loadIdentityKeyring: () => {
          throw new Error("IDENTITY_HMAC_SECRET is required");
        },
      }),
    ).rejects.toThrow("IDENTITY_HMAC_SECRET is required");
    expect(keyringDeps.prepareRun).not.toHaveBeenCalled();

    const credentialDeps = readyDeps();
    credentialDeps.credentialProvider.getPilotBinding.mockRejectedValue(
      new Error("KLAVIYO_PRIVATE_API_KEY is required"),
    );
    await expect(
      prepareKlaviyoProbeRun({
        scope,
        sampleSize: 20,
        triggerType: "manual",
        now: new Date("2026-08-01T00:00:00.000Z"),
        ...credentialDeps,
      }),
    ).rejects.toThrow("KLAVIYO_PRIVATE_API_KEY is required");
    expect(credentialDeps.prepareRun).not.toHaveBeenCalled();
  });

  it("prepares one scoped probe run with exactly the sampleSize request", async () => {
    const deps = readyDeps();
    const now = new Date("2026-08-01T00:00:00.000Z");
    await expect(
      prepareKlaviyoProbeRun({
        scope,
        sampleSize: 25,
        triggerType: "manual",
        now,
        ...deps,
      }),
    ).resolves.toEqual({ syncRunId: "run-1", reused: false });
    expect(deps.loadProbeReadiness).toHaveBeenCalledWith(scope);
    expect(deps.prepareRun).toHaveBeenCalledWith({
      scope,
      operation: "probe",
      triggerType: "manual",
      requestParameters: { sampleSize: 25 },
      now,
    });
  });
});
