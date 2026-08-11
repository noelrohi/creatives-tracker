import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("server-only", () => ({}));

const { runIncrementalConnection } = await import(
  "@/lib/klaviyo/incremental-sync"
);
type Children = Parameters<typeof runIncrementalConnection>[1];

const scope = {
  organizationId: "org-1",
  storeId: "store-1",
  connectionId: "connection-1",
};

function children(overrides: Partial<Children> = {}): {
  children: Children;
  calls: string[];
} {
  const calls: string[] = [];
  const track = <T,>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  const base: Children = {
    runShopifyEvidence: vi.fn(async () =>
      track("shopify_evidence", {
        ok: true,
        evidenceRunId: "evidence-run-1",
        status: "success" as const,
        lineCompleteness: "complete" as const,
      }),
    ),
    runOrderCore: vi.fn(async () =>
      track("order_core", {
        syncRunId: "source-run-1",
        status: "success" as const,
        checkpointNull: true,
        orderCoreParameters: true,
      }),
    ),
    runMatching: vi.fn(async () =>
      track("matching", { published: true, matchRunId: "match-run-1" }),
    ),
    startClaims: vi.fn(async () =>
      track("claims_start", {
        kind: "started" as const,
        claimReplayId: "graph-1",
      }),
    ),
    runClaimGraph: vi.fn(async () =>
      track("claims_graph", { status: "success" as const }),
    ),
    recoverClaims: vi.fn(async () => {
      calls.push("claims_recover");
    }),
    runJourney: vi.fn(async () => track("journey", { ok: true })),
    runDimensions: vi.fn(async () => track("dimensions", { ok: true })),
    runReports: vi.fn(async () => track("reports", { ok: true })),
  };
  return { children: { ...base, ...overrides }, calls };
}

describe("runIncrementalConnection", () => {
  it("runs the strict core chain in order and then enrichment sequentially", async () => {
    const { children: fakes, calls } = children();
    const report = await runIncrementalConnection({ scope }, fakes);
    expect(calls).toEqual([
      "shopify_evidence",
      "order_core",
      "matching",
      "claims_start",
      "claims_graph",
      "journey",
      "dimensions",
      "reports",
    ]);
    expect(report).toMatchObject({
      shopify_evidence: { state: "completed" },
      order_core: { state: "completed" },
      matching: { state: "completed" },
      claims: { state: "completed" },
      journey: { state: "completed" },
      dimensions: { state: "completed" },
      reports: { state: "completed" },
    });
  });

  it("launches no dependent on unacceptable evidence coverage", async () => {
    for (const evidence of [
      { ok: false, evidenceRunId: null, status: "failed", lineCompleteness: "unavailable" },
      { ok: true, evidenceRunId: "run-x", status: "running", lineCompleteness: "unavailable" },
      { ok: true, evidenceRunId: "run-x", status: "failed", lineCompleteness: "complete" },
      { ok: true, evidenceRunId: "run-x", status: "success", lineCompleteness: "unavailable" },
    ] as const) {
      const { children: fakes } = children({
        runShopifyEvidence: vi.fn(async () => evidence),
      });
      const report = await runIncrementalConnection({ scope }, fakes);
      expect(["failed", "pending"]).toContain(report.shopify_evidence.state);
      expect(fakes.runOrderCore).not.toHaveBeenCalled();
      expect(fakes.runMatching).not.toHaveBeenCalled();
      expect(fakes.runJourney).not.toHaveBeenCalled();
    }
  });

  it("accepts policy-labelled partial evidence but stays visibly partial", async () => {
    const { children: fakes } = children({
      runShopifyEvidence: vi.fn(async () => ({
        ok: true,
        evidenceRunId: "evidence-run-1",
        status: "partial" as const,
        lineCompleteness: "partial" as const,
      })),
    });
    const report = await runIncrementalConnection({ scope }, fakes);
    expect(report.shopify_evidence).toEqual({
      state: "completed",
      detail: "partial_visible",
    });
    expect(fakes.runOrderCore).toHaveBeenCalled();
  });

  it("launches neither matching nor claims on a bad order-core outcome", async () => {
    for (const orderCore of [
      { syncRunId: "run-1", status: "partial", checkpointNull: true, orderCoreParameters: true },
      { syncRunId: "run-1", status: "running", checkpointNull: false, orderCoreParameters: true },
      { syncRunId: "run-1", status: "success", checkpointNull: false, orderCoreParameters: true },
      { syncRunId: "run-1", status: "success", checkpointNull: true, orderCoreParameters: false },
    ] as const) {
      const { children: fakes } = children({
        runOrderCore: vi.fn(async () => orderCore),
      });
      const report = await runIncrementalConnection({ scope }, fakes);
      expect(["failed", "pending"]).toContain(report.order_core.state);
      expect(fakes.runMatching).not.toHaveBeenCalled();
      expect(fakes.startClaims).not.toHaveBeenCalled();
    }
  });

  it("launches no claims on an unpublished or stale match", async () => {
    const { children: fakes } = children({
      runMatching: vi.fn(async () => ({ published: false, matchRunId: null })),
    });
    const report = await runIncrementalConnection({ scope }, fakes);
    expect(report.matching.state).toBe("failed");
    expect(fakes.startClaims).not.toHaveBeenCalled();
    expect(fakes.runJourney).not.toHaveBeenCalled();
  });

  it("records a completed skipped stage for a valid zero-event no_work", async () => {
    const { children: fakes } = children({
      startClaims: vi.fn(async () => ({
        kind: "no_work" as const,
        matchRunId: "match-run-1",
      })),
    });
    const report = await runIncrementalConnection({ scope }, fakes);
    expect(report.claims).toEqual({ state: "skipped", detail: "no_work" });
    expect(fakes.runClaimGraph).not.toHaveBeenCalled();
    expect(fakes.runJourney).toHaveBeenCalled();
  });

  it("invokes the idempotent claim recovery fallback on a non-ok claim child", async () => {
    const { children: fakes, calls } = children({
      runClaimGraph: vi.fn(async () => {
        throw new Error("claim child crashed");
      }),
    });
    const report = await runIncrementalConnection({ scope }, fakes);
    expect(report.claims).toEqual({
      state: "failed",
      detail: "child_failed_recovered",
    });
    expect(calls).toContain("claims_recover");
    // Prior published data is preserved: enrichment still runs behind its
    // own gates and nothing upstream is deleted or relabelled.
    expect(fakes.runJourney).toHaveBeenCalled();
  });

  it("keeps a partial claim graph visibly partial and a live one pending", async () => {
    const partial = children({
      runClaimGraph: vi.fn(async () => ({ status: "partial" as const })),
    });
    expect(
      (await runIncrementalConnection({ scope }, partial.children)).claims,
    ).toEqual({ state: "completed", detail: "partial_visible" });
    const live = children({
      runClaimGraph: vi.fn(async () => ({ status: "running" as const })),
    });
    expect(
      (await runIncrementalConnection({ scope }, live.children)).claims,
    ).toEqual({ state: "pending", detail: "live_at_deadline" });
  });

  it("records enrichment failures without failing the chain or deleting data", async () => {
    const { children: fakes } = children({
      runDimensions: vi.fn(async () => {
        throw new Error("dimension start failed");
      }),
    });
    const report = await runIncrementalConnection({ scope }, fakes);
    expect(report.dimensions).toEqual({
      state: "failed",
      detail: "dimensions_failed",
    });
    expect(report.reports.state).toBe("completed");
  });
});

