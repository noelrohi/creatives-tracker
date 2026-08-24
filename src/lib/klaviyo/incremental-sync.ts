import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import type { StartClaimReplayResult } from "@/lib/klaviyo/claim-repository";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import {
  klaviyoConnections,
  klaviyoProbeReports,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";

export type IncrementalStageName =
  | "shopify_evidence"
  | "order_core"
  | "matching"
  | "claims"
  | "journey"
  | "consent"
  | "dimensions"
  | "reports";

export type StageOutcome =
  | { state: "completed"; detail?: string }
  | { state: "skipped"; detail: string }
  | { state: "failed"; detail: string }
  | { state: "pending"; detail: string }
  | { state: "not_run" };

export type IncrementalRunReport = Record<IncrementalStageName, StageOutcome>;

/**
 * Repository-derived eligibility: only ready connections with a passed
 * immutable probe and a completed order-core backfill — selected by
 * immutable `requestParameters.sourceMode`/`metricKinds`, never by a
 * now-null checkpoint or the generic latest `events` operation — may run
 * the incremental chain. A later same-window journey run can never
 * satisfy or replace the order-core requirement.
 */
export async function listEligibleConnections(): Promise<
  KlaviyoConnectionScope[]
> {
  const rows = await db
    .select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
    })
    .from(klaviyoConnections)
    .where(eq(klaviyoConnections.status, "ready"));
  const eligible: KlaviyoConnectionScope[] = [];
  for (const row of rows) {
    const scope: KlaviyoConnectionScope = {
      organizationId: row.organizationId,
      storeId: row.storeId,
      connectionId: row.connectionId,
    };
    if (!(await hasPassedProbe(scope))) continue;
    if (!(await hasCompletedOrderCoreBackfill(scope))) continue;
    eligible.push(scope);
  }
  return eligible;
}

async function hasPassedProbe(scope: KlaviyoConnectionScope): Promise<boolean> {
  const [report] = await db
    .select({ id: klaviyoProbeReports.id })
    .from(klaviyoProbeReports)
    .where(
      and(
        eq(klaviyoProbeReports.organizationId, scope.organizationId),
        eq(klaviyoProbeReports.storeId, scope.storeId),
        eq(klaviyoProbeReports.connectionId, scope.connectionId),
        eq(klaviyoProbeReports.status, "passed"),
      ),
    )
    .limit(1);
  return report !== undefined;
}

export async function hasCompletedOrderCoreBackfill(
  scope: KlaviyoConnectionScope,
): Promise<boolean> {
  const [run] = await db
    .select({ id: klaviyoSyncRuns.id })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.organizationId, scope.organizationId),
        eq(klaviyoSyncRuns.storeId, scope.storeId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
        eq(klaviyoSyncRuns.operation, "events"),
        eq(klaviyoSyncRuns.status, "success"),
        sql`${klaviyoSyncRuns.checkpoint} is null`,
        sql`${klaviyoSyncRuns.requestParameters}->>'sourceMode' = 'order_core'`,
        sql`${klaviyoSyncRuns.requestParameters}->'metricKinds' =
          '["placed_order","ordered_product"]'::jsonb`,
      ),
    )
    .limit(1);
  return run !== undefined;
}

export type ShopifyEvidenceOutcome = {
  ok: boolean;
  evidenceRunId: string | null;
  status: "success" | "partial" | "failed" | "running";
  lineCompleteness: "complete" | "partial" | "unavailable";
};

export type OrderCoreOutcome = {
  syncRunId: string | null;
  status: "success" | "partial" | "failed" | "running";
  checkpointNull: boolean;
  orderCoreParameters: boolean;
};

export type MatchingOutcome = {
  published: boolean;
  matchRunId: string | null;
};

/**
 * Durable-child seams. The Trigger supervisor provides implementations
 * backed by `triggerAndWait`/bounded database polls; unit tests provide
 * fakes proving strict ordering and failure isolation. Every callback
 * receives only internal IDs and safe ranges — never credentials, HMACs,
 * profile IDs, or raw provider data.
 */
export type IncrementalChildren = {
  runShopifyEvidence(
    scope: KlaviyoConnectionScope,
  ): Promise<ShopifyEvidenceOutcome>;
  runOrderCore(scope: KlaviyoConnectionScope): Promise<OrderCoreOutcome>;
  runMatching(
    scope: KlaviyoConnectionScope,
    input: { sourceRunId: string; shopifyEvidenceRunId: string },
  ): Promise<MatchingOutcome>;
  startClaims(
    scope: KlaviyoConnectionScope,
    input: { sourceRunId: string; matchRunId: string },
  ): Promise<StartClaimReplayResult>;
  runClaimGraph(
    scope: KlaviyoConnectionScope,
    claimReplayId: string,
  ): Promise<{ status: "success" | "partial" | "failed" | "stale" | "running" }>;
  recoverClaims(
    scope: KlaviyoConnectionScope,
    claimReplayId: string,
  ): Promise<void>;
  runJourney(scope: KlaviyoConnectionScope): Promise<{ ok: boolean }>;
  runConsent(scope: KlaviyoConnectionScope): Promise<{ ok: boolean }>;
  runDimensions(scope: KlaviyoConnectionScope): Promise<{ ok: boolean }>;
  runReports(scope: KlaviyoConnectionScope): Promise<{ ok: boolean }>;
};

