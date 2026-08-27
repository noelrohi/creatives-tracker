import { readFileSync } from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

/**
 * The grouped-by-day reads at the bottom of this file run against real rows,
 * so this suite carries a throwaway Postgres alongside its pure tests —
 * the same pattern findings.checks.test.ts uses. Everything above that
 * `describe` is pure and untouched by the mock.
 */
function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_attribution_grouped_test";

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  CLAIMED_WINDOWS_EXPRESSION,
  computeRoas,
  decodeOrderCursor,
  EMPTY_META_VERIFIED,
  encodeOrderCursor,
  getHourlySales,
  getMetaClaims,
  getMetaClaimsByDay,
  getMetaVerified,
  getMetaVerifiedByDay,
  getRefundsTotal,
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
      spendRowCount: 0,
      labeledRowShare: 0,
    });
  });

  /**
   * `spendCents` reads 0 for both, so the row count is the only thing telling a
   * day Meta has not reported from a day on which nothing was spent. A rule
   * that cannot tell them apart reports missing data as a real zero.
   */
  it("separates a day Meta has not reported from a day with no spend", () => {
    const unreported = metaClaimsFromRow(undefined);
    const reportedAtZero = metaClaimsFromRow({
      claimed: null,
      claimed7dClick: null,
      claimed1dView: null,
      spend: "0.00",
      totalRows: 12,
      labeledRows: 0,
    });

    expect(unreported.spendCents).toBe(reportedAtZero.spendCents);
    expect(unreported.spendRowCount).toBe(0);
    expect(reportedAtZero.spendRowCount).toBe(12);
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
  campaignId: string | null;
  name: string | null;
  spend: string;
  claimed: string | null;
  labeledRows: number;
}> = {}) {
  return {
    campaignId: "camp_1",
    name: "Trybe Campaign",
    spend: "100.00",
    claimed: "80.00",
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
      refundSide: [{ campaignId: "camp_1", name: "Trybe Campaign", refunded: "15.00" }],
    });

    expect(ledger.campaigns).toEqual([
      {
        campaignId: "camp_1",
        name: "Trybe Campaign",
        spendCents: 10_000,
        claimedCents: 8_000,
        confirmedRevenueCents: 7_500,
        orderCount: 3,
        roas: 0.75,
      },
    ]);
    expect(ledger.unresolved).toBeNull();
  });

  // A paused campaign can have nothing in the range but a refund of an older
  // order. Dropping it would break the one guarantee the ledger makes.
  it("keeps a campaign whose only movement in the range is a refund", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [],
      orderSide: [],
      refundSide: [
        { campaignId: "camp_paused", name: "Winter Sale", refunded: "40.00" },
      ],
    });

    expect(ledger.campaigns).toEqual([
      {
        campaignId: "camp_paused",
        name: "Winter Sale",
        spendCents: null,
        claimedCents: null,
        confirmedRevenueCents: -4_000,
        orderCount: 0,
        roas: null,
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
  });

  it("collects orders that resolved to no campaign into one row", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [],
      orderSide: [
        { campaignId: null, name: null, gross: "244.50", orderCount: 2 },
      ],
      refundSide: [{ campaignId: null, name: null, refunded: "4.50" }],
    });

    expect(ledger.campaigns).toEqual([]);
    expect(ledger.unresolved).toEqual({
      confirmedRevenueCents: 24_000,
      orderCount: 2,
      spendCents: null,
      claimedCents: null,
    });
  });

  // Deleting an ad set sets `ad.ad_set_id` to null and leaves the ad's
  // performance rows behind, so this spend reaches no campaign. It is still in
  // the Meta total on the screen above, so it has to land somewhere.
  it("collects the spend of an orphaned ad into the unresolved row", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [
        metaSideRow(),
        metaSideRow({ campaignId: null, name: null, spend: "37.50", claimed: "12.00" }),
      ],
      orderSide: [],
      refundSide: [],
    });

    expect(ledger.campaigns).toHaveLength(1);
    expect(ledger.unresolved).toMatchObject({
      spendCents: 3_750,
      claimedCents: 1_200,
    });
  });

  it("reports an unlabeled orphaned claim as no claim, never $0", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [
        metaSideRow({ campaignId: null, name: null, claimed: null, labeledRows: 0 }),
      ],
      orderSide: [],
      refundSide: [],
    });

    expect(ledger.unresolved?.spendCents).toBe(10_000);
    expect(ledger.unresolved?.claimedCents).toBeNull();
  });

  // Orphaned spend on its own still has to draw the row, or the money leaves
  // the ledger without the screen saying so.
  it("renders an unresolved row for a range whose only leftover is spend", () => {
    const ledger = mergeCampaignLedger({
      metaSide: [metaSideRow({ campaignId: null, name: null })],
      orderSide: [],
      refundSide: [],
    });

    expect(ledger.campaigns).toEqual([]);
    expect(ledger.unresolved).toEqual({
      confirmedRevenueCents: 0,
      orderCount: 0,
      spendCents: 10_000,
      claimedCents: 8_000,
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
        { campaignId: "camp_1", name: "Trybe Campaign", refunded: "15.00" },
        { campaignId: null, name: null, refunded: "4.50" },
      ],
    });

    const total =
      ledger.campaigns.reduce((sum, row) => sum + row.confirmedRevenueCents, 0) +
      (ledger.unresolved?.confirmedRevenueCents ?? 0);

    expect(total).toBe(9_000 + 12_057 + 24_450 - 1_500 - 450);
  });

});

