import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { computeHealth, rollupCreativeHealth, type CreativeHealth } from "./creative-health";
import { effectiveAdStatusSql } from "./effective-ad-status";
import { basePerformanceLogFilter, clickWeightedCpc } from "./performance-log-sql";

type AdHealthRow = {
  ad_id: string;
  ad_creative_id: string;
  format: string | null;
  status: string | null;
  spend: string | null;
  conversions: string | null;
  recent_conversions: string | null;
  roas: string | null;
  avg_ctr: string | null;
  recent_ctr: string | null;
  avg_cpc: string | null;
  recent_cpc: string | null;
  avg_cpa: string | null;
  recent_cpa: string | null;
  frequency: string | null;
  recent_hook_rate: string | null;
  prior_hook_rate: string | null;
  thumbstop_ratio: string | null;
};

/**
 * Fetch per-ad metrics for the given creatives, compute each ad's health,
 * then roll up to a creative-level health weighted by spend. The date filter
 * (if provided) is applied to the performance_log rows used for aggregation,
 * so the rollup matches the window being displayed.
 */
export type CreativeRollup = {
  health: CreativeHealth | null;
  reasons: string[];
  activeInWindow: boolean;
};

export async function computeCreativeHealthByCreativeId(opts: {
  organizationId: string;
  creativeIds: string[];
  dateFilter?: SQL;
}): Promise<Map<string, CreativeRollup>> {
  const { organizationId, creativeIds, dateFilter } = opts;
  const result = new Map<string, CreativeRollup>();
  if (creativeIds.length === 0) return result;

  const plDateFilter = dateFilter ? sql`AND ${dateFilter}` : sql``;
  const basePl = basePerformanceLogFilter("pl");
  const basePl2 = basePerformanceLogFilter("pl2");
  const basePl3 = basePerformanceLogFilter("pl3");

  const rows = (
    await db.execute(sql`
      SELECT
        ad.id as ad_id,
        ad.ad_creative_id,
        ac.format::text as format,
        ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} as status,
        sum(pl.spend)::text as spend,
        sum(pl.conversions)::text as conversions,
        (
          SELECT sum(pl2.conversions)
          FROM performance_log pl2
          WHERE pl2.ad_id = ad.id
            AND ${basePl2}
            AND pl2.date_start > (
              SELECT max(pl3.date_end) - 3
              FROM performance_log pl3
              WHERE pl3.ad_id = ad.id
                AND ${basePl3}
            )
        )::text as recent_conversions,
        (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
        (coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0))::text as avg_ctr,
        ${clickWeightedCpc("pl")}::text as avg_cpc,
        (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as avg_cpa,
        avg(pl.frequency)::text as frequency,
        (sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0))::text as thumbstop_ratio,
        (
          SELECT (coalesce(sum(pl2.ctr * pl2.impressions), 0) / nullif(sum(pl2.impressions), 0))::text
          FROM performance_log pl2
          WHERE pl2.ad_id = ad.id
            AND ${basePl2}
            AND pl2.date_start > (
              SELECT max(pl3.date_end) - 3
              FROM performance_log pl3
              WHERE pl3.ad_id = ad.id
                AND ${basePl3}
            )
        ) as recent_ctr,
        (
          SELECT ${clickWeightedCpc("pl2")}::text
          FROM performance_log pl2
          WHERE pl2.ad_id = ad.id
            AND ${basePl2}
            AND pl2.date_start > (
              SELECT max(pl3.date_end) - 3
              FROM performance_log pl3
              WHERE pl3.ad_id = ad.id
                AND ${basePl3}
            )
        ) as recent_cpc,
        (
          SELECT (coalesce(sum(pl2.spend), 0) / nullif(sum(pl2.conversions), 0))::text
          FROM performance_log pl2
          WHERE pl2.ad_id = ad.id
            AND ${basePl2}
            AND pl2.date_start > (
              SELECT max(pl3.date_end) - 3
              FROM performance_log pl3
              WHERE pl3.ad_id = ad.id
                AND ${basePl3}
            )
        ) as recent_cpa,
        (
          SELECT (sum(pl2.video_views_3s)::float / nullif(sum(pl2.impressions), 0))::text
          FROM performance_log pl2
          WHERE pl2.ad_id = ad.id
            AND ${basePl2}
            AND pl2.date_start > (
              SELECT max(pl3.date_end) - 3
              FROM performance_log pl3
              WHERE pl3.ad_id = ad.id
                AND ${basePl3}
            )
        ) as recent_hook_rate,
        (
          SELECT (sum(pl2.video_views_3s)::float / nullif(sum(pl2.impressions), 0))::text
          FROM performance_log pl2
          WHERE pl2.ad_id = ad.id
            AND ${basePl2}
            AND pl2.date_end <= (
              SELECT max(pl3.date_end) - 3
              FROM performance_log pl3
              WHERE pl3.ad_id = ad.id
                AND ${basePl3}
            )
        ) as prior_hook_rate
      FROM ad
      JOIN ad_creative ac ON ac.id = ad.ad_creative_id
      LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
      LEFT JOIN performance_log pl ON pl.ad_id = ad.id AND ${basePl} ${plDateFilter}
      WHERE ad.organization_id = ${organizationId}
        AND ad.ad_creative_id IN (${sql.join(creativeIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY ad.id, ac.format, ast.status
    `)
  ).rows as AdHealthRow[];

  type AdRollupInput = {
    spend: number | null;
    health: CreativeHealth | null;
    reasons: string[];
    status: string | null;
  };
  const byCreative = new Map<string, AdRollupInput[]>();
  for (const r of rows) {
    const spend = r.spend != null ? parseFloat(r.spend) : null;
    const verdict = computeHealth({
      roas: r.roas != null ? parseFloat(r.roas) : null,
      spend,
      conversions: r.conversions != null ? parseInt(r.conversions, 10) : null,
      status: r.status,
      format: r.format,
      recentConversions: r.recent_conversions != null ? parseInt(r.recent_conversions, 10) : null,
      recentCtr: r.recent_ctr != null ? parseFloat(r.recent_ctr) : null,
      avgCtr: r.avg_ctr != null ? parseFloat(r.avg_ctr) : null,
      recentCpc: r.recent_cpc != null ? parseFloat(r.recent_cpc) : null,
      avgCpc: r.avg_cpc != null ? parseFloat(r.avg_cpc) : null,
      frequency: r.frequency != null ? parseFloat(r.frequency) : null,
      recentHookRate: r.recent_hook_rate != null ? parseFloat(r.recent_hook_rate) : null,
      priorHookRate: r.prior_hook_rate != null ? parseFloat(r.prior_hook_rate) : null,
      recentCpa: r.recent_cpa != null ? parseFloat(r.recent_cpa) : null,
      avgCpa: r.avg_cpa != null ? parseFloat(r.avg_cpa) : null,
      thumbstopRatio: r.thumbstop_ratio != null ? parseFloat(r.thumbstop_ratio) : null,
    });
    const list = byCreative.get(r.ad_creative_id) ?? [];
    list.push({ spend, health: verdict.health, reasons: verdict.reasons, status: r.status });
    byCreative.set(r.ad_creative_id, list);
  }

  for (const id of creativeIds) {
    const adRows = byCreative.get(id) ?? [];
    const activeInWindow = adRows.some(
      (a) => a.status === "active" && a.spend != null && a.spend > 0,
    );
    const rolled = rollupCreativeHealth(adRows);
    result.set(id, {
      health: rolled.health,
      reasons: rolled.reasons,
      activeInWindow,
    });
  }
  return result;
}
