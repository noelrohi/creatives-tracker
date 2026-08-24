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
  it.each([
    ["meta", "meta-panel"],
    ["google", "google-panel"],
    ["klaviyo", "klaviyo-panel"],
  ] as const)("%s: renders its panel above the orders table", (bucket, panel) => {
    drawer(bucket);
    expect(screen.getByTestId(panel)).toBeInTheDocument();
    expect(screen.getByTestId("orders-panel")).toBeInTheDocument();
  });

  it("buckets without a panel render only the orders table", () => {
    drawer("tiktok");
    expect(screen.getByTestId("orders-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("meta-panel")).toBeNull();
  });

  it("carries no dashboard/lab links — those live on the ledger row", () => {
    drawer("meta", "owner");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
