import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  approvedRuleChecksum,
  matcherConfigChecksum,
} from "@/lib/klaviyo/matcher";
import {
  MatchInputStaleError,
  deriveFingerprints,
  loadApprovedRules,
  loadKlaviyoProjection,
  loadShopifyProjection,
} from "@/lib/klaviyo/match-service";
import type { KlaviyoStoreTransaction } from "@/lib/klaviyo/source-store";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import {
  klaviyoEventMatchResults,
  klaviyoMatchRuns,
  klaviyoOrderMatchResults,
} from "@/schema/klaviyo-match";

type Executor = typeof db | KlaviyoStoreTransaction;

export type SafeMatchStaleReason =
  | "run_missing"
  | "run_not_published"
  | "run_superseded_empty"
  | "no_current_results"
  | "zero_claim_with_nonempty_projection"
  | "source_projection_stale"
  | "fingerprint_mismatch"
  | "rule_or_config_changed";

export type MatchRunSummary = {
  id: string;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  publicationScopeFingerprint: string;
  invocationFingerprint: string;
  publishedAt: Date;
  expectedOrderCount: number;
  expectedEventCount: number;
};

export type MatchFreshnessResult =
  | { fresh: true; matchRun: MatchRunSummary }
  | { fresh: false; reason: SafeMatchStaleReason };

/**
 * Repository-grounded publication freshness proof. Returns only safe reasons
 * — never digest values or raw rows. With an executor, the caller already
 * holds store→connection locks and no nested transaction is opened.
 */
export async function verifyPublishedMatchFreshness(input: {
  scope: KlaviyoConnectionScope;
  matchRunId: string;
  executor?: Executor;
}): Promise<MatchFreshnessResult> {
  const executor = input.executor ?? db;
  const [run] = await executor
    .select({
      id: klaviyoMatchRuns.id,
      status: klaviyoMatchRuns.status,
      sourceRunId: klaviyoMatchRuns.sourceRunId,
      shopifyEvidenceRunId: klaviyoMatchRuns.shopifyEvidenceRunId,
      publicationScopeFingerprint: klaviyoMatchRuns.publicationScopeFingerprint,
      invocationFingerprint: klaviyoMatchRuns.invocationFingerprint,
      klaviyoSourceChecksum: klaviyoMatchRuns.klaviyoSourceChecksum,
      shopifyEvidenceChecksum: klaviyoMatchRuns.shopifyEvidenceChecksum,
      ruleChecksum: klaviyoMatchRuns.ruleChecksum,
      configChecksum: klaviyoMatchRuns.configChecksum,
      expectedOrderCount: klaviyoMatchRuns.expectedOrderCount,
      expectedEventCount: klaviyoMatchRuns.expectedEventCount,
      candidateCount: klaviyoMatchRuns.candidateCount,
      publishedAt: klaviyoMatchRuns.publishedAt,
      supersededAt: klaviyoMatchRuns.supersededAt,
    })
    .from(klaviyoMatchRuns)
    .where(
      and(
        eq(klaviyoMatchRuns.id, input.matchRunId),
        eq(klaviyoMatchRuns.organizationId, input.scope.organizationId),
        eq(klaviyoMatchRuns.storeId, input.scope.storeId),
        eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
      ),
    )
    .limit(1);
  if (!run) return { fresh: false, reason: "run_missing" };
  if (run.status !== "published") {
    return { fresh: false, reason: "run_not_published" };
  }

  const zeroResult =
    (run.expectedOrderCount ?? 0) === 0 && (run.expectedEventCount ?? 0) === 0;
  if (zeroResult) {
    if (run.supersededAt !== null) {
      return { fresh: false, reason: "run_superseded_empty" };
    }
    if ((run.candidateCount ?? 0) !== 0) {
      return { fresh: false, reason: "zero_claim_with_nonempty_projection" };
    }
  } else {
    const [currentOrders] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoOrderMatchResults)
      .where(
        and(
          eq(klaviyoOrderMatchResults.runId, run.id),
          isNull(klaviyoOrderMatchResults.supersededAt),
        ),
      );
    const [currentEvents] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoEventMatchResults)
      .where(
        and(
          eq(klaviyoEventMatchResults.runId, run.id),
          isNull(klaviyoEventMatchResults.supersededAt),
        ),
      );
    if ((currentOrders?.count ?? 0) === 0 && (currentEvents?.count ?? 0) === 0) {
      return { fresh: false, reason: "no_current_results" };
    }
  }

  let klaviyo;
  let shopify;
  try {
    klaviyo = await loadKlaviyoProjection(
      { scope: input.scope, sourceRunId: run.sourceRunId },
      executor,
    );
    shopify = await loadShopifyProjection(
      { scope: input.scope, shopifyEvidenceRunId: run.shopifyEvidenceRunId },
      executor,
    );
  } catch (error) {
    if (error instanceof MatchInputStaleError) {
      return { fresh: false, reason: "source_projection_stale" };
    }
    throw error;
  }
  if (zeroResult && (klaviyo.events.length > 0 || shopify.orders.length > 0)) {
    return { fresh: false, reason: "zero_claim_with_nonempty_projection" };
  }
  if (
    klaviyo.checksum !== run.klaviyoSourceChecksum ||
    shopify.checksum !== run.shopifyEvidenceChecksum
  ) {
    return { fresh: false, reason: "source_projection_stale" };
  }

  const rules = await loadApprovedRules(input.scope, executor);
  if (
    approvedRuleChecksum(rules) !== run.ruleChecksum ||
    matcherConfigChecksum() !== run.configChecksum
  ) {
    return { fresh: false, reason: "rule_or_config_changed" };
  }

  const fingerprints = deriveFingerprints({
    scope: input.scope,
    klaviyo,
    shopify,
    ruleChecksum: run.ruleChecksum!,
    configChecksum: run.configChecksum!,
  });
  if (
    fingerprints.invocationFingerprint !== run.invocationFingerprint ||
    fingerprints.publicationScopeFingerprint !== run.publicationScopeFingerprint
  ) {
    return { fresh: false, reason: "fingerprint_mismatch" };
  }

  return {
    fresh: true,
    matchRun: {
      id: run.id,
      sourceRunId: run.sourceRunId,
      shopifyEvidenceRunId: run.shopifyEvidenceRunId,
      publicationScopeFingerprint: run.publicationScopeFingerprint,
      invocationFingerprint: run.invocationFingerprint,
      publishedAt: run.publishedAt!,
      expectedOrderCount: run.expectedOrderCount ?? 0,
      expectedEventCount: run.expectedEventCount ?? 0,
    },
  };
}

