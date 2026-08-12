import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CoverageSummary } from "./coverage-summary";
import { OrdersTable, type LedgerRow } from "./orders-table";

function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    orderId: "order-1",
    orderName: "#1001",
    orderDay: "2026-07-20",
    netSales: "42.00",
    bucket: "klaviyo",
    orderStatus: "confirmed",
    productStatus: "exact",
    claimCount: 1,
    boundaryWarning: false,
    ...overrides,
  };
}

const noop = () => undefined;

describe("CoverageSummary", () => {
  it("shows every explicit order and event count with the boundary caveat", () => {
    render(
      <CoverageSummary
        coverage={{
          orders: {
            confirmed: 5,
            candidate: 2,
            ambiguous: 1,
            no_klaviyo_event: 3,
            duplicate_conversion_events: 1,
            not_evaluated: 4,
          },
          events: { confirmed: 5, unmatched: 2, not_evaluated: 1 },
        }}
      />,
    );
    expect(screen.getByTestId("order-confirmed")).toHaveTextContent("5");
    expect(screen.getByTestId("order-duplicate_conversion_events")).toHaveTextContent("1");
    expect(screen.getByTestId("order-not_evaluated")).toHaveTextContent("4");
    // Zero renders as 0, never inferred or hidden.
    expect(screen.getByTestId("event-candidate")).toHaveTextContent("0");
    expect(screen.getByTestId("event-not_evaluated")).toHaveTextContent("1");
    expect(screen.getByText("Outside evaluated boundary")).toBeVisible();
    expect(
      screen.getByText("A counterpart may exist outside this window."),
    ).toBeVisible();
  });
});

describe("OrdersTable", () => {
  it("puts Shopify order date net sales and bucket before Klaviyo evidence", () => {
    render(
      <OrdersTable
        data={{ items: [ledgerRow()], nextCursor: null }}
        error={false}
        filtered={false}
        onRetry={noop}
        onClearFilters={noop}
        onOpenOrder={noop}
        onNextPage={noop}
      />,
    );
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers.indexOf("Order")).toBeLessThan(headers.indexOf("Order status"));
    expect(headers.indexOf("Net sales")).toBeLessThan(
      headers.indexOf("Order status"),
    );
    expect(headers.indexOf("Current bucket")).toBeLessThan(
      headers.indexOf("Product status"),
    );
    expect(screen.getByText("Shopify truth")).toBeVisible();
    expect(screen.getByText("Klaviyo evidence (advisory)")).toBeVisible();
  });

  it("labels candidate confidence as advisory and never confirmed", () => {
    render(
      <OrdersTable
        data={{
          items: [ledgerRow({ orderStatus: "candidate", productStatus: null })],
          nextCursor: null,
        }}
        error={false}
        filtered={false}
        onRetry={noop}
        onClearFilters={noop}
        onOpenOrder={noop}
        onNextPage={noop}
      />,
    );
    expect(screen.getByText("Candidate (advisory)")).toBeVisible();
    expect(screen.queryByText(/^Confirmed$/)).toBeNull();
  });

  it("does not choose one campaign chain for duplicate conversion events", () => {
    render(
      <OrdersTable
        data={{
          items: [
            ledgerRow({
              orderStatus: "duplicate_conversion_events",
              claimCount: 4,
            }),
          ],
          nextCursor: null,
        }}
        error={false}
        filtered={false}
        onRetry={noop}
        onClearFilters={noop}
        onOpenOrder={noop}
        onNextPage={noop}
      />,
    );
    expect(screen.getByText("Multiple conversion events")).toBeVisible();
    // The row shows no canonical claim count for duplicates.
    expect(screen.queryByText("4")).toBeNull();
  });

  it("distinguishes empty, filtered-empty, and failed states and pages by cursor", async () => {
    const next = vi.fn();
    const clear = vi.fn();
    const { rerender } = render(
      <OrdersTable
        data={{ items: [], nextCursor: null }}
        error={false}
        filtered={false}
        onRetry={noop}
        onClearFilters={clear}
        onOpenOrder={noop}
        onNextPage={next}
      />,
    );
    expect(screen.getByText("No Shopify orders in this range")).toBeVisible();

    rerender(
      <OrdersTable
        data={{ items: [], nextCursor: null }}
        error={false}
        filtered={true}
        onRetry={noop}
        onClearFilters={clear}
        onOpenOrder={noop}
        onNextPage={next}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(clear).toHaveBeenCalledOnce();

    rerender(
      <OrdersTable
        data={null}
        error={true}
        filtered={false}
        onRetry={noop}
        onClearFilters={clear}
        onOpenOrder={noop}
        onNextPage={next}
      />,
    );
    expect(screen.getByText("Orders could not load")).toBeVisible();

    rerender(
      <OrdersTable
        data={{ items: [ledgerRow()], nextCursor: "cursor-2" }}
        error={false}
        filtered={false}
        onRetry={noop}
        onClearFilters={clear}
        onOpenOrder={noop}
        onNextPage={next}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(next).toHaveBeenCalledWith("cursor-2");
  });

  it("opens the clicked order", async () => {
    const open = vi.fn();
    render(
      <OrdersTable
        data={{ items: [ledgerRow()], nextCursor: null }}
        error={false}
        filtered={false}
        onRetry={noop}
        onClearFilters={noop}
        onOpenOrder={open}
        onNextPage={noop}
      />,
    );
    await userEvent.click(screen.getByText("#1001"));
    expect(open).toHaveBeenCalledWith("order-1");
  });
});
