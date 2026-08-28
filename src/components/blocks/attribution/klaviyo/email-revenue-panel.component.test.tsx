import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailRevenueHeadline, EmailRevenuePanel } from "./email-revenue-panel";
import { EmailRevenueGaps } from "./email-revenue-gaps";
import { EmailRevenueTables } from "./email-revenue-tables";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";

const queryState = vi.hoisted(() => ({
  attributionFn: (): Promise<unknown> => Promise.resolve(null),
  healthFn: (): Promise<unknown> => Promise.resolve(null),
  listHealthFn: (): Promise<unknown> => Promise.resolve(null),
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    klaviyo: {
      emailAttribution: {
        queryOptions: (input: unknown) => ({
          queryKey: ["ea", input],
          queryFn: queryState.attributionFn,
          retry: false,
        }),
      },
      health: {
        queryOptions: () => ({
          queryKey: ["health"],
          queryFn: queryState.healthFn,
          retry: false,
        }),
      },
      listHealth: {
        queryOptions: (input: unknown) => ({
          queryKey: ["list-health", input],
          queryFn: queryState.listHealthFn,
          retry: false,
        }),
      },
    },
  }),
}));

function summary(
  overrides: Partial<EmailAttributionSummary> = {},
): EmailAttributionSummary {
  return {
    email: {
      revenue: "1000.00",
      orderCount: 62,
      campaignsRevenue: "620.00",
      flowsRevenue: "380.00",
    },
    klaviyoSays: {
      conversionValue: "1450.00",
      requestedFrom: new Date("2026-06-01T00:00:00Z"),
      requestedTo: new Date("2026-08-01T00:00:00Z"),
      asOf: new Date("2026-08-01T00:00:00Z"),
    },
    sources: [
      {
        objectId: "campaign-1",
        objectType: "campaign",
        name: "Summer Sale",
        orderCount: 21,
        revenue: "340.00",
        klaviyoConversionValue: "505.00",
        klaviyoWindow: {
          requestedFrom: new Date("2026-06-01T00:00:00Z"),
          requestedTo: new Date("2026-08-01T00:00:00Z"),
          asOf: new Date("2026-08-01T00:00:00Z"),
        },
      },
      {
        objectId: "flow-1",
        objectType: "flow",
        name: "Welcome",
        orderCount: 17,
        revenue: "280.00",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
    ],
    products: [
      {
        productKey: "77",
        title: "Collagen Peptides 500g",
        units: 31,
        orderCount: 28,
        orderRevenue: "430.00",
      },
    ],
    claimCoverage: { covered: 542, total: 579 },
    gaps: {
      noEmailLink: { orders: 480, revenue: "8300.00" },
      claimsPending: { orders: 37, revenue: "640.00" },
      notEvaluated: { orders: 22, revenue: "410.00" },
      noKlaviyoEvent: { orders: 14, revenue: "290.00" },
      duplicateFlagged: { orders: 2, revenue: "18.00" },
      unmatchedEvents: 141,
    },
    ...overrides,
  };
}

describe("EmailRevenueHeadline", () => {
  // The fixture's report window is Jun 1 – Aug 1; this page range covers it.
  const coveringRange = { dateFrom: "2026-06-01", dateTo: "2026-08-01" };

  it("shows the KPI trio with share percent and the unconfirmed delta", () => {
    render(
      <EmailRevenueHeadline
        summary={summary()}
        shopifyTotal="10000.00"
        currency="USD"
        {...coveringRange}
      />,
    );
    expect(screen.getByTestId("email-linked-revenue")).toHaveTextContent(
      "$1,000.00",
    );
    expect(screen.getByTestId("email-linked-label")).toHaveTextContent("10%");
    expect(screen.getByTestId("email-linked-label")).toHaveTextContent(
      "62 orders",
    );
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$1,450.00");
    expect(screen.getByTestId("klaviyo-says-window")).toHaveTextContent(
      "report",
    );
    expect(screen.getByTestId("klaviyo-says-delta")).toHaveTextContent(
      "unconfirmed",
    );
  });

  it("captions the email KPI while claim coverage is partial", () => {
    // The figure is still filling in; saying so beats letting the owner
    // read a partial number as a finished one.
    render(
      <EmailRevenueHeadline
        summary={summary({ claimCoverage: { covered: 124, total: 1184 } })}
        shopifyTotal="10000.00"
        currency="USD"
        dateFrom="2026-06-01"
        dateTo="2026-08-01"
      />,
    );
    expect(screen.getByTestId("email-coverage")).toHaveTextContent(
      "124/1,184 checked",
    );
  });

  it("drops the caption once coverage is complete", () => {
    render(
      <EmailRevenueHeadline
        summary={summary({ claimCoverage: { covered: 1184, total: 1184 } })}
        shopifyTotal="10000.00"
        currency="USD"
        dateFrom="2026-06-01"
        dateTo="2026-08-01"
      />,
    );
    expect(screen.queryByTestId("email-coverage")).toBeNull();
  });

  it("survives report timestamps arriving as ISO strings off the wire", () => {
    // Over tRPC the Date-typed report window fields deserialize as ISO
    // strings in the real app (lab-header defends the same way); Date
    // fixtures alone masked a runtime `.getTime is not a function` crash.
    render(
      <EmailRevenueHeadline
        summary={summary({
          klaviyoSays: {
            conversionValue: "1450.00",
            requestedFrom: "2026-06-01T00:00:00.000Z" as unknown as Date,
            requestedTo: "2026-08-01T00:00:00.000Z" as unknown as Date,
            asOf: "2026-08-01T00:00:00.000Z" as unknown as Date,
          },
        })}
        shopifyTotal="10000.00"
        currency="USD"
        {...coveringRange}
      />,
    );
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$1,450.00");
    expect(screen.getByTestId("klaviyo-says-window")).toHaveTextContent(
      "report",
    );
    expect(screen.getByTestId("klaviyo-says-delta")).toBeInTheDocument();
  });

  it("omits the delta when the page range is shorter than the report window", () => {
    // Klaviyo's figure spans their ~2-month report; comparing it against a
    // single day would manufacture a phantom "unconfirmed" gap.
    render(
      <EmailRevenueHeadline
        summary={summary()}
        shopifyTotal="10000.00"
        currency="USD"
        dateFrom="2026-08-11"
        dateTo="2026-08-11"
      />,
    );
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$1,450.00");
    expect(screen.getByTestId("klaviyo-says-window")).toBeInTheDocument();
    expect(screen.queryByTestId("klaviyo-says-delta")).toBeNull();
  });

  it("omits the delta when Klaviyo says no more than we confirmed", () => {
    render(
      <EmailRevenueHeadline
        summary={summary({
          klaviyoSays: {
            conversionValue: "900.00",
            requestedFrom: new Date("2026-06-01T00:00:00Z"),
            requestedTo: new Date("2026-08-01T00:00:00Z"),
            asOf: new Date("2026-08-01T00:00:00Z"),
          },
        })}
        shopifyTotal="10000.00"
        currency="USD"
        {...coveringRange}
      />,
    );
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$900.00");
    expect(screen.queryByTestId("klaviyo-says-delta")).toBeNull();
  });

  it("omits the Klaviyo-says figure when no report exists", () => {
    render(
      <EmailRevenueHeadline
        summary={summary({ klaviyoSays: null })}
        shopifyTotal="10000.00"
        currency="USD"
        {...coveringRange}
      />,
    );
    expect(screen.queryByTestId("klaviyo-says-delta")).toBeNull();
  });
});

describe("EmailRevenueTables", () => {
  it("renders sources with their kind and Klaviyo comparison, dash for flows", () => {
    render(<EmailRevenueTables summary={summary()} currency="USD" />);
    expect(screen.getByText("Summer Sale")).toBeInTheDocument();
    expect(screen.getByTestId("source-campaign-1-says")).toHaveTextContent(
      "$505.00",
    );
    expect(screen.getByTestId("source-flow-1-says")).toHaveTextContent("—");
    expect(screen.getByText("Collagen Peptides 500g")).toBeInTheDocument();
  });

  it("shows the amber says-delta on campaigns and none on flows", () => {
    render(<EmailRevenueTables summary={summary()} currency="USD" />);
    // (50500 − 34000) / 34000 = 48.53% → rounds to 49
    expect(screen.getByTestId("source-campaign-1-delta")).toHaveTextContent(
      "+49%",
    );
    expect(screen.queryByTestId("source-flow-1-delta")).toBeNull();
  });

  it("suppresses the delta when Klaviyo says no more than we confirm", () => {
    render(
      <EmailRevenueTables
        summary={summary({
          sources: [
            {
              objectId: "campaign-1",
              objectType: "campaign",
              name: "Summer Sale",
              orderCount: 21,
              revenue: "340.00",
              klaviyoConversionValue: "340.00",
              klaviyoWindow: {
                requestedFrom: new Date("2026-06-01T00:00:00Z"),
                requestedTo: new Date("2026-08-01T00:00:00Z"),
                asOf: new Date("2026-08-01T00:00:00Z"),
              },
            },
          ],
        })}
        currency="USD"
      />,
    );
    expect(screen.getByTestId("source-campaign-1-says")).toHaveTextContent(
      "$340.00",
    );
    expect(screen.queryByTestId("source-campaign-1-delta")).toBeNull();
  });

  it("shows ten products with a one-way expander for the rest", async () => {
    const user = userEvent.setup();
    const products = Array.from({ length: 12 }, (_, index) => ({
      productKey: `p-${index + 1}`,
      title: `Product ${index + 1}`,
      units: 5,
      orderCount: 4,
      orderRevenue: "50.00",
    }));
    render(<EmailRevenueTables summary={summary({ products })} currency="USD" />);
    expect(screen.getByText("Product 10")).toBeInTheDocument();
    expect(screen.queryByText("Product 11")).toBeNull();
    const more = screen.getByRole("button", { name: /…2 more/ });
    await user.click(more);
    expect(screen.getByText("Product 11")).toBeInTheDocument();
    expect(screen.getByText("Product 12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("renders no expander when ten or fewer products exist", () => {
    render(<EmailRevenueTables summary={summary()} currency="USD" />);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });
});

describe("EmailRevenueGaps", () => {
  it("accounts for every remaining bucket and deep-links into the Lab", () => {
    render(
      <EmailRevenueGaps
        summary={summary()}
        currency="USD"
        dateFrom="2026-05-14"
        dateTo="2026-08-11"
      />,
    );
    expect(screen.getByTestId("gap-no-email-link")).toHaveTextContent("480");
    expect(screen.getByTestId("gap-no-email-link")).toHaveTextContent(
      "$8,300.00",
    );
    const link = screen.getByTestId("gap-no-email-link-href");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/attribution/klaviyo?"),
    );
    expect(link.getAttribute("href")).toContain("orderStatus=confirmed");
    expect(link.getAttribute("href")).toContain("claimType=none");
    expect(link.getAttribute("href")).toContain("from=2026-05-14");
    expect(
      screen.getByTestId("gap-unmatched-href").getAttribute("href"),
    ).toContain("view=unmatched");
  });

  it("reports pending-claim orders separately from no-link orders", () => {
    // "Not asked yet" is not a finding about the email program; showing it
    // inside the no-link bucket read as one.
    render(
      <EmailRevenueGaps
        summary={summary()}
        currency="USD"
        dateFrom="2026-08-01"
        dateTo="2026-08-24"
      />,
    );
    const pending = screen.getByTestId("gap-claims-pending");
    expect(pending).toBeInTheDocument();
    expect(pending).toHaveTextContent("37 orders not checked for email links yet");
    expect(pending).toHaveTextContent("$640.00");
    expect(screen.getByTestId("gap-no-email-link")).toHaveTextContent("480");
  });
});

describe("EmailRevenuePanel", () => {
  function renderPanel(
    props: Partial<Parameters<typeof EmailRevenuePanel>[0]> = {},
  ) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <EmailRevenuePanel
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
    queryState.attributionFn = () => Promise.resolve(summary());
    queryState.healthFn = () =>
      Promise.resolve({
        connection: {
          status: "ready",
          lastMatchPublishedAt: "2026-08-11T00:00:00Z",
        },
      });
  });

  it("renders nothing for members", () => {
    const { container } = renderPanel({ role: "member" });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the pilot connection is missing (NOT_FOUND)", async () => {
    queryState.attributionFn = () =>
      Promise.reject(
        Object.assign(new Error("nf"), { data: { code: "NOT_FOUND" } }),
      );
    const { container } = renderPanel();
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("shows the error line and refetches on Retry", async () => {
    const attributionFn = vi.fn(() => Promise.reject(new Error("boom")));
    queryState.attributionFn = attributionFn;
    const user = userEvent.setup();
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/Couldn’t load email revenue\./)).toBeInTheDocument();
    expect(attributionFn).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(attributionFn).toHaveBeenCalledTimes(2));
  });

  it("shows the not-ready chip instead of the headline before matches publish", async () => {
    queryState.healthFn = () =>
      Promise.resolve({
        connection: { status: "pending", lastMatchPublishedAt: null },
      });
    renderPanel();
    await screen.findByText("No data yet");
    expect(screen.queryByTestId("email-linked-revenue")).toBeNull();
  });

  it("renders the headline when the connection is ready", async () => {
    renderPanel();
    expect(await screen.findByTestId("email-linked-revenue")).toHaveTextContent(
      "$1,000.00",
    );
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$1,450.00");
    expect(screen.getByText(/matches published/)).toBeInTheDocument();
  });
});