describe("sortCampaignLedger", () => {
  function row(
    name: string,
    roas: number | null,
    confirmedRevenueCents = 0,
    spendCents: number | null = roas === null ? null : 10_000,
  ): CampaignLedgerRow {
    return {
      campaignId: name,
      name,
      spendCents,
      claimedCents: null,
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

  // Two campaigns returning nothing are not equally urgent.
  it("ranks the bigger spend first when the payback is the same", () => {
    const sorted = sortCampaignLedger([
      row("Small burn", 0, 0, 25_001),
      row("Big burn", 0, 0, 136_713),
      row("Trybe", 0.82),
    ]);

    expect(sorted.map((entry) => entry.name)).toEqual([
      "Big burn",
      "Small burn",
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

/* ------------------------------------------------------------------ */
/* Grouped-by-day reads (DB-backed)                                    */
/* ------------------------------------------------------------------ */

/**
 * `getMetaClaimsByDay` / `getMetaVerifiedByDay` exist to replace a per-day
 * loop, so the property worth pinning is not "the numbers look right" but
 * "the grouped path and the per-day path give the same answer, day for day".
 * The per-day functions are the oracle here: every case below seeds rows, then
 * compares the two paths for every day in the window.
 *
 * The cases that made this worth its own suite are the ones a hand-written
 * grouped `sum()` gets wrong: a day Meta has not reported (`spendRowCount` 0,
 * so a claim is unknown rather than $0), and a day with rows whose window
 * columns are null (§7.2's null-not-zero rule).
 */
const GROUPED_FIXTURE_DDL = [
  `CREATE TYPE "attribution_bucket" AS ENUM (
     'meta', 'google', 'klaviyo', 'tiktok', 'ai',
     'organic_direct', 'unattributed', 'untracked'
   )`,
  `CREATE TABLE performance_log (
     id text PRIMARY KEY,
     ad_id text NOT NULL,
     organization_id text,
     spend numeric,
     purchase_value numeric,
     purchase_value_7d_click numeric,
     purchase_value_1d_view numeric,
     country text,
     platform text,
     placement text,
     device text,
     age text,
     gender text,
     date_start date NOT NULL,
     date_end date NOT NULL,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE shopify_order (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     shopify_order_id text NOT NULL,
     order_created_at timestamp NOT NULL DEFAULT now(),
     order_day date NOT NULL,
     net_sales numeric NOT NULL,
     bucket "attribution_bucket",
     meta_verified boolean NOT NULL DEFAULT false,
     verification_pending boolean NOT NULL DEFAULT false,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE shopify_refund (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     order_id text NOT NULL,
     shopify_refund_id text NOT NULL,
     refund_day date NOT NULL,
     amount numeric NOT NULL,
     kind text NOT NULL DEFAULT 'refund',
     created_at timestamp NOT NULL DEFAULT now()
   )`,
];

const describeWithDb = testDb ? describe : describe.skip;

describeWithDb("grouped-by-day reads agree with the per-day reads", () => {
  const ORG = "org_grouped_test";
  const STORE = "store_grouped_test";

  /** Seven days, the window `findings/checks` asks for. */
  const DAYS = [
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
    "2026-08-16",
  ];
  const DATE_FROM = DAYS[0];
  const DATE_TO = DAYS[DAYS.length - 1];

  let rowSeq = 0;
  function nextId(prefix: string) {
    rowSeq += 1;
    return `${prefix}-${rowSeq}`;
  }

  /**
   * A Meta row. `claimed7dClick`/`claimed1dView` left null is a row that
   * predates the window labels — it still counts toward `spendRowCount`.
   */
  async function metaRow(params: {
    day: string;
    spend: string;
    claimed7dClick?: string;
    claimed1dView?: string;
    organizationId?: string;
    /** Any breakdown column set makes the row a non-base row. */
    country?: string;
  }) {
    await testDb?.execute(sql`
      INSERT INTO performance_log (
        id, ad_id, organization_id, spend,
        purchase_value_7d_click, purchase_value_1d_view, country,
        date_start, date_end
      ) VALUES (
        ${nextId("pl")}, 'ad-1', ${params.organizationId ?? ORG}, ${params.spend},
        ${params.claimed7dClick ?? null}, ${params.claimed1dView ?? null},
        ${params.country ?? null}, ${params.day}, ${params.day}
      )
    `);
  }

  async function order(params: {
    id: string;
    day: string;
    netSales: string;
    bucket?: string | null;
    metaVerified?: boolean;
    verificationPending?: boolean;
    storeId?: string;
    organizationId?: string;
    createdAt?: string;
  }) {
    await testDb?.execute(sql`
      INSERT INTO shopify_order (
        id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales, bucket, meta_verified, verification_pending
      ) VALUES (
        ${params.id}, ${params.organizationId ?? ORG}, ${params.storeId ?? STORE},
        ${params.id}, ${params.createdAt ?? "2026-08-10T04:00:00Z"},
        ${params.day}, ${params.netSales},
        ${(params.bucket ?? "meta") as string}::"attribution_bucket",
        ${params.metaVerified ?? true}, ${params.verificationPending ?? false}
      )
    `);
  }

  /** Refunds book on their own day, which is the point of the second query. */
  async function refund(params: {
    orderId: string;
    day: string;
    amount: string;
    kind?: string;
  }) {
    const id = nextId("refund");
    await testDb?.execute(sql`
      INSERT INTO shopify_refund (
        id, organization_id, store_id, order_id, shopify_refund_id,
        refund_day, amount${params.kind !== undefined ? sql`, kind` : sql``}
      ) VALUES (
        ${id}, ${ORG}, ${STORE}, ${params.orderId}, ${id},
        ${params.day}, ${params.amount}${
          params.kind !== undefined ? sql`, ${params.kind}` : sql``
        }
      )
    `);
  }

  /** What the loop this replaced computed: one pair of reads per day. */
  async function perDay(day: string) {
    const [claims, verified] = await Promise.all([
      getMetaClaims({ organizationId: ORG, dateFrom: day, dateTo: day }),
      getMetaVerified({
        organizationId: ORG,
        storeId: STORE,
        dateFrom: day,
        dateTo: day,
      }),
    ]);
    return { claims, verified };
  }

  /** The grouped path, read the way `getClaimVerifiedSeries` reads it. */
  async function grouped(day: string) {
    const [claimsByDay, verifiedByDay] = await Promise.all([
      getMetaClaimsByDay({
        organizationId: ORG,
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
      }),
      getMetaVerifiedByDay({
        organizationId: ORG,
        storeId: STORE,
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
      }),
    ]);
    return {
      claims: claimsByDay.get(day) ?? metaClaimsFromRow(undefined),
      verified: verifiedByDay.get(day) ?? EMPTY_META_VERIFIED,
    };
  }

  /** Every day in the window, both paths, compared whole. */
  async function expectAgreementAcrossWindow() {
    for (const day of DAYS) {
      const [loop, batch] = await Promise.all([perDay(day), grouped(day)]);
      expect(batch.claims, `claims on ${day}`).toEqual(loop.claims);
      expect(batch.verified, `verified on ${day}`).toEqual(loop.verified);
    }
  }

  beforeAll(async () => {
    if (!baseConnectionString || !testDb) return;
    const adminPool = new Pool({ connectionString: baseConnectionString });
    adminPool.on("error", () => {});
    testPool?.on("error", () => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await adminPool.end();

    for (const statement of GROUPED_FIXTURE_DDL) {
      await testDb.execute(sql.raw(statement));
    }
  });

  afterAll(async () => {
    await testPool?.end();
  });

  beforeEach(async () => {
    if (!testDb) return;
    rowSeq = 0;
    for (const table of ["shopify_refund", "shopify_order", "performance_log"]) {
      await testDb.execute(sql.raw(`DELETE FROM ${table}`));
    }
  });

  it("agrees day for day on an ordinary day", async () => {
    await metaRow({
      day: "2026-08-10",
      spend: "100.00",
      claimed7dClick: "250.00",
      claimed1dView: "50.00",
    });
    await order({ id: "o-1", day: "2026-08-10", netSales: "300.00" });

    const { claims, verified } = await grouped("2026-08-10");

    expect(claims.claimedCents).toBe(30_000);
    expect(claims.spendCents).toBe(10_000);
    expect(claims.spendRowCount).toBe(1);
    expect(verified.verifiedRevenueCents).toBe(30_000);
    await expectAgreementAcrossWindow();
  });

  /**
   * The distinction the whole thing hangs on: a day Meta has never reported.
   * `spendCents` sums to 0 either way, and only `spendRowCount` says which —
   * `getClaimVerifiedSeries` turns a 0 count into a null `spendCents`, so a
   * grouped read that invented a zero row would silently claim Meta reported.
   */
  it("leaves a day with no Meta rows absent, not zeroed", async () => {
    await metaRow({
      day: "2026-08-10",
      spend: "100.00",
      claimed7dClick: "250.00",
    });
    // 2026-08-11 gets orders but no Meta row at all.
    await order({ id: "o-2", day: "2026-08-11", netSales: "40.00" });

    const claimsByDay = await getMetaClaimsByDay({
      organizationId: ORG,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    });

    expect(claimsByDay.has("2026-08-11")).toBe(false);

    const missing = await perDay("2026-08-11");
    expect(missing.claims.spendRowCount).toBe(0);
    expect(missing.claims.claimedCents).toBeNull();
    expect(missing.claims.spendCents).toBe(0);
    // …and the fallback the caller reads it through says exactly that.
    expect(metaClaimsFromRow(undefined)).toEqual(missing.claims);

    await expectAgreementAcrossWindow();
  });

  /**
   * Rows present, window columns null: a claim is unknown, never $0, but the
   * day is still one Meta reported — spend and the row count are real.
   */
  it("keeps the null-not-zero rule on a day whose claims are unlabeled", async () => {
    await metaRow({ day: "2026-08-12", spend: "80.00" });
    await metaRow({ day: "2026-08-12", spend: "20.00" });
    await order({ id: "o-3", day: "2026-08-12", netSales: "10.00" });

    const { claims } = await grouped("2026-08-12");

    expect(claims.claimedCents).toBeNull();
    expect(claims.claimed7dClickCents).toBeNull();
    expect(claims.claimed1dViewCents).toBeNull();
    expect(claims.spendCents).toBe(10_000);
    expect(claims.spendRowCount).toBe(2);
    expect(claims.labeledRowShare).toBe(0);

    await expectAgreementAcrossWindow();
  });

  /** A partly-labeled day: the share is what tells a reader how answerable it is. */
  it("agrees on labeledRowShare when only some rows carry windows", async () => {
    await metaRow({ day: "2026-08-13", spend: "10.00", claimed7dClick: "5.00" });
    await metaRow({ day: "2026-08-13", spend: "10.00" });
    await metaRow({ day: "2026-08-13", spend: "10.00" });

    const { claims } = await grouped("2026-08-13");

    expect(claims.claimedCents).toBe(500);
    expect(claims.spendRowCount).toBe(3);
    expect(claims.labeledRowShare).toBeCloseTo(1 / 3);

    await expectAgreementAcrossWindow();
  });

  /** Breakdown rows double-count; both paths must drop them the same way. */
  it("drops non-base rows on both paths", async () => {
    await metaRow({ day: "2026-08-14", spend: "50.00", claimed7dClick: "70.00" });
    await metaRow({
      day: "2026-08-14",
      spend: "50.00",
      claimed7dClick: "70.00",
      country: "US",
    });

    const { claims } = await grouped("2026-08-14");

    expect(claims.spendRowCount).toBe(1);
    expect(claims.spendCents).toBe(5_000);
    expect(claims.claimedCents).toBe(7_000);

    await expectAgreementAcrossWindow();
  });

  /**
   * A refund books on the day it was issued, not the day the order was — the
   * reason the verified side needs two groupings rather than one join.
   */
  it("books a refund on its own day, like the per-day read", async () => {
    await order({ id: "o-4", day: "2026-08-10", netSales: "500.00" });
    await refund({ orderId: "o-4", day: "2026-08-15", amount: "120.00" });

    const day10 = await grouped("2026-08-10");
    const day15 = await grouped("2026-08-15");

    expect(day10.verified.verifiedRevenueCents).toBe(50_000);
    expect(day10.verified.verifiedOrderCount).toBe(1);
    expect(day15.verified.verifiedRevenueCents).toBe(-12_000);
    expect(day15.verified.verifiedOrderCount).toBe(0);

    await expectAgreementAcrossWindow();
  });

  /** Only Meta-bucket, meta_verified orders count; pending is its own tally. */
  it("agrees on the verified/pending split within one day", async () => {
    await order({ id: "o-5", day: "2026-08-16", netSales: "100.00" });
    await order({
      id: "o-6",
      day: "2026-08-16",
      netSales: "70.00",
      metaVerified: false,
    });
    await order({
      id: "o-7",
      day: "2026-08-16",
      netSales: "30.00",
      bucket: "google",
    });
    await order({
      id: "o-8",
      day: "2026-08-16",
      netSales: "25.00",
      bucket: null,
      metaVerified: false,
      verificationPending: true,
    });

    const { verified } = await grouped("2026-08-16");

    expect(verified.verifiedRevenueCents).toBe(10_000);
    expect(verified.verifiedOrderCount).toBe(1);
    expect(verified.verificationPendingCount).toBe(1);

    await expectAgreementAcrossWindow();
  });

  /** Rows outside the org, the store, or the range belong to neither path. */
  it("agrees while other orgs, stores and days are in the table", async () => {
    await metaRow({ day: "2026-08-10", spend: "10.00", claimed7dClick: "20.00" });
    await metaRow({
      day: "2026-08-10",
      spend: "999.00",
      claimed7dClick: "999.00",
      organizationId: "org_other",
    });
    await metaRow({ day: "2026-08-09", spend: "999.00", claimed7dClick: "999.00" });
    await metaRow({ day: "2026-08-17", spend: "999.00", claimed7dClick: "999.00" });

    await order({ id: "o-9", day: "2026-08-10", netSales: "15.00" });
    await order({
      id: "o-10",
      day: "2026-08-10",
      netSales: "999.00",
      storeId: "store_other",
    });
    await order({
      id: "o-11",
      day: "2026-08-10",
      netSales: "999.00",
      organizationId: "org_other",
    });
    await order({ id: "o-12", day: "2026-08-09", netSales: "999.00" });

    const { claims, verified } = await grouped("2026-08-10");

    expect(claims.spendCents).toBe(1_000);
    expect(claims.claimedCents).toBe(2_000);
    expect(verified.verifiedRevenueCents).toBe(1_500);

    await expectAgreementAcrossWindow();
  });

  /**
   * The whole window at once, with every shape mixed: this is the assertion the
   * issue asked for — the two paths compared day for day on one seeding.
   */
  it("agrees across a full seven-day window of mixed days", async () => {
    // Ordinary day.
    await metaRow({
      day: "2026-08-10",
      spend: "100.00",
      claimed7dClick: "180.00",
      claimed1dView: "20.00",
    });
    await order({ id: "w-1", day: "2026-08-10", netSales: "150.00" });

    // Rows, no labels.
    await metaRow({ day: "2026-08-11", spend: "60.00" });
    await order({ id: "w-2", day: "2026-08-11", netSales: "10.00" });

    // No Meta rows, orders only.
    await order({ id: "w-3", day: "2026-08-12", netSales: "90.00" });

    // Meta reported a genuine zero-spend day: rows exist, spend is 0.
    await metaRow({ day: "2026-08-13", spend: "0", claimed7dClick: "0" });

    // Meta rows, no orders at all.
    await metaRow({
      day: "2026-08-14",
      spend: "40.00",
      claimed1dView: "12.00",
    });

    // Refund only, against an order from the start of the window.
    await refund({ orderId: "w-1", day: "2026-08-15", amount: "25.00" });

    // Pending-only day: nothing verified, one order awaiting a verdict.
    await order({
      id: "w-4",
      day: "2026-08-16",
      netSales: "45.00",
      bucket: null,
      metaVerified: false,
      verificationPending: true,
    });

    await expectAgreementAcrossWindow();

    // And the two days that read identically through `spendCents` alone are
    // still told apart by the row count the series depends on.
    const reportedZero = await grouped("2026-08-13");
    const notReported = await grouped("2026-08-12");
    expect(reportedZero.claims.spendCents).toBe(0);
    expect(notReported.claims.spendCents).toBe(0);
    expect(reportedZero.claims.spendRowCount).toBe(1);
    expect(notReported.claims.spendRowCount).toBe(0);
  });

  describe("getRefundsTotal", () => {
    it("sums refunds of every kind whose refund day is in range", async () => {
      await order({ id: "o-r1", day: "2026-08-10", netSales: "300.00" });
      await refund({ orderId: "o-r1", day: "2026-08-11", amount: "40.00" });
      await refund({
        orderId: "o-r1",
        day: "2026-08-12",
        amount: "10.50",
        kind: "cancellation",
      });
      // Exactly on dateTo — pins the BETWEEN upper bound as inclusive.
      await refund({ orderId: "o-r1", day: "2026-08-13", amount: "4.50" });
      // Outside the queried range — must not count.
      await refund({ orderId: "o-r1", day: "2026-08-16", amount: "99.00" });

      const result = await getRefundsTotal({
        organizationId: ORG,
        storeId: STORE,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-13",
      });

      expect(result.refundedCents).toBe(5_500);
      expect(result.count).toBe(3);
    });

    it("returns zeros for a range with no refunds", async () => {
      const result = await getRefundsTotal({
        organizationId: ORG,
        storeId: STORE,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-13",
      });
      expect(result.refundedCents).toBe(0);
      expect(result.count).toBe(0);
    });
  });

  describe("getHourlySales", () => {
    it("buckets a day's orders by store-clock hour, zero-filled to 24 rows", async () => {
      // 23:30 Bangkok on Aug 10 = 16:30 UTC; belongs to hour 23 of Aug 10.
      await order({
        id: "o-h1",
        day: "2026-08-10",
        netSales: "100.00",
        createdAt: "2026-08-10T16:30:00Z",
      });
      // 00:10 Bangkok on Aug 11 (17:10 UTC Aug 10): a different order day —
      // excluded even though its UTC timestamp is still Aug 10.
      await order({
        id: "o-h2",
        day: "2026-08-11",
        netSales: "50.00",
        createdAt: "2026-08-10T17:10:00Z",
      });
      // 09:00 Bangkok on Aug 10 (02:00 UTC), plus a second order same hour.
      await order({
        id: "o-h3",
        day: "2026-08-10",
        netSales: "20.00",
        createdAt: "2026-08-10T02:00:00Z",
      });
      await order({
        id: "o-h4",
        day: "2026-08-10",
        netSales: "5.00",
        createdAt: "2026-08-10T02:45:00Z",
      });

      const hours = await getHourlySales({
        organizationId: ORG,
        storeId: STORE,
        day: "2026-08-10",
        timeZone: "Asia/Bangkok",
      });

      expect(hours).toHaveLength(24);
      expect(hours[23]).toEqual({ hour: 23, netCents: 10_000, orders: 1 });
      expect(hours[9]).toEqual({ hour: 9, netCents: 2_500, orders: 2 });
      expect(hours[0]).toEqual({ hour: 0, netCents: 0, orders: 0 });
      expect(hours.reduce((sum, h) => sum + h.netCents, 0)).toBe(12_500);
    });
  });
});
