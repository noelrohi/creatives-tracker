import "server-only";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PgInsertValue, PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { recountMatchRunCurrentness } from "@/lib/klaviyo/match-currentness";
import type { MATCHER_VERSION } from "@/lib/klaviyo/match-types";
import type { MatchComputation } from "@/lib/klaviyo/matcher";
import {
  MatchInputStaleError,
  deriveFingerprints,
  loadKlaviyoProjection,
  loadShopifyProjection,
} from "@/lib/klaviyo/match-service";
import type { KlaviyoStoreTransaction } from "@/lib/klaviyo/source-store";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoConnections } from "@/schema/klaviyo";
import {
  klaviyoEventMatchResults,
  klaviyoMatchCandidates,
  klaviyoMatchRuns,
  klaviyoOrderMatchResults,
  klaviyoProductEvidenceLinks,
} from "@/schema/klaviyo-match";
import { shopifyStores } from "@/schema/shopify";

/**
 * Rows per multi-row INSERT inside a publication.
 *
 * Postgres caps one statement at 65535 bind parameters. These publication rows
 * carry ~16 wide columns each (several of them jsonb), so 500 rows is ~8k
 * parameters — far under the cap with room for the widest table. It also turns
 * the ~30k sequential round trips a production-scale publication used to issue
 * into ~60: on a remote managed database at ~13ms per round trip that is the
 * difference between blowing the task's maxDuration and finishing in seconds.
 */
const PUBLICATION_INSERT_CHUNK = 500;

/**
 * Insert `rows` as chunked multi-row statements. An empty array inserts
 * nothing — drizzle rejects `.values([])`, and a zero-row group is legal
 * (a zero-candidate publication, for instance).
 */
async function insertChunked<TTable extends PgTable>(
  tx: KlaviyoStoreTransaction,
  table: TTable,
  rows: PgInsertValue<TTable>[],
): Promise<void> {
  for (
    let offset = 0;
    offset < rows.length;
    offset += PUBLICATION_INSERT_CHUNK
  ) {
    await tx
      .insert(table)
      .values(rows.slice(offset, offset + PUBLICATION_INSERT_CHUNK));
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function lockStoreThenConnection(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
): Promise<void> {
  const [store] = await tx
    .select({ id: shopifyStores.id })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.organizationId, scope.organizationId),
        eq(shopifyStores.id, scope.storeId),
      ),
    )
    .for("update");
  if (!store) throw new MatchInputStaleError("store_missing");
  const [connection] = await tx
    .select({ id: klaviyoConnections.id })
    .from(klaviyoConnections)
    .where(
      and(
        eq(klaviyoConnections.organizationId, scope.organizationId),
        eq(klaviyoConnections.storeId, scope.storeId),
        eq(klaviyoConnections.id, scope.connectionId),
      ),
    )
    .for("update");
  if (!connection) throw new MatchInputStaleError("connection_missing");
}

async function loadPublishedByInvocation(
  executor: KlaviyoStoreTransaction | typeof db,
  scope: KlaviyoConnectionScope,
  invocationFingerprint: string,
) {
  const [winner] = await executor
    .select({
      id: klaviyoMatchRuns.id,
      publishedAt: klaviyoMatchRuns.publishedAt,
      sourceRunId: klaviyoMatchRuns.sourceRunId,
      shopifyEvidenceRunId: klaviyoMatchRuns.shopifyEvidenceRunId,
      publicationScopeFingerprint: klaviyoMatchRuns.publicationScopeFingerprint,
      klaviyoSourceChecksum: klaviyoMatchRuns.klaviyoSourceChecksum,
      shopifyEvidenceChecksum: klaviyoMatchRuns.shopifyEvidenceChecksum,
    })
    .from(klaviyoMatchRuns)
    .where(
      and(
        eq(klaviyoMatchRuns.organizationId, scope.organizationId),
        eq(klaviyoMatchRuns.storeId, scope.storeId),
        eq(klaviyoMatchRuns.connectionId, scope.connectionId),
        eq(klaviyoMatchRuns.invocationFingerprint, invocationFingerprint),
        eq(klaviyoMatchRuns.status, "published"),
      ),
    )
    .limit(1);
  return winner ?? null;
}

