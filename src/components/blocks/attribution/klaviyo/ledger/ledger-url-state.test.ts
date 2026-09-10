import { describe, expect, it, vi } from "vitest";
import { LEDGER_URL_PARSERS, ledgerStateHelpers, type LedgerUrlState } from "./ledger-url-state";
import { LAB_URL_PARSERS } from "../use-klaviyo-lab-state";

const state: LedgerUrlState = {
  range: "last30", from: null, to: null, ledgerKind: "all", ledgerChannel: "all",
  q: null, source: null, sort: "revenue", dir: "desc",
};

describe("LEDGER_URL_PARSERS", () => {
  it("names exactly the ledger's params with their defaults", () => {
    expect(Object.keys(LEDGER_URL_PARSERS).sort()).toEqual(
      ["dir", "from", "ledgerChannel", "ledgerKind", "q", "range", "sort", "source", "to"],
    );
    expect(LEDGER_URL_PARSERS.range.defaultValue).toBe("last30");
    expect(LEDGER_URL_PARSERS.sort.defaultValue).toBe("revenue");
    expect(LEDGER_URL_PARSERS.dir.defaultValue).toBe("desc");
    expect(LEDGER_URL_PARSERS.ledgerKind.defaultValue).toBe("all");
  });

  it("is a subset of the lab's parsers, so a lab URL is a valid page URL", () => {
    for (const key of Object.keys(LEDGER_URL_PARSERS) as Array<keyof typeof LEDGER_URL_PARSERS>) {
      expect(LAB_URL_PARSERS[key]).toBe(LEDGER_URL_PARSERS[key]);
    }
  });
});

describe("ledgerStateHelpers", () => {
  it("opens and closes the source sheet and clears only ledger filters", () => {
    const setState = vi.fn();
    const helpers = ledgerStateHelpers(state, setState);
    helpers.openSource("camp-1");
    expect(setState).toHaveBeenLastCalledWith({ source: "camp-1" });
    helpers.closeSource();
    expect(setState).toHaveBeenLastCalledWith({ source: null });
    helpers.clearLedgerFilters();
    expect(setState).toHaveBeenLastCalledWith({ source: null, q: null, ledgerKind: "all", ledgerChannel: "all" });
  });

  it("toggles sort like the table header", () => {
    const setState = vi.fn();
    ledgerStateHelpers(state, setState).toggleSort("open");
    expect(setState).toHaveBeenLastCalledWith({ sort: "open", dir: "desc" });
    ledgerStateHelpers({ ...state, sort: "open" }, setState).toggleSort("open");
    expect(setState).toHaveBeenLastCalledWith({ sort: "open", dir: "asc" });
  });
});
