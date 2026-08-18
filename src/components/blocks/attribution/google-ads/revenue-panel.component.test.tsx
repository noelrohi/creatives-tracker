import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RevenuePanelSummary } from "@/lib/google-ads/revenue-panel";
import { googleAdsRevenue } from "./copy";
import { GoogleAdsRevenuePanel } from "./revenue-panel";

const queryState = vi.hoisted(() => ({
  revenuePanelFn: (): Promise<unknown> => Promise.resolve(null),
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    googleAds: {
      revenuePanel: {
        queryOptions: (input: unknown) => ({
          queryKey: ["google-ads-revenue-panel", input],
          queryFn: queryState.revenuePanelFn,
          retry: false,
        }),
      },
    },
  }),
}));

function emptySummary(
  overrides: Partial<RevenuePanelSummary> = {},
): RevenuePanelSummary {
  return {
    connection: null,
    googleCurrencyCode: null,
    ourSide: {
      bucketRevenueCents: 0,
      bucketOrders: 0,
      feedRevenueCents: 0,
      feedOrders: 0,
      paidRevenueCents: 0,
      paidOrders: 0,
      paidByCampaign: [],
    },
    googleSays: null,
    ...overrides,
  };
}

describe("GoogleAdsRevenuePanel", () => {
  function renderPanel(
    props: Partial<Parameters<typeof GoogleAdsRevenuePanel>[0]> = {},
  ) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <GoogleAdsRevenuePanel
          role="admin"
          dateFrom="2026-05-14"
          dateTo="2026-08-11"
          currency="USD"
          shopifyTotal="10000.00"
          {...props}
        />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    queryState.revenuePanelFn = () => Promise.resolve(emptySummary());
  });

  it("renders nothing for members", () => {
    const { container } = renderPanel({ role: "member" });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for anonymous (null) role", () => {
    const { container } = renderPanel({ role: null });
    expect(container.firstChild).toBeNull();
  });

  it("shows the awaiting-access copy when there is no pilot connection", async () => {
    renderPanel();
    expect(
      await screen.findAllByText(/awaiting Google API access/),
    ).not.toHaveLength(0);
    expect(screen.getByTestId("google-bucket-revenue")).toHaveTextContent(
      "$0.00",
    );
    expect(screen.getByTestId("google-spend")).toHaveTextContent("—");
    expect(screen.getByTestId("google-says")).toHaveTextContent("—");
    expect(screen.getByTestId("google-roas-claims")).toHaveTextContent("—");
    expect(screen.getByTestId("google-roas-confirm")).toHaveTextContent("—");
  });

  it("shows the error line and refetches on Retry", async () => {
    const revenuePanelFn = vi.fn(() => Promise.reject(new Error("boom")));
    queryState.revenuePanelFn = revenuePanelFn;
    const user = userEvent.setup();
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.getByText(/Couldn’t load Google Ads revenue\./),
    ).toBeInTheDocument();
    expect(revenuePanelFn).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(revenuePanelFn).toHaveBeenCalledTimes(2));
  });

  it("shows Google's own figures, ROAS pair, and the delta when a connection exists", async () => {
    queryState.revenuePanelFn = () =>
      Promise.resolve(
        emptySummary({
          connection: {
            status: "ready",
            lastFactsSyncedAt: new Date("2026-08-10T00:00:00Z"),
            backfillCompletedAt: new Date("2026-08-01T00:00:00Z"),
          },
          googleCurrencyCode: "USD",
          ourSide: {
            bucketRevenueCents: 150_000,
            bucketOrders: 40,
            feedRevenueCents: 50_000,
            feedOrders: 15,
            paidRevenueCents: 100_000,
            paidOrders: 25,
            paidByCampaign: [
              { utmCampaign: "Summer Sale", revenueCents: 100_000, orders: 25 },
            ],
          },
          googleSays: {
            spendCents: 50_000,
            conversions: 30,
            conversionsValueCents: 120_000,
            byCampaign: [
              {
                campaignId: "1",
                campaignName: "Summer Sale",
                spendCents: 50_000,
                conversions: 30,
                conversionsValueCents: 120_000,
                matchedUtmCampaign: "Summer Sale",
              },
            ],
          },
        }),
      );
    renderPanel();
    expect(await screen.findByTestId("google-bucket-revenue")).toHaveTextContent(
      "$1,500",
    );
    expect(screen.getByTestId("google-spend")).toHaveTextContent("$500.00");
    expect(screen.getByTestId("google-says")).toHaveTextContent("$1,200");
    // (120000 - 100000) / 100 = $200.00 unconfirmed
    expect(screen.getByTestId("google-says-delta")).toHaveTextContent(
      "$200.00 unconfirmed",
    );
    // Google claims 120000/50000 = 2.40, we confirm 100000/50000 = 2.00
    expect(screen.getByTestId("google-roas-claims")).toHaveTextContent("2.40");
    expect(screen.getByTestId("google-roas-confirm")).toHaveTextContent("2.00");
    expect(screen.getAllByText(/Google says/).length).toBeGreaterThan(0);
    expect(screen.getByText("Summer Sale")).toBeInTheDocument();
  });

  it("guards ROAS and the delta when Google's currency differs from the store's", async () => {
    // Store currency is USD (renderPanel default) but Google reports in PHP:
    // cents-level arithmetic across currencies is meaningless, so ROAS and
    // the "+X unconfirmed" delta must both fall back to "—"/hidden, and the
    // insight strip's cross-currency delta message must not render either.
    // paidRevenueCents > 0 so only the currency mismatch — not a zero paid
    // total — is what suppresses the delta insight.
    queryState.revenuePanelFn = () =>
      Promise.resolve(
        emptySummary({
          connection: {
            status: "ready",
            lastFactsSyncedAt: new Date("2026-08-10T00:00:00Z"),
            backfillCompletedAt: new Date("2026-08-01T00:00:00Z"),
          },
          googleCurrencyCode: "PHP",
          ourSide: {
            bucketRevenueCents: 150_000,
            bucketOrders: 40,
            feedRevenueCents: 50_000,
            feedOrders: 15,
            paidRevenueCents: 100_000,
            paidOrders: 25,
            paidByCampaign: [
              { utmCampaign: "Summer Sale", revenueCents: 100_000, orders: 25 },
            ],
          },
          googleSays: {
            spendCents: 50_000,
            conversions: 30,
            conversionsValueCents: 2_500_000,
            byCampaign: [
              {
                campaignId: "1",
                campaignName: "Summer Sale",
                spendCents: 50_000,
                conversions: 30,
                conversionsValueCents: 2_500_000,
                matchedUtmCampaign: "Summer Sale",
              },
            ],
          },
        }),
      );
    renderPanel();
    expect(await screen.findByTestId("google-says")).toHaveTextContent("PHP");
    expect(screen.getByTestId("google-roas-claims")).toHaveTextContent("—");
    expect(screen.getByTestId("google-roas-confirm")).toHaveTextContent("—");
    expect(
      screen.getByText(/mixed currencies — not comparable/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("google-says-delta")).toBeNull();
    expect(
      screen.queryByText(/our paid-tagged revenue confirms/),
    ).toBeNull();
  });

  it("shows the untagged-paid insight when Google reports conversions but paid is zero", async () => {
    queryState.revenuePanelFn = () =>
      Promise.resolve(
        emptySummary({
          connection: {
            status: "ready",
            lastFactsSyncedAt: new Date("2026-08-10T00:00:00Z"),
            backfillCompletedAt: new Date("2026-08-01T00:00:00Z"),
          },
          googleCurrencyCode: "USD",
          ourSide: {
            bucketRevenueCents: 72_010,
            bucketOrders: 9,
            feedRevenueCents: 72_010,
            feedOrders: 9,
            paidRevenueCents: 0,
            paidOrders: 0,
            paidByCampaign: [],
          },
          googleSays: {
            spendCents: 124_000,
            conversions: 18,
            conversionsValueCents: 210_600,
            byCampaign: [
              {
                campaignId: "1",
                campaignName: "PMax",
                spendCents: 124_000,
                conversions: 18,
                conversionsValueCents: 210_600,
                matchedUtmCampaign: null,
              },
            ],
          },
        }),
      );
    renderPanel();
    expect(
      await screen.findByText(googleAdsRevenue.insight.untaggedPaid),
    ).toBeInTheDocument();
    // And the delta reading must not render alongside it.
    expect(
      screen.queryByText(/our paid-tagged revenue confirms/),
    ).toBeNull();
  });

  it("shows the conv value with ROAS dashed out when Google spend is zero", async () => {
    queryState.revenuePanelFn = () =>
      Promise.resolve(
        emptySummary({
          connection: {
            status: "ready",
            lastFactsSyncedAt: new Date("2026-08-10T00:00:00Z"),
            backfillCompletedAt: new Date("2026-08-01T00:00:00Z"),
          },
          googleCurrencyCode: "USD",
          googleSays: {
            spendCents: 0,
            conversions: 5,
            conversionsValueCents: 30_000,
            byCampaign: [
              {
                campaignId: "1",
                campaignName: "Brand",
                spendCents: 0,
                conversions: 5,
                conversionsValueCents: 30_000,
                matchedUtmCampaign: null,
              },
            ],
          },
        }),
      );
    renderPanel();
    expect(await screen.findByTestId("google-says")).toHaveTextContent(
      "$300.00",
    );
    expect(screen.getByTestId("google-roas-claims")).toHaveTextContent("—");
    expect(screen.getByTestId("google-roas-confirm")).toHaveTextContent("—");
    expect(screen.getByTestId("google-spend")).toHaveTextContent("$0.00");
  });
});
