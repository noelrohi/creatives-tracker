import { describe, expect, it } from "vitest";
import { DEFAULT_LEDGER_SORT, nextLedgerSort, sortLedgerRows } from "./ledger-sort";

const row = (name: string, revenue: string, open: number | null, sentAt: string | null = null) => ({
  name, sentAt, revenue, orderCount: 0,
  klaviyo: open === null ? null : { recipients: 10, unsubscribes: 0, conversionValue: null },
  rates: { delivered: null, open, click: null },
});

describe("sortLedgerRows", () => {
  it("defaults to confirmed revenue descending with name tie-breaks", () => {
    const sorted = sortLedgerRows([row("B", "5.00", null), row("A", "5.00", null), row("C", "9.00", null)], DEFAULT_LEDGER_SORT);
    expect(sorted.map((r) => r.name)).toEqual(["C", "A", "B"]);
  });
  it("puts null metrics last in both directions", () => {
    const rows = [row("none", "0.00", null), row("low", "0.00", 0.1), row("high", "0.00", 0.5)];
    expect(sortLedgerRows(rows, { column: "open", direction: "desc" }).map((r) => r.name)).toEqual(["high", "low", "none"]);
    expect(sortLedgerRows(rows, { column: "open", direction: "asc" }).map((r) => r.name)).toEqual(["low", "high", "none"]);
  });
  it("sorts flows (no send time) after campaigns on the Sent column", () => {
    const rows = [row("flow", "0.00", null, null), row("old", "0.00", null, "2026-07-01T00:00:00Z"), row("new", "0.00", null, "2026-07-20T00:00:00Z")];
    expect(sortLedgerRows(rows, { column: "sent", direction: "desc" }).map((r) => r.name)).toEqual(["new", "old", "flow"]);
  });
  it("toggles direction only on the active column", () => {
    expect(nextLedgerSort(DEFAULT_LEDGER_SORT, "open")).toEqual({ column: "open", direction: "desc" });
    expect(nextLedgerSort({ column: "open", direction: "desc" }, "open")).toEqual({ column: "open", direction: "asc" });
  });
});
