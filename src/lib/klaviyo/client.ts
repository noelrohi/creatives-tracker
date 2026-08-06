import "server-only";

const KLAVIYO_ORIGIN = "https://a.klaviyo.com";
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_CURSOR_LENGTH = 4_096;

export const KLAVIYO_API_REVISIONS = {
  accounts: "2026-07-15",
  metrics: "2026-07-15",
  events: "2026-07-15",
  campaigns: "2026-07-15",
  flows: "2026-07-15",
  trackingSettings: "2026-07-15",
  reports: "2026-07-15",
} as const;

export type KlaviyoResource = {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};

export type KlaviyoCompoundPage = {
  data: KlaviyoResource[];
  included: KlaviyoResource[];
  nextCursor: string | null;
  apiRevision: string;
};

export class KlaviyoApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /**
     * Sanitized provider-directed delay. Durable callers must persist or
     * reschedule this wait before issuing another request after a terminal 429.
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "KlaviyoApiError";
  }
}

type ClientOptions = {
  privateApiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

type RequestOptions = {
  path: string;
  revision: string;
  params?: URLSearchParams;
  /** Single-resource endpoints return `data: {}`; normalize to a one-item page. */
  singleResource?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResource(value: unknown): value is KlaviyoResource {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") {
    return false;
  }
  if (value.attributes !== undefined && !isRecord(value.attributes)) {
    return false;
  }
  return value.relationships === undefined || isRecord(value.relationships);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // Body disposal is best-effort and must never surface provider content.
  }
}

function invalidPaginationLink(): never {
  throw new KlaviyoApiError(
    "Klaviyo returned an invalid pagination link",
    null,
    false,
  );
}

function rawPathHasDotSegment(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return true;
  const pathStart = value.indexOf("/", schemeEnd + 3);
  if (pathStart < 0) return false;
  const queryStart = value.indexOf("?", pathStart);
  const fragmentStart = value.indexOf("#", pathStart);
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, value.length].filter((index) => index >= 0),
  );
  const rawPath = value.slice(pathStart, pathEnd);
  return rawPath.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch {
      return true;
    }
  });
}

function nextCursor(next: unknown, expectedPath: string): string | null {
  if (next === null || next === undefined) return null;
  if (typeof next !== "string") invalidPaginationLink();

  let url: URL;
  try {
    url = new URL(next);
  } catch {
    invalidPaginationLink();
  }

  const canonicalPath = expectedPath.endsWith("/")
    ? expectedPath.slice(0, -1)
    : expectedPath;
  if (
    url.protocol !== "https:" ||
    url.origin !== KLAVIYO_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    next.includes("#") ||
    rawPathHasDotSegment(next) ||
    (url.pathname !== canonicalPath && url.pathname !== `${canonicalPath}/`)
  ) {
    invalidPaginationLink();
  }

  const cursorValues = url.searchParams.getAll("page[cursor]");
  if (
    cursorValues.length !== 1 ||
    cursorValues[0].trim() === "" ||
    cursorValues[0].length > MAX_CURSOR_LENGTH
  ) {
    invalidPaginationLink();
  }
  return cursorValues[0];
}

function eventFilter(metricId: string, from: string, to: string): string {
  const metric = JSON.stringify(metricId);
  return (
    `and(equals(metric_id,${metric}),` +
    `greater-or-equal(datetime,${from}),` +
    `less-than(datetime,${to}))`
  );
}

function invalidEventWindow(): never {
  throw new KlaviyoApiError(
    "Klaviyo event request has an invalid half-open window",
    null,
    false,
  );
}

function invalidRequestCursor(): never {
  throw new KlaviyoApiError(
    "Klaviyo request cursor is invalid",
    null,
    false,
  );
}

function assertRequestCursor(
  cursor: unknown,
): asserts cursor is string | null {
  if (
    cursor !== null &&
    (typeof cursor !== "string" ||
      cursor.trim() === "" ||
      cursor.length > MAX_CURSOR_LENGTH)
  ) {
    invalidRequestCursor();
  }
}