export async function publishMatchRun(input: {
  scope: KlaviyoConnectionScope;
  runId: string;
  startedAt: Date;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  publicationScopeFingerprint: string;
  invocationFingerprint: string;
  computation: MatchComputation;
  expectedOrderIds: string[];
  expectedEventIds: string[];
}): Promise<{ runId: string; publishedAt: Date; replayed: boolean }> {
  try {
    return await db.transaction(
      async (tx) => {
        await lockStoreThenConnection(tx, input.scope);

        // Replay of an already published fingerprint returns the winner after
        // revalidating its exact binding.
        const existing = await loadPublishedByInvocation(
          tx,
          input.scope,
          input.invocationFingerprint,
        );
        if (existing) {
          if (
            existing.sourceRunId !== input.sourceRunId ||
            existing.shopifyEvidenceRunId !== input.shopifyEvidenceRunId ||
            existing.publicationScopeFingerprint !==
              input.publicationScopeFingerprint
          ) {
            throw new MatchInputStaleError("replayed_run_binding_mismatch");
          }
          return {
            runId: existing.id,
            publishedAt: existing.publishedAt!,
            replayed: true,
          };
        }

        // Rederive both canonical projections and fingerprints under the
        // store→connection locks; inequality fails before any write.
        const klaviyo = await loadKlaviyoProjection(
          { scope: input.scope, sourceRunId: input.sourceRunId },
          tx,
        );
        const shopify = await loadShopifyProjection(
          { scope: input.scope, shopifyEvidenceRunId: input.shopifyEvidenceRunId },
          tx,
        );
        const fingerprints = deriveFingerprints({
          scope: input.scope,
          klaviyo,
          shopify,
          ruleChecksum: input.computation.ruleChecksum,
          configChecksum: input.computation.configChecksum,
        });
        if (
          fingerprints.invocationFingerprint !== input.invocationFingerprint ||
          fingerprints.publicationScopeFingerprint !==
            input.publicationScopeFingerprint ||
          klaviyo.checksum !== input.computation.klaviyoSourceChecksum ||
          shopify.checksum !== input.computation.shopifyEvidenceChecksum
        ) {
          throw new MatchInputStaleError("projection_changed_before_publication");
        }
        if (
          input.computation.orderResults.length !==
            input.expectedOrderIds.length ||
          input.computation.eventResults.length !==
            input.expectedEventIds.length
        ) {
          throw new MatchInputStaleError("result_count_mismatch");
        }

        const publishedAt = new Date();
        await tx.insert(klaviyoMatchRuns).values({
          id: input.runId,
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          sourceRunId: input.sourceRunId,
          shopifyEvidenceRunId: input.shopifyEvidenceRunId,
          matcherVersion: input.computation.matcherVersion,
          publicationScopeFingerprint: input.publicationScopeFingerprint,
          invocationFingerprint: input.invocationFingerprint,
          status: "published",
          eventWindowFrom: klaviyo.window.from,
          eventWindowTo: klaviyo.window.to,
          shopifyWindowFrom: shopify.window.from,
          shopifyWindowTo: shopify.window.to,
          klaviyoSourceChecksum: klaviyo.checksum,
          shopifyEvidenceChecksum: shopify.checksum,
          ruleChecksum: input.computation.ruleChecksum,
          configChecksum: input.computation.configChecksum,
          expectedOrderCount: input.expectedOrderIds.length,
          expectedEventCount: input.expectedEventIds.length,
          resultOrderCount: input.computation.orderResults.length,
          resultEventCount: input.computation.eventResults.length,
          candidateCount: input.computation.candidates.length,
          startedAt: input.startedAt,
          completedAt: publishedAt,
          publishedAt,
        });

        // Candidates with generated IDs keyed by (eventId, orderId). The map
        // is fully populated while building the rows, before any consumer
        // below resolves a selected edge against it.
        const candidateIds = new Map<string, string>();
        // Annotating the callback's return type (rather than the array
        // variable) keeps each row a fresh object literal, so an unknown
        // column stays a compile error instead of a silently dropped write.
        const candidateRows = input.computation.candidates.map(
          (candidate): PgInsertValue<typeof klaviyoMatchCandidates> => {
            const id = crypto.randomUUID();
            candidateIds.set(`${candidate.eventId}:${candidate.orderId}`, id);
            return {
              id,
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              runId: input.runId,
              runStatus: "published",
              eventId: candidate.eventId,
              orderId: candidate.orderId,
              candidateClass: candidate.candidateClass,
              method: candidate.method,
              featureVector: candidate.featureVector as Record<string, never>,
              weights: candidate.weights as Record<string, never>,
              tolerances: candidate.tolerances as Record<string, never>,
              score: String(candidate.score),
              confidence: String(candidate.confidence),
              reasonCodes: candidate.reasonCodes,
            };
          },
        );
        await insertChunked(tx, klaviyoMatchCandidates, candidateRows);

        const affectedRunIds = new Set<string>();
        const supersede = async (
          table: typeof klaviyoEventMatchResults | typeof klaviyoOrderMatchResults,
          where: ReturnType<typeof and>,
          reason: "entity_replaced" | "incident_edge_boundary",
        ) => {
          const rows = await tx
            .update(table)
            .set({
              supersededAt: sql`greatest(${table.publishedAt}, now())`,
              supersessionReason: reason,
            })
            .where(where)
            .returning({ runId: table.runId });
          for (const row of rows) affectedRunIds.add(row.runId);
        };

        // Direct entity replacement.
        if (input.expectedEventIds.length > 0) {
          await supersede(
            klaviyoEventMatchResults,
            and(
              eq(klaviyoEventMatchResults.connectionId, input.scope.connectionId),
              ne(klaviyoEventMatchResults.runId, input.runId),
              isNull(klaviyoEventMatchResults.supersededAt),
              inArray(klaviyoEventMatchResults.eventId, input.expectedEventIds),
            ),
            "entity_replaced",
          );
        }
        if (input.expectedOrderIds.length > 0) {
          await supersede(
            klaviyoOrderMatchResults,
            and(
              eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
              ne(klaviyoOrderMatchResults.runId, input.runId),
              isNull(klaviyoOrderMatchResults.supersededAt),
              inArray(klaviyoOrderMatchResults.orderId, input.expectedOrderIds),
            ),
            "entity_replaced",
          );
        }

        // Incident-edge closure in both directions, including duplicate
        // fan-in through candidate edges.
        if (input.expectedEventIds.length > 0) {
          await supersede(
            klaviyoOrderMatchResults,
            and(
              eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
              ne(klaviyoOrderMatchResults.runId, input.runId),
              isNull(klaviyoOrderMatchResults.supersededAt),
              inArray(
                klaviyoOrderMatchResults.selectedEventId,
                input.expectedEventIds,
              ),
            ),
            "incident_edge_boundary",
          );
        }
        if (input.expectedOrderIds.length > 0) {
          const incidentEvents = await tx
            .select({ id: klaviyoEventMatchResults.id })
            .from(klaviyoEventMatchResults)
            .innerJoin(
              klaviyoMatchCandidates,
              eq(
                klaviyoMatchCandidates.id,
                klaviyoEventMatchResults.selectedCandidateId,
              ),
            )
            .where(
              and(
                eq(
                  klaviyoEventMatchResults.connectionId,
                  input.scope.connectionId,
                ),
                ne(klaviyoEventMatchResults.runId, input.runId),
                isNull(klaviyoEventMatchResults.supersededAt),
                inArray(klaviyoMatchCandidates.orderId, input.expectedOrderIds),
              ),
            );
          if (incidentEvents.length > 0) {
            await supersede(
              klaviyoEventMatchResults,
              and(
                inArray(
                  klaviyoEventMatchResults.id,
                  incidentEvents.map((row) => row.id),
                ),
              ),
              "incident_edge_boundary",
            );
          }
        }


        // Row construction still runs the per-row edge resolution in order, so
        // a stale computation whose selected edge has no candidate throws here
        // and aborts the transaction exactly as the row-by-row inserts did.
        const eventResultRows = input.computation.eventResults.map(
          (result): PgInsertValue<typeof klaviyoEventMatchResults> => {
            const selectedCandidateId =
              result.selectedEdge === null
                ? null
                : (candidateIds.get(
                    `${result.selectedEdge.eventId}:${result.selectedEdge.orderId}`,
                  ) ?? null);
            if (result.selectedEdge !== null && selectedCandidateId === null) {
              throw new MatchInputStaleError("selected_edge_missing_candidate");
            }
            return {
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              runId: input.runId,
              runStatus: "published",
              eventId: result.eventId,
              status: result.status,
              selectedCandidateId,
              selectedClass: result.selectedClass,
              candidateCount: result.candidateCount,
              duplicateWarning: result.duplicateWarning ? 1 : 0,
              reasonCodes: result.reasonCodes,
              publishedAt,
            };
          },
        );
        await insertChunked(tx, klaviyoEventMatchResults, eventResultRows);

        const orderResultRows = input.computation.orderResults.map(
          (result): PgInsertValue<typeof klaviyoOrderMatchResults> => {
            const selectedCandidateId =
              result.selectedEdge === null
                ? null
                : (candidateIds.get(
                    `${result.selectedEdge.eventId}:${result.selectedEdge.orderId}`,
                  ) ?? null);
            if (result.selectedEdge !== null && selectedCandidateId === null) {
              throw new MatchInputStaleError("selected_edge_missing_candidate");
            }
            return {
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              runId: input.runId,
              runStatus: "published",
              orderId: result.orderId,
              status: result.status,
              selectedCandidateId,
              selectedClass: result.selectedClass,
              selectedEventId: result.selectedEventId,
              productStatus: result.productStatus,
              reasonCodes: result.reasonCodes,
              matcherVersion: input.computation.matcherVersion,
              publishedAt,
            };
          },
        );
        await insertChunked(tx, klaviyoOrderMatchResults, orderResultRows);

        const productLinkRows = input.computation.productLinks.map(
          (link): PgInsertValue<typeof klaviyoProductEvidenceLinks> => ({
            organizationId: input.scope.organizationId,
            storeId: input.scope.storeId,
            connectionId: input.scope.connectionId,
            runId: input.runId,
            runStatus: "published",
            orderedProductEventId: link.orderedProductEventId,
            placedOrderEventId: link.placedOrderEventId,
            shopifyOrderId: link.shopifyOrderId,
            method: link.method,
            matcherVersion: input.computation.matcherVersion,
            status: link.status,
            reasonCodes: link.reasonCodes,
          }),
        );
        await insertChunked(tx, klaviyoProductEvidenceLinks, productLinkRows);

        // A later exact-scope publication explicitly supersedes an earlier
        // zero-result publication.
        const zeroRows = await tx
          .update(klaviyoMatchRuns)
          .set({
            supersededAt: sql`greatest(${klaviyoMatchRuns.publishedAt}, now())`,
          })
          .where(
            and(
              eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
              ne(klaviyoMatchRuns.id, input.runId),
              eq(klaviyoMatchRuns.status, "published"),
              eq(
                klaviyoMatchRuns.publicationScopeFingerprint,
                input.publicationScopeFingerprint,
              ),
              isNull(klaviyoMatchRuns.supersededAt),
              eq(klaviyoMatchRuns.expectedOrderCount, 0),
              eq(klaviyoMatchRuns.expectedEventCount, 0),
            ),
          )
          .returning({ id: klaviyoMatchRuns.id });
        void zeroRows;

        await recountMatchRunCurrentness([...affectedRunIds], tx);
        return { runId: input.runId, publishedAt, replayed: false };
      },
      { isolationLevel: "repeatable read" },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Invocation race: elect the committed winner and return it after
      // validating its exact binding.
      const winner = await loadPublishedByInvocation(
        db,
        input.scope,
        input.invocationFingerprint,
      );
      if (
        winner &&
        winner.sourceRunId === input.sourceRunId &&
        winner.shopifyEvidenceRunId === input.shopifyEvidenceRunId &&
        winner.publicationScopeFingerprint === input.publicationScopeFingerprint
      ) {
        return {
          runId: winner.id,
          publishedAt: winner.publishedAt!,
          replayed: true,
        };
      }
    }
    throw error;
  }
}

