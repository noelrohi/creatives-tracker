import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifySummary } from "./shopify-summary";

const queryState = vi.hoisted(() => ({
  refundsFn: (): Promise<unknown> => Promise.resolve(null),
  dailyFn: (): Promise<unknown> => Promise.resolve(null),
  hourlyFn: vi.fn((): Promise<unknown> => Promise.resolve(null)),
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    attribution: {
      refundsTotal: {
        queryOptions: (input: unknown) => ({
          queryKey: ["refundsTotal", input],
          queryFn: queryState.refundsFn,
          retry: false,
        }),
      },
      dailySeries: {
        queryOptions: (input: unknown) => ({
          queryKey: ["dailySeries", input],
          queryFn: queryState.dailyFn,
          retry: false,
        }),
      },
      hourlySeries: {
        queryOptions: (input: unknown) => ({
          queryKey: ["hourlySeries", input],
          queryFn: queryState.hourlyFn,
          retry: false,
        }),
      },
    },
  }),
}));

function refunds() {
  return {
    range: { dateFrom: "2026-08-20", dateTo: "2026-08-26" },
    total: "45.50",
    count: 2,
  };
}

function daily() {
  return {
    range: { dateFrom: "2026-08-20", dateTo: "2026-08-26" },
    days: [
      { day: "2026-08-20", buckets: {}, pendingNet: "0.00", totalNet: "100.00" },
      { day: "2026-08-21", buckets: {}, pendingNet: "0.00", totalNet: "250.00" },
    ],
  };
}

function hourly() {
  return {
    day: "2026-08-26",
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      net: hour === 9 ? "80.00" : "0.00",
      orders: hour === 9 ? 2 : 0,
    })),
  };
}

function summary(overrides: {
  dateFrom?: string;
  dateTo?: string;
  total?: string | null;
  orderCount?: number;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ShopifySummary
        dateFrom={overrides.dateFrom ?? "2026-08-20"}
        dateTo={overrides.dateTo ?? "2026-08-26"}
        currency="USD"
        total={overrides.total === undefined ? "350.00" : overrides.total}
        orderCount={overrides.orderCount ?? 5}
        loading={false}
      />
    </QueryClientProvider>,
  );
}

describe("ShopifySummary", () => {
  beforeEach(() => {
    queryState.refundsFn = () => Promise.resolve(refunds());
    queryState.dailyFn = () => Promise.resolve(daily());
    queryState.hourlyFn = vi.fn(() => Promise.resolve(hourly()));
  });

  it("shows the four cards with derived average order", async () => {
    summary();
    expect(screen.getByText("Total sales")).toBeInTheDocument();
    expect(screen.getByText("$350.00")).toBeInTheDocument();
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    // 350.00 / 5
    expect(screen.getByText("$70.00")).toBeInTheDocument();
    expect(await screen.findByText("$45.50")).toBeInTheDocument();
    expect(screen.getByText("2 refunds")).toBeInTheDocument();
  });

  it("wears the no-data chip instead of a fake $0 average when there are no orders", () => {
    summary({ total: "0.00", orderCount: 0 });
    const averageCard = screen.getByText("Average order").parentElement!;
    expect(averageCard).toHaveTextContent("no data yet");
    expect(averageCard).not.toHaveTextContent("$");
  });

  it("multi-day range charts the daily series and never asks for hours", async () => {
    summary();
    expect(await screen.findByTestId("shopify-sales-chart")).toBeInTheDocument();
    expect(queryState.hourlyFn).not.toHaveBeenCalled();
  });

  it("single-day range charts by hour", async () => {
    summary({ dateFrom: "2026-08-26", dateTo: "2026-08-26" });
    expect(await screen.findByTestId("shopify-sales-chart")).toBeInTheDocument();
    expect(queryState.hourlyFn).toHaveBeenCalled();
  });

  it("a chart error keeps the cards and offers a retry", async () => {
    queryState.dailyFn = () => Promise.reject(new Error("nope"));
    summary();
    expect(
      await screen.findByText("The sales summary didn't load."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText("$350.00")).toBeInTheDocument();
  });
});