/**
 * Proves only that a match run is published — the claims flow's gate.
 * Deliberately weaker than verifyPublishedMatchFreshness: claims are
 * immutable facts about a Klaviyo event, so a Shopify projection that
 * drifted after publication cannot invalidate them, and the panel
 * re-joins claims to current order results at read time.
 *
 * The run's own `supersededAt` is deliberately NOT checked: a superseded
 * publication is still a true record of what Klaviyo attributed, and every
 * caller separately validates the specific conversion's event result
 * through verifyCurrentClaimAnchor. (resolveCurrentPublishedMatchRun does
 * filter it, because picking a rebind target is a different question.)
 */
export async function verifyClaimPublication(input: {
  scope: KlaviyoConnectionScope;
  matchRunId: string;
  executor?: Executor;
}): Promise<boolean> {
  const executor = input.executor ?? db;
  const [run] = await executor
    .select({ status: klaviyoMatchRuns.status })
    .from(klaviyoMatchRuns)
    .where(
      and(
        eq(klaviyoMatchRuns.id, input.matchRunId),
        eq(klaviyoMatchRuns.organizationId, input.scope.organizationId),
        eq(klaviyoMatchRuns.storeId, input.scope.storeId),
        eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
      ),
    )
    .limit(1);
  return run?.status === "published";
}

/**
 * The connection's newest published, unsuperseded match run — the target a
 * claim graph rebinds onto when its own run is replaced. Returns null when
 * the connection has no such run, leaving the caller nothing to continue
 * against.
 */
