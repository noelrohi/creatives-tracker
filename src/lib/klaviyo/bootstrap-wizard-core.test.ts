import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_STAGES,
  runKlaviyoBootstrapWizard,
  type BootstrapContext,
  type BootstrapProgress,
  type BootstrapWizardAdapters,
} from "../../../scripts/klaviyo-bootstrap-wizard-core";

const context: BootstrapContext = {
  organizationId: "org-reviv",
  storeId: "store-reviv",
  shopDomain: "reviv.myshopify.com",
  storeTimezone: "Asia/Bangkok",
  connectionId: null,
};

function adapters(overrides: Partial<BootstrapWizardAdapters> = {}) {
  const calls: string[] = [];
  const updates: BootstrapProgress[] = [];
  const mark = (name: string) => async () => {
    calls.push(name);
  };
  const value: BootstrapWizardAdapters = {
    preflight: async () => {
      calls.push("preflight");
      return context;
    },
    captureSnapshot: async () => {
      calls.push("snapshot");
      return { orderCount: 10, fingerprint: "safe" };
    },
    runShopifyEvidence: mark("shopify_evidence"),
    runDiscovery: async (input) => {
      calls.push("discovery");
      return { ...input, connectionId: "connection-reviv" };
    },
    runProbe: mark("probe"),
    waitForReview: mark("review"),
    runOrderCore: mark("order_core"),
    runMatching: mark("matching"),
    runClaims: mark("claims"),
    runJourney: mark("journey"),
    runDimensions: mark("dimensions"),
    runReports: mark("reports"),
    verify: async (_input, before) => {
      calls.push(`verify:${before.fingerprint}`);
    },
    progress: (update) => updates.push(update),
    ...overrides,
  };
  return { calls, updates, value };
}

describe("Klaviyo bootstrap wizard", () => {
  it("runs the approved production stages sequentially", async () => {
    const test = adapters();

    const result = await runKlaviyoBootstrapWizard(test.value);

    expect(result.connectionId).toBe("connection-reviv");
    expect(test.calls).toEqual([
      "preflight",
      "snapshot",
      "shopify_evidence",
      "discovery",
      "probe",
      "review",
      "order_core",
      "matching",
      "claims",
      "journey",
      "dimensions",
      "reports",
      "verify:safe",
    ]);
    expect(test.calls.indexOf("dimensions")).toBeLessThan(
      test.calls.indexOf("reports"),
    );
    expect(
      test.updates.filter((update) => update.state === "completed").map(
        (update) => update.stage,
      ),
    ).toEqual(BOOTSTRAP_STAGES);
  });

  it("exposes one review wait before downstream data work", async () => {
    const test = adapters();

    await runKlaviyoBootstrapWizard(test.value);

    const waiting = test.updates.filter((update) => update.state === "waiting");
    expect(waiting).toEqual([
      expect.objectContaining({ stage: "review", state: "waiting" }),
    ]);
    expect(test.calls.indexOf("review")).toBeLessThan(
      test.calls.indexOf("order_core"),
    );
  });

  it("stops every downstream stage when review is rejected", async () => {
    const runOrderCore = vi.fn(async () => undefined);
    const test = adapters({
      waitForReview: async () => {
        throw new Error("Probe was rejected");
      },
      runOrderCore,
    });

    await expect(runKlaviyoBootstrapWizard(test.value)).rejects.toThrow(
      "Bootstrap stage review failed: Probe was rejected",
    );
    expect(runOrderCore).not.toHaveBeenCalled();
  });

  it("stops after the first failed durable stage", async () => {
    const runReports = vi.fn(async () => undefined);
    const test = adapters({
      runDimensions: async () => {
        throw new Error("dimensions failed");
      },
      runReports,
    });

    await expect(runKlaviyoBootstrapWizard(test.value)).rejects.toThrow(
      "Bootstrap stage dimensions failed: dimensions failed",
    );
    expect(runReports).not.toHaveBeenCalled();
  });
});
