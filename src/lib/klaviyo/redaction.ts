import { createHash } from "node:crypto";
import type {
  JsonType,
  JsonValue,
  RedactedEventEvidence,
} from "@/lib/klaviyo/types";

export const REDACTED_PROPERTY_MAX_KEYS = 64;
export const REDACTED_PROPERTY_MAX_DEPTH = 3;
export const REDACTED_PROPERTY_MAX_BYTES = 16 * 1024;
export const FINGERPRINT_MAX_KEYS = 128;

const MAX_PROPERTY_KEY_BYTES = 512;
const MAX_TEXT_CODE_POINTS = 512;
const EMAIL_REPLACE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_DETECT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REPLACE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const PHONE_DETECT = /(?:\+?\d[\d\s().-]{7,}\d)/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;
const EXACT_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IDENTITY_PATH_LABELS = new Set([
  "profile",
  "profiles",
  "customer",
  "customers",
  "person",
  "persons",
  "people",
  "user",
  "users",
  "identity",
  "identities",
]);

function invalidInput(): never {
  throw new Error("Klaviyo event redaction input is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24);
}

function snapshotStringSet(
  value: ReadonlySet<string>,
  kind: "approved" | "host",
): Set<string> {
  let entries: unknown[];
  try {
    entries = Array.from(Set.prototype.values.call(value) as Iterable<unknown>);
  } catch {
    invalidInput();
  }
  const result = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") invalidInput();
    const normalized = kind === "host" ? entry.trim().toLowerCase() : entry;
    if (
      normalized.length === 0 ||
      CONTROL_CHARACTER.test(normalized) ||
      Buffer.byteLength(normalized, "utf8") > MAX_PROPERTY_KEY_BYTES ||
      (kind === "host" && !EXACT_HOSTNAME_PATTERN.test(normalized))
    ) {
      invalidInput();
    }
    result.add(normalized);
  }
  return result;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) return null;
  const cleaned = value
    .trim()
    .replace(EMAIL_REPLACE, "[redacted]")
    .replace(PHONE_REPLACE, "[redacted]");
  return Array.from(cleaned).slice(0, MAX_TEXT_CODE_POINTS).join("");
}

type DecodedSegment =
  | { kind: "dot" }
  | { kind: "redacted" }
  | { kind: "safe"; value: string };

function decodePathSegment(rawSegment: string): DecodedSegment {
  let value = rawSegment;
  for (let depth = 0; depth <= REDACTED_PROPERTY_MAX_DEPTH; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return { kind: "redacted" };
    }
    if (decoded === value) break;
    value = decoded;
  }
  if (value === "." || value === "..") return { kind: "dot" };
  if (
    CONTROL_CHARACTER.test(value) ||
    /[/\\?#]/.test(value) ||
    /%[0-9a-f]{2}/i.test(value)
  ) {
    return { kind: "redacted" };
  }
  return { kind: "safe", value };
}

function printablePathSegment(value: string): string {
  return encodeURIComponent(value)
    .replace(/%5B/gi, "[")
    .replace(/%5D/gi, "]")
    .replace(/%3A/gi, ":")
    .replace(/%40/gi, "@");
}

function safePathname(rawPathname: string): string | null {
  let redactNextIdentitySegment = false;
  const output: string[] = [];
  for (const rawSegment of rawPathname.split("/")) {
    const decoded = decodePathSegment(rawSegment);
    if (decoded.kind === "dot") return null;
    if (decoded.kind === "redacted") {
      output.push("[redacted]");
      if (redactNextIdentitySegment) redactNextIdentitySegment = false;
      continue;
    }
    const segment = decoded.value;
    if (segment.length === 0) {
      output.push("");
      continue;
    }
    const isIdentityLabel = IDENTITY_PATH_LABELS.has(
      segment.trim().toLowerCase(),
    );
    if (redactNextIdentitySegment) {
      output.push("[redacted]");
      redactNextIdentitySegment = isIdentityLabel;
      continue;
    }
    if (isIdentityLabel) {
      output.push(printablePathSegment(segment.slice(0, 96)));
      redactNextIdentitySegment = true;
      continue;
    }
    if (
      EMAIL_DETECT.test(segment) ||
      PHONE_DETECT.test(segment) ||
      OPAQUE_SEGMENT.test(segment)
    ) {
      output.push("[redacted]");
      continue;
    }
    output.push(printablePathSegment(Array.from(segment).slice(0, 96).join("")));
  }
  return output.join("/");
}

