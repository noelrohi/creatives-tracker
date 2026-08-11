import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailRevenueHeadline } from "./email-revenue-panel";
import { EmailRevenueGaps } from "./email-revenue-gaps";
import { EmailRevenueTables } from "./email-revenue-tables";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";

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
    gaps: {
      noEmailLink: { orders: 480, revenue: "8300.00" },
      notEvaluated: { orders: 22, revenue: "410.00" },
      noKlaviyoEvent: { orders: 14, revenue: "290.00" },
      duplicateFlagged: { orders: 2, revenue: "18.00" },
      unmatchedEvents: 141,
    },
    ...overrides,
  };
}

describe("EmailRevenueHeadline", () => {
  it("shows the KPI trio with share percent and the unconfirmed delta", () => {
    render(
      <EmailRevenueHeadline
        summary={summary()}
        shopifyTotal="10000.00"
        currency="USD"
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
    expect(screen.getByTestId("klaviyo-says-delta")).toHaveTextContent(
      "unconfirmed",
    );
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
});
