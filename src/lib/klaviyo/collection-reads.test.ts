import { describe, expect, it, vi } from "vitest";
import {
  campaignsInputSchema, campaignsOutputSchema, eventsInputSchema, eventsOutputSchema,
  metricsInputSchema, metricsOutputSchema, readCampaigns, readEvents, readMetrics,
} from "./collection-reads";
import { KlaviyoReadError, type KlaviyoReadRequester } from "./read-transport";

const scope = { organizationId: "org1", connectionId: "conn1" };
const now = new Date("2026-09-07T00:00:00Z");
const datetime = "2026-09-01T00:00:00Z";
const window = { metricIds: ["M1", "M2"], since: datetime, until: now.toISOString() };
const link = (resource: string, cursor = "opaque+/=cursor") =>
  `https://a.klaviyo.com/api/${resource}/?page%5Bcursor%5D=${encodeURIComponent(cursor)}&filter=untrusted`;
const empty = (next: string | null = null) => ({ data: [], links: { next } });
function client(...responses: unknown[]) {
  const request = vi.fn<KlaviyoReadRequester["request"]>();
  responses.forEach((response) => request.mockResolvedValueOnce(response));
  return { request };
}
function campaignPage(channel = "email", archived = false) {
  return {
    data: [{ type: "campaign", id: "C1", attributes: {
      name: "Campaign", status: "Sent", archived, created_at: datetime, updated_at: datetime,
      scheduled_at: datetime, send_time: null, audiences: "PRIVATE",
    }, relationships: { "campaign-messages": { data: [{ type: "campaign-message", id: "MSG1" }] } } }],
    included: [{ type: "campaign-message", id: "MSG1", attributes: {
      created_at: datetime, updated_at: datetime, definition: { channel, content: {
        subject: "<untrusted>", preview_text: "Preview", from_email: "PRIVATE", body: "PRIVATE",
      } },
    }, relationships: { campaign: { data: { type: "campaign", id: "C1" } } } }],
    links: { next: null as string | null },
  };
}
function eventPage(metricId = "M1") {
  return {
    data: [{ type: "event", id: "E1", attributes: {
      datetime, uuid: "uuid", event_properties: { $value: 42.5, $event_id: "order1", $currency: "USD", email: "PRIVATE" },
    }, relationships: {
      metric: { data: { type: "metric", id: metricId } }, profile: { data: { type: "profile", id: "P1" } },
    } }],
    included: [
      { type: "profile", id: "P1", attributes: { external_id: "external1", email: "PRIVATE", properties: { secret: "PRIVATE" } } },
      { type: "metric", id: metricId, attributes: { name: "Placed Order", integration: "PRIVATE" } },
    ], links: { next: null as string | null },
  };
}

