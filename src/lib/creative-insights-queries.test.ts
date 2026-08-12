import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  backPerDollar,
  isUntagged,
  mergeSliceRows,
  missingEnforcedTags,
  NO_TAGS_KEY,
  pickInsightCards,
  summarizeCoverage,
  UNMATCHED_KEY,
  untaggedAdSql,
  type CoverageAdRow,
  type EnforcedTagRow,
  type SliceRow,
} from "./creative-insights-queries";

function slice(partial: Partial<SliceRow> & { key: string }): SliceRow {
  const revenueCents = partial.revenueCents ?? 0;
  const spendCents = partial.spendCents ?? 0;
  return {
    key: partial.key,
    revenueCents,
    orderCount: partial.orderCount ?? 0,
    spendCents,
    backPer1: partial.backPer1 ?? backPerDollar(revenueCents, spendCents),
  };
}

describe("backPerDollar", () => {
  it("divides revenue by spend and refuses to invent a zero", () => {
    expect(backPerDollar(49_000, 10_000)).toBe(4.9);
    expect(backPerDollar(49_000, 0)).toBeNull();
    expect(backPerDollar(49_000, null)).toBeNull();
  });
});

describe("mergeSliceRows", () => {
  it("nets refunds off revenue and ranks tagged values by revenue", () => {
    const rows = mergeSliceRows({
      orderRows: [
        { key: "problem_solution", grossCents: 700_000, orderCount: 40 },
        { key: "social_proof", grossCents: 300_000, orderCount: 22 },
      ],
      refundRows: [{ key: "problem_solution", refundedCents: 6_000 }],
      spendRows: [
        { key: "problem_solution", spendCents: 142_000 },
        { key: "social_proof", spendCents: 136_000 },
      ],
    });

    expect(rows.map((row) => row.key)).toEqual([
      "problem_solution",
      "social_proof",
      NO_TAGS_KEY,
      UNMATCHED_KEY,
    ]);
    expect(rows[0]).toMatchObject({ revenueCents: 694_000, orderCount: 40 });
    expect(rows[0].backPer1).toBeCloseTo(694_000 / 142_000, 10);
  });

  it("always emits both explicit rows, even with nothing behind them", () => {
    const rows = mergeSliceRows({ orderRows: [], refundRows: [], spendRows: [] });

    expect(rows.map((row) => row.key)).toEqual([NO_TAGS_KEY, UNMATCHED_KEY]);
    expect(rows[0]).toMatchObject({ revenueCents: 0, spendCents: 0 });
  });

  it("keeps 'no tags yet' spend but leaves 'unmatched ad' spendless", () => {
    const rows = mergeSliceRows({
      orderRows: [{ key: UNMATCHED_KEY, grossCents: 101_200, orderCount: 7 }],
      refundRows: [],
      spendRows: [{ key: NO_TAGS_KEY, spendCents: 88_000 }],
    });

    const noTags = rows.find((row) => row.key === NO_TAGS_KEY);
    const unmatched = rows.find((row) => row.key === UNMATCHED_KEY);
    expect(noTags).toMatchObject({ spendCents: 88_000, revenueCents: 0 });
    expect(unmatched).toMatchObject({
      spendCents: null,
      backPer1: null,
      revenueCents: 101_200,
      orderCount: 7,
    });
  });

  it("holds the identity: the rows sum to the money that went in", () => {
    const rows = mergeSliceRows({
      orderRows: [
        { key: "tof", grossCents: 912_000, orderCount: 41 },
        { key: NO_TAGS_KEY, grossCents: 101_200, orderCount: 7 },
        { key: UNMATCHED_KEY, grossCents: 24_000, orderCount: 2 },
      ],
      refundRows: [{ key: "tof", refundedCents: 12_000 }],
      spendRows: [],
    });

    const total = rows.reduce((sum, row) => sum + row.revenueCents, 0);
    expect(total).toBe(912_000 - 12_000 + 101_200 + 24_000);
  });
});

