import "server-only";

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { MATCHER_VERSION } from "@/lib/klaviyo/match-types";
import {
  withKlaviyoConnectionLock,
  type KlaviyoStoreTransaction,
} from "@/lib/klaviyo/source-store";
import {
  KLAVIYO_ORDER_CORE_KINDS,
  type KlaviyoConnectionScope,
} from "@/lib/klaviyo/types";
import {
  klaviyoConnections,
  klaviyoEventAliases,
  klaviyoJoinRules,
  klaviyoMetrics,
  klaviyoProbeReports,
} from "@/schema/klaviyo";

const ALLOWED_CANONICALIZERS = new Set([
  "shopify_order_gid",
  "trimmed_exact",
] as const);

export function assertRuleCanBeApproved(input: {
  probeStatus: string;
  state: string;
  canonicalizer: string;
  observedPopulated: number;
  observedCollisions: number;
}) {
  if (input.probeStatus !== "passed") {
    throw new Error("Join rules require a passed probe report");
  }
  if (input.state !== "candidate") {
    throw new Error("Only candidate join rules can be approved");
  }
  if (!ALLOWED_CANONICALIZERS.has(input.canonicalizer as never)) {
    throw new Error("Join rule canonicalizer is not allowlisted");
  }
  if (input.observedPopulated <= 0) {
    throw new Error("Join rules require populated probe observations");
  }
  if (input.observedCollisions !== 0) {
    throw new Error("Join rules with observed collisions cannot be approved");
  }
}

export function assertProbeCanBeApproved(input: {
  status: string;
  sampledShopifyOrders: number;
  bindingOverlapCount: number;
  redactionVerified: boolean;
  enabledOrderMetricKinds: string[];
}): void {
  if (input.status !== "pending") {
    throw new Error("Only pending probe reports can be approved");
  }
  if (
    !Number.isInteger(input.sampledShopifyOrders) ||
    input.sampledShopifyOrders < 20 ||
    input.sampledShopifyOrders > 50
  ) {
    throw new Error("Probe sample size is outside the approved range");
  }
  if (input.bindingOverlapCount <= 0) {
    throw new Error("Probe found no binding overlap with sampled orders");
  }
  if (!input.redactionVerified) {
    throw new Error("Probe redaction verification is required");
  }
  const kinds = [...input.enabledOrderMetricKinds].sort();
  const expected = [...KLAVIYO_ORDER_CORE_KINDS].sort();
  if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
    throw new Error("Probe requires exactly the enabled native order metrics");
  }
}

function scopedConnectionPredicate(scope: KlaviyoConnectionScope) {
  return and(
    eq(klaviyoConnections.organizationId, scope.organizationId),
    eq(klaviyoConnections.storeId, scope.storeId),
    eq(klaviyoConnections.id, scope.connectionId),
  );
}

async function loadEnabledOrderKinds(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
): Promise<string[]> {
  const metrics = await tx
    .select({ canonicalKind: klaviyoMetrics.canonicalKind })
    .from(klaviyoMetrics)
    .where(
      and(
        eq(klaviyoMetrics.organizationId, scope.organizationId),
        eq(klaviyoMetrics.storeId, scope.storeId),
        eq(klaviyoMetrics.connectionId, scope.connectionId),
        eq(klaviyoMetrics.ingestionEnabled, 1),
        inArray(klaviyoMetrics.canonicalKind, [...KLAVIYO_ORDER_CORE_KINDS]),
      ),
    );
  return metrics.flatMap((metric) =>
    metric.canonicalKind === null ? [] : [metric.canonicalKind as string],
  );
}

/**
 * Fixed lock order for every probe review: scoped connection row first
 * (via withKlaviyoConnectionLock), then the report row.
 */
