import { describe, expect, it, vi } from "vitest";
import {
  ensurePilotConnection,
  safeSyncError,
  sameCheckpoint,
  summarizeCheckpoint,
} from "@/lib/klaviyo/source-store";
import { orderCoreSourceContract } from "@/lib/klaviyo/types";

describe("Klaviyo source store helpers", () => {
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
    expect(summarizeCheckpoint("probe", { page: 3, cursor: hostile })).toEqual({
      sourceMode: null,
      metricIndex: null,
      page: 3,
    });
    expect(summarizeCheckpoint("events", { ...orderCoreSourceContract(), cursor: hostile })).toBeNull();
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