describe("missingEnforcedTags", () => {
  const tagged = {
    creativeId: "creative_1",
    funnelStage: "tof",
    persona: "busy parents",
    angle: "problem_solution",
    awarenessLevel: "problem_aware",
  };

  it("returns nothing when all four enforced tags are present", () => {
    expect(missingEnforcedTags(tagged)).toEqual([]);
  });

  it("names each missing tag", () => {
    expect(missingEnforcedTags({ ...tagged, funnelStage: null, angle: null })).toEqual([
      "funnelStage",
      "angle",
    ]);
  });

  it("counts all three creative tags missing when there is no creative", () => {
    expect(
      missingEnforcedTags({
        creativeId: null,
        funnelStage: "bof",
        persona: null,
        angle: null,
        awarenessLevel: null,
      }),
    ).toEqual(["persona", "angle", "awareness"]);
  });
});

/**
 * `untaggedAdSql` is the Postgres twin of `missingEnforcedTags` and the two
 * cannot share code, so this pins them to the same verdicts: the rendered SQL is
 * read back term by term and evaluated in TypeScript over every combination of
 * present/absent tags. Any change to one side that the other does not follow —
 * a dropped term, a different column, a form this reader cannot parse — fails
 * here.
 */
describe("untaggedAdSql (SQL twin of missingEnforcedTags)", () => {
  const COLUMN_TO_FIELD: Record<string, keyof EnforcedTagRow> = {
    "ad.funnel_stage": "funnelStage",
    "ad_creative.id": "creativeId",
    "ad_creative.persona": "persona",
    "ad_creative.angle": "angle",
    "ad_creative.awareness_level": "awarenessLevel",
  };

  /** Evaluates the rendered `(… is null or … is null)` against one row. */
  function evaluateSql(row: EnforcedTagRow): boolean {
    const rendered = new PgDialect().sqlToQuery(untaggedAdSql()).sql;
    const body = rendered.trim().replace(/^\(/, "").replace(/\)$/, "");
    return body.split(" or ").some((term) => {
      const match = term
        .trim()
        .match(/^"(\w+)"\."(\w+)" is null$/);
      if (!match) throw new Error(`unreadable SQL term: ${term}`);
      const field = COLUMN_TO_FIELD[`${match[1]}.${match[2]}`];
      if (!field) throw new Error(`unknown column in SQL: ${match[0]}`);
      return row[field] === null;
    });
  }

  it("agrees with missingEnforcedTags on every combination of tags", () => {
    const present: EnforcedTagRow = {
      creativeId: "creative_1",
      funnelStage: "tof",
      persona: "busy parents",
      angle: "problem_solution",
      awarenessLevel: "problem_aware",
    };
    const fields = Object.keys(present) as Array<keyof EnforcedTagRow>;

    for (let mask = 0; mask < 1 << fields.length; mask += 1) {
      const row = { ...present };
      fields.forEach((field, index) => {
        if (mask & (1 << index)) row[field] = null;
      });

      expect({ row, untagged: evaluateSql(row) }).toEqual({
        row,
        untagged: isUntagged(row),
      });
    }
  });
});

