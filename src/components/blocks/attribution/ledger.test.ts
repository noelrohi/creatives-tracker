import { describe, expect, it } from "vitest";
import { ledger as copy } from "./copy";
import { ledgerLines } from "./ledger";

const base = {
  sumOfBuckets: "$14,132.17",
  actual: "$14,132.17",
  difference: null,
  matches: true,
  pendingCount: 0,
  pendingMoney: null,
};

describe("ledgerLines", () => {
  it("prints one Net sales line when the pieces tie out exactly", () => {
    const lines = ledgerLines(base);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      key: "pieces",
      label: copy.totalLabel,
      share: copy.shareLabel,
      money: "$14,132.17",
      rule: "strong",
      tone: "default",
    });
  });

  it("grows a ladder while orders are still landing", () => {
    const lines = ledgerLines({
      ...base,
      actual: "$14,350.57",
      pendingCount: 4,
      pendingMoney: "$218.40",
    });

    expect(lines.map((line) => line.key)).toEqual([
      "pieces",
      "pending",
      "shopify",
    ]);
    expect(lines[0].label).toBe(copy.piecesLabel);
    expect(lines[1]).toMatchObject({ money: "$218.40", rule: "soft", tone: "muted" });
    expect(lines[2]).toMatchObject({ money: "$14,350.57", rule: "strong" });
  });

  it("ignores a pending total that carries no orders", () => {
    const lines = ledgerLines({ ...base, pendingCount: 0, pendingMoney: "$0.00" });

    expect(lines.map((line) => line.key)).toEqual(["pieces"]);
  });

  it("names the gap when the two sides disagree", () => {
    const lines = ledgerLines({
      sumOfBuckets: "$13,720.06",
      actual: "$14,132.17",
      difference: "$412.11",
      matches: false,
      pendingCount: 0,
      pendingMoney: null,
    });

    expect(lines.map((line) => line.key)).toEqual(["pieces", "shopify", "gap"]);
    expect(lines[2]).toMatchObject({
      label: copy.gapLabel,
      money: "$412.11",
      tone: "gap",
    });
  });

  it("drops the gap line when we cannot say how big the gap is", () => {
    const lines = ledgerLines({
      sumOfBuckets: "$13,720.06",
      actual: "$14,132.17",
      difference: null,
      matches: false,
      pendingCount: 0,
      pendingMoney: null,
    });

    expect(lines.map((line) => line.key)).toEqual(["pieces", "shopify"]);
  });
});
