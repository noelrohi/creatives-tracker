import { describe, expect, it } from "vitest";
import {
  computeRoas,
  decodeOrderCursor,
  encodeOrderCursor,
  identityMatches,
  isConnectorStale,
  labeledShare,
  META_SYNC_CYCLE_MS,
  SHOPIFY_SYNC_CYCLE_MS,
} from "./attribution-queries";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function agoMs(ms: number) {
  return new Date(NOW.getTime() - ms);
}

describe("isConnectorStale", () => {
  it("treats a never-synced connector as stale", () => {
    expect(isConnectorStale(null, SHOPIFY_SYNC_CYCLE_MS, NOW)).toBe(true);
  });

  it("keeps Shopify fresh inside two hourly cycles", () => {
    const lastSuccess = agoMs(90 * 60 * 1000);
    expect(isConnectorStale(lastSuccess, SHOPIFY_SYNC_CYCLE_MS, NOW)).toBe(
      false,
    );
  });

  it("flags Shopify past two hourly cycles", () => {
    const lastSuccess = agoMs(2 * 60 * 60 * 1000 + 1);
    expect(isConnectorStale(lastSuccess, SHOPIFY_SYNC_CYCLE_MS, NOW)).toBe(true);
  });

  it("is inclusive at exactly 2× the cycle", () => {
    const lastSuccess = agoMs(2 * SHOPIFY_SYNC_CYCLE_MS);
    expect(isConnectorStale(lastSuccess, SHOPIFY_SYNC_CYCLE_MS, NOW)).toBe(
      false,
    );
  });

  it("gives Meta a 48h window", () => {
    expect(isConnectorStale(agoMs(47 * 60 * 60 * 1000), META_SYNC_CYCLE_MS, NOW)).toBe(
      false,
    );
    expect(isConnectorStale(agoMs(49 * 60 * 60 * 1000), META_SYNC_CYCLE_MS, NOW)).toBe(
      true,
    );
  });
});

describe("identityMatches", () => {
  it("holds when buckets plus pending equal the ungrouped total", () => {
    expect(
      identityMatches({
        sumOfBucketsCents: 120_000,
        pendingCents: 4_500,
        actualCents: 124_500,
      }),
    ).toBe(true);
  });

  it("fails when a single cent goes missing", () => {
    expect(
      identityMatches({
        sumOfBucketsCents: 120_000,
        pendingCents: 4_500,
        actualCents: 124_501,
      }),
    ).toBe(false);
  });

  it("handles a refund-heavy range that nets negative", () => {
    expect(
      identityMatches({
        sumOfBucketsCents: -3_000,
        pendingCents: 0,
        actualCents: -3_000,
      }),
    ).toBe(true);
  });
});

describe("labeledShare", () => {
  it("returns 0 when there are no rows at all", () => {
    expect(labeledShare(0, 0)).toBe(0);
  });

  it("reports the labeled fraction", () => {
    expect(labeledShare(3, 12)).toBe(0.25);
  });

  it("reports 1 when every row carries window columns", () => {
    expect(labeledShare(9, 9)).toBe(1);
  });
});

describe("computeRoas", () => {
  it("returns null with zero spend rather than a fake 0", () => {
    expect(computeRoas(50_000, 0)).toBeNull();
  });

  it("divides revenue by spend in cents", () => {
    expect(computeRoas(30_000, 10_000)).toBe(3);
  });
});

describe("order cursor", () => {
  it("round-trips", () => {
    const cursor = { orderCreatedAt: NOW, id: "order_123" };
    const decoded = decodeOrderCursor(encodeOrderCursor(cursor));
    expect(decoded?.id).toBe("order_123");
    expect(decoded?.orderCreatedAt.toISOString()).toBe(NOW.toISOString());
  });

  it("rejects malformed cursors", () => {
    expect(decodeOrderCursor("nonsense")).toBeNull();
    expect(decodeOrderCursor("not-a-date|order_1")).toBeNull();
    expect(decodeOrderCursor(`${NOW.toISOString()}|`)).toBeNull();
  });
});