export async function reviewProbeReport(input: {
  scope: KlaviyoConnectionScope;
  reportId: string;
  reviewerId: string;
  decision: "passed" | "failed";
  reviewNote: string;
}): Promise<void> {
  if (input.decision !== "passed" && input.decision !== "failed") {
    throw new Error("Probe review decision is invalid");
  }
  if (input.reviewerId.trim().length === 0) {
    throw new Error("Probe review requires a reviewer");
  }
  await withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [report] = await tx
      .select({
        id: klaviyoProbeReports.id,
        status: klaviyoProbeReports.status,
        sampledShopifyOrders: klaviyoProbeReports.sampledShopifyOrders,
        bindingOverlapCount: klaviyoProbeReports.bindingOverlapCount,
        redactionVerified: klaviyoProbeReports.redactionVerified,
      })
      .from(klaviyoProbeReports)
      .where(
        and(
          eq(klaviyoProbeReports.id, input.reportId),
          eq(klaviyoProbeReports.organizationId, input.scope.organizationId),
          eq(klaviyoProbeReports.storeId, input.scope.storeId),
          eq(klaviyoProbeReports.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!report) throw new Error("Klaviyo probe report is outside this scope");
    if (report.status !== "pending") {
      throw new Error("Only pending probe reports can be reviewed");
    }

    const reviewedAt = new Date();
    if (input.decision === "failed") {
      await tx
        .update(klaviyoProbeReports)
        .set({
          status: "failed",
          reviewerId: input.reviewerId,
          reviewNote: input.reviewNote,
          reviewedAt,
        })
        .where(eq(klaviyoProbeReports.id, report.id));
      // Rejection marks only this report's candidates; it never regresses a
      // connection made ready by another report.
      await tx
        .update(klaviyoEventAliases)
        .set({ state: "rejected", updatedAt: reviewedAt })
        .where(
          and(
            eq(klaviyoEventAliases.probeReportId, report.id),
            eq(klaviyoEventAliases.state, "candidate"),
          ),
        );
      return;
    }

    const [connection] = await tx
      .select({ status: klaviyoConnections.status })
      .from(klaviyoConnections)
      .where(scopedConnectionPredicate(input.scope));
    if (!connection || connection.status !== "pending") {
      throw new Error(
        "Klaviyo connection is no longer pending for probe approval",
      );
    }

    const enabledOrderMetricKinds = await loadEnabledOrderKinds(tx, input.scope);
    assertProbeCanBeApproved({
      status: report.status,
      sampledShopifyOrders: report.sampledShopifyOrders,
      bindingOverlapCount: report.bindingOverlapCount,
      redactionVerified: report.redactionVerified === 1,
      enabledOrderMetricKinds,
    });

    const candidates = await tx
      .select({
        id: klaviyoEventAliases.id,
        metricId: klaviyoEventAliases.metricId,
        canonicalField: klaviyoEventAliases.canonicalField,
        sourceProperty: klaviyoEventAliases.sourceProperty,
        observedMalformed: klaviyoEventAliases.observedMalformed,
      })
      .from(klaviyoEventAliases)
      .where(
        and(
          eq(klaviyoEventAliases.organizationId, input.scope.organizationId),
          eq(klaviyoEventAliases.storeId, input.scope.storeId),
          eq(klaviyoEventAliases.connectionId, input.scope.connectionId),
          eq(klaviyoEventAliases.probeReportId, report.id),
          eq(klaviyoEventAliases.state, "candidate"),
        ),
      )
      .for("update");
    if (candidates.some((candidate) => candidate.observedMalformed !== 0)) {
      throw new Error("Probe candidate aliases contain malformed observations");
    }

    // Retire the previously approved alias for each mapping this report
    // re-binds; historical rows stay auditable as disabled.
    for (const candidate of candidates) {
      await tx
        .update(klaviyoEventAliases)
        .set({ state: "disabled", updatedAt: reviewedAt })
        .where(
          and(
            eq(klaviyoEventAliases.organizationId, input.scope.organizationId),
            eq(klaviyoEventAliases.storeId, input.scope.storeId),
            eq(klaviyoEventAliases.connectionId, input.scope.connectionId),
            eq(klaviyoEventAliases.metricId, candidate.metricId),
            eq(klaviyoEventAliases.state, "approved"),
            or(
              eq(klaviyoEventAliases.canonicalField, candidate.canonicalField),
              eq(klaviyoEventAliases.sourceProperty, candidate.sourceProperty),
            ),
          ),
        );
    }
    await tx
      .update(klaviyoEventAliases)
      .set({ state: "approved", updatedAt: reviewedAt })
      .where(
        and(
          eq(klaviyoEventAliases.probeReportId, report.id),
          eq(klaviyoEventAliases.state, "candidate"),
        ),
      );

    await tx
      .update(klaviyoProbeReports)
      .set({
        status: "passed",
        reviewerId: input.reviewerId,
        reviewNote: input.reviewNote,
        reviewedAt,
      })
      .where(eq(klaviyoProbeReports.id, report.id));

    const readied = await tx
      .update(klaviyoConnections)
      .set({ status: "ready", updatedAt: reviewedAt })
      .where(
        and(scopedConnectionPredicate(input.scope), sql`status = 'pending'`),
      )
      .returning({ id: klaviyoConnections.id });
    if (readied.length !== 1) {
      throw new Error(
        "Klaviyo connection is no longer pending for probe approval",
      );
    }
  });
}