describe("summarizeCoverage", () => {
  const rows: CoverageAdRow[] = [
    {
      adId: "ad_tagged",
      adName: "Morning stiffness UGC #4",
      creativeId: "c1",
      funnelStage: "tof",
      persona: "busy parents",
      angle: "problem_solution",
      awarenessLevel: "problem_aware",
      spendCents: 400_000,
    },
    {
      adId: "ad_big_gap",
      adName: "Bundle promo",
      creativeId: "c2",
      funnelStage: null,
      persona: "busy parents",
      angle: "offer_promo",
      awarenessLevel: "most_aware",
      spendCents: 90_000,
    },
    {
      adId: "ad_small_gap",
      adName: "Cold plunge UGC #3",
      creativeId: null,
      funnelStage: null,
      persona: null,
      angle: null,
      awarenessLevel: null,
      spendCents: 10_000,
    },
  ];

  it("splits tagged from untagged spend and ranks the gap by money", () => {
    const summary = summarizeCoverage(rows);

    expect(summary.totalActiveSpendCents).toBe(500_000);
    expect(summary.taggedSpendCents).toBe(400_000);
    expect(summary.untaggedSpendCents).toBe(100_000);
    expect(summary.share).toBe(0.8);
    expect(summary.untaggedAdCount).toBe(2);
    expect(summary.topUntaggedAds.map((ad) => ad.adId)).toEqual([
      "ad_big_gap",
      "ad_small_gap",
    ]);
    expect(summary.topUntaggedAds[0].missing).toEqual(["funnelStage"]);
  });

  it("does not veil at exactly the 80% line", () => {
    expect(summarizeCoverage(rows).gated).toBe(false);
  });

  it("veils below the line", () => {
    const summary = summarizeCoverage([
      { ...rows[0], spendCents: 100_000 },
      { ...rows[1], spendCents: 100_000 },
    ]);

    expect(summary.share).toBe(0.5);
    expect(summary.gated).toBe(true);
  });

  it("reports no share and no gate when nothing was spent", () => {
    const summary = summarizeCoverage([{ ...rows[1], spendCents: 0 }]);

    expect(summary.share).toBeNull();
    expect(summary.gated).toBe(false);
    expect(summary.untaggedAdCount).toBe(1);
  });

  it("keeps the top list short", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...rows[2],
      adId: `ad_${index}`,
      spendCents: index * 1_000,
    }));

    expect(summarizeCoverage(many, 3).topUntaggedAds).toHaveLength(3);
  });
});

describe("pickInsightCards", () => {
  const angle: SliceRow[] = [
    slice({ key: "problem_solution", revenueCents: 694_000, spendCents: 142_000 }),
    slice({ key: "transformation", revenueCents: 361_000, spendCents: 116_000 }),
    slice({ key: "social_proof", revenueCents: 288_000, spendCents: 131_000 }),
    // Real payback, but far too little spend behind it to say anything.
    slice({ key: "skepticism", revenueCents: 61_000, spendCents: 1_000 }),
    slice({ key: NO_TAGS_KEY, revenueCents: 101_200, spendCents: 88_000 }),
    slice({ key: UNMATCHED_KEY, revenueCents: 24_000, spendCents: null }),
  ];
  const awareness: SliceRow[] = [
    slice({ key: "problem_aware", revenueCents: 742_000, spendCents: 181_000 }),
    slice({ key: "solution_aware", revenueCents: 418_000, spendCents: 139_000 }),
  ];

  it("writes one card per dimension, best payback first", () => {
    const cards = pickInsightCards({ slices: { angle, awareness } });

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.dimension)).toEqual(["angle", "awareness"]);
    expect(cards[0]).toMatchObject({
      value: "problem_solution",
      runnerUp: { value: "transformation" },
    });
    expect(cards[0].backPer1).toBeCloseTo(694_000 / 142_000, 10);
  });

  it("never claims anything about an under-spent or explicit row", () => {
    const values = pickInsightCards({ slices: { angle } })[0].bars.map(
      (bar) => bar.value,
    );

    expect(values).not.toContain("skepticism");
    expect(values).not.toContain(NO_TAGS_KEY);
    expect(values).not.toContain(UNMATCHED_KEY);
  });

  it("skips a dimension with nothing worth saying", () => {
    const cards = pickInsightCards({
      slices: {
        angle: [slice({ key: "education", revenueCents: 900, spendCents: 500 })],
      },
    });

    expect(cards).toEqual([]);
  });

  it("has no runner-up when only one value clears the floor", () => {
    const cards = pickInsightCards({
      slices: { angle: [angle[0], slice({ key: "education", spendCents: 100 })] },
    });

    expect(cards[0].runnerUp).toBeNull();
    expect(cards[0].bars).toHaveLength(1);
  });
});
