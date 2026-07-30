import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_SORT,
  type ManagerSortableRow,
  nextManagerSort,
  sortManagerRows,
} from "./manager-ledger-sort";

function row(
  name: string,
  metrics: Partial<Omit<ManagerSortableRow, "name">> = {},
): ManagerSortableRow {
  return {
    name,
    spend: "0",
    roas: null,
    cpa: null,
    ctr: null,
    conversions: 0,
    ...metrics,
  };
}

const names = (rows: ManagerSortableRow[]) => rows.map((r) => r.name);

describe("sortManagerRows", () => {
  it("sorts numeric strings by value, not lexically", () => {
    const rows = [
      row("a", { spend: "9.5" }),
      row("b", { spend: "100" }),
      row("c", { spend: "80" }),
    ];

    expect(names(sortManagerRows(rows, DEFAULT_MANAGER_SORT))).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("reverses on direction", () => {
    const rows = [
      row("a", { spend: "5" }),
      row("b", { spend: "20" }),
      row("c", { spend: "1" }),
    ];

    expect(
      names(sortManagerRows(rows, { column: "spend", direction: "asc" })),
    ).toEqual(["c", "a", "b"]);
    expect(
      names(sortManagerRows(rows, { column: "spend", direction: "desc" })),
    ).toEqual(["b", "a", "c"]);
  });

  it("sorts nulls last in both directions", () => {
    const rows = [
      row("a", { roas: null }),
      row("b", { roas: "2.5" }),
      row("c", { roas: null }),
      row("d", { roas: "0.5" }),
    ];

    expect(
      names(sortManagerRows(rows, { column: "roas", direction: "desc" })),
    ).toEqual(["b", "d", "a", "c"]);
    expect(
      names(sortManagerRows(rows, { column: "roas", direction: "asc" })),
    ).toEqual(["d", "b", "a", "c"]);
  });

  it("tie-breaks by name ascending regardless of direction", () => {
    const rows = [
      row("charlie", { spend: "10" }),
      row("alpha", { spend: "10" }),
      row("bravo", { spend: "10" }),
    ];

    expect(
      names(sortManagerRows(rows, { column: "spend", direction: "desc" })),
    ).toEqual(["alpha", "bravo", "charlie"]);
    expect(
      names(sortManagerRows(rows, { column: "spend", direction: "asc" })),
    ).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("tie-breaks null rows by name too", () => {
    const rows = [row("z", { cpa: null }), row("y", { cpa: null })];

    expect(
      names(sortManagerRows(rows, { column: "cpa", direction: "desc" })),
    ).toEqual(["y", "z"]);
  });

  it("sorts the numeric conversions column", () => {
    const rows = [
      row("a", { conversions: 3 }),
      row("b", { conversions: 12 }),
      row("c", { conversions: null }),
    ];

    expect(
      names(
        sortManagerRows(rows, { column: "conversions", direction: "desc" }),
      ),
    ).toEqual(["b", "a", "c"]);
  });

  it("treats unparseable metric values as null", () => {
    const rows = [row("a", { ctr: "NaN" }), row("b", { ctr: "1.2" })];

    expect(
      names(sortManagerRows(rows, { column: "ctr", direction: "asc" })),
    ).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const rows = [row("a", { spend: "1" }), row("b", { spend: "2" })];
    sortManagerRows(rows, DEFAULT_MANAGER_SORT);

    expect(names(rows)).toEqual(["a", "b"]);
  });

  it("defaults to spend descending", () => {
    expect(DEFAULT_MANAGER_SORT).toEqual({
      column: "spend",
      direction: "desc",
    });
  });
});

describe("nextManagerSort", () => {
  it("starts a new column descending", () => {
    expect(
      nextManagerSort({ column: "spend", direction: "asc" }, "roas"),
    ).toEqual({ column: "roas", direction: "desc" });
  });

  it("toggles direction on the active column", () => {
    expect(
      nextManagerSort({ column: "roas", direction: "desc" }, "roas"),
    ).toEqual({ column: "roas", direction: "asc" });
    expect(
      nextManagerSort({ column: "roas", direction: "asc" }, "roas"),
    ).toEqual({ column: "roas", direction: "desc" });
  });
});
