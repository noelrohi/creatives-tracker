import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
