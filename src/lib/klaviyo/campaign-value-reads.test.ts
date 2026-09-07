import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { campaignValuesInputSchema, campaignValuesOutputSchema, readCampaignValues } from "./campaign-value-reads";
import { KlaviyoReadError } from "./read-transport";

const now = new Date("2026-09-07T12:00:00Z");
const scope = { organizationId: "org1", connectionId: "connection1", accountTimezone: "UTC" };
const input = { conversionMetricId: "RESQ6t", since: "2026-08-01T00:00:00Z", until: "2026-09-01T00:00:00Z" };
// Local copy of ecomconn packages/connectors/src/klaviyo/fixtures/campaigns.ts.
// Envelope and grouping shape corroborated by the 2026-07-15 primary reference:
// https://developers.klaviyo.com/en/v2026-07-15/reference/query_campaign_values
// This synthetic fixture is not evidence of account-wide completeness.
const fixture = {
  data: {
    type: "campaign-values-report",
    attributes: { results: [{
      groupings: { campaign_id: "campaign-1", campaign_message_id: "message-1", send_channel: "email", group_name: "private audience" },
      statistics: {
        recipients: 1000, delivered: 980, delivery_rate: 0.98,
        opens_unique: 510, open_rate: 0.5204, clicks_unique: 120, click_rate: 0.1224,
        conversions: 34, conversion_rate: 0.0347, conversion_value: 4210.5,
        revenue_per_recipient: 4.2105, bounced: 20, bounce_rate: 0.02,
        unsubscribes: 3, unsubscribe_rate: 0.0031, spam_complaints: 1,
        spam_complaint_rate: 0.001, average_order_value: 123.838,
      },
    }] },
  },
  links: { self: "https://a.klaviyo.com/api/campaign-values-reports" },
};
const expectedStats = {
  recipients: 1000, delivered: 980, deliveryRate: 0.98,
  opensUnique: 510, openRate: 0.5204, clicksUnique: 120, clickRate: 0.1224,
  conversions: 34, conversionRate: 0.0347, conversionValue: 4210.5,
  revenuePerRecipient: 4.2105, bounced: 20, bounceRate: 0.02,
  unsubscribes: 3, unsubscribeRate: 0.0031, spamComplaints: 1, spamComplaintRate: 0.001,
};
const expectedProviderStats = [
  "recipients", "delivered", "delivery_rate", "opens_unique", "open_rate",
  "clicks_unique", "click_rate", "conversions", "conversion_rate", "conversion_value",
  "revenue_per_recipient", "bounced", "bounce_rate", "unsubscribes", "unsubscribe_rate",
  "spam_complaints", "spam_complaint_rate",
];
function client(body: unknown = fixture) {
  return { request: vi.fn().mockResolvedValue(body) };
}
function withResults(results: unknown[]) {
  return { data: { type: "campaign-values-report", attributes: { results } } };
}

async function readWindow(since: string, until: string, accountTimezone = "UTC") {
  return readCampaignValues(client(), { ...scope, accountTimezone }, { ...input, since, until }, now);
}

