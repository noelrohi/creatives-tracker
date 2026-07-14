import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function isPrivateAddress(address: string) {
  const version = isIP(address.replace(/^\[|\]$/g, ""));
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export function isHttpUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function assertPublicHttpUrl(value: string) {
  const url = new URL(value);
  if (!isHttpUrl(value) || url.username || url.password) {
    throw new Error("Reference image URL must be a public HTTP(S) URL");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Reference image URL resolves to a private or reserved address");
  }

  return url;
}

async function readLimitedBody(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Reference image exceeds the 10 MB limit");
  }
  if (!response.body) throw new Error("Reference image response had no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Reference image exceeds the 10 MB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const image = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    image.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return image;
}

export async function fetchRemoteImage(value: string) {
  let url = await assertPublicHttpUrl(value);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "image/*" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new Error("Reference image redirected too many times");
      }
      url = await assertPublicHttpUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch reference image: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (!contentType?.startsWith("image/")) {
      await response.body?.cancel();
      throw new Error("Reference image URL did not return an image");
    }

    return readLimitedBody(response);
  }

  throw new Error("Reference image redirected too many times");
}
