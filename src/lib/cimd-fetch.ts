import "server-only";

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";

// Drop-in replacement for @better-auth/cimd/node's fetchClientMetadataResource.
// The upstream transport passes its pinned DNS answer to node:https with the
// legacy (err, address, family) callback shape, which Node >= 26 and Bun no
// longer accept when they request all addresses — every fetch fails with
// "Invalid IP address: undefined". Same behavior otherwise: HTTPS only,
// resolve-once DNS with public-routable validation, connection pinned to the
// first answer, redirects returned to the caller rather than followed.

const BODY_FORBIDDEN_STATUSES = new Set([204, 205, 304]);

function toResponseHeaders(headers: Record<string, string | string[] | undefined>) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

export const fetchClientMetadataResource = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const webRequest = new Request(input, init);
  const url = new URL(webRequest.url);
  if (url.protocol !== "https:") {
    throw new TypeError("CIMD transport requires an HTTPS URL");
  }
  if (webRequest.method !== "GET" && webRequest.method !== "HEAD") {
    throw new TypeError("CIMD transport supports only GET and HEAD");
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new TypeError("metadata hostname returned no DNS addresses");
  }
  for (const result of addresses) {
    if (!isPublicRoutableHost(result.address)) {
      throw new TypeError(
        "metadata hostname must resolve only to public-routable addresses",
      );
    }
  }
  const pinned = addresses[0];

  const headers = Object.fromEntries(webRequest.headers.entries());
  headers.host = url.host;
  const signal =
    init?.signal ??
    (input instanceof Request ? input.signal : webRequest.signal);

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        agent: false,
        headers,
        method: webRequest.method,
        servername:
          isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0
            ? url.hostname
            : undefined,
        signal: signal ?? undefined,
        lookup: (_hostname, options, callback) => {
          // Node decides the callback shape via options.all.
          if (typeof options === "object" && options?.all) {
            (callback as unknown as (
              err: Error | null,
              addresses: { address: string; family: number }[],
            ) => void)(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      },
      (response) => {
        const status = response.statusCode ?? 500;
        const body =
          webRequest.method === "HEAD" || BODY_FORBIDDEN_STATUSES.has(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream);
        resolve(
          new Response(body, {
            headers: toResponseHeaders(response.headers),
            status,
            statusText: response.statusMessage,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
};
