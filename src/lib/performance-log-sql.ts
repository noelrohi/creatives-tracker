import { sql, type SQL } from "drizzle-orm";

const BREAKDOWN_COLUMNS = [
  "country",
  "platform",
  "placement",
  "device",
  "age",
  "gender",
] as const;

function qualifiedColumn(alias: string, column: string): SQL {
  return sql.raw(`${alias}.${column}`);
}

// Filter for canonical per-ad-per-day aggregate rows:
//   - breakdown columns are empty/null (not a demographic split), AND
//   - date_start = date_end (not a legacy multi-day rollup)
// Multi-day rollup rows coexist with single-day rows for the same ad + date
// range in older data, so aggregations that don't exclude them double-count
// spend, revenue, and conversions.
export function basePerformanceLogFilter(alias = "pl"): SQL {
  const parts: SQL[] = BREAKDOWN_COLUMNS.map(
    (column) => sql`coalesce(${qualifiedColumn(alias, column)}, '') = ''`,
  );
  parts.push(sql`${qualifiedColumn(alias, "date_start")} = ${qualifiedColumn(alias, "date_end")}`);
  return sql.join(parts, sql` AND `);
}

// CTR is a ratio, so aggregating it across rows means weighting each row by the
// impressions it was measured over. `avg(pl.ctr)` gives a 200-impression row the
// same say as a 400,000-impression one and does not describe the group at all.
// Returns NULL when the group has no impressions.
//
// The denominator skips rows with a NULL ctr, because a NULL there means Meta
// reported no CTR for the row, not that the row earned no clicks — when there
// are genuinely no clicks Meta sends an explicit 0. Counting those impressions
// would drag the result toward zero on the strength of a number we were never
// given, and `avg(pl.ctr)` did not count them either, so this keeps the change
// to the weighting alone.
export function impressionWeightedCtr(alias = "pl"): SQL {
  const ctr = qualifiedColumn(alias, "ctr");
  const impressions = qualifiedColumn(alias, "impressions");
  return sql`(coalesce(sum(${ctr} * ${impressions}), 0) / nullif(sum(${impressions}) FILTER (WHERE ${ctr} IS NOT NULL), 0))`;
}
