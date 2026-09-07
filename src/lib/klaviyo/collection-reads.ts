import { createHash } from "node:crypto";
import { z } from "zod";
import { KlaviyoReadError, type KlaviyoReadRequester } from "./read-transport";

const MAX_RECORDS = 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const text = z.string().max(16384);
const id = z.string().min(1).max(256);
const instant = z.string().datetime({ offset: true });
const continuation = z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/);
const snapshotInput = z.object({ continuation: continuation.optional() }).strict();
export const campaignsInputSchema = snapshotInput;
export const metricsInputSchema = snapshotInput;
export const eventsInputSchema = z.object({
  metricIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/)).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length),
  since: instant,
  until: instant,
  continuation: continuation.optional(),
}).strict().refine(({ since, until }) => {
  const span = Date.parse(until) - Date.parse(since);
  return span > 0 && span <= YEAR_MS;
});

const campaignSchema = z.object({
  campaignId: id, name: text.min(1), status: text.min(1), archived: z.boolean(),
  createdAt: instant, updatedAt: instant, scheduledAt: instant.nullable(), sendTime: instant.nullable(),
}).strict();
const messageSchema = z.object({
  messageId: id, campaignId: id, channel: text.min(1),
  subject: text.nullable(), previewText: text.nullable(), createdAt: instant, updatedAt: instant,
}).strict();
const metricSchema = z.object({ metricId: id, name: text.nullable() }).strict();
const eventSchema = z.object({
  eventId: id, metricId: id, metricName: text.nullable(), datetime: instant,
  profileId: id.nullable(), profileExternalId: text.nullable(), value: z.number().finite().nullable(),
  uuid: text.nullable(), orderId: text.nullable(), currency: text.nullable(),
}).strict();
export const campaignsOutputSchema = z.object({
  campaigns: z.array(campaignSchema).max(MAX_RECORDS), messages: z.array(messageSchema).max(MAX_RECORDS),
  nextContinuation: continuation.nullable(),
}).strict();
export const metricsOutputSchema = z.object({
  metrics: z.array(metricSchema).max(MAX_RECORDS), nextContinuation: continuation.nullable(),
}).strict();
export const eventsOutputSchema = z.object({
  events: z.array(eventSchema).max(MAX_RECORDS), nextContinuation: continuation.nullable(),
}).strict();

