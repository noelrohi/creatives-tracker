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
/** A stalled-open connection never rejects on its own; abort converts it into a retryable failure. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh slightly early so an in-flight request never carries an expired token. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
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
  return status === 408 || status === 429 || status >= 500;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch {
      throw new GoogleAdsApiError("Google Ads request failed to complete", null, true);
    } finally {
      clearTimeout(timer);
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
      // surface rather than mask.
      throw new GoogleAdsApiError(
        "Google Ads OAuth token refresh was rejected",
        response.status,
        false,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GoogleAdsApiError("Google Ads OAuth token response was malformed", null, false);
    }
    const record = payload as { access_token?: unknown; expires_in?: unknown };
    if (typeof record.access_token !== "string" || typeof record.expires_in !== "number") {
      throw new GoogleAdsApiError("Google Ads OAuth token response was malformed", null, false);
    }
    this.#accessToken = record.access_token;
    this.#accessTokenExpiresAt =
      Date.now() + record.expires_in * 1_000 - TOKEN_EXPIRY_SLACK_MS;
    return this.#accessToken;
  }

  /** Runs one GAQL search page against the pilot customer account. */
  async search(params: {
    query: string;
    pageToken?: string | null;
  }): Promise<GoogleAdsSearchPage> {
    const url = `${GOOGLE_ADS_ORIGIN}/${GOOGLE_ADS_API_VERSION}/customers/${this.#credential.customerId}/googleAds:search`;
    let lastError: GoogleAdsApiError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const token = await this.#getAccessToken();
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
          body: JSON.stringify({
            query: params.query,
            ...(params.pageToken ? { pageToken: params.pageToken } : {}),
          }),
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

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        discardResponseBody(response);
        const retryable = isRetryableStatus(response.status);
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

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new GoogleAdsApiError("Google Ads search response was malformed", null, false);
      }
      const record = payload as { results?: unknown; nextPageToken?: unknown };
      const results = record.results ?? [];
      if (
        !Array.isArray(results) ||
        results.some((row) => typeof row !== "object" || row === null || Array.isArray(row)) ||
        (record.nextPageToken !== undefined && typeof record.nextPageToken !== "string")
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
