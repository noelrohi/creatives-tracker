import { describe, expect, it } from "vitest";
import { snapshotReportProviderWindow, canonicalSnapshotJson, canonicalizeSnapshotScope, snapshotScopeFingerprint, initialSnapshotCheckpoint, assertExactSnapshotCheckpoint, snapshotCheckpointComplete, buildSnapshotNotAvailable, encodeSnapshotReadContinuation, decodeSnapshotReadContinuation } from "./snapshot-contracts";

describe("snapshot contracts (not persistence verification)", () => {
  it("canonicalizes equivalent instants and metric-set ordering", () => {
    const a = { dataset: "events" as const, metricIds: ["B", "A"], since: "2026-09-01T02:00:00+02:00", until: "2026-09-02T00:00:00Z" };
    const b = { ...a, metricIds: ["A", "B"], since: "2026-09-01T00:00:00Z" };
    expect(snapshotScopeFingerprint(a)).toBe(snapshotScopeFingerprint(b));
    expect(canonicalizeSnapshotScope(a)).toMatchObject({ metricIds: ["A", "B"], since: "2026-09-01T00:00:00.000Z" });
    expect(snapshotScopeFingerprint({ ...b, until: "2026-09-03T00:00:00Z" })).not.toBe(snapshotScopeFingerprint(a));
  });
  it("retains numeric and null semantics in deterministic content hashing", () => {
    expect(canonicalSnapshotJson({ b: null, a: { d: 0.17, c: 0 } })).toBe(canonicalSnapshotJson({ a: { c: 0, d: 0.17 }, b: null }));
    expect(JSON.parse(canonicalSnapshotJson({ zero: 0, absent: null }))).toEqual({ zero: 0, absent: null });
  });
  it("distinguishes the initial position from completed empty collection", () => {
    const initial = initialSnapshotCheckpoint("metrics");
    expect(snapshotCheckpointComplete(initial)).toBe(false);
    expect(snapshotCheckpointComplete({ ...initial, page: 1 })).toBe(true);
    expect(() => assertExactSnapshotCheckpoint({ ...initial, providerUrl: "unsafe" })).toThrow();
    expect(() => assertExactSnapshotCheckpoint({ ...initial, dataset: "campaign_values", continuation: "abc" })).toThrow();
  });
  it("does not fabricate an empty dataset for absent scope", () => {
    const result = buildSnapshotNotAvailable("metrics", "not_synced");
    expect(result).toMatchObject({ state: "not_available", requiredSyncRequest: { dataset: "metrics" } });
    expect(result).not.toHaveProperty("metrics");
  });
  it.each([
    { dataset: "events", metricIds: ["A", "A"], since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" },
    { dataset: "events", metricIds: [], since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" },
    { dataset: "events", metricIds: ["A"], since: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" },
    { dataset: "events", metricIds: ["A"], since: "2025-01-01T00:00:00Z", until: "2026-09-01T00:00:00Z" },
  ] as const)("rejects invalid exact scopes: %j", scope => {
    expect(() => canonicalizeSnapshotScope({ ...scope, metricIds: [...scope.metricIds] })).toThrow();
  });
  it("encodes report provider wall clocks without asserting UTC or rounding statistics", () => {
    expect(snapshotReportProviderWindow({ since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" }, "America/New_York"))
      .toEqual({ start: "2026-08-31T20:00:00Z", end: "2026-09-01T19:59:59Z" });
    expect(snapshotReportProviderWindow({ since: "2026-09-01T00:00:00.100Z", until: "2026-09-01T00:00:00.500Z" }, "UTC"))
      .toEqual({ start: "2026-09-01T00:00:00.100Z", end: "2026-09-01T00:00:00.100Z" });
    expect(() => snapshotReportProviderWindow({ since: "2026-11-01T05:50:00Z", until: "2026-11-01T06:10:00Z" }, "America/New_York")).toThrow();
  });
  it("rejects provider state smuggled into the DB token position and mismatched dataset kinds", () => {
    const token = { version: 1, snapshotId: "id", dataset: "metrics", scopeFingerprint: "a".repeat(64), position: { resourceKind: "metric", orderingKey: "A", providerUrl: "https://provider.example" } };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(decodeSnapshotReadContinuation(encode(token))).toBeNull();
    expect(decodeSnapshotReadContinuation(encode({ ...token, position: { resourceKind: "event", orderingKey: "A" } }))).toBeNull();
    expect(decodeSnapshotReadContinuation("a".repeat(8193))).toBeNull();
  });
  it("rejects non-initial starting cursors and multi-page campaign reports", () => {
    expect(() => assertExactSnapshotCheckpoint({ dataset: "metrics", continuation: "cursor", page: 0 })).toThrow();
    expect(() => assertExactSnapshotCheckpoint({ dataset: "campaign_values", continuation: null, page: 2 })).toThrow();
  });
  it("encodes a pinned DB position and rejects provider continuation shapes", () => {
    const token = { version: 1 as const, snapshotId: "snapshot", dataset: "metrics" as const, scopeFingerprint: "a".repeat(64), position: { resourceKind: "metric" as const, orderingKey: "A" } };
    expect(decodeSnapshotReadContinuation(encodeSnapshotReadContinuation(token))).toEqual(token);
    expect(decodeSnapshotReadContinuation(Buffer.from(JSON.stringify({ cursor: "provider" })).toString("base64url"))).toBeNull();
  });
});
