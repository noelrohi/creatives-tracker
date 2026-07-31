/**
 * The tie-out, as data.
 *
 * The reconciliation identity is the product's differentiator, so it is drawn as
 * a totals block in the same columns as the channel rows rather than written as
 * a caption underneath them. This module decides which lines that block has —
 * pure, so the three shapes (exact, still landing, gap) can be tested without a
 * renderer. Money arrives already formatted; nothing here does arithmetic.
 *
 * What this block proves is completeness, not agreement: every order landed in
 * exactly one piece. Comparing against Shopify's own reported Net sales needs
 * that figure fetched, which we do not do yet — so no line here may be worded
 * as if Shopify had confirmed it.
 */

import { ledger as copy, help } from "./copy";

export type LedgerLine = {
  key: "pieces" | "pending" | "shopify" | "gap";
  label: string;
  /** Only the first line carries a share; the rest sit under the same column. */
  share: string | null;
  money: string;
  /** A strong rule opens a total; a soft rule opens a line inside one. */
  rule: "strong" | "soft";
  tone: "default" | "muted" | "gap";
  help?: string;
};

export type LedgerInput = {
  /** What the visible pieces hold, formatted. */
  sumOfBuckets: string;
  /**
   * Our own Net sales for the same days, counted ungrouped — NOT Shopify's
   * reported figure, which this screen never reads.
   */
  actual: string;
  /** Signed distance between the two, formatted, when they disagree. */
  difference: string | null;
  matches: boolean;
  pendingCount: number;
  pendingMoney: string | null;
};

/**
 * Three shapes, and only three:
 *
 * - exact          → one `Net sales` line
 * - still landing  → pieces, the orders too new to place, then our Net sales
 * - gap            → pieces, our Net sales, then the gap we're looking into
 */
export function ledgerLines(input: LedgerInput): LedgerLine[] {
  const { sumOfBuckets, actual, difference, matches } = input;
  const pending =
    input.pendingCount > 0 && input.pendingMoney ? input.pendingMoney : null;

  if (!matches) {
    return [
      {
        key: "pieces",
        label: copy.piecesLabel,
        share: copy.shareLabel,
        money: sumOfBuckets,
        rule: "strong",
        tone: "default",
      },
      {
        key: "shopify",
        label: copy.ourNetSalesLabel,
        share: null,
        money: actual,
        rule: "soft",
        tone: "muted",
        help: help.netSales,
      },
      // No difference means we know the two disagree but not yet by how much;
      // the sentence under the block says so, and this line stays away.
      ...(difference
        ? [
            {
              key: "gap" as const,
              label: copy.gapLabel,
              share: null,
              money: difference,
              rule: "strong" as const,
              tone: "gap" as const,
            },
          ]
        : []),
    ];
  }

  if (pending) {
    return [
      {
        key: "pieces",
        label: copy.piecesLabel,
        share: copy.shareLabel,
        money: sumOfBuckets,
        rule: "strong",
        tone: "default",
      },
      {
        key: "pending",
        label: copy.tooNewLabel,
        share: null,
        money: pending,
        rule: "soft",
        tone: "muted",
        help: help.tooNew,
      },
      {
        key: "shopify",
        label: copy.ourNetSalesLabel,
        share: null,
        money: actual,
        rule: "strong",
        tone: "default",
        help: help.netSales,
      },
    ];
  }

  return [
    {
      key: "pieces",
      label: copy.totalLabel,
      share: copy.shareLabel,
      money: sumOfBuckets,
      rule: "strong",
      tone: "default",
      help: help.netSales,
    },
  ];
}
