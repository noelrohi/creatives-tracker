import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LEDGER_SORT } from "./ledger-sort";
import { LedgerTable } from "./ledger-table";
import type { LedgerRowData } from "./ledger-types";

const stats = {
  recipients: 1000, delivered: 990, uniqueOpens: 400, uniqueClicks: 40,
  bounced: 10, unsubscribes: 2, spamComplaints: 0, conversions: 5, conversionValue: "150.00",
};

function row(overrides: Partial<LedgerRowData> = {}): LedgerRowData {
  return {
    objectId: "camp-1",
    objectType: "campaign",
    name: "July Sale",
    channel: "email",
    status: "sent",
    sentAt: "2026-07-10T09:00:00.000Z" as unknown as Date,
    messageCount: 2,
    klaviyo: stats,
    rates: { delivered: 0.99, open: 400 / 990, click: 40 / 990, unsubscribe: 2 / 990 },
    orderCount: 3,
    revenue: "97.50",
    ...overrides,
  };
}

const report = {
  asOf: "2026-08-02T00:00:00.000Z" as unknown as Date,
  hasCampaignGeneration: true,
  hasFlowGeneration: true,
  reportFrom: null,
  reportTo: null,
};
const noop = () => undefined;

function renderTable(props: Partial<Parameters<typeof LedgerTable>[0]> = {}) {
  return render(
    <LedgerTable
      data={{ rows: [row()], report }}
      error={false}
      filtered={false}
      busy={false}
      accountTimezone="America/Los_Angeles"
      range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }}
      sort={DEFAULT_LEDGER_SORT}
      onToggleSort={noop}
      expanded={new Set()}
      onToggleExpand={noop}
      renderMessageRows={() => null}
      onOpenSource={noop}
      onRefresh={noop}
      onRetry={noop}
      onClearFilters={noop}
      {...props}
    />,
  );
}

describe("LedgerTable", () => {
  it("renders the ten columns with the row's chips, rates, and money", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent?.trim());
    expect(headers).toEqual(["", "Name", "Sent", "Recipients", "Delivered", "Open", "Click", "Orders", "We confirm", "Klaviyo says", "Unsub"]);
    const body = screen.getAllByRole("row")[1];
    expect(within(body).getByText("CMP")).toBeVisible();
    expect(within(body).getByText("EMAIL")).toBeVisible();
    expect(within(body).getByText("Jul 10")).toBeVisible();
    expect(within(body).getByText("1,000")).toBeVisible();
    expect(within(body).getByText("99.0%")).toBeVisible();
    expect(within(body).getByText("40.4%")).toBeVisible();
    expect(within(body).getByText("$97.50")).toBeVisible();
    expect(within(body).getByText("$150")).toBeVisible();
    expect(within(body).getByText("2")).toBeVisible();
    expect(screen.getByText(/Send dates use America\/Los_Angeles account days/)).toBeVisible();
    expect(screen.getByText(/as of 2026-08-02/)).toBeVisible();
  });

  it("shows dashes for a row without a fact and 'ongoing' for a flow", () => {
    renderTable({ data: { rows: [row({ objectId: "flow-1", objectType: "flow", name: "Welcome", sentAt: null, klaviyo: null, rates: { delivered: null, open: null, click: null, unsubscribe: null }, messageCount: 3 })], report } });
    const body = screen.getAllByRole("row")[1];
    expect(within(body).getByText("FLW")).toBeVisible();
    expect(within(body).getByText("ongoing")).toBeVisible();
    expect(within(body).getAllByText("—")).toHaveLength(6);
  });

  it("only offers a chevron when there is something to expand and opens the sheet on row click", async () => {
    const onToggleExpand = vi.fn();
    const onOpenSource = vi.fn();
    renderTable({
      data: { rows: [row(), row({ objectId: "camp-2", name: "Single", messageCount: 1 })], report },
      onToggleExpand,
      onOpenSource,
    });
    expect(screen.getByRole("button", { name: "Expand July Sale" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Expand Single" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Expand July Sale" }));
    expect(onToggleExpand).toHaveBeenCalledWith("camp-1");
    expect(onOpenSource).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Single"));
    expect(onOpenSource).toHaveBeenCalledWith("camp-2");
  });

  it("renders message rows under an expanded parent", () => {
    renderTable({
      expanded: new Set(["camp-1"]),
      renderMessageRows: (parent) => (
        <tr data-testid="messages">
          <td>{`children of ${parent.name}`}</td>
        </tr>
      ),
    });
    expect(screen.getByTestId("messages")).toHaveTextContent("children of July Sale");
  });

  it("sorts headers via the callback and marks the active column", async () => {
    const onToggleSort = vi.fn();
    renderTable({ onToggleSort, sort: { column: "open", direction: "asc" } });
    expect(screen.getByRole("columnheader", { name: /Open/ })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: "Sort by Unsub" }));
    expect(onToggleSort).toHaveBeenCalledWith("unsub");
  });

  it("keeps the no-report, empty, filtered, and error states distinct", () => {
    const { rerender } = renderTable({ data: { rows: [row({ klaviyo: null })], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false, reportFrom: null, reportTo: null } } });
    expect(screen.getByText("No Klaviyo report yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh report" })).toBeVisible();
    // Our numbers still render for the row.
    expect(screen.getByText("$97.50")).toBeVisible();
    rerender(<LedgerTable data={{ rows: [], report }} error={false} filtered={false} busy={false} accountTimezone="UTC" range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }} sort={DEFAULT_LEDGER_SORT} onToggleSort={noop} expanded={new Set()} onToggleExpand={noop} renderMessageRows={() => null} onOpenSource={noop} onRefresh={noop} onRetry={noop} onClearFilters={noop} />);
    expect(screen.getByText("No campaigns or flows in this range")).toBeVisible();
    rerender(<LedgerTable data={{ rows: [], report }} error={false} filtered={true} busy={false} accountTimezone="UTC" range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }} sort={DEFAULT_LEDGER_SORT} onToggleSort={noop} expanded={new Set()} onToggleExpand={noop} renderMessageRows={() => null} onOpenSource={noop} onRefresh={noop} onRetry={noop} onClearFilters={noop} />);
    expect(screen.getByText("No results match your filters")).toBeVisible();
    rerender(<LedgerTable data={null} error={true} filtered={false} busy={false} accountTimezone="UTC" range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }} sort={DEFAULT_LEDGER_SORT} onToggleSort={noop} expanded={new Set()} onToggleExpand={noop} renderMessageRows={() => null} onOpenSource={noop} onRefresh={noop} onRetry={noop} onClearFilters={noop} />);
    expect(screen.getByText("Couldn’t load campaigns.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("hides the Refresh button when the viewer cannot refresh", () => {
    renderTable({
      data: { rows: [row({ klaviyo: null })], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false, reportFrom: null, reportTo: null } },
      onRefresh: undefined,
    });
    expect(screen.queryByRole("button", { name: "Refresh report" })).toBeNull();
  });

  it("names the report's own coverage in the caption when it differs from the range", () => {
    renderTable({
      data: {
        rows: [row()],
        report: {
          ...report,
          reportFrom: "2026-08-10T00:00:00.000Z" as unknown as Date,
          reportTo: "2026-09-08T00:00:00.000Z" as unknown as Date,
        },
      },
    });
    expect(
      screen.getByText(/Klaviyo report covers 2026-08-10 → 2026-09-08/),
    ).toBeVisible();
  });

  it("omits the report-coverage caption when the report window is unknown", () => {
    renderTable();
    expect(screen.queryByText(/Klaviyo report covers/)).toBeNull();
  });
});