export async function publishFailedMatchRun(input: {
  scope: KlaviyoConnectionScope;
  runId: string;
  startedAt: Date;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  publicationScopeFingerprint: string;
  invocationFingerprint: string;
  matcherVersion: typeof MATCHER_VERSION;
  safeFailureCode: "MATCH_COMPUTATION_FAILED" | "MATCH_PUBLICATION_FAILED";
}): Promise<{ runId: string; changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStoreThenConnection(tx, input.scope);
    const [existing] = await tx
      .select({ id: klaviyoMatchRuns.id, status: klaviyoMatchRuns.status })
      .from(klaviyoMatchRuns)
      .where(eq(klaviyoMatchRuns.id, input.runId))
      .limit(1);
    // Idempotent; never rewrites an existing (published or failed) run.
    if (existing) return { runId: input.runId, changed: false };
    const now = new Date();
    await tx.insert(klaviyoMatchRuns).values({
      id: input.runId,
      organizationId: input.scope.organizationId,
      storeId: input.scope.storeId,
      connectionId: input.scope.connectionId,
      sourceRunId: input.sourceRunId,
      shopifyEvidenceRunId: input.shopifyEvidenceRunId,
      matcherVersion: input.matcherVersion,
      publicationScopeFingerprint: input.publicationScopeFingerprint,
      invocationFingerprint: input.invocationFingerprint,
      status: "failed",
      failureCode: input.safeFailureCode,
      startedAt: input.startedAt,
      completedAt: now,
    });
    return { runId: input.runId, changed: true };
  });
}

export const MATCH_SUPERSESSION_TIME = sql`now()`;