/**
 * Fixed lock order: scoped connection first, then the candidate rule, then
 * its passed report. Rule review never executes matching.
 */
export async function reviewJoinRule(input: {
  scope: KlaviyoConnectionScope;
  ruleId: string;
  reviewerId: string;
  decision: "approved" | "rejected";
  reviewNote: string;
}): Promise<void> {
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new Error("Join rule review decision is invalid");
  }
  if (input.reviewerId.trim().length === 0) {
    throw new Error("Join rule review requires a reviewer");
  }
  await withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [rule] = await tx
      .select({
        id: klaviyoJoinRules.id,
        probeReportId: klaviyoJoinRules.probeReportId,
        eventKind: klaviyoJoinRules.eventKind,
        sourceProperty: klaviyoJoinRules.sourceProperty,
        targetNamespace: klaviyoJoinRules.targetNamespace,
        canonicalizer: klaviyoJoinRules.canonicalizer,
        state: klaviyoJoinRules.state,
        observedPopulated: klaviyoJoinRules.observedPopulated,
        observedCollisions: klaviyoJoinRules.observedCollisions,
      })
      .from(klaviyoJoinRules)
      .where(
        and(
          eq(klaviyoJoinRules.id, input.ruleId),
          eq(klaviyoJoinRules.organizationId, input.scope.organizationId),
          eq(klaviyoJoinRules.storeId, input.scope.storeId),
          eq(klaviyoJoinRules.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!rule) throw new Error("Klaviyo join rule is outside this scope");
    if (rule.state !== "candidate") {
      throw new Error("Only candidate join rules can be reviewed");
    }

    const [report] = await tx
      .select({ status: klaviyoProbeReports.status })
      .from(klaviyoProbeReports)
      .where(
        and(
          eq(klaviyoProbeReports.id, rule.probeReportId),
          eq(klaviyoProbeReports.organizationId, input.scope.organizationId),
          eq(klaviyoProbeReports.storeId, input.scope.storeId),
          eq(klaviyoProbeReports.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!report) throw new Error("Klaviyo probe report is outside this scope");

    const reviewedAt = new Date();
    if (input.decision === "rejected") {
      await tx
        .update(klaviyoJoinRules)
        .set({
          state: "rejected",
          approverId: input.reviewerId,
          reviewNote: input.reviewNote,
          updatedAt: reviewedAt,
        })
        .where(eq(klaviyoJoinRules.id, rule.id));
      return;
    }

    if (input.reviewNote.trim().length === 0) {
      throw new Error("Join rule approval requires non-empty review text");
    }
    assertRuleCanBeApproved({
      probeStatus: report.status,
      state: rule.state,
      canonicalizer: rule.canonicalizer,
      observedPopulated: rule.observedPopulated,
      observedCollisions: rule.observedCollisions,
    });

    await tx
      .update(klaviyoJoinRules)
      .set({ state: "disabled", updatedAt: reviewedAt })
      .where(
        and(
          eq(klaviyoJoinRules.organizationId, input.scope.organizationId),
          eq(klaviyoJoinRules.storeId, input.scope.storeId),
          eq(klaviyoJoinRules.connectionId, input.scope.connectionId),
          eq(klaviyoJoinRules.eventKind, rule.eventKind),
          eq(klaviyoJoinRules.sourceProperty, rule.sourceProperty),
          eq(klaviyoJoinRules.targetNamespace, rule.targetNamespace),
          eq(klaviyoJoinRules.state, "approved"),
        ),
      );
    await tx
      .update(klaviyoJoinRules)
      .set({
        state: "approved",
        approverId: input.reviewerId,
        reviewNote: input.reviewNote,
        approvedAt: reviewedAt,
        matcherVersion: MATCHER_VERSION,
        updatedAt: reviewedAt,
      })
      .where(
        and(
          eq(klaviyoJoinRules.id, rule.id),
          eq(klaviyoJoinRules.state, "candidate"),
        ),
      );
  });
}