function assertProviderPathId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\/?#\s]/.test(value)
  ) {
    throw new KlaviyoApiError(
      `Klaviyo ${label} request has an invalid identifier`,
      null,
      false,
    );
  }
}

type ListEventsInput = {
  metricId: string;
  from: Date;
  to: Date;
  cursor: string | null;
  includeAttributions: boolean;
  includeProfileEmail: boolean;
};

type EventRequestSnapshot = Omit<ListEventsInput, "from" | "to"> & {
  from: string;
  to: string;
};

function snapshotEventRequest(input: ListEventsInput): EventRequestSnapshot {
  let metricId: string;
  let fromMilliseconds: number;
  let toMilliseconds: number;
  let cursor: string | null;
  let includeAttributions: boolean;
  let includeProfileEmail: boolean;
  try {
    metricId = input.metricId;
    const from = input.from;
    fromMilliseconds = Date.prototype.getTime.call(from);
    const to = input.to;
    toMilliseconds = Date.prototype.getTime.call(to);
    cursor = input.cursor;
    includeAttributions = input.includeAttributions;
    includeProfileEmail = input.includeProfileEmail;
  } catch {
    invalidEventWindow();
  }
  if (
    !Number.isFinite(fromMilliseconds) ||
    !Number.isFinite(toMilliseconds) ||
    fromMilliseconds >= toMilliseconds
  ) {
    invalidEventWindow();
  }
  if (typeof metricId !== "string" || metricId.trim() === "") {
    throw new KlaviyoApiError(
      "Klaviyo event request has an invalid metric",
      null,
      false,
    );
  }
  if (
    typeof includeAttributions !== "boolean" ||
    typeof includeProfileEmail !== "boolean"
  ) {
    throw new KlaviyoApiError(
      "Klaviyo event request has invalid include flags",
      null,
      false,
    );
  }
  assertRequestCursor(cursor);

  return {
    metricId,
    from: new Date(fromMilliseconds).toISOString(),
    to: new Date(toMilliseconds).toISOString(),
    cursor,
    includeAttributions,
    includeProfileEmail,
  };
}

function invalidResponse(status: number): never {
  throw new KlaviyoApiError(
    "Klaviyo API response was invalid",
    status,
    false,
  );
}

function compoundPage(
  body: unknown,
  status: number,
  revision: string,
  expectedPath: string,
  singleResource = false,
): KlaviyoCompoundPage {
  if (!isRecord(body)) invalidResponse(status);
  if (singleResource) {
    if (!isRecord(body.data)) invalidResponse(status);
    body = { ...body, data: [body.data] };
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new KlaviyoApiError(
      "Klaviyo API response did not contain a resource collection",
      status,
      false,
    );
  }
  if (!body.data.every(isResource)) invalidResponse(status);
  if (body.included !== undefined && !Array.isArray(body.included)) {
    invalidResponse(status);
  }
  const included = body.included ?? [];
  if (!included.every(isResource)) invalidResponse(status);
  if (body.links !== undefined && !isRecord(body.links)) {
    invalidResponse(status);
  }

  return {
    data: body.data,
    included,
    nextCursor: nextCursor(body.links?.next, expectedPath),
    apiRevision: revision,
  };
}

