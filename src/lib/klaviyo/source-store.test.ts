import { describe, expect, it, vi } from "vitest";
import {
  dedupeKlaviyoEventsLastWins,
  ensurePilotConnection,
  safeSyncError,
  sameCheckpoint,
  summarizeCheckpoint,
  type ProbePersistence,
} from "@/lib/klaviyo/source-store";
import {
  orderCoreSourceContract,
  type NormalizedKlaviyoEvent,
} from "@/lib/klaviyo/types";

describe("Klaviyo source store helpers", () => {
  it("deduplicates page events by external ID with the last occurrence winning", () => {
    const first = {
      externalEventId: "duplicate",
      sourceChecksum: "first",
    } as NormalizedKlaviyoEvent;
    const distinct = {
      externalEventId: "distinct",
      sourceChecksum: "only",
    } as NormalizedKlaviyoEvent;
    const last = {
      externalEventId: "duplicate",
      sourceChecksum: "last",
    } as NormalizedKlaviyoEvent;

    expect(dedupeKlaviyoEventsLastWins([first, distinct, last])).toEqual([
      last,
      distinct,
    ]);
  });

  it("compares opaque checkpoints exactly", () => {
    expect(
      sameCheckpoint(
        { ...orderCoreSourceContract(), metricIndex: 0, cursor: "abc", page: 2 },
        { ...orderCoreSourceContract(), metricIndex: 0, cursor: "abc", page: 2 },
      ),
    ).toBe(true);
    expect(
      sameCheckpoint(
        { ...orderCoreSourceContract(), metricIndex: 0, cursor: "abc", page: 2 },
        { ...orderCoreSourceContract(), metricIndex: 1, cursor: null, page: 0 },
      ),
    ).toBe(false);
  });

  it("removes URLs, email addresses, and provider content from errors", () => {
    expect(
      safeSyncError(
        "GET https://a.klaviyo.com/api/events?email=user@example.com failed with private payload",
      ),
    ).toEqual({
      code: "KLAVIYO_SYNC_FAILED",
      message:
        "Klaviyo sync failed; inspect the provider status and configured scopes",
    });
  });

  it("summarizes checkpoints without copying opaque cursors", () => {
    const hostile = "user@example.com-secret-provider-cursor";
    const summary = summarizeCheckpoint("events", {
      ...orderCoreSourceContract(),
      metricIndex: 1,
      cursor: hostile,
      page: 7,
    });
    expect(summary).toEqual({
      sourceMode: "order_core",
      metricIndex: 1,
      page: 7,
    });
    expect(JSON.stringify(summary)).not.toContain(hostile);
    expect(summarizeCheckpoint("probe", { page: 3, cursor: hostile })).toBeNull();
    expect(summarizeCheckpoint("events", { ...orderCoreSourceContract(), cursor: hostile })).toBeNull();
  });

  it("fails closed on malformed or unsupported event checkpoint contracts", () => {
    expect(
      summarizeCheckpoint("events", {
        ...orderCoreSourceContract(),
        metricIndex: 0,
        cursor: null,
        page: 1,
        unsafeExtra: true,
      }),
    ).toBeNull();
    expect(
      summarizeCheckpoint("events", {
        ...orderCoreSourceContract(),
        metricKinds: ["placed_order", "clicked_email"],
        metricIndex: 0,
        cursor: null,
        page: 1,
      }),
    ).toBeNull();
    expect(
      summarizeCheckpoint("events", {
        sourceMode: "journey",
        metricIndex: 0,
        cursor: "private",
        page: 1,
      }),
    ).toBeNull();
  });

  it("exports the exact redacted probe persistence contract", () => {
    const persistence: ProbePersistence = {
      bindingOverlapCount: 1,
      keyTypeShapes: [],
      identifierCoverage: { orderId: 1 },
      collisionSummary: { orderId: 0 },
      unmatchedSummary: { count: 0 },
      unmatchedExamples: [],
      productCoverage: { comparable: 1 },
      attributionCoverage: { campaign: 1 },
      redactionVerified: true,
    };
    expect(persistence.redactionVerified).toBe(true);
  });

  it("fails HMAC and private-key validation before opening a transaction", async () => {
    const transaction = vi.fn();
    const getPilotBinding = vi.fn();
    await expect(
      ensurePilotConnection("org-a", {
        database: { transaction } as never,
        loadIdentityKeyring: () => {
          throw new Error("missing hmac");
        },
        credentialProvider: { getPilotBinding, resolve: vi.fn() },
      }),
    ).rejects.toThrow("missing hmac");
    expect(getPilotBinding).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();

    await expect(
      ensurePilotConnection("org-a", {
        database: { transaction } as never,
        loadIdentityKeyring: () => ({
          current: { version: "v1", secret: new Uint8Array(32) },
        }),
        credentialProvider: {
          getPilotBinding: async () => {
            throw new Error("missing private key");
          },
          resolve: vi.fn(),
        },
      }),
    ).rejects.toThrow("missing private key");
    expect(transaction).not.toHaveBeenCalled();
  });
});
