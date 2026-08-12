/**
 * Retention sweep
 * (docs/superpowers/specs/2026-08-12-storage-retention-design.md §2).
 *
 * Dry-run is the default; a caller has to ask for deletes explicitly.
 * Deletes run in id-batches until a batch comes back empty, so locks stay
 * short and a crashed run resumes safely.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { planRetention, type RetentionPlan } from "./plan";
import { rollupMonthlySummaries } from "./rollup";
import { retentionCategoryDefinitions, retentionCutoffs } from "./shared";

const DEFAULT_BATCH_SIZE = 5_000;

export type RetentionResult = {
  plan: RetentionPlan;
  dryRun: boolean;
  deleted: Record<string, number>;
};

export async function executeRetention(input: {
  organizationId: string;
  today: string;
  dryRun?: boolean;
  batchSize?: number;
}): Promise<RetentionResult> {
  const dryRun = input.dryRun ?? true;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const plan = await planRetention({
    organizationId: input.organizationId,
    today: input.today,
  });

  if (dryRun) {
    return { plan, dryRun: true, deleted: {} };
  }

  // Every month is locked into the summary table before any base row can go.
  await rollupMonthlySummaries({
    organizationId: input.organizationId,
    today: input.today,
  });

  // cascadeOnly categories are plan-visibility rows; PostgreSQL deletes them
  // with their parent, so deleting them here would double-fire.
  const definitions = retentionCategoryDefinitions(
    input.organizationId,
    retentionCutoffs(input.today),
  )
    .filter((definition) => !definition.cascadeOnly)
    .sort((a, b) => a.deleteOrder - b.deleteOrder);

  const deleted: Record<string, number> = {};
  for (const definition of definitions) {
    let removed = 0;
    for (;;) {
      const result = await db.execute(sql`
        DELETE FROM ${sql.raw(definition.table)}
        WHERE id IN (
          SELECT ${sql.raw(`${definition.alias}.id`)}
          FROM ${sql.raw(definition.table)} ${sql.raw(definition.alias)}
          WHERE ${definition.predicate}
          LIMIT ${batchSize}
        )
      `);
      const batch = result.rowCount ?? 0;
      removed += batch;
      if (batch === 0) break;
    }
    // Guarded categories (sync runs) re-evaluate after their children are
    // gone, so a count can exceed the plan snapshot taken before deletes.
    deleted[definition.key] = removed;
  }

  return { plan, dryRun: false, deleted };
}
