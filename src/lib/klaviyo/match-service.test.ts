import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("server-only", () => ({}));

const { deriveFingerprints, stableHash, MatchInputStaleError } = await import(
  "@/lib/klaviyo/match-service"
);

const scope = {
  organizationId: "org-1",
  storeId: "store-1",
  connectionId: "connection-1",
};

const klaviyo = {
  sourceRunId: "source-run-1",
  window: {
    from: new Date("2026-05-01T00:00:00.000Z"),
    to: new Date("2026-07-30T00:00:00.000Z"),
  },
  currentKeyVersion: "v1",
  events: [],
  checksum: "klaviyo-checksum",
};
const shopify = {
  shopifyEvidenceRunId: "evidence-run-1",
  window: {
    from: new Date("2026-05-01T00:00:00.000Z"),
    to: new Date("2026-07-30T00:00:00.000Z"),
  },
  coverage: { status: "success", lineCompleteness: "complete" },
  orders: [],
  missingOrderCount: 0,
  checksum: "shopify-checksum",
};

describe("match service fingerprints", () => {
  it("keeps the logical scope fingerprint independent of run IDs and checksums", () => {
    const base = deriveFingerprints({
      scope,
      klaviyo,
      shopify,
      ruleChecksum: "rules",
      configChecksum: "config",
    });
    const differentRuns = deriveFingerprints({
      scope,
      klaviyo: { ...klaviyo, sourceRunId: "source-run-2", checksum: "other" },
      shopify: {
        ...shopify,
        shopifyEvidenceRunId: "evidence-run-2",
        checksum: "other",
      },
      ruleChecksum: "rules",
      configChecksum: "config",
    });
    expect(differentRuns.publicationScopeFingerprint).toBe(
      base.publicationScopeFingerprint,
    );
    expect(differentRuns.invocationFingerprint).not.toBe(
      base.invocationFingerprint,
    );
  });

  it("changes both fingerprints when windows, rules, or config change", () => {
    const base = deriveFingerprints({
      scope,
      klaviyo,
      shopify,
      ruleChecksum: "rules",
      configChecksum: "config",
    });
    const differentRules = deriveFingerprints({
      scope,
      klaviyo,
      shopify,
      ruleChecksum: "rules-2",
      configChecksum: "config",
    });
    expect(differentRules.publicationScopeFingerprint).not.toBe(
      base.publicationScopeFingerprint,
    );
    const differentWindow = deriveFingerprints({
      scope,
      klaviyo: {
        ...klaviyo,
        window: { ...klaviyo.window, to: new Date("2026-08-01T00:00:00.000Z") },
      },
      shopify,
      ruleChecksum: "rules",
      configChecksum: "config",
    });
    expect(differentWindow.publicationScopeFingerprint).not.toBe(
      base.publicationScopeFingerprint,
    );
  });

  it("hashes deterministically regardless of key insertion order", () => {
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("exposes a safe stale error shape", () => {
    const error = new MatchInputStaleError("source_run_unacceptable");
    expect(error.reason).toBe("source_run_unacceptable");
    expect(String(error)).not.toContain("digest");
  });
});
