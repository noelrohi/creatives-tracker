import "server-only";

import type { ResolvedGoogleAdsCredential } from "@/lib/google-ads/credential-provider";

/**
 * Pinned per the spec: one named version constant recorded on every row and
 * run. Verify against the current release during sandbox bring-up and bump
 * here only (sandbox runbook step 6).
 */
export const GOOGLE_ADS_API_VERSION = "v21";

const GOOGLE_ADS_ORIGIN = "https://googleads.googleapis.com";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 60_000;
/**
 * Per-request abort: a stalled-open connection never rejects on its own,
 * which starves the whole batch until the task's maxDuration kills it.
 * Passing the signal straight into fetch (rather than clearing a timer once
 * headers arrive) means the budget also covers reading the response body,
 * so a stalled body read is converted into a retryable failure too.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh slightly early so an in-flight request never carries an expired token. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;
/** Floor for cached token lifetime so a sub-slack expires_in can't cause a refresh storm. */
const MIN_TOKEN_LIFETIME_MS = 30_000;

export class GoogleAdsApiError extends Error {
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
    this.name = "GoogleAdsApiError";
  }
}

export type GoogleAdsSearchRow = Record<string, unknown>;

export type GoogleAdsSearchPage = {
  results: GoogleAdsSearchRow[];
  nextPageToken: string | null;
  apiVersion: string;
};

type ClientOptions = {
  credential: ResolvedGoogleAdsCredential;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
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

function isRetryableStatus(status: number): boolean {
  // 401 is deliberately excluded: it gets a single forced-refresh retry
  // handled separately in `search`, not the generic backoff-and-retry path.
  return status === 408 || status === 429 || status >= 500;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Reads a JSON body with the same abort budget the request was made under.
 * A timeout that fires mid-body-read must be classified as a retryable
 * transport failure, not conflated with a genuinely malformed payload.
 */
async function readJson(response: Response, malformedMessage: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new GoogleAdsApiError("Google Ads request failed to complete", null, true);
    }
    throw new GoogleAdsApiError(malformedMessage, null, false);
  }
}

export class GoogleAdsClient {
  readonly #credential: ResolvedGoogleAdsCredential;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;
  #tokenRefresh: Promise<string> | null = null;

