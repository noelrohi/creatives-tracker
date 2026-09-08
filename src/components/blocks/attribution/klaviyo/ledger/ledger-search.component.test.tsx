import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerSearch } from "./ledger-search";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function searchBox() {
  return screen.getByRole("textbox", { name: "Search" });
}

function type(text: string) {
  fireEvent.change(searchBox(), { target: { value: text } });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("LedgerSearch", () => {
  it("publishes a typed draft once, after the debounce", () => {
    const onChange = vi.fn();
    render(<LedgerSearch value="" onChange={onChange} />);
    type("zzz");
    expect(onChange).not.toHaveBeenCalled();
    advance(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("zzz");
  });

  it("lets an external clear win instead of republishing the stale draft", () => {
    const onChange = vi.fn();
    const { rerender } = render(<LedgerSearch value="" onChange={onChange} />);
    type("zzz");
    advance(300);
    expect(onChange).toHaveBeenCalledWith("zzz");
    // The parent accepted the search; the URL now carries it.
    rerender(<LedgerSearch value="zzz" onChange={onChange} />);
    onChange.mockClear();
    // "Clear filters" wipes `q`; the draft must follow, not fight back.
    rerender(<LedgerSearch value="" onChange={onChange} />);
    advance(500);
    expect(onChange).not.toHaveBeenCalled();
    expect(searchBox()).toHaveValue("");
  });
});
