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
export const REDACTED_PROPERTY_MAX_RAW_KEYS = 256;
export const KLAVIYO_RAW_STRING_MAX_UTF16_UNITS = 20_000;
export const KLAVIYO_RAW_STRING_MAX_UTF8_BYTES = 16_000;
export const KLAVIYO_RAW_STRING_MAX_CODE_POINTS = 10_000;
export const KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES = 512;

const MAX_PROPERTY_KEY_BYTES = KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES;
const MAX_TEXT_CODE_POINTS = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;
const INTERNATIONAL_EMAIL =
  /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}/giu;
const PHONE_CANDIDATE = /(?:\+|00)?\d[\d\s().-]{6,}\d/gu;
const BARE_PHONE_STRING = /^\s*\d{10,15}\s*$/u;
const JWT_CREDENTIAL =
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const BEARER_CREDENTIAL = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const BASIC_CREDENTIAL = /\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})(?=\s|$)/gi;
const NAMED_CREDENTIAL =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)\s*[:=]\s*\S+/i;
const PREFIXED_CREDENTIAL =
  /\b(?:(?:sk|pk|rk)_(?:(?:live|test|prod)_)?[A-Za-z0-9_-]{12,}|shp(?:at|ca|pa|ss|ua)_[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{12,})\b/i;
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

export function isKlaviyoRawStringWithinBounds(value: string): boolean {
  if (value.length > KLAVIYO_RAW_STRING_MAX_UTF16_UNITS) return false;
  if (Buffer.byteLength(value, "utf8") > KLAVIYO_RAW_STRING_MAX_UTF8_BYTES) {
    return false;
  }
  let codePoints = 0;
  for (const character of value) {
    if (character.length > 0) codePoints += 1;
    if (codePoints > KLAVIYO_RAW_STRING_MAX_CODE_POINTS) return false;
  }
  return true;
}

function normalizedDecodedString(value: string): string | null {
  if (!isKlaviyoRawStringWithinBounds(value)) return null;
  let normalized = value.normalize("NFKC");
  if (!isKlaviyoRawStringWithinBounds(normalized)) return null;
  for (let depth = 0; depth <= REDACTED_PROPERTY_MAX_DEPTH; depth += 1) {
    if (!/%[0-9a-f]{2}/i.test(normalized)) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(normalized);
    } catch {
      return null;
    }
    normalized = decoded.normalize("NFKC");
    if (!isKlaviyoRawStringWithinBounds(normalized)) return null;
  }
  return /%[0-9a-f]{2}/i.test(normalized) ? null : normalized;
}

function phoneRanges(value: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of value.matchAll(PHONE_CANDIDATE)) {
    const candidate = match[0];
    const start = match.index;
    const previous = start > 0 ? value[start - 1] : "";
    const next = value[start + candidate.length] ?? "";
    const digits = candidate.replace(/\D/g, "");
    const separators = candidate.match(/[\s().-]/g)?.length ?? 0;
    const digitGroups = candidate.match(/\d+/g) ?? [];
    const firstGroup = digitGroups.at(0);
    const lastGroup = digitGroups.at(-1);
    const plausibleSeparatedPhone =
      separators >= 2 &&
      digitGroups.length >= 3 &&
      firstGroup !== undefined &&
      lastGroup !== undefined &&
      firstGroup.length <= 3 &&
      lastGroup.length <= 4 &&
      digitGroups.slice(1, -1).every((group) => group.length <= 4);
    const hasTelephoneShape =
      candidate.startsWith("+") ||
      candidate.startsWith("00") ||
      /[()]/.test(candidate) ||
      plausibleSeparatedPhone;
    if (
      digits.length >= 8 &&
      digits.length <= 15 &&
      hasTelephoneShape &&
      !/[A-Za-z0-9_-]/.test(previous) &&
      !/[A-Za-z0-9_-]/.test(next)
    ) {
      ranges.push([start, start + candidate.length]);
    }
  }
  return ranges;
}

function hasCredentialShape(value: string): boolean {
  return (
    JWT_CREDENTIAL.test(value) ||
    BEARER_CREDENTIAL.test(value) ||
    hasBasicCredential(value) ||
    NAMED_CREDENTIAL.test(value) ||
    PREFIXED_CREDENTIAL.test(value)
  );
}

function hasBasicCredential(value: string): boolean {
  for (const match of value.matchAll(BASIC_CREDENTIAL)) {
    const token = match[1];
    let decoded: string;
    try {
      const bytes = Buffer.from(token, "base64");
      const canonical = bytes.toString("base64").replace(/=+$/, "");
      if (canonical !== token.replace(/=+$/, "")) continue;
      decoded = bytes.toString("utf8");
    } catch {
      continue;
    }
    if (decoded.includes(":")) return true;
  }
  return false;
}

