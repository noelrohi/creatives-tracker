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

// CPC is spend / clicks, so aggregating it means summing both sides — not
// averaging per-row ratios. `avg(pl.cpc)` gives a 3-click row the same say as a
// 3,000-click one and does not describe the group at all.
//
// The denominator is all clicks, not link clicks: Meta's per-row `cpc` is
// defined over all clicks, and measured against production it matches
// spend / clicks_all to a median relative error of 1.6e-07 (against link_clicks
// the error is ~50%). Per-row clicks are read in three steps, in this order:
// `clicks_all` when the row has it (only rows synced after #231 do), else the
// figure implied by impressions and `ctr`, Meta's all-clicks CTR in percent,
// else spend / cpc — by the same identity, and it keeps a row that carries only
// Meta's own ratio in the aggregate instead of dropping it.
//
// Rows where all three come up empty carry no click signal at all, so they are
// filtered out of the numerator as well, mirroring `impressionWeightedCtr`.
// Leaving their spend in while their clicks were missing from the denominator
// would inflate the CPC of every group that contains one.
export function clickWeightedCpc(alias = "pl"): SQL {
  const spend = qualifiedColumn(alias, "spend");
  const clicks = impliedClicks(alias);
  return sql`(sum(${spend}) FILTER (WHERE ${clicks} IS NOT NULL) / nullif(sum(${clicks}), 0))`;
}

// Per-row all-clicks: the synced value when we have it, else implied from
// impressions and Meta's all-clicks CTR (percent-scale), else backed out of
// Meta's own per-row cpc. NULL when the row carries none of the three.
function impliedClicks(alias: string): SQL {
  const clicksAll = qualifiedColumn(alias, "clicks_all");
  const impressions = qualifiedColumn(alias, "impressions");
  const ctr = qualifiedColumn(alias, "ctr");
  const spend = qualifiedColumn(alias, "spend");
  const cpc = qualifiedColumn(alias, "cpc");
  return sql`coalesce(${clicksAll}::numeric, ${impressions} * ${ctr} / 100.0, ${spend} / nullif(${cpc}, 0))`;
}
