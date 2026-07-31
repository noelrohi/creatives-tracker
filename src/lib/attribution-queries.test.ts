import { describe, expect, it } from "vitest";
import {
  CLAIMED_WINDOWS_EXPRESSION,
  computeRoas,
  decodeOrderCursor,
  encodeOrderCursor,
  identityMatches,
  isConnectorStale,
  labeledClaimCents,
  labeledShare,
  mergeCampaignLedger,
  META_SYNC_CYCLE_MS,
  metaClaimsFromRow,
  SHOPIFY_SYNC_CYCLE_MS,
  sortCampaignLedger,
  summarizeMetaFreshness,
  type CampaignLedgerRow,
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

  it("reads a claim as unknown, not zero, when nothing was labeled", () => {
    expect(labeledClaimCents("400.00", 0)).toBeNull();
    expect(labeledClaimCents(null, 12)).toBeNull();
    expect(labeledClaimCents("400.00", 12)).toBe(40_000);
  });
});

/* ------------------------------------------------------------------ */
/* Per-campaign ledger                                                 */
/* ------------------------------------------------------------------ */

function metaSideRow(overrides: Partial<{
  campaignId: string;
  name: string;
  spend: string;
  claimed: string | null;
  totalRows: number;
  labeledRows: number;
}> = {}) {
  return {
    campaignId: "camp_1",
    name: "Trybe Campaign",
    spend: "100.00",
    claimed: "80.00",
    totalRows: 7,
    labeledRows: 7,
    ...overrides,
  };
}

describe("mergeCampaignLedger", () => {
  it("joins the two sides on the campaign", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [metaSideRow()],
      orderSide: [
        {
          campaignId: "camp_1",
          name: "Trybe Campaign",
          gross: "90.00",
          orderCount: 3,
        },
      ],
      refundSide: [{ campaignId: "camp_1", refunded: "15.00" }],
    });

    expect(ledger.campaigns).toEqual([
      {
        campaignId: "camp_1",
        name: "Trybe Campaign",
        spendCents: 10_000,
        claimedCents: 8_000,
        labeledRowShare: 1,
        confirmedRevenueCents: 7_500,
        orderCount: 3,
        roas: 0.75,
      },
    ]);
    expect(ledger.unresolved).toBeNull();
  });

  // The whole point of the outer join: money spent on nothing is the cut list.
  it("keeps a campaign that spent and sold nothing", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [metaSideRow({ campaignId: "camp_dead", name: "Special Creators" })],
      orderSide: [],
      refundSide: [],
    });

    expect(ledger.campaigns).toHaveLength(1);
    expect(ledger.campaigns[0].confirmedRevenueCents).toBe(0);
    expect(ledger.campaigns[0].orderCount).toBe(0);
    // Spend with no revenue is a real 0 back per $1, not "can't tell".
    expect(ledger.campaigns[0].roas).toBe(0);
  });

  it("keeps a campaign that sold with no spend in the range", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [],
      orderSide: [
        { campaignId: "camp_2", name: "All UGC", gross: "185.00", orderCount: 3 },
      ],
      refundSide: [],
    });

    expect(ledger.campaigns[0]).toMatchObject({
      name: "All UGC",
      spendCents: null,
      claimedCents: null,
      confirmedRevenueCents: 18_500,
      roas: null,
    });
  });

  it("reports a campaign Meta has not labeled as no claim, never $0", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [metaSideRow({ claimed: null, labeledRows: 0 })],
      orderSide: [],
      refundSide: [],
    });

    expect(ledger.campaigns[0].claimedCents).toBeNull();
    expect(ledger.campaigns[0].spendCents).toBe(10_000);
    expect(ledger.campaigns[0].labeledRowShare).toBe(0);
  });

  it("collects orders that resolved to no campaign into one row", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [],
      orderSide: [
        { campaignId: null, name: null, gross: "244.50", orderCount: 2 },
      ],
      refundSide: [{ campaignId: null, refunded: "4.50" }],
    });

    expect(ledger.campaigns).toEqual([]);
    expect(ledger.unresolved).toEqual({
      confirmedRevenueCents: 24_000,
      orderCount: 2,
    });
  });

  // The reconciliation the screen rests on, in miniature: campaign rows plus
  // the unresolved row are every Meta order minus every Meta refund.
  it("sums to the same money the two sides carried in", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [metaSideRow(), metaSideRow({ campaignId: "camp_2", name: "Bundles" })],
      orderSide: [
        { campaignId: "camp_1", name: "Trybe Campaign", gross: "90.00", orderCount: 3 },
        { campaignId: "camp_2", name: "Bundles", gross: "120.57", orderCount: 2 },
        { campaignId: null, name: null, gross: "244.50", orderCount: 2 },
      ],
      refundSide: [
        { campaignId: "camp_1", refunded: "15.00" },
        { campaignId: null, refunded: "4.50" },
      ],
    });

    const total =
      ledger.campaigns.reduce((sum, row) => sum + row.confirmedRevenueCents, 0) +
      (ledger.unresolved?.confirmedRevenueCents ?? 0);

    expect(total).toBe(9_000 + 12_057 + 24_450 - 1_500 - 450);
  });

  it("ignores a refund whose campaign has no orders in the range", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [],
      orderSide: [],
      refundSide: [{ campaignId: "camp_gone", refunded: "15.00" }],
    });

    expect(ledger.campaigns).toEqual([]);
    expect(ledger.unresolved).toBeNull();
  });
});

describe("sortCampaignLedger", () => {
  function row(
    name: string,
    roas: number | null,
    confirmedRevenueCents = 0,
  ): CampaignLedgerRow {
    return {
      campaignId: name,
      name,
      spendCents: roas === null ? null : 10_000,
      claimedCents: null,
      labeledRowShare: 1,
      confirmedRevenueCents,
      orderCount: 0,
      roas,
    };
  }

  // It is a cut list, so the worst row is the first row.
  it("puts the lowest payback first", () => {
    const sorted = sortCampaignLedger([
      row("Trybe", 0.82),
      row("Bundles", 0.11),
      row("Special Creators", 0),
    ]);

    expect(sorted.map((entry) => entry.name)).toEqual([
      "Special Creators",
      "Bundles",
      "Trybe",
    ]);
  });

  it("drops the campaigns with no spend to the bottom, biggest first", () => {
    const sorted = sortCampaignLedger([
      row("No spend, small", null, 5_000),
      row("Trybe", 0.82),
      row("No spend, big", null, 40_000),
    ]);

    expect(sorted.map((entry) => entry.name)).toEqual([
      "Trybe",
      "No spend, big",
      "No spend, small",
    ]);
  });
});