type Scope = { organizationId: string; connectionId: string };
type Resource = "campaigns" | "metrics" | "events";
const cursorSchema = z.string().min(1).max(2048).refine((s) => s.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(s));
const stateSchema = z.object({
  version: z.literal(1), resource: z.enum(["campaigns", "metrics", "events"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), chain: z.number().int().min(0).max(19),
  cursor: cursorSchema.nullable(), anchor: instant.nullable(),
}).strict();
type State = z.infer<typeof stateSchema>;

function parse<T extends z.ZodType>(schema: T, value: unknown, code: "invalid_input" | "invalid_response" = "invalid_response"): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new KlaviyoReadError(code);
  return result.data;
}
function invalid(): never { throw new KlaviyoReadError("invalid_response"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function records(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid();
  if (value.length > MAX_RECORDS) throw new KlaviyoReadError("limit_exceeded");
  return value;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? parse(text, value) : null;
}
function begin(resource: Resource, scope: Scope, input: { continuation?: string }, request: unknown, chains: number, now?: Date): State {
  parse(z.object({ organizationId: id, connectionId: id }).strict(), {
    organizationId: scope.organizationId, connectionId: scope.connectionId,
  }, "invalid_input");
  const fingerprint = createHash("sha256").update(JSON.stringify([resource, scope.organizationId, scope.connectionId, request])).digest("hex");
  if (input.continuation) {
    let decoded: unknown;
    try {
      const bytes = Buffer.from(input.continuation, "base64url");
      if (bytes.toString("base64url") !== input.continuation) throw new Error();
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch { throw new KlaviyoReadError("invalid_input"); }
    const state = parse(stateSchema, decoded, "invalid_input");
    if (state.resource !== resource || state.fingerprint !== fingerprint || state.chain >= chains ||
        (resource === "events" ? state.anchor === null : state.anchor !== null)) {
      throw new KlaviyoReadError("invalid_input");
    }
    return state;
  }
  if (now && !Number.isFinite(now.getTime())) throw new KlaviyoReadError("invalid_input");
  return { version: 1, resource, fingerprint, chain: 0, cursor: null, anchor: now?.toISOString() ?? null };
}
function next(state: State, cursor: string | null, chains: number): string | null {
  if (!cursor && state.chain + 1 === chains) return null;
  const following = { ...state, chain: cursor ? state.chain : state.chain + 1, cursor };
  return parse(continuation, Buffer.from(JSON.stringify(following)).toString("base64url"));
}

// Mirror client's raw-path guard: URL parsing erases literal and encoded dot segments.
function rawPathHasDotSegment(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return true;
  const pathStart = value.indexOf("/", schemeEnd + 3);
  if (pathStart < 0) return false;
  const pathEnd = Math.min(...[value.indexOf("?", pathStart), value.indexOf("#", pathStart), value.length]
    .filter((index) => index >= 0));
  return value.slice(pathStart, pathEnd).split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch { return true; }
  });
}

// Rebuild all filters locally; a provider link contributes only its opaque cursor.
function page(body: unknown, resource: Resource) {
  const envelope = object(body);
  const data = records(envelope.data);
  const included = envelope.included === undefined ? [] : records(envelope.included);
  if (data.length + included.length > MAX_RECORDS) throw new KlaviyoReadError("limit_exceeded");
  const link = envelope.links === undefined ? undefined : object(envelope.links).next;
  let cursor: string | null = null;
  if (link != null) {
    if (typeof link !== "string" || link.length > 8192) return invalid();
    let url: URL;
    try { url = new URL(link); } catch { return invalid(); }
    if (url.origin !== "https://a.klaviyo.com" || url.username || url.password || link.includes("#") ||
        link.includes("\\") || /[\u0000-\u0020\u007f]/.test(link) || rawPathHasDotSegment(link) ||
        ![`/api/${resource}`, `/api/${resource}/`].includes(url.pathname) ||
        url.searchParams.getAll("page[cursor]").length !== 1) return invalid();
    cursor = parse(cursorSchema, url.searchParams.get("page[cursor]"));
  }
  const resources = new Map<string, Record<string, unknown>>();
  for (const raw of included) {
    const item = object(raw);
    if (resource === "campaigns" && item.type !== "campaign-message") continue;
    const key = `${parse(id, item.type)}:${parse(id, item.id)}`;
    if (resources.has(key)) return invalid();
    resources.set(key, item);
  }
  return { data, resources, cursor };
}
function resource(raw: unknown, type: string) {
  const value = object(raw);
  if (value.type !== type) return invalid();
  return {
    value, id: parse(id, value.id),
    attributes: type === "metric" || type === "profile" ? optionalObject(value.attributes) : object(value.attributes),
  };
}
function reference(raw: unknown, type: string): string {
  const ref = object(raw);
  if (ref.type !== type) return invalid();
  return parse(id, ref.id);
}
function relationship(value: Record<string, unknown>, name: string): unknown {
  return object(object(value.relationships)[name]).data;
}
function optionalRelationship(value: Record<string, unknown>, name: string): unknown {
  if (value.relationships === undefined) return undefined;
  const relation = object(value.relationships)[name];
  return relation === undefined ? undefined : object(relation).data;
}
function paramsWithCursor(params: Record<string, string>, state: State): URLSearchParams {
  const result = new URLSearchParams(params);
  if (state.cursor !== null) result.set("page[cursor]", state.cursor);
  return result;
}
const CHANNELS = ["email", "sms", "mobile_push"] as const;

export async function readCampaigns(client: KlaviyoReadRequester, scope: Scope, input: z.infer<typeof campaignsInputSchema>): Promise<z.infer<typeof campaignsOutputSchema>> {
  input = parse(campaignsInputSchema, input, "invalid_input");
  const state = begin("campaigns", scope, input, null, 6);
  const channel = CHANNELS[Math.floor(state.chain / 2)];
  const archived = state.chain % 2 === 1;
  const response = page(await client.request({ resource: "campaigns", params: paramsWithCursor({
    filter: `and(equals(messages.channel,'${channel}'),equals(archived,${archived}))`,
    include: "campaign-messages", "fields[campaign]": "archived,created_at,name,scheduled_at,send_time,status,updated_at",
    "fields[campaign-message]": "created_at,updated_at,definition.channel,definition.content.subject,definition.content.preview_text",
    "page[size]": "100", sort: "id",
  }, state) }), "campaigns");
  const messages: z.infer<typeof messageSchema>[] = [];
  const owners = new Map<string, string>();
  const campaigns = response.data.map((raw) => {
    const { value, id: campaignId, attributes: a } = resource(raw, "campaign");
    if (a.archived !== archived) return invalid();
    const refs = optionalRelationship(value, "campaign-messages");
    for (const ref of refs == null ? [] : Array.isArray(refs) ? records(refs) : [refs]) {
      const messageId = reference(ref, "campaign-message");
      const knownParent = owners.get(messageId);
      if (knownParent !== undefined && knownParent !== campaignId) return invalid();
      owners.set(messageId, campaignId);
    }
    return {
      campaignId, name: a.name, status: a.status, archived: a.archived, createdAt: a.created_at,
      updatedAt: a.updated_at, scheduledAt: nullableString(a.scheduled_at), sendTime: nullableString(a.send_time),
    };
  });
  for (const item of response.resources.values()) {
    const { id: messageId, attributes: m } = resource(item, "campaign-message");
    const parentRef = optionalRelationship(item, "campaign");
    const includedParent = parentRef == null ? undefined : reference(parentRef, "campaign");
    const knownParent = owners.get(messageId);
    if (includedParent !== undefined && knownParent !== undefined && includedParent !== knownParent) return invalid();
    const campaignId = includedParent ?? knownParent;
    if (!campaignId) return invalid();
    const definition = object(m.definition);
    // The filter selects campaigns, not which related messages are included.
    // A multi-channel campaign can include messages from its other channels.
    const content = optionalObject(definition.content);
    messages.push(parse(messageSchema, {
      messageId, campaignId, channel: definition.channel, createdAt: m.created_at, updatedAt: m.updated_at,
      subject: nullableString(content.subject), previewText: nullableString(content.preview_text),
    }));
  }
  return parse(campaignsOutputSchema, { campaigns, messages, nextContinuation: next(state, response.cursor, 6) });
}

export async function readMetrics(client: KlaviyoReadRequester, scope: Scope, input: z.infer<typeof metricsInputSchema>): Promise<z.infer<typeof metricsOutputSchema>> {
  input = parse(metricsInputSchema, input, "invalid_input");
  const state = begin("metrics", scope, input, null, 1);
  const response = page(await client.request({ resource: "metrics", params: paramsWithCursor({ "fields[metric]": "name" }, state) }), "metrics");
  const metrics = response.data.map((raw) => {
    const { id: metricId, attributes } = resource(raw, "metric");
    return { metricId, name: nullableString(attributes.name) };
  });
  return parse(metricsOutputSchema, { metrics, nextContinuation: next(state, response.cursor, 1) });
}

export async function readEvents(client: KlaviyoReadRequester, scope: Scope, input: z.infer<typeof eventsInputSchema>, now: Date = new Date()): Promise<z.infer<typeof eventsOutputSchema>> {
  input = parse(eventsInputSchema, input, "invalid_input");
  const { metricIds, since, until } = input;
  const state = begin("events", scope, input, [metricIds, since, until], metricIds.length, now);
  const anchor = Date.parse(state.anchor!);
  // Unsigned traversal state is not authority to widen the current historical window.
  const current = now.getTime();
  if (!Number.isFinite(current) || Date.parse(since) < current - YEAR_MS || Date.parse(until) > current ||
      Date.parse(since) < anchor - YEAR_MS || Date.parse(until) > anchor) throw new KlaviyoReadError("invalid_input");
  const metricId = metricIds[state.chain];
  const response = page(await client.request({ resource: "events", params: paramsWithCursor({
    filter: `and(equals(metric_id,'${metricId}'),greater-or-equal(datetime,${since}),less-than(datetime,${until}))`,
    include: "metric,profile", "fields[event]": "datetime,event_properties,uuid", "fields[metric]": "name",
    "fields[profile]": "external_id", "page[size]": "200", sort: "datetime",
  }, state) }), "events");
  const events = response.data.map((raw) => {
    const { value, id: eventId, attributes: a } = resource(raw, "event");
    if (reference(relationship(value, "metric"), "metric") !== metricId) return invalid();
    const metric = response.resources.get(`metric:${metricId}`);
    if (!metric) return invalid();
    const metricName = nullableString(resource(metric, "metric").attributes.name);
    const profileRef = optionalRelationship(value, "profile");
    const profileId = profileRef == null ? null : reference(profileRef, "profile");
    let profileExternalId: string | null = null;
    if (profileId !== null) {
      const profile = response.resources.get(`profile:${profileId}`);
      if (!profile) return invalid();
      profileExternalId = nullableString(resource(profile, "profile").attributes.external_id);
    }
    const datetime = parse(instant, a.datetime);
    if (Date.parse(datetime) < Date.parse(since) || Date.parse(datetime) >= Date.parse(until)) return invalid();
    const properties = optionalObject(a.event_properties);
    return { eventId, metricId, metricName, datetime, profileId, profileExternalId,
      value: properties.$value ?? null, uuid: nullableString(a.uuid),
      orderId: nullableString(properties.$event_id), currency: nullableString(properties.$currency) };
  });
  return parse(eventsOutputSchema, { events, nextContinuation: next(state, response.cursor, metricIds.length) });
}
