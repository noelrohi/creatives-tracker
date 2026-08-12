/**
 * Read-only retention report
 * (docs/superpowers/specs/2026-08-12-storage-retention-design.md §2).
 * Never deletes; executeRetention is the only writer.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  retentionCategoryDefinitions,
  retentionCutoffs,
  type RetentionCutoffs,
} from "./shared";

export type RetentionCategory = {
  key: string;
  table: string;
  candidateRows: number;
  oldestDate: string | null;
  newestDate: string | null;
  /** Deleted by PostgreSQL with its parent, not by the executor. */
  cascadeOnly: boolean;
};

export type RetentionPlan = {
  organizationId: string;
  today: string;
  cutoffs: RetentionCutoffs;
  categories: RetentionCategory[];
  totalCandidateRows: number;
};

type CountRow = {
  candidate_rows: number | string | null;
  oldest_date: string | null;
  newest_date: string | null;
};

/** Every organization with performance data — the sweep and CLI iterate this. */
export async function listRetentionOrganizationIds() {
  const result = await db.execute(sql`
    SELECT DISTINCT organization_id
    FROM performance_log
    WHERE organization_id IS NOT NULL
    ORDER BY organization_id
  `);
  return (result.rows as { organization_id: string }[]).map(
    (row) => row.organization_id,
  );
}

export async function planRetention(input: {
  organizationId: string;
  today: string;
}): Promise<RetentionPlan> {
  const cutoffs = retentionCutoffs(input.today);
  const definitions = retentionCategoryDefinitions(
    input.organizationId,
    cutoffs,
  );

  const categories: RetentionCategory[] = [];
  for (const definition of definitions) {
    const result = await db.execute(sql`
      SELECT
        count(*)::integer AS candidate_rows,
        min(${definition.dateExpression})::date::text AS oldest_date,
        max(${definition.dateExpression})::date::text AS newest_date
      FROM ${sql.raw(definition.table)} ${sql.raw(definition.alias)}
      WHERE ${definition.predicate}
    `);
    const row = (result.rows[0] ?? {}) as Partial<CountRow>;
    categories.push({
      key: definition.key,
      table: definition.table,
      candidateRows: Number(row.candidate_rows ?? 0),
      oldestDate: row.oldest_date ?? null,
      newestDate: row.newest_date ?? null,
      cascadeOnly: definition.cascadeOnly ?? false,
    });
  }

  return {
    organizationId: input.organizationId,
    today: input.today,
    cutoffs,
    categories,
    totalCandidateRows: categories.reduce(
      (total, category) => total + category.candidateRows,
      0,
    ),
  };
}
