import { describe, expect, it } from "vitest";
import {
  assertExactReportRequest,
  normalizeReportRows,
  publicationScopeFingerprint,
  refreshFingerprint,
  refreshSetFingerprint,
  type KlaviyoReportRequest,
} from "@/lib/klaviyo/reports";

function reportRequest(
  overrides: Partial<KlaviyoReportRequest> = {},
): KlaviyoReportRequest {
  return {
    connectionId: "connection-a",
    kind: "campaign",
    conversionMetricRowId: "metric-row-1",
    conversionExternalMetricId: "metric-ext-1",
    timeframe: {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    statistics: ["conversions", "conversion_value"],
    grouping: ["campaign_id", "send_date"],
    apiRevision: "2026-07-15",
    asOf: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("report request validation and fingerprints", () => {
  it("accepts campaign and flow kinds with closed statistics and groupings", () => {
    expect(() => assertExactReportRequest(reportRequest())).not.toThrow();
    expect(() =>
      assertExactReportRequest(
        reportRequest({ kind: "flow", grouping: ["flow_id", "send_date"] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertExactReportRequest(
        reportRequest({ statistics: ["clicks_total" as "conversions"] }),
      ),
    ).toThrow("report request is invalid");
    expect(() =>
      assertExactReportRequest(
        reportRequest({ grouping: ["browser_string" as "send_date"] }),
      ),
    ).toThrow("report request is invalid");
    expect(() =>
      assertExactReportRequest(
        reportRequest({
          timeframe: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-07-01T00:00:00.000Z",
          },
        }),
      ),
    ).toThrow("report request is invalid");
  });

  it("keeps asOf out of the publication scope but inside the refresh fingerprint", () => {
    const first = reportRequest();
    const later = reportRequest({ asOf: "2026-08-06T00:00:00.000Z" });
    expect(publicationScopeFingerprint(first, "America/New_York")).toBe(
      publicationScopeFingerprint(later, "America/New_York"),
    );
    expect(refreshFingerprint(first, "America/New_York")).not.toBe(
      refreshFingerprint(later, "America/New_York"),
    );
    expect(publicationScopeFingerprint(first, "UTC")).not.toBe(
      publicationScopeFingerprint(first, "America/New_York"),
    );
  });

  it("fingerprints the provider metric ID, never the internal row ID", () => {
    const swappedInternal = reportRequest({
      conversionMetricRowId: "metric-row-other",
    });
    expect(publicationScopeFingerprint(reportRequest(), "UTC")).toBe(
      publicationScopeFingerprint(swappedInternal, "UTC"),
    );
    const swappedExternal = reportRequest({
      conversionExternalMetricId: "metric-ext-other",
    });
    expect(publicationScopeFingerprint(reportRequest(), "UTC")).not.toBe(
      publicationScopeFingerprint(swappedExternal, "UTC"),
    );
  });

  it("orders the refresh-set fingerprint deterministically", () => {
    expect(refreshSetFingerprint(["b", "a"])).toBe(
      refreshSetFingerprint(["a", "b"]),
    );
  });
});

describe("normalizeReportRows", () => {
  it("keeps typed statistics, drops unknowns, and rejects malformed numerics", () => {
    const { facts, warnings } = normalizeReportRows({
      kind: "campaign",
      requestFingerprint: "req-1",
      rows: [
        {
          groupings: { campaign_id: "campaign-1", send_date: "2026-07-15" },
          statistics: {
            conversions: 4,
            conversion_value: "120.50",
            recipients: "not-a-number",
            clicks_unique_extra: 7,
            weird: { nested: true },
          },
        },
      ],
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].statistics.conversions).toBe("4");
    expect(facts[0].statistics.conversionValue).toBe("120.50");
    expect(facts[0].statistics.recipients).toBeNull();
    expect(facts[0].additionalStatistics).toEqual({ clicks_unique_extra: "7" });
    expect(facts[0].campaignExternalId).toBe("campaign-1");
    expect(facts[0].grouping.send_date).toBe("2026-07-15");
    expect(warnings).toContain("report_statistic_malformed");
    expect(warnings).toContain("report_statistic_dropped");
  });

  it("gives identical rows identical fact fingerprints and distinct rows distinct ones", () => {
    const row = {
      groupings: { flow_id: "flow-1", send_date: "2026-07-15" },
      statistics: { conversions: 1 },
    };
    const build = () =>
      normalizeReportRows({
        kind: "flow" as const,
        requestFingerprint: "req-2",
        rows: [row],
      }).facts[0].factFingerprint;
    expect(build()).toBe(build());
    const other = normalizeReportRows({
      kind: "flow",
      requestFingerprint: "req-2",
      rows: [{ ...row, statistics: { conversions: 2 } }],
    }).facts[0].factFingerprint;
    expect(other).not.toBe(build());
  });

  it("never resolves a Shopify order or event from report rows", () => {
    const { facts } = normalizeReportRows({
      kind: "campaign",
      requestFingerprint: "req-3",
      rows: [
        {
          groupings: { campaign_id: "campaign-1" },
          statistics: { conversions: 1 },
          order_id: "gid://shopify/Order/1001",
        },
      ],
    });
    expect(JSON.stringify(facts)).not.toContain("gid://shopify/Order");
  });
});