describe("Klaviyo collection contracts", () => {
  it("accepts internal scope metadata without changing continuation binding", async () => {
    const serviceScope = { ...scope, accountTimezone: "Asia/Kolkata" };
    const first = await readMetrics(client(empty(link("metrics"))), serviceScope, {});
    await expect(readMetrics(client(empty()), scope, { continuation: first.nextContinuation! }))
      .resolves.toEqual({ metrics: [], nextContinuation: null });
    await expect(readCampaigns(client(empty()), serviceScope, {})).resolves.toMatchObject({ campaigns: [] });
    await expect(readEvents(client(empty()), serviceScope, window, now)).resolves.toMatchObject({ events: [] });
  });
  it("normalizes empty nullable strings to null across reviewed fields", async () => {
    const campaign = campaignPage();
    campaign.data[0].attributes.scheduled_at = "";
    Reflect.set(campaign.data[0].attributes, "send_time", "");
    campaign.included[0].attributes.definition.content.subject = "";
    campaign.included[0].attributes.definition.content.preview_text = "";
    const campaigns = await readCampaigns(client(campaign), scope, {});
    expect(campaigns.campaigns[0]).toMatchObject({ scheduledAt: null, sendTime: null });
    expect(campaigns.messages[0]).toMatchObject({ subject: null, previewText: null });
    const metrics = await readMetrics(client({ data: [{ type: "metric", id: "M1", attributes: { name: "" } }] }), scope, {});
    expect(metrics.metrics[0].name).toBeNull();
    const event = eventPage();
    event.data[0].attributes.uuid = "";
    event.data[0].attributes.event_properties.$event_id = "";
    event.data[0].attributes.event_properties.$currency = "";
    Reflect.set(event.included[0].attributes, "external_id", "");
    Reflect.set(event.included[1].attributes, "name", "");
    const events = await readEvents(client(event), scope, window, now);
    expect(events.events[0]).toMatchObject({ metricName: null, profileExternalId: null, uuid: null, orderId: null, currency: null });
  });
  it.each([null, undefined, 123, false, [], {}, { nested: null }].map((value) => ({ value })))(
    "normalizes nonstring optional projections to null: $value", async ({ value }) => {
      const campaign = campaignPage();
      for (const field of ["scheduled_at", "send_time"]) Reflect.set(campaign.data[0].attributes, field, value);
      for (const field of ["subject", "preview_text"]) Reflect.set(campaign.included[0].attributes.definition.content, field, value);
      const campaigns = await readCampaigns(client(campaign), scope, {});
      expect(campaigns.campaigns[0]).toMatchObject({ scheduledAt: null, sendTime: null });
      expect(campaigns.messages[0]).toMatchObject({ subject: null, previewText: null });
      const metrics = await readMetrics(client({ data: [{ type: "metric", id: "M1", attributes: { name: value } }] }), scope, {});
      expect(metrics.metrics[0].name).toBeNull();
      const event = eventPage();
      Reflect.set(event.data[0].attributes, "uuid", value);
      for (const field of ["$event_id", "$currency"]) Reflect.set(event.data[0].attributes.event_properties, field, value);
      Reflect.set(event.included[0].attributes, "external_id", value);
      Reflect.set(event.included[1].attributes, "name", value);
      const events = await readEvents(client(event), scope, window, now);
      expect(events.events[0]).toMatchObject({ metricName: null, profileExternalId: null, uuid: null, orderId: null, currency: null, value: 42.5 });
    },
  );
  it.each([undefined, null, 123, "PRIVATE", false, [], { arbitrary: null }, Object.create(null)].map((value) => ({ value })))(
    "treats optional property containers as empty when not objects: $value", async ({ value }) => {
      const body = eventPage();
      if (value === undefined) Reflect.deleteProperty(body.data[0].attributes, "event_properties");
      else Reflect.set(body.data[0].attributes, "event_properties", value);
      for (const included of body.included) Reflect.set(included, "attributes", value);
      const result = await readEvents(client(body), scope, window, now);
      expect(result.events[0]).toMatchObject({ value: null, orderId: null, currency: null, metricName: null, profileExternalId: null });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      const metrics = await readMetrics(client({ data: [{ type: "metric", id: "M1", attributes: value }] }), scope, {});
      expect(metrics.metrics[0]).toEqual({ metricId: "M1", name: null });
      const campaign = campaignPage();
      Reflect.set(campaign.included[0].attributes.definition, "content", value);
      const campaigns = await readCampaigns(client(campaign), scope, {});
      expect(campaigns.messages[0]).toMatchObject({ subject: null, previewText: null });
    },
  );
  it.each(["42.5", "", "NaN", true])("rejects non-number event value %j per ecomconn requiredNumber", async (value) => {
    const body = eventPage();
    Reflect.set(body.data[0].attributes.event_properties, "$value", value);
    await expect(readEvents(client(body), scope, window, now)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("closes all inputs and outputs and rejects snapshot windows", () => {
    expect(campaignsInputSchema.safeParse({ since: datetime }).success).toBe(false);
    expect(metricsInputSchema.safeParse({ until: datetime }).success).toBe(false);
    expect(eventsInputSchema.safeParse({ ...window, extra: true }).success).toBe(false);
    for (const [schema, output] of [
      [campaignsOutputSchema, { campaigns: [], messages: [], nextContinuation: null }],
      [metricsOutputSchema, { metrics: [], nextContinuation: null }],
      [eventsOutputSchema, { events: [], nextContinuation: null }],
    ] as const) expect(schema.safeParse({ ...output, raw: {} }).success).toBe(false);
  });
  it.each([[], ["M1", "M1"], ["bad-id"], Array.from({ length: 21 }, (_, i) => `M${i}`)].map((metricIds) => ({ metricIds })))("rejects invalid metric selection $metricIds", async ({ metricIds }) => {
    const c = client();
    await expect(readEvents(c, scope, { ...window, metricIds }, now)).rejects.toMatchObject({ code: "invalid_input" });
    expect(c.request).not.toHaveBeenCalled();
  });
  it.each([
    [datetime, datetime], [now.toISOString(), datetime],
    ["2025-09-06T00:00:00Z", now.toISOString()],
    [datetime, "2026-09-08T00:00:00Z"], ["2026-09-01", now.toISOString()],
    ["2026-02-30T00:00:00Z", now.toISOString()],
  ])("rejects bad window %s → %s before I/O", async (since, until) => {
    const c = client();
    await expect(readEvents(c, scope, { ...window, since, until }, now)).rejects.toMatchObject({ code: "invalid_input" });
    expect(c.request).not.toHaveBeenCalled();
  });
});

describe("campaign traversal", () => {
  it.each(["sms", "mobile_push", "whatsapp"])("preserves %s included messages on a campaign selected by its email message", async (otherChannel) => {
    const body = campaignPage();
    const other = structuredClone(body.included[0]);
    other.id = "MSG2";
    other.attributes.definition.channel = otherChannel;
    body.included.push(other);
    body.data[0].relationships["campaign-messages"].data.push({ type: "campaign-message", id: "MSG2" });
    const result = await readCampaigns(client(body), scope, {});
    expect(result.messages.map(({ messageId, channel }) => ({ messageId, channel }))).toEqual([
      { messageId: "MSG1", channel: "email" }, { messageId: "MSG2", channel: otherChannel },
    ]);
  });

  it("visits all six chains, retaining empty-page cursors and resetting on transitions", async () => {
    const c = client(...["email", "sms", "mobile_push"].flatMap((channel) => [false, true].flatMap((archived) => [
      empty(link("campaigns")), campaignPage(channel, archived),
    ])));
    let continuation: string | undefined;
    for (let chain = 0; chain < 6; chain++) {
      const first = await readCampaigns(c, scope, { continuation });
      expect(first.campaigns).toEqual([]);
      expect(first.nextContinuation).toBeTypeOf("string");
      const second = await readCampaigns(c, scope, { continuation: first.nextContinuation! });
      expect(second.campaigns[0].campaignId).toBe("C1");
      expect(second.messages[0]).toEqual({
        messageId: "MSG1", campaignId: "C1", channel: ["email", "sms", "mobile_push"][Math.floor(chain / 2)],
        subject: "<untrusted>", previewText: "Preview", createdAt: datetime, updatedAt: datetime,
      });
      expect(JSON.stringify(second)).not.toContain("PRIVATE");
      const start = c.request.mock.calls[chain * 2][0].params!;
      const following = c.request.mock.calls[chain * 2 + 1][0].params!;
      expect(start.get("page[cursor]")).toBeNull();
      expect(following.get("page[cursor]")).toBe("opaque+/=cursor");
      expect(following.get("filter")).toBe(`and(equals(messages.channel,'${["email", "sms", "mobile_push"][Math.floor(chain / 2)]}'),equals(archived,${chain % 2 === 1}))`);
      continuation = second.nextContinuation ?? undefined;
    }
    expect(continuation).toBeUndefined();
    expect(c.request).toHaveBeenCalledTimes(12);
  });
  it("advances even when every chain is empty", async () => {
    const c = client(...Array.from({ length: 6 }, () => empty()));
    let continuation: string | undefined;
    for (let i = 0; i < 6; i++) {
      const result = await readCampaigns(c, scope, { continuation });
      expect(result.nextContinuation === null).toBe(i === 5);
      continuation = result.nextContinuation ?? undefined;
    }
  });
  it.each(["singleton", "array", "included-parent"])("resolves message parents through %s", async (variant) => {
    const body = campaignPage();
    if (variant === "included-parent") Reflect.deleteProperty(body.data[0], "relationships");
    else {
      Reflect.deleteProperty(body.included[0], "relationships");
      if (variant === "singleton") {
        Reflect.set(body.data[0].relationships["campaign-messages"], "data", { type: "campaign-message", id: "MSG1" });
      }
    }
    const result = await readCampaigns(client(body), scope, {});
    expect(result.messages[0]).toMatchObject({ messageId: "MSG1", campaignId: "C1" });
  });
  it("ignores unrelated included types and permits campaigns without included messages", async () => {
    const body = campaignPage();
    Reflect.set(body, "included", [...body.included, { type: "tag", id: "T1", attributes: { name: "PRIVATE" } }]);
    const result = await readCampaigns(client(body), scope, {});
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    body.included = [];
    await expect(readCampaigns(client(body), scope, {})).resolves.toMatchObject({ messages: [] });
    Reflect.deleteProperty(body.data[0], "relationships");
    await expect(readCampaigns(client(body), scope, {})).resolves.toMatchObject({ messages: [] });
  });
  it("rejects conflicting campaign-side parents", async () => {
    const body = campaignPage();
    body.data.push({ ...body.data[0], id: "C2" });
    await expect(readCampaigns(client(body), scope, {})).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects missing required fields and missing/mismatched message parents", async () => {
    const missing = campaignPage();
    Reflect.deleteProperty(missing.data[0].attributes, "status");
    const absent = campaignPage();
    Reflect.deleteProperty(absent.data[0], "relationships");
    Reflect.deleteProperty(absent.included[0], "relationships");
    const mismatch = campaignPage(); mismatch.included[0].relationships.campaign.data.id = "OTHER";
    for (const body of [missing, absent, mismatch]) {
      await expect(readCampaigns(client(body), scope, {})).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
});

describe("metrics and continuation validation", () => {
  it("projects ID/name only and follows an opaque cursor", async () => {
    const c = client({ data: [{ type: "metric", id: "M1", attributes: { name: null, email: "PRIVATE" } }], links: { next: link("metrics") } }, empty());
    const first = await readMetrics(c, scope, {});
    expect(first.metrics).toEqual([{ metricId: "M1", name: null }]);
    expect(await readMetrics(c, scope, { continuation: first.nextContinuation! })).toEqual({ metrics: [], nextContinuation: null });
    expect(c.request.mock.calls[1][0].params!.get("filter")).toBeNull();
    expect(c.request.mock.calls[1][0].params!.get("page[cursor]")).toBe("opaque+/=cursor");
  });
  it.each([
    "https://evil.test/api/metrics?page[cursor]=x", "http://a.klaviyo.com/api/metrics?page[cursor]=x",
    "https://a.klaviyo.com/api/events?page[cursor]=x", "https://user:pass@a.klaviyo.com/api/metrics?page[cursor]=x",
    "https://a.klaviyo.com/api/metrics?page[cursor]=x#fragment", "https://a.klaviyo.com/api/metrics",
    "https://a.klaviyo.com/api/metrics?page[cursor]=x&page[cursor]=y", "/api/metrics?page[cursor]=x",
    "https://a.klaviyo.com/api/other/../metrics?page[cursor]=x",
    "https://a.klaviyo.com/api/other/%2e%2E/metrics?page[cursor]=x",
    "https://a.klaviyo.com/api/%2e/metrics?page[cursor]=x",
    "https://a.klaviyo.com/api/metrics?page[cursor]=x#",
    "https://a.klaviyo.com/api/metrics?page[cursor]=%20%20",
    "https://a.klaviyo.com/api\\\\metrics?page[cursor]=x",
  ])("rejects unsafe provider next link %s", async (next) => {
    await expect(readMetrics(client(empty(next)), scope, {})).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects cross-scope, cross-resource, malformed and structurally invalid continuations", async () => {
    const first = await readMetrics(client(empty(link("metrics"))), scope, {});
    const continuation = first.nextContinuation!;
    for (const other of [{ ...scope, organizationId: "org2" }, { ...scope, connectionId: "conn2" }]) {
      const c = client();
      await expect(readMetrics(c, other, { continuation })).rejects.toMatchObject({ code: "invalid_input" });
      expect(c.request).not.toHaveBeenCalled();
    }
    await expect(readCampaigns(client(), scope, { continuation })).rejects.toMatchObject({ code: "invalid_input" });
    const decoded = JSON.parse(Buffer.from(continuation, "base64url").toString());
    for (const token of ["notjson", "!", "x".repeat(8193), ...[
      { ...decoded, version: 2 }, { ...decoded, chain: 1 }, { ...decoded, url: "PRIVATE" }, { ...decoded, cursor: "" },
    ].map((state) => Buffer.from(JSON.stringify(state)).toString("base64url"))]) {
      await expect(readMetrics(client(), scope, { continuation: token })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });
  it.each([{ data: [] }, { data: [], links: {} }])("treats absent links/next as end: %j", async (body) => {
    await expect(readMetrics(client(body), scope, {})).resolves.toEqual({ metrics: [], nextContinuation: null });
    await expect(readEvents(client(body), scope, { ...window, metricIds: ["M1"] }, now))
      .resolves.toEqual({ events: [], nextContinuation: null });
    const result = await readCampaigns(client(body), scope, {});
    expect(result.nextContinuation).toBeTypeOf("string");
  });
  it("enforces envelope/record bounds and sanitized validation errors", async () => {
    for (const body of [{}, { data: [], links: false }, { data: [], links: { next: 42 } }, { data: [null], links: { next: null } },
      { data: [{ type: "metric", id: 3, attributes: { name: "Name" } }], links: { next: null } }]) {
      await expect(readMetrics(client(body), scope, {})).rejects.toMatchObject({ code: "invalid_response" });
    }
    await expect(readMetrics(client({ data: Array(1001).fill({}), links: { next: null } }), scope, {})).rejects.toMatchObject({ code: "limit_exceeded" });
    const error = new KlaviyoReadError("rate_limited", 1000);
    const c = { request: vi.fn().mockRejectedValue(error) };
    await expect(readMetrics(c, scope, {})).rejects.toBe(error);
  });
});

describe("events", () => {
  it("joins included by type/ID, minimizes fields and finishes each metric chain before transitioning", async () => {
    const body = eventPage(); body.links.next = link("events");
    const c = client(body, empty(), eventPage("M2"));
    const first = await readEvents(c, scope, window, now);
    expect(first.events).toEqual([{
      eventId: "E1", metricId: "M1", metricName: "Placed Order", datetime, profileId: "P1", profileExternalId: "external1",
      value: 42.5, uuid: "uuid", orderId: "order1", currency: "USD",
    }]);
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
    const second = await readEvents(c, scope, { ...window, continuation: first.nextContinuation! }, now);
    expect(second.events).toEqual([]);
    const third = await readEvents(c, scope, { ...window, continuation: second.nextContinuation! }, now);
    expect(third.nextContinuation).toBeNull();
    expect(third.events[0].metricId).toBe("M2");
    expect(c.request.mock.calls.map(([arg]) => arg.params!.get("page[cursor]"))).toEqual([null, "opaque+/=cursor", null]);
    expect(c.request.mock.calls[1][0].params!.get("filter")).toContain("equals(metric_id,'M1')");
    expect(c.request.mock.calls[2][0].params!.get("filter")).toContain("equals(metric_id,'M2')");
    expect(c.request.mock.calls[0][0].params!.get("fields[profile]")).toBe("external_id");
  });
  it("rejects changed windows and metric order with no provider work", async () => {
    const first = await readEvents(client(empty()), scope, window, now);
    for (const change of [{ since: "2026-09-02T00:00:00Z" }, { until: "2026-09-06T00:00:00Z" }, { metricIds: ["M2", "M1"] }]) {
      const c = client();
      await expect(readEvents(c, scope, { ...window, ...change, continuation: first.nextContinuation! }, now)).rejects.toMatchObject({ code: "invalid_input" });
      expect(c.request).not.toHaveBeenCalled();
    }
  });
  it("does not let the original clock anchor extend the real 365-day lookback", async () => {
    const input = { ...window, since: new Date(now.getTime() - 365 * 86400000).toISOString() };
    const first = await readEvents(client(empty()), scope, input, now);
    const later = new Date(now.getTime() + 86400000);
    const c = client();
    await expect(readEvents(c, scope, { ...input, continuation: first.nextContinuation! }, later)).rejects.toMatchObject({ code: "invalid_input" });
    expect(c.request).not.toHaveBeenCalled();
    await expect(readEvents(client(), scope, input, later)).rejects.toMatchObject({ code: "invalid_input" });
  });
  it.each([
    { since: "2025-08-01T00:00:00Z", until: "2025-08-02T00:00:00Z" },
    { since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z" },
  ])("rejects an edited anchor granting authority outside real now: $since", async (dates) => {
    const input = { ...window, ...dates };
    const first = await readEvents(client(empty()), scope, input, new Date(dates.until));
    const state = JSON.parse(Buffer.from(first.nextContinuation!, "base64url").toString());
    state.anchor = new Date(Date.parse(dates.until) + 86400000).toISOString();
    const continuation = Buffer.from(JSON.stringify(state)).toString("base64url");
    const c = client(empty());
    await expect(readEvents(c, scope, { ...input, continuation }, now)).rejects.toMatchObject({ code: "invalid_input" });
    expect(c.request).not.toHaveBeenCalled();
  });
  it("validates current now on continuations and permits still-valid anchored windows", async () => {
    const first = await readEvents(client(empty()), scope, window, now);
    const input = { ...window, continuation: first.nextContinuation! };
    await expect(readEvents(client(empty()), scope, input, new Date(now.getTime() + 86400000)))
      .resolves.toMatchObject({ nextContinuation: null });
    await expect(readEvents(client(), scope, input, new Date(NaN))).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("rejects metric mismatch, wrong reference types, missing included resources, duplicate IDs and nonfinite values", async () => {
    const wrongType = eventPage(); wrongType.data[0].relationships.metric.data.type = "profile";
    const absent = eventPage(); absent.included = [];
    const absentProfile = eventPage(); absentProfile.included = absentProfile.included.slice(1);
    const duplicate = eventPage(); duplicate.included.push(duplicate.included[0]);
    const infinite = eventPage(); infinite.data[0].attributes.event_properties.$value = Infinity;
    const nan = eventPage(); nan.data[0].attributes.event_properties.$value = NaN;
    const end = eventPage(); end.data[0].attributes.datetime = window.until;
    const missing = eventPage(); Reflect.deleteProperty(missing.data[0].attributes, "datetime");
    for (const body of [eventPage("OTHER"), wrongType, absent, absentProfile, duplicate, infinite, nan, end, missing]) {
      await expect(readEvents(client(body), scope, window, now)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("permits an absent profile relationship", async () => {
    const body = eventPage();
    Reflect.deleteProperty(body.data[0].relationships, "profile");
    body.included = body.included.slice(1);
    await expect(readEvents(client(body), scope, window, now)).resolves.toMatchObject({
      events: [{ profileId: null, profileExternalId: null }],
    });
  });
  it("supports nullable profile and optional reviewed properties without leaking unreviewed ones", async () => {
    const body = eventPage();
    Reflect.set(body.data[0].relationships.profile, "data", null);
    Reflect.set(body.data[0].attributes, "event_properties", { email: "PRIVATE" });
    Reflect.deleteProperty(body.data[0].attributes, "uuid");
    const result = await readEvents(client(body), scope, window, now);
    expect(result.events[0]).toMatchObject({ profileId: null, profileExternalId: null, value: null, uuid: null, orderId: null, currency: null });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
