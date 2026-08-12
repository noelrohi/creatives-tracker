import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReportsTable } from "./reports-table";
import { UnmatchedEventsTable } from "./unmatched-events-table";

const noop = () => undefined;

describe("UnmatchedEventsTable", () => {
  it("shows event status with the boundary caveat and no Shopify labels", () => {
    const { container } = render(
      <UnmatchedEventsTable
        data={{
          items: [
            {
              eventId: "event-1",
              occurredAt: "2026-07-20T10:00:00.000Z",
              eventStatus: "unmatched",
              boundaryWarning: false,
            },
            {
              eventId: "event-2",
              occurredAt: "2026-07-21T10:00:00.000Z",
              eventStatus: "not_evaluated",
              boundaryWarning: true,
            },
          ],
          nextCursor: null,
        }}
        error={false}
        onRetry={noop}
        onNextPage={noop}
      />,
    );
    expect(screen.getByText("unmatched")).toBeVisible();
    expect(screen.getByText("Outside evaluated boundary")).toBeVisible();
    expect(
      screen.getByText(
        "A Shopify counterpart may exist outside this evaluated window",
      ),
    ).toBeVisible();
    // No Shopify order/Net sales column exists on the event ledger.
    expect(
      screen.queryByRole("columnheader", { name: "Net sales" }),
    ).toBeNull();
    expect(
      screen.queryByRole("columnheader", { name: /Shopify order/ }),
    ).toBeNull();
    expect(container.textContent).toContain(
      "Klaviyo observation — not Shopify Net sales",
    );
  });

  it("paginates by server cursor", async () => {
    const next = vi.fn();
    render(
      <UnmatchedEventsTable
        data={{
          items: [
            {
              eventId: "event-1",
              occurredAt: "2026-07-20T10:00:00.000Z",
              eventStatus: "unmatched",
              boundaryWarning: false,
            },
          ],
          nextCursor: "cursor-2",
        }}
        error={false}
        onRetry={noop}
        onNextPage={next}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(next).toHaveBeenCalledWith("cursor-2");
  });
});

describe("ReportsTable", () => {
  const data = {
    generationId: "generation-1",
    publishedAt: "2026-08-05T00:00:00.000Z",
    facts: [
      {
        id: "fact-1",
        grouping: { campaign_id: "campaign-ext-1", send_date: "2026-07-15" },
        conversions: "3",
        conversionValue: "99.50",
        recipients: "120",
        uniqueClicks: "18",
        uniqueOpens: "60",
        campaignObjectId: "campaign-row-1",
        flowObjectId: null,
        asOf: "2026-08-05T00:00:00.000Z",
      },
    ],
  };

  it("labels account-timezone send-date semantics with as-of and no order-time label", () => {
    const { container } = render(
      <ReportsTable
        data={data}
        error={false}
        accountTimezone="America/Los_Angeles"
        kind="campaign"
        range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }}
        busy={false}
        onRetry={noop}
        onRefresh={noop}
      />,
    );
    expect(
      screen.getByText(
        /Report dates use America\/Los_Angeles message-send days/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/as of 2026-08-05/)).toBeVisible();
    expect(
      screen.getByText("Aggregate Klaviyo claims — not order-level attribution."),
    ).toBeVisible();
    expect(screen.getByText("Klaviyo conversion value")).toBeVisible();
    expect(container.textContent).not.toContain("order-occurrence");
    expect(container.textContent).not.toContain("Net sales");
  });

  it("refreshes only the selected report kind", async () => {
    const refresh = vi.fn();
    render(
      <ReportsTable
        data={data}
        error={false}
        accountTimezone="America/Los_Angeles"
        kind="flow"
        range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }}
        busy={false}
        onRetry={noop}
        onRefresh={refresh}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh flow report" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps its own empty and error states distinct from the order ledger", () => {
    const { rerender } = render(
      <ReportsTable
        data={{ generationId: null, publishedAt: null, facts: [] }}
        error={false}
        accountTimezone="UTC"
        kind="campaign"
        range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }}
        busy={false}
        onRetry={noop}
        onRefresh={noop}
      />,
    );
    expect(
      screen.getByText("No published report facts for this slot"),
    ).toBeVisible();
    expect(screen.queryByText("No Shopify orders in this range")).toBeNull();
    rerender(
      <ReportsTable
        data={null}
        error={true}
        accountTimezone="UTC"
        kind="campaign"
        range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }}
        busy={false}
        onRetry={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText("Reports could not load")).toBeVisible();
  });
});