export async function resolveCurrentPublishedMatchRun(input: {
  scope: KlaviyoConnectionScope;
  executor?: Executor;
}): Promise<{ id: string; sourceRunId: string } | null> {
  const executor = input.executor ?? db;
  const [run] = await executor
    .select({
      id: klaviyoMatchRuns.id,
      sourceRunId: klaviyoMatchRuns.sourceRunId,
    })
    .from(klaviyoMatchRuns)
    .where(
      and(
        eq(klaviyoMatchRuns.organizationId, input.scope.organizationId),
        eq(klaviyoMatchRuns.storeId, input.scope.storeId),
        eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
        eq(klaviyoMatchRuns.status, "published"),
        isNull(klaviyoMatchRuns.supersededAt),
      ),
    )
    // A connection normally holds several published, unsuperseded runs, so
    // the id tiebreaker is load-bearing: without it equal timestamps order
    // arbitrarily and consecutive batches would rebind graphs back and
    // forth. Correctness of the DESC ordering (Postgres sorts NULLs first)
    // relies on status='published' implying published_at is not null, which
    // klaviyo_match_run_terminal_shape_check guarantees.
    .orderBy(desc(klaviyoMatchRuns.publishedAt), desc(klaviyoMatchRuns.id))
    .limit(1);
  return run ?? null;
}

export type ClaimAnchorResult =
  | {
      fresh: true;
      eventStatus: string;
      canonicalOrderResultId: string | null;
    }
  | { fresh: false; reason: "publication_stale" | "event_result_superseded" };

/**
 * Claim-anchor proof for Plan 4: the run is published and the exact
 * run/event result remains unsuperseded. A canonical order attaches only
 * through the same run's confirmed, unsuperseded order result selecting the
 * identical deterministic edge.
 */
export async function verifyCurrentClaimAnchor(input: {
  scope: KlaviyoConnectionScope;
  matchRunId: string;
  conversionEventRowId: string;
  executor?: Executor;
}): Promise<ClaimAnchorResult> {
  const executor = input.executor ?? db;
  // Claims need only that the run published and this conversion's event
  // result is still current — never that the Shopify projection still
  // matches, which hourly ingest breaks continuously and which has no
  // bearing on what Klaviyo attributed a conversion to. The dropped gate
  // also covered rule_or_config_changed and fingerprint_mismatch; both are
  // benign here for the same reason — they say the next publication would
  // match differently, not that this published run's event result lies.
  if (
    !(await verifyClaimPublication({
      scope: input.scope,
      matchRunId: input.matchRunId,
      executor,
    }))
  ) {
    return { fresh: false, reason: "publication_stale" };
  }

  const [eventResult] = await executor
    .select({
      id: klaviyoEventMatchResults.id,
      status: klaviyoEventMatchResults.status,
      selectedCandidateId: klaviyoEventMatchResults.selectedCandidateId,
      supersededAt: klaviyoEventMatchResults.supersededAt,
    })
    .from(klaviyoEventMatchResults)
    .where(
      and(
        eq(klaviyoEventMatchResults.runId, input.matchRunId),
        eq(klaviyoEventMatchResults.eventId, input.conversionEventRowId),
        eq(klaviyoEventMatchResults.connectionId, input.scope.connectionId),
      ),
    )
    .limit(1);
  if (!eventResult || eventResult.supersededAt !== null) {
    return { fresh: false, reason: "event_result_superseded" };
  }

  let canonicalOrderResultId: string | null = null;
  if (eventResult.status === "confirmed") {
    const [orderResult] = await executor
      .select({
        id: klaviyoOrderMatchResults.id,
        status: klaviyoOrderMatchResults.status,
        selectedCandidateId: klaviyoOrderMatchResults.selectedCandidateId,
        supersededAt: klaviyoOrderMatchResults.supersededAt,
      })
      .from(klaviyoOrderMatchResults)
      .where(
        and(
          eq(klaviyoOrderMatchResults.runId, input.matchRunId),
          eq(
            klaviyoOrderMatchResults.selectedEventId,
            input.conversionEventRowId,
          ),
          eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
        ),
      )
      .limit(1);
    if (
      orderResult &&
      orderResult.supersededAt === null &&
      orderResult.status === "confirmed" &&
      orderResult.selectedCandidateId !== null &&
      orderResult.selectedCandidateId === eventResult.selectedCandidateId
    ) {
      canonicalOrderResultId = orderResult.id;
    }
  }
  return { fresh: true, eventStatus: eventResult.status, canonicalOrderResultId };
}
