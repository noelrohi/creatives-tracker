import "server-only";

const PATHS = {
  accounts: "/api/accounts",
  campaigns: "/api/campaigns",
  metrics: "/api/metrics",
  events: "/api/events",
  campaignValues: "/api/campaign-values-reports",
} as const;
const MAX_BYTES = 16 * 1024 * 1024;
const TOTAL_MS = 25_000;
const ATTEMPT_MS = 10_000;
const MAX_ATTEMPTS = 4;

export type KlaviyoReadInput = {
  resource: keyof typeof PATHS;
  params?: URLSearchParams;
  body?: unknown;
};

export interface KlaviyoReadRequester {
  request(input: KlaviyoReadInput): Promise<unknown>;
}

export type KlaviyoReadErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "rate_limited"
  | "credential_rejected"
  | "unavailable"
  | "limit_exceeded";

const MESSAGES: Record<KlaviyoReadErrorCode, string> = {
  invalid_input: "Klaviyo read input is invalid",
  invalid_response: "Klaviyo read response is invalid",
  rate_limited: "Klaviyo read is rate limited",
  credential_rejected: "Klaviyo read credential was rejected",
  unavailable: "Klaviyo read is unavailable",
  limit_exceeded: "Klaviyo read limit was exceeded",
};

export class KlaviyoReadError extends Error {
  constructor(
    readonly code: KlaviyoReadErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(MESSAGES[code]);
    this.name = "KlaviyoReadError";
  }
}

type Options = {
  privateApiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

function discard(body: ReadableStream<Uint8Array> | null): void {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup must neither block the deadline nor expose provider errors.
  }
}

function retryAfter(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    // Even overflowing provider guidance must not turn into a short retry.
    return Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** A timer race also bounds injected fetch/streams that ignore AbortSignal. */
async function bounded<T>(
  work: () => Promise<T>,
  ms: number,
  timeoutError: KlaviyoReadError,
  abort: () => void = () => undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError);
          abort();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
    discard(response.body);
    throw new KlaviyoReadError("limit_exceeded");
  }
  if (!response.body) throw new KlaviyoReadError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new KlaviyoReadError("invalid_response");
      }
      if (signal.aborted) throw new KlaviyoReadError("unavailable");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new KlaviyoReadError("limit_exceeded");
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new KlaviyoReadError("invalid_response");
      }
    }
    try {
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch {
      throw new KlaviyoReadError("invalid_response");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export class KlaviyoReadTransport implements KlaviyoReadRequester {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(options: Options) {
    if (
      typeof options.privateApiKey !== "string" ||
      !options.privateApiKey.trim() ||
      /[^\x21-\x7e]/.test(options.privateApiKey)
    ) {
      throw new KlaviyoReadError("invalid_input");
    }
    this.#key = options.privateApiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  async request(input: KlaviyoReadInput): Promise<unknown> {
    const deadline = this.#now() + TOTAL_MS;
    let url: URL;
    let method: "GET" | "POST";
    let body: string | undefined;
    try {
      if (!Object.hasOwn(PATHS, input.resource)) throw new Error();
      method = input.resource === "campaignValues" ? "POST" : "GET";
      if (method === "GET" && input.body !== undefined) throw new Error();
      if (input.params !== undefined && !(input.params instanceof URLSearchParams)) throw new Error();
      url = new URL(PATHS[input.resource], "https://a.klaviyo.com");
      url.search = input.params?.toString() ?? "";
      if (input.body !== undefined) {
        body = JSON.stringify(input.body);
        if (body === undefined) throw new Error();
      }
    } catch {
      throw new KlaviyoReadError("invalid_input");
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) throw new KlaviyoReadError("limit_exceeded");
      const controller = new AbortController();
      let failure: KlaviyoReadError;
      try {
        const result = await bounded(async () => {
          let response: Response;
          try {
            response = await this.#fetch(url.toString(), {
              method,
              body,
              redirect: "error",
              credentials: "omit",
              cache: "no-store",
              signal: controller.signal,
              headers: {
                accept: "application/vnd.api+json",
                authorization: `Klaviyo-API-Key ${this.#key}`,
                revision: "2026-07-15",
                ...(body !== undefined ? { "content-type": "application/vnd.api+json" } : {}),
              },
            });
          } catch {
            throw new KlaviyoReadError("unavailable");
          }
          if (controller.signal.aborted) {
            discard(response.body);
            throw new KlaviyoReadError("unavailable");
          }
          if (response.redirected || (response.status >= 300 && response.status < 400)) {
            discard(response.body);
            throw new KlaviyoReadError("invalid_response");
          }
          if (!response.ok) {
            discard(response.body);
            const code = response.status === 429 ? "rate_limited"
              : response.status === 401 || response.status === 403 ? "credential_rejected"
              : response.status >= 500 ? "unavailable" : "invalid_response";
            throw new KlaviyoReadError(code, retryAfter(response.headers.get("retry-after"), this.#now()));
          }
          return readJson(response, controller.signal);
        }, Math.min(ATTEMPT_MS, remaining),
        new KlaviyoReadError(remaining <= ATTEMPT_MS ? "limit_exceeded" : "unavailable"),
        () => controller.abort());
        if (this.#now() >= deadline) throw new KlaviyoReadError("limit_exceeded");
        return result;
      } catch (error) {
        failure = error instanceof KlaviyoReadError ? error : new KlaviyoReadError("invalid_response");
      } finally {
        controller.abort();
      }
      if (!["rate_limited", "unavailable"].includes(failure.code) || attempt === MAX_ATTEMPTS - 1) {
        throw failure;
      }
      const jitter = Math.floor(Math.max(0, Math.min(1, this.#random())) * 250);
      const delay = Math.max(500 * 2 ** attempt + jitter, failure.retryAfterMs ?? 0);
      const waitBudget = deadline - this.#now();
      // Never clamp Retry-After to a shorter delay just to fit our budget.
      if (delay >= waitBudget) throw failure;
      await bounded(async () => {
        try {
          await this.#sleep(delay);
        } catch {
          throw new KlaviyoReadError("unavailable");
        }
      }, waitBudget, new KlaviyoReadError("limit_exceeded"));
    }
    throw new KlaviyoReadError("unavailable");
  }
}