function replaceSensitiveText(value: string): string {
  const emailRedacted = value.replace(INTERNATIONAL_EMAIL, "[redacted]");
  const ranges = phoneRanges(emailRedacted);
  if (ranges.length === 0) return emailRedacted;
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    result += `${emailRedacted.slice(cursor, start)}[redacted]`;
    cursor = end;
  }
  return result + emailRedacted.slice(cursor);
}

export function sanitizeKlaviyoSensitiveString(
  value: string,
  mode: "identifier" | "text",
): string | null {
  const normalized = normalizedDecodedString(value);
  if (
    normalized === null ||
    CONTROL_CHARACTER.test(normalized) ||
    hasCredentialShape(normalized) ||
    (mode === "text" && BARE_PHONE_STRING.test(normalized))
  ) {
    return null;
  }
  const redacted = replaceSensitiveText(normalized);
  if (mode === "identifier" && redacted !== normalized) return null;
  if (mode === "identifier" || redacted === normalized) return value;
  return redacted;
}

export function isKlaviyoProviderOpaqueId(value: string): boolean {
  const safe = sanitizeKlaviyoSensitiveString(value, "identifier");
  return (
    safe === value &&
    value.length <= 256 &&
    /^(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
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
      normalized.length > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
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
  if (typeof value !== "string") return null;
  const sanitized = sanitizeKlaviyoSensitiveString(value, "text");
  if (sanitized === null) return null;
  const cleaned = sanitized.trim();
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
      redactNextIdentitySegment = true;
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
    const sanitizedSegment = sanitizeKlaviyoSensitiveString(segment, "text");
    if (
      sanitizedSegment === null ||
      sanitizedSegment !== segment ||
      OPAQUE_SEGMENT.test(segment)
    ) {
      output.push("[redacted]");
      redactNextIdentitySegment = true;
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
  const authorityEnd = Math.min(
    ...[
      value.indexOf("/", authorityStart),
      value.indexOf("?", authorityStart),
      value.indexOf("#", authorityStart),
      value.length,
    ].filter((index) => index >= 0),
  );
  if (value[authorityEnd] !== "/") return "/";
  const pathStart = authorityEnd;
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
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
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
  const rawPath = rawAbsolutePath(candidate);
  if (rawPath === null) return null;
  const path = safePathname(rawPath);
  return path === null ? null : `${url.origin}${path}`;
}

function safeRelativePath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    CONTROL_CHARACTER.test(value) ||
    value.includes("\\")
  ) {
    return null;
  }
  const candidate = value.trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
  const queryStart = candidate.indexOf("?");
  const fragmentStart = candidate.indexOf("#");
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, candidate.length].filter(
      (index) => index >= 0,
    ),
  );
  return safePathname(candidate.slice(0, pathEnd));
}

function approvedValue(
  key: string,
  value: unknown,
  merchantHosts: ReadonlySet<string>,
): JsonValue | undefined {
  const classifiedValue =
    typeof value === "string" && !CONTROL_CHARACTER.test(value)
      ? value.trim()
      : value;
  if (/url|link|referrer/i.test(key)) {
    return safeUrl(classifiedValue, merchantHosts) ?? undefined;
  }
  if (
    /path|page/i.test(key) ||
    (typeof classifiedValue === "string" && classifiedValue.startsWith("/"))
  ) {
    return (
      safeRelativePath(classifiedValue) ??
      safeUrl(classifiedValue, merchantHosts) ??
      undefined
    );
  }
  if (
    typeof classifiedValue === "string" &&
    /^[a-z][a-z0-9+.-]*:\/\//i.test(classifiedValue)
  ) {
    return safeUrl(classifiedValue, merchantHosts) ?? undefined;
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
    keys = Object.keys(properties);
  } catch {
    invalidInput();
  }
  if (keys.length > REDACTED_PROPERTY_MAX_RAW_KEYS) invalidInput();
  for (const key of keys) {
    if (
      key.length > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
      Buffer.byteLength(key, "utf8") > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
      CONTROL_CHARACTER.test(key)
    ) {
      invalidInput();
    }
  }
  keys.sort();

  const values = Object.create(null) as Record<string, JsonValue>;
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
    if (typeof value === "string" && !isKlaviyoRawStringWithinBounds(value)) {
      invalidInput();
    }
    if (Object.keys(values).length >= REDACTED_PROPERTY_MAX_KEYS) {
      truncated = true;
      continue;
    }
    const normalized = approvedValue(key, value, hostSnapshot);
    if (normalized !== undefined) {
      Object.defineProperty(values, key, {
        configurable: true,
        enumerable: true,
        value: normalized,
        writable: true,
      });
    }
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
