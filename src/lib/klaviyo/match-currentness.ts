import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { KlaviyoStoreTransaction } from "@/lib/klaviyo/source-store";
import {
  klaviyoEventMatchResults,
  klaviyoMatchRuns,
  klaviyoOrderMatchResults,
} from "@/schema/klaviyo-match";

/**
 * Shared locked recount used by publication, privacy erasure, and rotation
 * prune. A nonempty published run is marked superseded only when zero
 * current (unsuperseded) order and event results remain. A zero-result
 * publication stays fresh: only a later exact-scope publication supersedes
 * it explicitly, never a vacuous entity count. Executor-only: callers hold
 * the store→connection lock order and pass their transaction.
 */
export async function recountMatchRunCurrentness(
  affectedRunIds: readonly string[],
  tx: KlaviyoStoreTransaction,
): Promise<{ supersededRunIds: string[] }> {
  const runIds = [...new Set(affectedRunIds)];
  if (runIds.length === 0) return { supersededRunIds: [] };

  const runs = await tx
    .select({
      id: klaviyoMatchRuns.id,
      status: klaviyoMatchRuns.status,
      supersededAt: klaviyoMatchRuns.supersededAt,
      expectedOrderCount: klaviyoMatchRuns.expectedOrderCount,
      expectedEventCount: klaviyoMatchRuns.expectedEventCount,
    })
    .from(klaviyoMatchRuns)
    .where(inArray(klaviyoMatchRuns.id, runIds))
    .for("update");

  const supersededRunIds: string[] = [];
  for (const run of runs) {
    if (run.status !== "published" || run.supersededAt !== null) continue;
    const nonempty =
      (run.expectedOrderCount ?? 0) > 0 || (run.expectedEventCount ?? 0) > 0;
    if (!nonempty) continue;

    const [currentOrders] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoOrderMatchResults)
      .where(
        and(
          eq(klaviyoOrderMatchResults.runId, run.id),
          isNull(klaviyoOrderMatchResults.supersededAt),
        ),
      );
    if ((currentOrders?.count ?? 0) > 0) continue;
    const [currentEvents] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoEventMatchResults)
      .where(
        and(
          eq(klaviyoEventMatchResults.runId, run.id),
          isNull(klaviyoEventMatchResults.supersededAt),
        ),
      );
    if ((currentEvents?.count ?? 0) > 0) continue;

    await tx
      .update(klaviyoMatchRuns)
      .set({ supersededAt: sql`greatest(${klaviyoMatchRuns.publishedAt}, now())` })
      .where(
        and(eq(klaviyoMatchRuns.id, run.id), isNull(klaviyoMatchRuns.supersededAt)),
      );
    supersededRunIds.push(run.id);
  }
  return { supersededRunIds };
}
