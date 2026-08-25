import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailRevenueListHealth } from "./email-revenue-list-health";
import { ListHealthTable } from "./list-health-table";
import type { ListHealthSummary } from "@/lib/klaviyo/list-health";

function summary(overrides: Partial<ListHealthSummary> = {}): ListHealthSummary {
  return {
    discovered: true,
    totals: { subscribed: 142, unsubscribed: 38, wonBack: 12, quickChurn: 5, net: 104 },
    daily: [
      { day: "2026-08-22", subscribed: 19, unsubscribed: 4, wonBack: 2, quickChurn: 1, net: 15 },
      { day: "2026-08-21", subscribed: 11, unsubscribed: 7, wonBack: 0, quickChurn: 0, net: 4 },
    ],
    ...overrides,
  };
}

describe("EmailRevenueListHealth", () => {
  it("renders the strip with all five figures and the Lab deep link", () => {
    render(
      <EmailRevenueListHealth summary={summary()} dateFrom="2026-08-01" dateTo="2026-08-24" />,
    );
    const strip = screen.getByTestId("list-health-strip");
    expect(strip).toHaveTextContent("+142 subscribed");
    expect(strip).toHaveTextContent("-38 unsubscribed");
    expect(strip).toHaveTextContent("12 won back");
    expect(strip).toHaveTextContent("5 quick churn");
    expect(strip).toHaveTextContent("net +104");
    const href = screen.getByTestId("list-health-strip-href").getAttribute("href");
    expect(href).toContain("/attribution/klaviyo?");
    expect(href).toContain("view=list-health");
    expect(href).toContain("from=2026-08-01");
  });

  it("renders nothing when totals are all zero or undiscovered", () => {
    const zero = { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 };
    const { container: zeroContainer } = render(
      <EmailRevenueListHealth
        summary={summary({ totals: zero })}
        dateFrom="2026-08-01"
        dateTo="2026-08-24"
      />,
    );
    expect(zeroContainer).toBeEmptyDOMElement();
    const { container: undiscoveredContainer } = render(
      <EmailRevenueListHealth
        summary={summary({ discovered: false })}
        dateFrom="2026-08-01"
        dateTo="2026-08-24"
      />,
    );
    expect(undiscoveredContainer).toBeEmptyDOMElement();
  });

  it("never renders a bare minus for a zero unsubscribed figure", () => {
    render(
      <EmailRevenueListHealth
        summary={summary({
          totals: { subscribed: 142, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 142 },
        })}
        dateFrom="2026-08-01"
        dateTo="2026-08-24"
      />,
    );
    const strip = screen.getByTestId("list-health-strip");
    expect(strip).toHaveTextContent("0 unsubscribed");
    expect(strip).not.toHaveTextContent("-0 unsubscribed");
    expect(strip).not.toHaveTextContent("−0 unsubscribed");
  });
});

describe("ListHealthTable", () => {
  it("renders KPIs, daily rows, and the aggregate note", () => {
    render(<ListHealthTable summary={summary()} error={false} onRetry={() => {}} />);
    expect(screen.getByTestId("list-health-kpi-subscribed")).toHaveTextContent("142");
    expect(screen.getByTestId("list-health-kpi-net")).toHaveTextContent("+104");
    expect(screen.getByText("2026-08-22")).toBeInTheDocument();
    expect(screen.getByText(/Aggregate counts only/)).toBeInTheDocument();
  });

  it("shows the discovery hint when metrics are undiscovered", () => {
    render(
      <ListHealthTable summary={summary({ discovered: false })} error={false} onRetry={() => {}} />,
    );
    expect(screen.getByText(/Run discovery to enable list tracking/)).toBeInTheDocument();
  });

  it("tones the net KPI red (not emerald) when net is negative", () => {
    render(
      <ListHealthTable
        summary={summary({
          totals: { subscribed: 12, unsubscribed: 38, wonBack: 2, quickChurn: 5, net: -24 },
        })}
        error={false}
        onRetry={() => {}}
      />,
    );
    const net = screen.getByTestId("list-health-kpi-net");
    expect(net).toHaveTextContent("-24");
    expect(net.className).toContain("text-red-600");
    expect(net.className).not.toContain("text-emerald-600");
  });

  it("paints a zero-net day's bar neutral instead of emerald", () => {
    render(
      <ListHealthTable
        summary={summary({
          daily: [{ day: "2026-08-22", subscribed: 3, unsubscribed: 3, wonBack: 0, quickChurn: 0, net: 0 }],
        })}
        error={false}
        onRetry={() => {}}
      />,
    );
    const bar = screen.getByTestId("list-health-bar-2026-08-22");
    expect(bar.className).toContain("bg-muted");
    expect(bar.className).not.toContain("bg-emerald-600/70");
  });
});
