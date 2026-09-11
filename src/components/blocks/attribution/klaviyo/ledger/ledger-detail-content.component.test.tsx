import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LedgerDetailContent } from "./ledger-detail-content";
import type { LedgerDetailData } from "./ledger-types";

const stats = {
  recipients: 18420, delivered: 18254, uniqueOpens: 7520, uniqueClicks: 694,
  bounced: 163, unsubscribes: 38, spamComplaints: 2, conversions: 226, conversionValue: "12980.00",
};

function detail(overrides: Partial<LedgerDetailData> = {}): LedgerDetailData {
  return {
    object: {
      objectId: "camp-1", objectType: "campaign", name: "Labor Day Sale", channel: "email", status: "sent",
      sentAt: "2026-09-01T09:00:00.000Z" as unknown as Date, subject: "20% off ends tonight", messageCount: 2,
    },
    klaviyo: stats,
    rates: { delivered: 18254 / 18420, open: 7520 / 18254, click: 694 / 18254, unsubscribe: 38 / 18254 },
    ours: { orderCount: 212, revenue: "11904.00" },
    reconciliation: { unconfirmedOrders: 14, revenuePerRecipient: "0.65", averageOrderValue: "56.15" },
    ordersByDay: {
      mode: "offset",
      points: Array.from({ length: 14 }, (_, i) => ({ label: String(i), orders: i === 0 ? 120 : i === 1 ? 60 : 0, revenue: "0.00" })),
    },
    topProducts: [
      { productKey: "1", title: "Vitamin C Serum", units: 88, orderCount: 80, orderRevenue: "4290.00" },
    ],
    messages: [
      { objectId: "m-a", objectType: "campaign_message", name: "A", subject: "20% off ends tonight", channel: "email", klaviyo: { ...stats, uniqueOpens: 4000 }, rates: { delivered: 0.99, open: 0.43, click: 0.04, unsubscribe: 0.002 }, orderCount: 120, revenue: "6410.00" },
      { objectId: "m-b", objectType: "campaign_message", name: "B", subject: "Last call", channel: "email", klaviyo: stats, rates: { delivered: 0.99, open: 0.394, click: 0.03, unsubscribe: 0.002 }, orderCount: 92, revenue: "5494.00" },
    ],
    ...overrides,
  };
}

describe("LedgerDetailContent", () => {
  it("renders all seven blocks for a campaign with variants", async () => {
    const onViewOrders = vi.fn();
    render(<LedgerDetailContent detail={detail()} onViewOrders={onViewOrders} />);
    expect(screen.getByRole("heading", { name: "Labor Day Sale" })).toBeVisible();
    expect(screen.getByText(/Subject: “20% off ends tonight”/)).toBeVisible();
    expect(screen.getByTestId("funnel-recipients")).toHaveTextContent("18,420");
    expect(screen.getByTestId("funnel-opened")).toHaveTextContent("41.2%");
    expect(screen.getByTestId("funnel-ordered")).toHaveTextContent("212");
    expect(screen.getByTestId("we-confirm")).toHaveTextContent("$11904");
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$12980");
    expect(screen.getByText("14 orders we couldn’t confirm")).toBeVisible();
    expect(screen.getByTestId("per-recipient")).toHaveTextContent("$0.65");
    expect(screen.getByText("AOV $56.15")).toBeVisible();
    expect(screen.getByTestId("list-unsubscribed")).toHaveTextContent("38");
    expect(screen.getByTestId("list-unsubscribed")).toHaveTextContent("0.2%");
    expect(screen.getByText("Confirmed orders by day after send")).toBeVisible();
    expect(screen.getAllByTestId("day-bar")).toHaveLength(14);
    await userEvent.click(screen.getByRole("button", { name: "View orders in Orders →" }));
    expect(onViewOrders).toHaveBeenCalledOnce();
    expect(screen.getByText("Vitamin C Serum")).toBeVisible();
    expect(screen.getByText("Variants (A/B)")).toBeVisible();
    expect(screen.getByText("Last call")).toBeVisible();
  });

  it("dashes Klaviyo blocks without a fact and hides the variants block for a single message", () => {
    render(
      <LedgerDetailContent
        detail={detail({
          klaviyo: null,
          rates: { delivered: null, open: null, click: null, unsubscribe: null },
          reconciliation: { unconfirmedOrders: null, revenuePerRecipient: null, averageOrderValue: "56.15" },
          object: { ...detail().object, messageCount: 1 },
          messages: [],
        })}
      />,
    );
    expect(screen.getByTestId("funnel-opened")).toHaveTextContent("—");
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("—");
    expect(screen.queryByText(/we couldn’t confirm/)).toBeNull();
    expect(screen.getByTestId("list-unsubscribed")).toHaveTextContent("—");
    expect(screen.queryByText("Variants (A/B)")).toBeNull();
    expect(screen.queryByRole("button", { name: "View orders in Orders →" })).toBeNull();
  });

  it("labels a flow as ongoing with calendar-day bars and an emails block", () => {
    render(
      <LedgerDetailContent
        detail={detail({
          object: { ...detail().object, objectType: "flow", name: "Welcome", sentAt: null, subject: null, messageCount: 3 },
          ordersByDay: { mode: "calendar", points: [{ label: "2026-07-01", orders: 2, revenue: "80.00" }, { label: "2026-07-02", orders: 0, revenue: "0.00" }] },
        })}
        onViewOrders={() => undefined}
      />,
    );
    expect(screen.getByText("ongoing")).toBeVisible();
    expect(screen.getByText("Confirmed orders by day")).toBeVisible();
    expect(screen.getAllByTestId("day-bar")).toHaveLength(2);
    expect(screen.getByText("Emails in this flow")).toBeVisible();
  });
});