describe("klaviyo-incremental trigger source boundary", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "trigger/klaviyo-incremental.ts"),
    "utf8",
  );

  it("exports only the manual supervisor task on a single-concurrency queue", () => {
    expect(source).toContain("export const klaviyoIncrementalTask");
    expect(source).toContain('name: "klaviyo-incremental-supervisor"');
    expect(source).toContain("concurrencyLimit: 1");
    expect(source).not.toContain("schedules.task");
  });

  it("keys evidence handoffs by connection and store day", () => {
    expect(source).toContain(
      "`klaviyo:incremental:evidence:${scope.connectionId}:incremental_7d:${storeDay}`",
    );
  });

  it("hands Plan 1 evidence start its exact mode-only payload", () => {
    // The evidence task is env-store-bound and rejects extra keys by
    // exact shape — the supervisor must never add organizationId to it.
    expect(source).toContain('{ mode: "incremental_7d" }');
    expect(source).not.toMatch(/organizationId[^\n]*mode: "incremental_7d"/);
  });

  it("sends the match task a reason from its closed union", () => {
    expect(source).toContain('reason: "source_sync" as const');
    expect(source).not.toContain('reason: "scheduled" as const');
  });

  it("uses explicit global keys with seven-day TTLs for every handoff", () => {
    const globalKeys = source.match(/\{\s*scope: "global",?\s*\}/g) ?? [];
    const ttls = source.match(/idempotencyKeyTTL: "7d"/g) ?? [];
    expect(globalKeys.length).toBeGreaterThanOrEqual(6);
    expect(ttls.length).toBe(globalKeys.length);
    expect(source).toContain("`klaviyo-claims:first:${claimReplayId}`");
    expect(source).toContain("`klaviyo:reports:first:${prepared.syncRunId}`");
    expect(source).toContain("`klaviyo:dimensions:first:${prepared.syncRunId}`");
  });

  it("flushes the supervisor checkpoint before handoffs and polls durably", () => {
    expect(source).toContain('metadata.set("supervisor"');
    expect(source).toContain("await metadata.flush()");
    expect(source).toContain("wait.for({ seconds: POLL_INTERVAL_SECONDS })");
    expect(source).not.toContain("Promise.all");
    expect(source).not.toMatch(/setTimeout/);
  });

  it("captures child result IDs before branching on ok and passes no secrets", () => {
    expect(source).toContain('metadata.set("shopifyTriggerRunId", result.id)');
    expect(source).toContain('metadata.set("claimTriggerRunId", result.id)');
    expect(source).not.toMatch(/privateApiKey|profile_id|digest/);
    expect(source).toContain('reason: "scheduled"');
  });
});
