import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { SourceDrawer } from "./source-drawer";

vi.mock("./bucket-orders-panel", () => ({
  BucketOrdersPanel: () => <div data-testid="orders-panel" />,
}));
vi.mock("./meta/revenue-panel", () => ({
  MetaRevenuePanel: () => <div data-testid="meta-panel" />,
}));
vi.mock("./google-ads/revenue-panel", () => ({
  GoogleAdsRevenuePanel: () => <div data-testid="google-panel" />,
}));
vi.mock("./klaviyo/email-revenue-panel", () => ({
  EmailRevenuePanel: () => <div data-testid="klaviyo-panel" />,
}));

function drawer(bucket: AttributionBucket, role: string | null = "owner") {
  return render(
    <SourceDrawer
      bucket={bucket}
      dateFrom="2026-08-01"
      dateTo="2026-08-07"
      currency="USD"
      timeZone="UTC"
      role={role}
      shopDomain={null}
      shopifyTotal="2000.00"
      metaDown={false}
      detailHref="/mer"
      onClose={() => {}}
    />,
  );
}

describe("SourceDrawer", () => {
  it("meta: panel, orders, and a dashboard link for every role", () => {
    drawer("meta", "member");
    expect(screen.getByTestId("meta-panel")).toBeInTheDocument();
    expect(screen.getByTestId("orders-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Meta dashboard" }),
    ).toHaveAttribute("href", "/meta");
  });

  it("google: panel plus a privileged lab link", () => {
    drawer("google");
    expect(screen.getByTestId("google-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Google Ads Lab" }),
    ).toHaveAttribute("href", "/attribution/google-ads");
  });

  it("google: members see no lab link", () => {
    drawer("google", "member");
    expect(screen.queryByRole("link", { name: "Google Ads Lab" })).toBeNull();
  });

  it("klaviyo: panel plus a privileged lab link", () => {
    drawer("klaviyo");
    expect(screen.getByTestId("klaviyo-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Klaviyo Lab" }),
    ).toHaveAttribute("href", "/attribution/klaviyo");
  });

  it("klaviyo: members see no lab link", () => {
    drawer("klaviyo", "member");
    expect(screen.queryByRole("link", { name: "Klaviyo Lab" })).toBeNull();
  });

  it("buckets without a panel render only the orders table", () => {
    drawer("tiktok");
    expect(screen.getByTestId("orders-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("meta-panel")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
