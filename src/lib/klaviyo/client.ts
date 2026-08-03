import "server-only";

const KLAVIYO_ORIGIN = "https://a.klaviyo.com";
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_CURSOR_LENGTH = 4_096;

export const KLAVIYO_API_REVISIONS = {
  accounts: "2026-07-15",
  metrics: "2026-07-15",
  events: "2026-07-15",
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
): KlaviyoCompoundPage {
  if (!isRecord(body)) invalidResponse(status);
  if (!Array.isArray(body.data)) {
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
}