function rawAbsolutePath(value: string): string | null {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return null;
  const authorityStart = schemeEnd + 3;
  const pathStart = value.indexOf("/", authorityStart);
  if (pathStart < 0) return "/";
  const queryStart = value.indexOf("?", pathStart);
  const fragmentStart = value.indexOf("#", pathStart);
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, value.length].filter((index) => index >= 0),
  );
  return value.slice(pathStart, pathEnd);
}

function safeUrl(
  value: unknown,
  merchantHosts: ReadonlySet<string>,
): string | null {
  if (
    typeof value !== "string" ||
    CONTROL_CHARACTER.test(value) ||
    value.includes("\\")
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !merchantHosts.has(url.hostname.toLowerCase())
  ) {
    return null;
  }
  const rawPath = rawAbsolutePath(value);
  if (rawPath === null) return null;
  const path = safePathname(rawPath);
  return path === null ? null : `${url.origin}${path}`;
}

function safeRelativePath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    CONTROL_CHARACTER.test(value) ||
    value.includes("\\")
  ) {
    return null;
  }
  const queryStart = value.indexOf("?");
  const fragmentStart = value.indexOf("#");
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, value.length].filter((index) => index >= 0),
  );
  return safePathname(value.slice(0, pathEnd));
}

function approvedValue(
  key: string,
  value: unknown,
  merchantHosts: ReadonlySet<string>,
): JsonValue | undefined {
  if (/url|link|referrer/i.test(key)) {
    return safeUrl(value, merchantHosts) ?? undefined;
  }
  if (
    /path|page/i.test(key) ||
    (typeof value === "string" && value.startsWith("/"))
  ) {
    return (
      safeRelativePath(value) ?? safeUrl(value, merchantHosts) ?? undefined
    );
  }
  if (
    typeof value === "string" &&
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  ) {
    return safeUrl(value, merchantHosts) ?? undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return boundedText(value) ?? undefined;
}

export function redactEventProperties(
  properties: Record<string, unknown>,
  approvedKeys: ReadonlySet<string>,
  merchantHosts: ReadonlySet<string>,
): RedactedEventEvidence {
  if (!isRecord(properties)) invalidInput();
  const approvedSnapshot = snapshotStringSet(approvedKeys, "approved");
  const hostSnapshot = snapshotStringSet(merchantHosts, "host");
  let keys: string[];
  try {
    keys = Object.keys(properties).sort();
  } catch {
    invalidInput();
  }

  const values: Record<string, JsonValue> = {};
  const fingerprint: RedactedEventEvidence["fingerprint"] = [];
  let truncated = keys.length > FINGERPRINT_MAX_KEYS;

  for (const key of keys.slice(0, FINGERPRINT_MAX_KEYS)) {
    let value: unknown;
    try {
      value = properties[key];
    } catch {
      invalidInput();
    }
    const keyWithinBounds =
      !CONTROL_CHARACTER.test(key) &&
      Buffer.byteLength(key, "utf8") <= MAX_PROPERTY_KEY_BYTES;
    const approved = keyWithinBounds && approvedSnapshot.has(key);
    fingerprint.push({
      key: approved ? key : hashKey(key),
      keyKind: approved ? "approved" : "sha256",
      type: jsonType(value),
    });
    if (!approved) continue;
    if (Object.keys(values).length >= REDACTED_PROPERTY_MAX_KEYS) {
      truncated = true;
      continue;
    }
    const normalized = approvedValue(key, value, hostSnapshot);
    if (normalized !== undefined) values[key] = normalized;
  }

  while (
    Buffer.byteLength(JSON.stringify(values), "utf8") >
    REDACTED_PROPERTY_MAX_BYTES
  ) {
    const lastKey = Object.keys(values).at(-1);
    if (!lastKey) break;
    delete values[lastKey];
    truncated = true;
  }

  return {
    values,
    fingerprint,
    warnings: truncated ? ["redacted_evidence_truncated"] : [],
    truncated,
  };
}