describe("campaign values reader", () => {
  it("sends exactly the 17 statistics, explicit metric and three groupings in one request", async () => {
    const requester = client();
    const result = await readCampaignValues(requester, scope, input, now);
    expect(requester.request).toHaveBeenCalledExactlyOnceWith({
      resource: "campaignValues",
      body: { data: { type: "campaign-values-report", attributes: {
        statistics: expectedProviderStats,
        conversion_metric_id: "RESQ6t",
        group_by: ["campaign_id", "campaign_message_id", "send_channel"],
        timeframe: { start: input.since, end: "2026-08-31T23:59:59Z" },
      } } },
    });
    expect(result.rows).toEqual([{
      campaignId: "campaign-1", campaignMessageId: "message-1", sendChannel: "email",
      conversionMetricId: input.conversionMetricId,
      timeframeStart: input.since, timeframeEnd: "2026-08-31T23:59:59Z",
      ...expectedStats,
    }]);
    expect(result.requestedWindow).toEqual({ since: input.since, until: input.until });
    expect(result).toMatchObject({ nextContinuation: null, completeness: "unverified", accountTimezone: "UTC", effectiveWindowPrecision: "unverified" });
    expect(campaignValuesOutputSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private audience|average_order_value|links|statistics/);
  });

  it("preserves nulls, zero, negative monetary values and provider channel strings", async () => {
    const result = structuredClone(fixture.data.attributes.results[0]);
    Object.assign(result.statistics, { open_rate: null, recipients: 0, conversion_value: -2.5 });
    result.groupings.send_channel = "push-notification";
    const output = await readCampaignValues(client(withResults([result])), scope, input, now);
    expect(output.rows[0]).toMatchObject({ openRate: null, recipients: 0, conversionValue: -2.5, sendChannel: "push-notification" });
  });

  it.each([{}, { statistics: {} }, { statistics: undefined }, { statistics: null },
    { statistics: [] }, { statistics: "invalid" }, { statistics: 12 }, { statistics: false },
  ])("matches ecomconn's empty statistics fallback: %j", async (container) => {
    const output = await readCampaignValues(client(withResults([{
      groupings: fixture.data.attributes.results[0].groupings, ...container,
    }])), scope, input, now);
    for (const name of Object.keys(expectedStats)) {
      expect(output.rows[0][name as keyof typeof expectedStats]).toBeNull();
    }
    expect(output.warnings.join(" ")).toContain("absent");
  });

  it.each([{ results: [] }, { results: fixture.data.attributes.results }])("never infers completeness from missing cursor (%j)", async ({ results }) => {
    const output = await readCampaignValues(client(withResults(results)), scope, input, now);
    expect(output.completeness).toBe("unverified");
    expect(output.nextContinuation).toBeNull();
    expect(output.warnings.join(" ")).toContain("no next-cursor response field");
  });

  it("does not follow undocumented provider URLs or conceal an indicated next page", async () => {
    const requester = client({ ...fixture, links: { next: "https://untrusted.invalid/?secret=hidden" } });
    const output = await readCampaignValues(requester, scope, input, now);
    expect(output.completeness).toBe("more_available");
    expect(output.nextContinuation).toBeNull();
    expect(output.warnings.join(" ")).toContain("cannot be followed safely");
    expect(JSON.stringify(output)).not.toContain("hidden");
    expect(requester.request).toHaveBeenCalledTimes(1);
  });

  it("returns all 10000 rows with a cap warning, rejects 10001 without truncation", async () => {
    const row = fixture.data.attributes.results[0];
    const output = await readCampaignValues(client(withResults(Array(10_000).fill(row))), scope, input, now);
    expect(output.rows).toHaveLength(10_000);
    expect(output.completeness).toBe("unverified");
    expect(output.warnings.join(" ")).toContain("10000-row");
    await expect(readCampaignValues(client(withResults(Array(10_001).fill(row))), scope, input, now))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it.each([
    null, {}, { data: { type: "flow-values-report", attributes: { results: [] } } },
    { data: { type: "campaign-values-report", attributes: { results: null } } },
    withResults([null]), withResults([{}]),
    withResults([{ groupings: { campaign_id: "c", send_channel: "email" }, statistics: {} }]),
  ])("rejects malformed response %j", async (body) => {
    await expect(readCampaignValues(client(body), scope, input, now)).rejects.toMatchObject({ code: "invalid_response" });
  });

  // requiredNumber in ecomconn packages/core/src/delivery/connector.ts only
  // checks typeof number and Number.isFinite; optionalNumber preserves null.
  it.each([-1, 1.5, 1.01, -0.1, Number.MAX_SAFE_INTEGER + 1, 1e100, -Number.MAX_VALUE, Number.MAX_VALUE, Number.MIN_VALUE, null])(
    "preserves %j unchanged for all 17 measures, including conversion_rate",
    async (value) => {
      const row = structuredClone(fixture.data.attributes.results[0]);
      Object.assign(row.statistics, Object.fromEntries(expectedProviderStats.map((name) => [name, value])));
      const output = await readCampaignValues(client(withResults([row])), scope, input, now);
      for (const name of Object.keys(expectedStats)) {
        expect(output.rows[0][name as keyof typeof expectedStats]).toBe(value);
      }
    },
  );

  it.each([
    ["conversion_value", Infinity], ["conversion_value", -Infinity],
    ["conversion_value", NaN], ["opens_unique", "12"], ["conversion_rate", "1.5"],
    ["conversion_value", "1e100"], ["delivered", ""], ["delivered", {}],
    ["click_rate", false], ["recipients", []],
  ])("rejects invalid statistic %s = %j without coercion, matching requiredNumber", async (name, value) => {
    const row = structuredClone(fixture.data.attributes.results[0]);
    Object.assign(row.statistics, { [name]: value });
    await expect(readCampaignValues(client(withResults([row])), scope, input, now)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { conversionMetricId: "" }, { conversionMetricId: "ab-c" }, { conversionMetricId: " ab" },
    { since: "2026-08-01" }, { since: "2026-08-01T00:00:00" }, { since: "2026-02-30T00:00:00Z" },
    { until: input.since }, { since: input.until, until: input.since },
    { since: "2025-09-07T11:59:59Z" }, { until: "2026-09-07T12:00:01Z" },
    { since: "2025-01-01T00:00:00Z" }, { continuation: "not-supported" },
  ])("rejects invalid input before provider access: %j", async (patch) => {
    const requester = client();
    await expect(readCampaignValues(requester, scope, { ...input, ...patch }, now)).rejects.toMatchObject({ code: "invalid_input" });
    expect(requester.request).not.toHaveBeenCalled();
  });

  it("accepts exactly 365 days and until=now; schema enforces max span", async () => {
    const since = new Date(now.getTime() - 365 * 86400000).toISOString();
    await expect(readWindow(since, now.toISOString())).resolves.toMatchObject({ completeness: "unverified" });
    expect(campaignValuesInputSchema.safeParse({ ...input, since: "2025-01-01T00:00:00Z" }).success).toBe(false);
  });

  it.each(["invalid/zone", "", "+05:30"])("rejects invalid account timezone %j before access", async (accountTimezone) => {
    const requester = client();
    await expect(readCampaignValues(requester, { ...scope, accountTimezone }, input, now)).rejects.toMatchObject({ code: "invalid_input" });
    expect(requester.request).not.toHaveBeenCalled();
  });

  it("rejects an invalid injected clock", async () => {
    await expect(readCampaignValues(client(), scope, input, new Date(NaN))).rejects.toMatchObject({ code: "invalid_input" });
  });

  // Account-local offsets ignored and end rounding are documented here:
  // https://developers.klaviyo.com/en/reference/reporting_api_overview
  it.each([
    ["America/New_York", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", "2026-03-08T00:00:00Z", "2026-03-08T23:59:59Z"],
    ["America/New_York", "2025-11-02T04:00:00Z", "2025-11-03T05:00:00Z", "2025-11-02T00:00:00Z", "2025-11-02T23:59:59Z"],
    ["Asia/Kathmandu", "2026-08-01T18:15:00Z", "2026-08-02T18:15:00Z", "2026-08-02T00:00:00Z", "2026-08-02T23:59:59Z"],
    ["Australia/Adelaide", "2026-08-01T14:30:00Z", "2026-08-02T14:30:00Z", "2026-08-02T00:00:00Z", "2026-08-02T23:59:59Z"],
  ])("converts both boundaries independently in %s", async (zone, since, until, start, end) => {
    const result = await readWindow(since, until, zone);
    expect(result.providerWindow).toEqual({ start, end });
    expect(result.accountTimezone).toBe(zone);
    expect(result.providerTimeSemantics).toBe("account_local_offset_ignored");
    expect(result.effectiveWindowPrecision).toBe("unverified");
  });

  it("rejects a fold that reverses the provider wall-clock window", async () => {
    await expect(readWindow("2025-11-02T05:50:00Z", "2025-11-02T06:10:00Z", "America/New_York"))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("exposes effective end-of-hour rounding rather than claiming exact filtering", async () => {
    const result = await readWindow("2026-08-01T00:15:00Z", "2026-08-01T00:30:00Z");
    expect(result.providerWindow.end).toBe("2026-08-01T00:29:59Z");
    expect(result.providerRoundedEnd).toBe("2026-08-01T00:59:59Z");
    expect(result.warnings.join(" ")).toContain("exact instant filtering");
  });

  it.each([
    ["2026-08-01T00:00:00Z", "2026-08-01T01:00:00.500Z", "2026-08-01T01:00:00Z", "2026-08-01T01:59:59Z"],
    ["2026-08-01T00:00:00.100Z", "2026-08-01T00:00:00.200Z", "2026-08-01T00:00:00.100Z", "2026-08-01T00:59:59Z"],
  ])("handles subsecond boundary %s → %s without shifting into the previous hour", async (since, until, end, rounded) => {
    const result = await readWindow(since, until);
    expect(result.providerWindow.end).toBe(end);
    expect(result.providerRoundedEnd).toBe(rounded);
    expect(result.warnings.join(" ")).toContain("Subsecond boundaries");
  });

  it("interprets input offsets as instants before account-local conversion", async () => {
    const result = await readWindow("2026-08-01T05:45:00+05:45", "2026-08-02T05:45:00+05:45", "UTC");
    expect(result.providerWindow).toEqual({ start: "2026-08-01T00:00:00Z", end: "2026-08-01T23:59:59Z" });
  });

  it.each(["rate_limited", "credential_rejected", "unavailable"] as const)("preserves sanitized %s errors and retry guidance without retrying", async (code) => {
    const error = new KlaviyoReadError(code, 1234);
    const requester = { request: vi.fn().mockRejectedValue(error) };
    await expect(readCampaignValues(requester, scope, input, now)).rejects.toBe(error);
    expect(requester.request).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unexpected transport failures", async () => {
    const requester = { request: vi.fn().mockRejectedValue(new Error("secret provider body")) };
    await expect(readCampaignValues(requester, scope, input, now)).rejects.toMatchObject({ code: "unavailable" });
    await readCampaignValues(requester, scope, input, now).catch((error: Error) => {
      expect(error.message).not.toContain("secret");
    });
  });

  it("rejects unknown fields at every declared output object boundary", async () => {
    const output = await readCampaignValues(client(), scope, input, now);
    const extra = { unreviewed: "private data" };
    for (const candidate of [
      { ...output, ...extra },
      { ...output, rows: [{ ...output.rows[0], ...extra }] },
      { ...output, requestedWindow: { ...output.requestedWindow, ...extra } },
      { ...output, providerWindow: { ...output.providerWindow, ...extra } },
    ]) {
      expect(campaignValuesOutputSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("strips internal provider extras before producing strict reviewed output", async () => {
    const raw = structuredClone(fixture);
    const extra = { unreviewed: "private data" };
    Object.assign(raw, extra);
    Object.assign(raw.data, extra);
    Object.assign(raw.data.attributes, extra);
    Object.assign(raw.data.attributes.results[0], extra);
    Object.assign(raw.data.attributes.results[0].groupings, extra);
    Object.assign(raw.data.attributes.results[0].statistics, extra);
    const output = await readCampaignValues(client(raw), scope, input, now);
    expect(campaignValuesOutputSchema.safeParse(output).success).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/unreviewed|private data|private audience|average_order_value/);
  });

  it("keeps schemas usable as inferred public types", () => {
    const typedInput: z.infer<typeof campaignValuesInputSchema> = input;
    expect(campaignValuesInputSchema.parse(typedInput)).toEqual(input);
  });
});