function emptyReport(): IncrementalRunReport {
  return {
    shopify_evidence: { state: "not_run" },
    order_core: { state: "not_run" },
    matching: { state: "not_run" },
    claims: { state: "not_run" },
    journey: { state: "not_run" },
    consent: { state: "not_run" },
    dimensions: { state: "not_run" },
    reports: { state: "not_run" },
  };
}

/**
 * The strict core chain and call order for one eligible connection:
 * Shopify evidence → acceptable coverage → order core → atomic match
 * publication → claim graph. A running, failed, stale, or unavailable
 * upstream launches no dependent; a policy-labelled partial is acceptable
 * but stays visibly partial. Journey, dimensions, and reports are
 * independent enrichment branches launched only after the core chain has
 * reached its own prerequisite gate, and never in parallel with an unmet
 * upstream dependency. At every failure, prior published data remains
 * queryable with stale/failure coverage — nothing is deleted or silently
 * relabelled.
 */
export async function runIncrementalConnection(
  input: { scope: KlaviyoConnectionScope },
  children: IncrementalChildren,
): Promise<IncrementalRunReport> {
  const report = emptyReport();

  const evidence = await children.runShopifyEvidence(input.scope);
  const evidenceAcceptable =
    evidence.ok &&
    evidence.evidenceRunId !== null &&
    ((evidence.status === "success" &&
      evidence.lineCompleteness === "complete") ||
      (evidence.status === "partial" &&
        evidence.lineCompleteness === "partial"));
  if (!evidenceAcceptable) {
    report.shopify_evidence = {
      state: evidence.status === "running" ? "pending" : "failed",
      detail: `${evidence.status}:${evidence.lineCompleteness}`,
    };
    return report;
  }
  report.shopify_evidence = {
    state: "completed",
    detail:
      evidence.status === "partial" ? "partial_visible" : "success_complete",
  };

  const orderCore = await children.runOrderCore(input.scope);
  const orderCoreAcceptable =
    orderCore.syncRunId !== null &&
    orderCore.status === "success" &&
    orderCore.checkpointNull &&
    orderCore.orderCoreParameters;
  if (!orderCoreAcceptable) {
    report.order_core = {
      state: orderCore.status === "running" ? "pending" : "failed",
      detail: orderCore.status,
    };
    return report;
  }
  report.order_core = { state: "completed" };
  const sourceRunId = orderCore.syncRunId!;

  const matching = await children.runMatching(input.scope, {
    sourceRunId,
    shopifyEvidenceRunId: evidence.evidenceRunId!,
  });
  if (!matching.published || matching.matchRunId === null) {
    report.matching = { state: "failed", detail: "not_published" };
    return report;
  }
  report.matching = { state: "completed" };

  const claimStart = await children.startClaims(input.scope, {
    sourceRunId,
    matchRunId: matching.matchRunId,
  });
  if (claimStart.kind === "no_work") {
    report.claims = { state: "skipped", detail: "no_work" };
  } else if (claimStart.kind === "stale" || claimStart.kind === "conflict") {
    report.claims = { state: "failed", detail: claimStart.kind };
  } else {
    const claimReplayId = claimStart.claimReplayId;
    let graphStatus: string;
    try {
      graphStatus = (await children.runClaimGraph(input.scope, claimReplayId))
        .status;
    } catch {
      await children.recoverClaims(input.scope, claimReplayId);
      report.claims = { state: "failed", detail: "child_failed_recovered" };
      graphStatus = "failed";
    }
    if (graphStatus === "success") {
      report.claims = { state: "completed" };
    } else if (graphStatus === "partial") {
      report.claims = { state: "completed", detail: "partial_visible" };
    } else if (graphStatus === "running") {
      report.claims = { state: "pending", detail: "live_at_deadline" };
    } else if (report.claims.state === "not_run") {
      report.claims = { state: "failed", detail: graphStatus };
    }
  }

  // Independent enrichment branches: each behind the core gate above, run
  // sequentially through durable named stages so replay cannot duplicate
  // them. A failure records the stage and preserves prior published data.
  const journey = await children.runJourney(input.scope).catch(() => ({
    ok: false,
  }));
  report.journey = journey.ok
    ? { state: "completed" }
    : { state: "failed", detail: "journey_failed" };
  const consent = await children.runConsent(input.scope).catch(() => ({
    ok: false,
  }));
  report.consent = consent.ok
    ? { state: "completed" }
    : { state: "failed", detail: "consent_failed" };
  const dimensions = await children.runDimensions(input.scope).catch(() => ({
    ok: false,
  }));
  report.dimensions = dimensions.ok
    ? { state: "completed" }
    : { state: "failed", detail: "dimensions_failed" };
  const reports = await children.runReports(input.scope).catch(() => ({
    ok: false,
  }));
  report.reports = reports.ok
    ? { state: "completed" }
    : { state: "failed", detail: "reports_failed" };

  return report;
}
