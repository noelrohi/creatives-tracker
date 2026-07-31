import { describe, expect, it } from "vitest";
import {
  CLAIMED_WINDOWS_EXPRESSION,
  computeRoas,
  decodeOrderCursor,
  encodeOrderCursor,
  identityMatches,
  isConnectorStale,
  labeledShare,
  META_SYNC_CYCLE_MS,
  metaClaimsFromRow,
  SHOPIFY_SYNC_CYCLE_MS,
  summarizeMetaFreshness,
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

describe("summarizeMetaFreshness", () => {
  // An org that does not use Meta must never raise a connection alert.
  it("reports an org with no connected accounts as fresh, not disconnected", () => {
    expect(summarizeMetaFreshness([], NOW)).toEqual({
      lastSuccessAt: null,
      stale: false,
    });
  });

  it("is never-connected while any one account has never synced", () => {
    const recent = agoMs(60 * 60 * 1000);
    expect(
      summarizeMetaFreshness(
        [{ lastSuccessAt: recent }, { lastSuccessAt: null }],
        NOW,
      ),
    ).toEqual({ lastSuccessAt: null, stale: true });
  });

  // The whole point of the rule: one busy account cannot cover for a quiet one.
  it("takes the account that ran least recently", () => {
    const oldest = agoMs(20 * 60 * 60 * 1000);
    expect(
      summarizeMetaFreshness(
        [{ lastSuccessAt: agoMs(60 * 60 * 1000) }, { lastSuccessAt: oldest }],
        NOW,
      ),
    ).toEqual({ lastSuccessAt: oldest, stale: false });
  });

  it("goes stale once the quietest account passes 48h", () => {
    const result = summarizeMetaFreshness(
      [
        { lastSuccessAt: agoMs(60 * 60 * 1000) },
        { lastSuccessAt: agoMs(49 * 60 * 60 * 1000) },
      ],
      NOW,
    );

    expect(result.stale).toBe(true);
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

// §3.2: "The standard claim = 7d_click + 1d_view" — and §3.4 keeps
// `purchase_value` as Meta's own default-window number, which the checker must
// not read: it would compare a differently-windowed claim against Shopify.
describe("Meta claim reads (§3.2)", () => {
  function columnNames(expression: { queryChunks: unknown[] }): string[] {
    return expression.queryChunks
      .map((chunk) => (chunk as { name?: unknown })?.name)
      .filter((name): name is string => typeof name === "string");
  }

  it("sums the per-window columns and never purchase_value", () => {
    const names = columnNames(CLAIMED_WINDOWS_EXPRESSION);
    expect(names).toContain("purchase_value_7d_click");
    expect(names).toContain("purchase_value_1d_view");
    expect(names).not.toContain("purchase_value");
  });

  it("reports the combined claim from the window columns", () => {
    const claims = metaClaimsFromRow({
      claimed: "6200.00",
      claimed7dClick: "5800.00",
      claimed1dView: "400.00",
      spend: "1800.00",
      totalRows: 40,
      labeledRows: 40,
    });

    expect(claims.claimedCents).toBe(620_000);
    expect(claims.claimed7dClickCents).toBe(580_000);
    expect(claims.claimed1dViewCents).toBe(40_000);
    expect(claims.spendCents).toBe(180_000);
    expect(claims.labeledRowShare).toBe(1);
  });

  it("returns no claim at all when the range predates the window labels", () => {
    const claims = metaClaimsFromRow({
      claimed: null,
      claimed7dClick: null,
      claimed1dView: null,
      spend: "1800.00",
      totalRows: 40,
      labeledRows: 0,
    });

    expect(claims.claimedCents).toBeNull();
    expect(claims.claimed7dClickCents).toBeNull();
    expect(claims.claimed1dViewCents).toBeNull();
    // Spend is a base-row sum, unaffected by the claim labels (§3.7).
    expect(claims.spendCents).toBe(180_000);
    expect(claims.labeledRowShare).toBe(0);
  });

  it("keeps spend readable when no rows exist at all", () => {
    expect(metaClaimsFromRow(undefined)).toEqual({
      claimedCents: null,
      claimed7dClickCents: null,
      claimed1dViewCents: null,
      spendCents: 0,
      labeledRowShare: 0,
    });
  });
});