  constructor(options: ClientOptions) {
    this.#credential = options.credential;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async #fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GoogleAdsApiError("Google Ads request failed to complete", null, true);
    }
  }

  async #getAccessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt) {
      return this.#accessToken;
    }
    // Single-flight: concurrent callers share one refresh.
    this.#tokenRefresh ??= this.#refreshAccessToken().finally(() => {
      this.#tokenRefresh = null;
    });
    return this.#tokenRefresh;
  }

  async #refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.#credential.oauthClientId,
      client_secret: this.#credential.oauthClientSecret,
      refresh_token: this.#credential.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await this.#fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      discardResponseBody(response);
      // invalid_grant / invalid_client are configuration failures; retrying
      // cannot fix them and 5xx from the token endpoint is rare enough to
      // surface rather than mask. Transport-level failures (network errors,
      // timeouts) never reach here — #fetchWithTimeout throws a retryable
      // GoogleAdsApiError for those before a response exists.
      throw new GoogleAdsApiError(
        "Google Ads OAuth token refresh was rejected",
        response.status,
        false,
      );
    }
    const payload = await readJson(response, "Google Ads OAuth token response was malformed");
    const record = payload as { access_token?: unknown; expires_in?: unknown };
    if (
      typeof record.access_token !== "string" ||
      typeof record.expires_in !== "number" ||
      !Number.isFinite(record.expires_in) ||
      record.expires_in <= 0
    ) {
      throw new GoogleAdsApiError("Google Ads OAuth token response was malformed", null, false);
    }
    this.#accessToken = record.access_token;
    this.#accessTokenExpiresAt =
      Date.now() +
      Math.max(record.expires_in * 1_000 - TOKEN_EXPIRY_SLACK_MS, MIN_TOKEN_LIFETIME_MS);
    return this.#accessToken;
  }

  /** Runs one GAQL search page against the pilot customer account. */
  async search(params: {
    query: string;
    pageToken?: string | null;
  }): Promise<GoogleAdsSearchPage> {
    const url = `${GOOGLE_ADS_ORIGIN}/${GOOGLE_ADS_API_VERSION}/customers/${this.#credential.customerId}/googleAds:search`;
    // Hoisted above the retry loop: a serialization TypeError here is a
    // caller bug, not a transport failure, and must not be misclassified
    // as retryable by the fetch try/catch below.
    const requestBody = JSON.stringify({
      query: params.query,
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
    });

    let lastError: GoogleAdsApiError | null = null;
    let unauthorizedRetried = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let token: string;
      try {
        token = await this.#getAccessToken();
      } catch (error) {
        const apiError =
          error instanceof GoogleAdsApiError
            ? error
            : new GoogleAdsApiError("Google Ads request failed to complete", null, true);
        // A rejected token (invalid_grant, malformed payload) can't be
        // fixed by retrying; only a transport-level failure backs off.
        if (!apiError.retryable) throw apiError;
        lastError = apiError;
        await this.#backoff(attempt, null);
        continue;
      }

      let response: Response;
      try {
        response = await this.#fetchWithTimeout(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "developer-token": this.#credential.developerToken,
            "login-customer-id": this.#credential.loginCustomerId,
            "content-type": "application/json",
          },
          body: requestBody,
        });
      } catch (error) {
        lastError =
          error instanceof GoogleAdsApiError
            ? error
            : new GoogleAdsApiError("Google Ads request failed to complete", null, true);
        if (!lastError.retryable) throw lastError;
        await this.#backoff(attempt, null);
        continue;
      }

      if (response.status === 401) {
        discardResponseBody(response);
        // Force a fresh token and retry exactly once; a second consecutive
        // 401 means the credential itself is bad, not just stale.
        this.#accessToken = null;
        this.#accessTokenExpiresAt = 0;
        if (unauthorizedRetried) {
          throw new GoogleAdsApiError(
            "Google Ads search was rejected (HTTP 401)",
            401,
            false,
          );
        }
        unauthorizedRetried = true;
        continue;
      }

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        const retryAfterMs = retryable
          ? parseRetryAfter(response.headers.get("retry-after"))
          : null;
        if (retryable && retryAfterMs !== null && retryAfterMs > MAX_RETRY_DELAY_MS) {
          // The provider is asking for a wait longer than this client will
          // ever sleep for. Surface it as a retryable error carrying the
          // full delay so a durable caller (Trigger.dev retry) reschedules
          // instead of us hammering the API on a shortened clock.
          discardResponseBody(response);
          throw new GoogleAdsApiError(
            `Google Ads search retry delay exceeds client limit (HTTP ${response.status})`,
            response.status,
            true,
            retryAfterMs,
          );
        }
        discardResponseBody(response);
        lastError = new GoogleAdsApiError(
          `Google Ads search was rejected (HTTP ${response.status})`,
          response.status,
          retryable,
          retryAfterMs,
        );
        if (!retryable) throw lastError;
        await this.#backoff(attempt, retryAfterMs);
        continue;
      }

      const payload = await readJson(response, "Google Ads search response was malformed");
      const record = payload as { results?: unknown; nextPageToken?: unknown };
      const results = record.results ?? [];
      if (
        !Array.isArray(results) ||
        results.some((row) => typeof row !== "object" || row === null || Array.isArray(row)) ||
        (record.nextPageToken !== undefined &&
          record.nextPageToken !== null &&
          typeof record.nextPageToken !== "string")
      ) {
        throw new GoogleAdsApiError("Google Ads search response was malformed", null, false);
      }
      return {
        results: results as GoogleAdsSearchRow[],
        nextPageToken:
          typeof record.nextPageToken === "string" && record.nextPageToken.length > 0
            ? record.nextPageToken
            : null,
        apiVersion: GOOGLE_ADS_API_VERSION,
      };
    }

    throw lastError ??
      new GoogleAdsApiError("Google Ads search failed after retries", null, true);
  }

  async #backoff(attempt: number, retryAfterMs: number | null): Promise<void> {
    if (attempt >= MAX_ATTEMPTS) return;
    const base = Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    const jitter = base * 0.25 * this.#random();
    const delay = Math.min(
      Math.max(retryAfterMs ?? 0, base + jitter),
      MAX_RETRY_DELAY_MS,
    );
    await this.#sleep(delay);
  }
}
