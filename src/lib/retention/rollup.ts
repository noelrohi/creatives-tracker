/**
 * Monthly rollup of daily base performance rows
 * (docs/superpowers/specs/2026-08-12-storage-retention-design.md §1).
 *
 * Additive sums only — ratios are derived at read time — and no reach, which
 * cannot be summed across days.
 *
 * A month is never recomputed from partial data. Months starting on or after
 * baseWindowStart(today) are fully retained, so they are recomputed on every
 * run. Older months are inserted once, as an initial capture, and then frozen:
 * the sweep rolls up before it deletes, so that capture was taken while the
 * month was complete, and recomputing it from the survivors would silently
 * shrink history.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { baseWindowStart } from "./policy";

const SUM_COLUMNS = [
  "spend",
  "purchase_value",
  "purchase_value_7d_click",
  "purchase_value_1d_view",
  "conversions",
  "impressions",
  "link_clicks",
  "clicks_all",
  "landing_page_views",
  "add_to_cart",
  "initiate_checkout",
  "video_views_3s",
  "video_thruplay",
] as const;

const INTEGER_SUM_COLUMNS = new Set<string>([
  "conversions",
  "impressions",
  "link_clicks",
  "clicks_all",
  "landing_page_views",
  "add_to_cart",
  "initiate_checkout",
  "video_views_3s",
  "video_thruplay",
]);

function sumExpression(column: string) {
  // sum() widens integer to bigint; the summary columns are integer.
  return INTEGER_SUM_COLUMNS.has(column)
    ? sql`sum(${sql.raw(`pl.${column}`)})::integer`
    : sql`sum(${sql.raw(`pl.${column}`)})`;
}

export async function rollupMonthlySummaries(input: {
  organizationId: string;
  today: string;
}): Promise<{ monthsUpserted: number }> {
  const baseCutoff = baseWindowStart(input.today);
  const insertColumns = sql.join(
    SUM_COLUMNS.map((column) => sql.raw(column)),
    sql`, `,
  );
  const selectSums = sql.join(
    SUM_COLUMNS.map((column) => sumExpression(column)),
    sql`, `,
  );
  const updateSums = sql.join(
    SUM_COLUMNS.map(
      (column) => sql`${sql.raw(column)} = excluded.${sql.raw(column)}`,
    ),
    sql`, `,
  );

  const result = await db.execute(sql`
    INSERT INTO performance_monthly_summary (
      id, organization_id, month, ${insertColumns},
      days_with_data, source_row_count, rolled_up_at, created_at, updated_at
    )
    SELECT
      gen_random_uuid()::text,
      ${input.organizationId},
      date_trunc('month', pl.date_start)::date,
      ${selectSums},
      count(DISTINCT pl.date_start)::integer,
      count(*)::integer,
      now(), now(), now()
    FROM performance_log pl
    WHERE pl.organization_id = ${input.organizationId}
      AND ${basePerformanceLogFilter("pl")}
    GROUP BY date_trunc('month', pl.date_start)
    ON CONFLICT (organization_id, month) DO UPDATE SET
      ${updateSums},
      days_with_data = excluded.days_with_data,
      source_row_count = excluded.source_row_count,
      rolled_up_at = now(),
      updated_at = now()
    WHERE performance_monthly_summary.month >= ${baseCutoff}::date
  `);

  return { monthsUpserted: result.rowCount ?? 0 };
}
