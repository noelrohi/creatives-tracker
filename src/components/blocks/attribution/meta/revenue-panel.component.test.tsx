import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaRevenuePanel } from "./revenue-panel";

const queryState = vi.hoisted(() => ({
  metaCheckFn: (): Promise<unknown> => Promise.resolve(null),
  campaignLedgerFn: (): Promise<unknown> => Promise.resolve(null),
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    attribution: {
      metaCheck: {
        queryOptions: (input: unknown) => ({
          queryKey: ["metaCheck", input],
          queryFn: queryState.metaCheckFn,
          retry: false,
        }),
      },
      campaignLedger: {
        queryOptions: (input: unknown) => ({
          queryKey: ["campaignLedger", input],
          queryFn: queryState.campaignLedgerFn,
          retry: false,
        }),
      },
    },
  }),
}));

/** Mirrors the `attribution.metaCheck` router output shape. */
function metaCheck() {
  return {
    range: { dateFrom: "2026-08-01", dateTo: "2026-08-07" },
    claims: {
      claimed: "1200.00",
      claimed7dClick: "900.00",
      claimed1dView: "300.00",
      labeledRowShare: 1,
    },
    spend: "400.00",
    verifiedRevenue: "800.00",
    verifiedOrderCount: 12,
    verificationPendingCount: 0,
    verifiedRoas: "2.00",
    roasTarget: "3.00",
  };
}

/** Mirrors the `attribution.campaignLedger` router output shape. */
function campaignLedger() {
  return {
    range: { dateFrom: "2026-08-01", dateTo: "2026-08-07" },
    campaigns: [
      {
        campaignId: "c-1",
        name: "Prospecting US",
        spend: "300.00",
        claimed: "900.00",
        confirmedRevenue: "600.00",
        orderCount: 9,
        roas: "2.00",
      },
    ],
    unresolved: null,
    roasTarget: "3.00",
  };
}

function renderPanel(
  overrides: { metaDown?: boolean; shopifyTotal?: string | null } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MetaRevenuePanel
        dateFrom="2026-08-01"
        dateTo="2026-08-07"
        currency="USD"
        metaDown={overrides.metaDown ?? false}
        detailHref="/mer?from=2026-08-01&to=2026-08-07"
        shopifyTotal={
          overrides.shopifyTotal === undefined
            ? "2000.00"
            : overrides.shopifyTotal
        }
      />
    </QueryClientProvider>,
  );
}

describe("MetaRevenuePanel", () => {
  beforeEach(() => {
    queryState.metaCheckFn = () => Promise.resolve(metaCheck());
    queryState.campaignLedgerFn = () => Promise.resolve(campaignLedger());
  });

  it("shows the Meta check figures, share bar, and campaign table", async () => {
    renderPanel();
    expect(await screen.findByText("Spent on Meta")).toBeInTheDocument();
    expect(screen.getByText("The Meta check")).toBeInTheDocument();
    expect(screen.getByText("Campaign by campaign")).toBeInTheDocument();
    expect(await screen.findByText("Prospecting US")).toBeInTheDocument();
    expect(screen.getByTestId("meta-confirmed-share")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "See Meta vs Shopify →" }),
    ).toHaveAttribute("href", "/mer?from=2026-08-01&to=2026-08-07");
  });

  it("drops Meta's own claims while the connection is down", async () => {
    renderPanel({ metaDown: true });
    // "We can confirm" survives a Meta outage; the claim sentence does not.
    expect(
      await screen.findByText("We can confirm in Shopify"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Meta says its ads made \$/)).toBeNull();
  });

  it("shows the error line and refetches on Retry when metaCheck fails", async () => {
    const metaCheckFn = vi.fn(() => Promise.reject(new Error("boom")));
    queryState.metaCheckFn = metaCheckFn;
    const user = userEvent.setup();
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(
      screen.getByText("The Meta check didn't load."),
    ).toBeInTheDocument();
    expect(metaCheckFn).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(metaCheckFn).toHaveBeenCalledTimes(2));
  });

  it("hides the share bar when there is no Shopify total", async () => {
    renderPanel({ shopifyTotal: null });
    expect(await screen.findByText("Spent on Meta")).toBeInTheDocument();
    expect(screen.queryByTestId("meta-confirmed-share")).toBeNull();
  });
});