export class KlaviyoApiClient {
  readonly #privateApiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: ClientOptions) {
    const privateApiKey = options.privateApiKey;
    if (typeof privateApiKey !== "string" || privateApiKey.trim() === "") {
      throw new Error("Klaviyo private API key is required");
    }
    this.#privateApiKey = privateApiKey;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
  }

  async #request(options: RequestOptions): Promise<KlaviyoCompoundPage> {
    const url = new URL(options.path, KLAVIYO_ORIGIN);
    for (const [name, value] of options.params ?? new URLSearchParams()) {
      url.searchParams.set(name, value);
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            accept: "application/vnd.api+json",
            authorization: `Klaviyo-API-Key ${this.#privateApiKey}`,
            revision: options.revision,
          },
        });
      } catch {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new KlaviyoApiError(
            "Klaviyo API network request failed",
            null,
            true,
          );
        }
        await this.#sleep(
          500 * 2 ** attempt + Math.floor(this.#random() * 250),
        );
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = retryable
        ? parseRetryAfter(response.headers.get("retry-after"))
        : null;
      if (retryAfter !== null && retryAfter > MAX_RETRY_DELAY_MS) {
        discardResponseBody(response);
        throw new KlaviyoApiError(
          "Klaviyo API retry delay exceeds client limit",
          response.status,
          true,
          response.status === 429 ? retryAfter : null,
        );
      }
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        discardResponseBody(response);
        await this.#sleep(
          retryAfter ??
            500 * 2 ** attempt + Math.floor(this.#random() * 250),
        );
        continue;
      }
      if (!response.ok) {
        discardResponseBody(response);
        throw new KlaviyoApiError(
          `Klaviyo API request failed (${response.status})`,
          response.status,
          retryable,
          response.status === 429 ? retryAfter : null,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        invalidResponse(response.status);
      }
      return compoundPage(
        body,
        response.status,
        options.revision,
        options.path,
        options.singleResource ?? false,
      );
    }

    throw new KlaviyoApiError(
      "Klaviyo API retry budget was exhausted",
      null,
      true,
    );
  }

  listAccounts(): Promise<KlaviyoCompoundPage> {
    return this.#request({
      path: "/api/accounts",
      revision: KLAVIYO_API_REVISIONS.accounts,
    });
  }

  async listMetrics(cursor: string | null): Promise<KlaviyoCompoundPage> {
    assertRequestCursor(cursor);
    const params = new URLSearchParams();
    if (cursor !== null) params.set("page[cursor]", cursor);
    return this.#request({
      path: "/api/metrics",
      revision: KLAVIYO_API_REVISIONS.metrics,
      params,
    });
  }

  async listEvents(input: ListEventsInput): Promise<KlaviyoCompoundPage> {
    const snapshot = snapshotEventRequest(input);
    const include = [
      ...(snapshot.includeProfileEmail ? ["profile"] : []),
      "metric",
      ...(snapshot.includeAttributions ? ["attributions"] : []),
    ].join(",");
    const params = new URLSearchParams({
      filter: eventFilter(snapshot.metricId, snapshot.from, snapshot.to),
      include,
      "fields[event]": "id,datetime,event_properties,timestamp,uuid",
      "fields[metric]": "id,name,integration",
      "fields[attribution]": "id",
      "page[size]": "200",
      sort: "datetime",
    });
    if (snapshot.includeProfileEmail) params.set("fields[profile]", "email");
    if (snapshot.cursor !== null) {
      params.set("page[cursor]", snapshot.cursor);
    }
    return this.#request({
      path: "/api/events",
      revision: KLAVIYO_API_REVISIONS.events,
      params,
    });
  }

  async listCampaigns(input: {
    channel: "email" | "sms";
    cursor: string | null;
  }): Promise<KlaviyoCompoundPage> {
    if (input.channel !== "email" && input.channel !== "sms") {
      throw new KlaviyoApiError(
        "Klaviyo campaign request has an invalid channel",
        null,
        false,
      );
    }
    assertRequestCursor(input.cursor);
    const params = new URLSearchParams({
      filter: `equals(messages.channel,'${input.channel}')`,
      "fields[campaign]": "name,status,archived,created_at,updated_at",
      sort: "id",
    });
    if (input.cursor !== null) params.set("page[cursor]", input.cursor);
    return this.#request({
      path: "/api/campaigns",
      revision: KLAVIYO_API_REVISIONS.campaigns,
      params,
    });
  }

  async listCampaignMessages(input: {
    campaignId: string;
    cursor: string | null;
  }): Promise<KlaviyoCompoundPage> {
    assertProviderPathId(input.campaignId, "campaign");
    assertRequestCursor(input.cursor);
    const params = new URLSearchParams({
      "fields[campaign-message]": "label,channel,created_at,updated_at",
    });
    if (input.cursor !== null) params.set("page[cursor]", input.cursor);
    return this.#request({
      path: `/api/campaigns/${encodeURIComponent(input.campaignId)}/campaign-messages`,
      revision: KLAVIYO_API_REVISIONS.campaigns,
      params,
    });
  }

  async listFlows(input: {
    cursor: string | null;
  }): Promise<KlaviyoCompoundPage> {
    assertRequestCursor(input.cursor);
    const params = new URLSearchParams({
      "fields[flow]": "name,status,archived,created,updated",
      sort: "id",
    });
    if (input.cursor !== null) params.set("page[cursor]", input.cursor);
    return this.#request({
      path: "/api/flows",
      revision: KLAVIYO_API_REVISIONS.flows,
      params,
    });
  }

  async listFlowActions(input: {
    flowId: string;
    cursor: string | null;
  }): Promise<KlaviyoCompoundPage> {
    assertProviderPathId(input.flowId, "flow");
    assertRequestCursor(input.cursor);
    const params = new URLSearchParams({
      "fields[flow-action]": "action_type,status,created,updated",
    });
    if (input.cursor !== null) params.set("page[cursor]", input.cursor);
    return this.#request({
      path: `/api/flows/${encodeURIComponent(input.flowId)}/flow-actions`,
      revision: KLAVIYO_API_REVISIONS.flows,
      params,
    });
  }

  async listFlowMessages(input: {
    actionId: string;
    cursor: string | null;
  }): Promise<KlaviyoCompoundPage> {
    assertProviderPathId(input.actionId, "flow action");
    assertRequestCursor(input.cursor);
    const params = new URLSearchParams({
      "fields[flow-message]": "name,channel,created,updated",
    });
    if (input.cursor !== null) params.set("page[cursor]", input.cursor);
    return this.#request({
      path: `/api/flow-actions/${encodeURIComponent(input.actionId)}/flow-messages`,
      revision: KLAVIYO_API_REVISIONS.flows,
      params,
    });
  }

  /**
   * Tracking configuration for one closed scope. Account scope pages the
   * tracking-settings collection; message scopes fetch exactly one message
   * resource's tracking fields. Configuration evidence never proves a
   * visited URL.
   */
  async getTrackingSettings(input: {
    scope: "account" | "campaign_message" | "flow_message";
    externalId: string | null;
    cursor: string | null;
  }): Promise<KlaviyoCompoundPage> {
    assertRequestCursor(input.cursor);
    if (input.scope === "account") {
      if (input.externalId !== null) {
        throw new KlaviyoApiError(
          "Klaviyo account tracking request cannot carry an object ID",
          null,
          false,
        );
      }
      const params = new URLSearchParams({
        "fields[tracking-setting]":
          "auto_add_parameters,custom_parameters,utm_source,utm_medium,utm_campaign,utm_id,utm_term",
      });
      if (input.cursor !== null) params.set("page[cursor]", input.cursor);
      return this.#request({
        path: "/api/tracking-settings",
        revision: KLAVIYO_API_REVISIONS.trackingSettings,
        params,
      });
    }
    if (typeof input.externalId !== "string" || input.cursor !== null) {
      throw new KlaviyoApiError(
        "Klaviyo message tracking request is invalid",
        null,
        false,
      );
    }
    assertProviderPathId(input.externalId, "tracking message");
    const path =
      input.scope === "campaign_message"
        ? `/api/campaign-messages/${encodeURIComponent(input.externalId)}`
        : `/api/flow-messages/${encodeURIComponent(input.externalId)}`;
    const fieldsKey =
      input.scope === "campaign_message"
        ? "fields[campaign-message]"
        : "fields[flow-message]";
    return this.#request({
      path,
      revision: KLAVIYO_API_REVISIONS.trackingSettings,
      params: new URLSearchParams({
        [fieldsKey]: "label,channel,tracking_options",
      }),
      singleResource: true,
    });
  }

  /**
   * Pinned single-event fetch with a closed purpose union: callers select a
   * purpose and cannot construct arbitrary includes. Only identity rotation
   * sparse-includes profile email; the claim purposes never do. The primary
   * returned resource ID must equal the requested stored external ID.
   */
  async getEventById(input: {
    externalEventId: string;
    request: KlaviyoSingleEventRequest;
  }): Promise<KlaviyoSingleEventResult> {
    const externalEventId = input.externalEventId;
    if (
      typeof externalEventId !== "string" ||
      externalEventId.length === 0 ||
      externalEventId.length > 512 ||
      /[\/?#\s]/.test(externalEventId)
    ) {
      throw new KlaviyoApiError(
        "Klaviyo single-event request is invalid",
        null,
        false,
      );
    }
    const purpose = input.request.purpose;
    const shape = SINGLE_EVENT_REQUESTS[purpose];
    if (
      shape === undefined ||
      JSON.stringify(input.request) !== JSON.stringify(shape)
    ) {
      throw new KlaviyoApiError(
        "Klaviyo single-event request is invalid",
        null,
        false,
      );
    }
    const params = new URLSearchParams({
      include: shape.include.join(","),
      "fields[event]": "id,datetime,event_properties,timestamp,uuid",
    });
    if (purpose === "identity_rotation") {
      params.set("fields[profile]", "email");
    } else {
      params.set("fields[metric]", "id,name,integration");
      if (purpose === "attribution_claim") {
        params.set("fields[attribution]", "id");
      }
    }
    const page = await this.#request({
      path: `/api/events/${encodeURIComponent(externalEventId)}`,
      revision: KLAVIYO_API_REVISIONS.events,
      params,
      singleResource: true,
    });
    const [event] = page.data;
    if (!event || event.type !== "event" || event.id !== externalEventId) {
      throw new KlaviyoApiError(
        "Klaviyo returned a different event than requested",
        null,
        false,
      );
    }
    if (purpose === "identity_rotation") {
      let profileId: string | null = null;
      let profileEmail: string | null = null;
      for (const resource of page.included) {
        if (resource.type !== "profile") continue;
        profileId = resource.id;
        const attributes = resource.attributes;
        const email =
          attributes && typeof attributes === "object"
            ? (attributes as Record<string, unknown>).email
            : null;
        if (typeof email === "string" && email.includes("@")) {
          profileEmail = email;
        }
        break;
      }
      return { purpose, event, profileId, profileEmail };
    }
    if (purpose === "attribution_claim") {
      const attributions = page.included.filter(
        (resource) => resource.type === "attribution",
      );
      return {
        purpose,
        event,
        attributionIds: attributions.map((resource) => resource.id),
        attributions,
      };
    }
    return {
      purpose,
      event,
      metric:
        page.included.find((resource) => resource.type === "metric") ?? null,
    };
  }
}

const SINGLE_EVENT_REQUESTS = {
  identity_rotation: {
    purpose: "identity_rotation",
    include: ["profile"],
    profileFields: ["email"],
  },
  attribution_claim: {
    purpose: "attribution_claim",
    include: ["metric", "attributions"],
  },
  referenced_interaction: {
    purpose: "referenced_interaction",
    include: ["metric"],
  },
} as const;

export type KlaviyoSingleEventRequest =
  | { purpose: "identity_rotation"; include: ["profile"]; profileFields: ["email"] }
  | { purpose: "attribution_claim"; include: ["metric", "attributions"] }
  | { purpose: "referenced_interaction"; include: ["metric"] };

export type KlaviyoSingleEventResult =
  | {
      purpose: "identity_rotation";
      event: KlaviyoResource;
      profileId: string | null;
      profileEmail: string | null;
    }
  | {
      purpose: "attribution_claim";
      event: KlaviyoResource;
      attributionIds: string[];
      attributions: KlaviyoResource[];
    }
  | {
      purpose: "referenced_interaction";
      event: KlaviyoResource;
      metric: KlaviyoResource | null;
    };
