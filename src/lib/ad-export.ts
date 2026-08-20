import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { computeHealth, rollupCreativeHealth, type CreativeHealth } from "./creative-health";
import { effectiveAdStatusSql } from "./effective-ad-status";
import { basePerformanceLogFilter, clickWeightedCpc } from "./performance-log-sql";
import { clampToBreakdownWindow } from "./retention/window-guard";

type RawAdRow = {
  ad_id: string;
  meta_ad_id: string | null;
  ad_name: string;
  ad_status: string | null;
  ad_set_status: string | null;
  ad_destination_url: string | null;

  creative_id: string;
  creative_name: string;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awareness_level: string | null;
  hook: string | null;
  cta: string | null;
  asset_url: string | null;
  video_url: string | null;

  ad_set_id: string | null;
  meta_ad_set_id: string | null;
  ad_set_name: string | null;
  campaign_id: string | null;
  meta_campaign_id: string | null;
  campaign_name: string | null;
  account_id: string | null;
  account_name: string | null;
  team_id: string | null;
  team_name: string | null;

  window_spend: string | null;
  window_revenue: string | null;
  window_conversions: string | null;
  window_roas: string | null;
  window_cpa: string | null;
  window_ctr: string | null;
  window_cpc: string | null;
  window_frequency: string | null;
  window_impressions: string | null;
  window_clicks: string | null;
  window_hook_rate: string | null;
  window_days_with_logs: string | null;

  lifetime_spend: string | null;
  lifetime_conversions: string | null;
  lifetime_roas: string | null;
  running_days: string | null;
  last_log_at: string | null;

  recent_conversions: string | null;
  recent_ctr: string | null;
  recent_cpc: string | null;
  recent_cpa: string | null;
  recent_hook_rate: string | null;
  prior_hook_rate: string | null;
};

type DemographicDimension = "gender" | "age" | "country" | "device";

type RawDemographicRow = {
  ad_id: string;
  label: string | null;
  spend: string | null;
  conversions: string | null;
  roas: string | null;
};

export type AdExportRow = {
  // IDs
  adId: string;
  metaAdId: string | null;
  adName: string;
  creativeId: string;
  creativeName: string;
  adSetId: string | null;
  metaAdSetId: string | null;
  adSetName: string | null;
  campaignId: string | null;
  metaCampaignId: string | null;
  campaignName: string | null;
  accountId: string | null;
  accountName: string | null;
  teamId: string | null;
  teamName: string | null;

  // Creative attributes
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  cta: string | null;
  destinationUrl: string | null;
  assetUrl: string | null;
  videoUrl: string | null;

  // Status & time
  status: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  // Spread of the ad's lifetime log history (max date_end - min date_start).
  // CSV exposes this as `days_with_logs` — it is NOT "days since launch".
  runningDays: number | null;
  // Count of distinct log dates inside the selected export window.
  daysInWindow: number | null;
  lastLogAt: string | null;
  activeInWindow: boolean;

  // Window metrics
  windowSpend: number | null;
  windowRevenue: number | null;
  windowConversions: number | null;
  windowRoas: number | null;
  windowCpa: number | null;
  windowCtr: number | null;
  windowCpc: number | null;
  windowFrequency: number | null;
  windowImpressions: number | null;
  windowClicks: number | null;
  windowHookRate: number | null;
  // Effective window the demographic breakdowns cover — clamped to the retained
  // 14-day breakdown window, so it can be narrower than windowFrom/windowTo.
  demoWindowFrom: string;
  demoWindowTo: string;
  genderBreakdown: string | null;
  ageBreakdown: string | null;
  countryBreakdown: string | null;
  deviceBreakdown: string | null;

  // Lifetime
  lifetimeSpend: number | null;
  lifetimeConversions: number | null;
  lifetimeRoas: number | null;

  // Trend deltas: recent vs baseline, expressed as a percent change.
  // Direction of "good" is metric-dependent:
  //   ctrDeltaPct, hookRateDeltaPct → positive = better (rate went up)
  //   cpcDeltaPct, cpaDeltaPct      → positive = worse  (cost went up)
  ctrDeltaPct: number | null;
  cpcDeltaPct: number | null;
  cpaDeltaPct: number | null;
  hookRateDeltaPct: number | null;

  // Verdicts
  adHealth: CreativeHealth | null;
  adHealthReasons: string[];
  creativeRollupHealth: CreativeHealth | null;
  creativeRollupReasons: string[];

  dollarsAtRisk: number;

  flagDisableCandidate: boolean;
  flagScaleCandidate: boolean;
  flagReviewCandidate: boolean;
  // pause_now → confident-dead, paste the meta_ad_id and pause today.
  // watch     → leaning bad but didn't get a fair shot on both spend and time.
  // cooking   → too early to call (under-spent and under-aged).
  // null      → not bleeding.
  disableTier: "pause_now" | "watch" | "cooking" | null;
  // True when a *different* ad on the same creative is profitable (ROAS >= 1, spend >= $25).
  // Lets the agent (and CSV reader) tell "this creative is dead" from
  // "this creative works elsewhere — pause this placement, keep the concept".
  creativeHasWinners: boolean;
};

export type CreativeExportRow = {
  creativeId: string;
  creativeName: string;
  accountId: string | null;
  accountName: string | null;
  teamId: string | null;
  teamName: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  cta: string | null;
  destinationUrl: string | null;
  assetUrl: string | null;
  videoUrl: string | null;

  windowFrom: string | null;
  windowTo: string | null;

  adCount: number;
  activeAdCount: number;
  activeInWindow: boolean;

  windowSpend: number | null;
  windowRevenue: number | null;
  windowConversions: number | null;
  windowRoas: number | null;
  windowCpa: number | null;
  windowCtr: number | null;

  lifetimeSpend: number | null;
  lifetimeConversions: number | null;
  lifetimeRoas: number | null;
  runningDays: number | null;
  lastLogAt: string | null;

  rollupHealth: CreativeHealth | null;
  rollupReasons: string[];
  dollarsAtRisk: number;

  flagDisableCandidate: boolean;
  flagScaleCandidate: boolean;
  flagReviewCandidate: boolean;
};

function n(v: string | null): number | null {
  if (v == null) return null;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
}

function pct(recent: number | null, baseline: number | null): number | null {
  if (recent == null || baseline == null || baseline === 0) return null;
  return ((recent - baseline) / baseline) * 100;
}

function fmtCompactNumber(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatDemographicSummary(
  rows: RawDemographicRow[],
  totalSpend: number | null,
): string | null {
  if (rows.length === 0) return null;

  const topRows = rows.slice(0, 5);
  const overflow = rows.length - topRows.length;
  const parts = topRows.map((row) => {
    const label = row.label?.trim() || "Unknown";
    const spend = n(row.spend);
    const conversions = n(row.conversions);
    const roas = n(row.roas);
    const details = [];

    if (spend != null && totalSpend != null && totalSpend > 0) {
      details.push(`${((spend / totalSpend) * 100).toFixed(0)}% spend`);
    }
    const convText = fmtCompactNumber(conversions);
    if (convText) details.push(`${convText} conv`);
    if (roas != null) details.push(`${roas.toFixed(1).replace(/\.0$/, "")}x ROAS`);

    return details.length > 0 ? `${label} (${details.join(", ")})` : label;
  });

  if (overflow > 0) {
    parts.push(`+${overflow} more`);
  }

  return parts.join(" | ");
}

type DemographicSummaries = {
  /** Effective window the summaries were computed over. */
  windowFrom: string;
  windowTo: string;
  /** True when the export range was wider than the retained breakdown window. */
  clamped: boolean;
  byDimension: Record<DemographicDimension, Map<string, string>>;
};

async function fetchAdDemographicSummaries(opts: {
  organizationId: string;
  from: string;
  to: string;
  adIds: string[];
}): Promise<DemographicSummaries> {
  const { organizationId, to, adIds } = opts;

  // Breakdown rows only exist for the last 14 days, so the demographic section
  // is computed over the intersection of the export range and that window.
  // The window is carried out with the result so the CSV can label it — a
  // silently narrower section would read as "these ads had no other audiences".
  const from = clampToBreakdownWindow(opts.from);
  const clamped = from !== opts.from;

  const summaries: DemographicSummaries = {
    windowFrom: from,
    windowTo: to,
    clamped,
    byDimension: {
      gender: new Map(),
      age: new Map(),
      country: new Map(),
      device: new Map(),
    },
  };

  if (adIds.length === 0 || from > to) return summaries;

  const adIdList = sql.join(adIds.map((id) => sql`${id}`), sql`, `);
  const dimensionColumns: Record<DemographicDimension, string> = {
    gender: "pl.gender",
    age: "pl.age",
    country: "pl.country",
    device: "pl.device",
  };

  const results = await Promise.all(
    (Object.entries(dimensionColumns) as [DemographicDimension, string][])
      .map(async ([dimension, column]) => {
        const rows = (
          await db.execute(sql`
            SELECT
              pl.ad_id,
              ${sql.raw(column)}::text AS label,
              sum(pl.spend)::text AS spend,
              sum(pl.conversions)::text AS conversions,
              (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text AS roas
            FROM performance_log pl
            JOIN ad
              ON ad.id = pl.ad_id
             AND ad.organization_id = ${organizationId}
            WHERE pl.organization_id = ${organizationId}
              AND pl.ad_id IN (${adIdList})
              AND pl.date_start = pl.date_end
              AND pl.date_start >= ${from}::date
              AND pl.date_start <= ${to}::date
              AND ${sql.raw(column)} IS NOT NULL
              AND ${sql.raw(column)} != ''
            GROUP BY pl.ad_id, ${sql.raw(column)}
            ORDER BY pl.ad_id, sum(pl.spend) DESC NULLS LAST
          `)
        ).rows as RawDemographicRow[];

        return { dimension, rows };
      }),
  );

  for (const { dimension, rows } of results) {
    const rowsByAd = new Map<string, RawDemographicRow[]>();
    for (const row of rows) {
      const adRows = rowsByAd.get(row.ad_id) ?? [];
      adRows.push(row);
      rowsByAd.set(row.ad_id, adRows);
    }

    for (const [adId, adRows] of rowsByAd) {
      const totalSpend = adRows.reduce((acc, current) => acc + (n(current.spend) ?? 0), 0);
      const summary = formatDemographicSummary(adRows, totalSpend) ?? "";
      summaries.byDimension[dimension].set(
        adId,
        summary && clamped ? `[${from} to ${to}] ${summary}` : summary,
      );
    }
  }

  return summaries;
}

export async function fetchAgentExportRows(opts: {
  organizationId: string;
  from: string;
  to: string;
  filter?: {
    accountId?: string | null;
    adSetIds?: string[] | null;
    campaignIds?: string[] | null;
    landingPageUrls?: string[] | null;
    statuses?: string[] | null;
    teamId?: string | null;
    format?: string | null;
    awarenessLevel?: string | null;
    ownership?: "ours" | "theirs" | null;
    search?: string | null;
    untaggedOnly?: boolean | null;
  };
}): Promise<{ ads: AdExportRow[]; creatives: CreativeExportRow[] }> {
  const { organizationId, from, to, filter } = opts;

  const whereParts: SQL[] = [sql`ad.organization_id = ${organizationId}`];
  if (filter?.accountId) whereParts.push(sql`aa.id = ${filter.accountId}`);
  if (filter?.teamId) whereParts.push(sql`t.id = ${filter.teamId}`);
  if (filter?.format) whereParts.push(sql`ac.format::text = ${filter.format}`);
  if (filter?.awarenessLevel) whereParts.push(sql`ac.awareness_level::text = ${filter.awarenessLevel}`);
  if (filter?.search) whereParts.push(sql`ac.name ILIKE ${"%" + filter.search + "%"}`);
  if (filter?.adSetIds?.length) {
    whereParts.push(sql`ast.id IN (${sql.join(filter.adSetIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (filter?.campaignIds?.length) {
    whereParts.push(sql`c.id IN (${sql.join(filter.campaignIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (filter?.landingPageUrls?.length) {
    whereParts.push(sql`split_part(ad.destination_url, '?', 1) IN (${sql.join(filter.landingPageUrls.map((url) => sql`${url}`), sql`, `)})`);
  }
  if (filter?.statuses?.length) {
    whereParts.push(sql`${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} IN (${sql.join(filter.statuses.map((status) => sql`${status}`), sql`, `)})`);
  }
  if (filter?.ownership === "ours") whereParts.push(sql`ac.ownership = 'ours'`);
  if (filter?.ownership === "theirs") whereParts.push(sql`(ac.ownership IS NULL OR ac.ownership != 'ours')`);
  if (filter?.untaggedOnly) {
    whereParts.push(sql`(ac.format IS NULL AND ac.angle IS NULL AND ac.awareness_level IS NULL)`);
  }

  const basePl = basePerformanceLogFilter("pl");
  const basePl2 = basePerformanceLogFilter("pl2");

  const rawRows = (
    await db.execute(sql`
      WITH window_m AS (
        SELECT
          pl.ad_id,
          sum(pl.spend) AS spend,
          sum(pl.purchase_value) AS revenue,
          sum(pl.conversions) AS conversions,
          sum(pl.impressions) AS impressions,
          sum(pl.link_clicks) AS clicks,
          coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0) AS ctr,
          sum(pl.spend) / nullif(sum(pl.link_clicks), 0) AS cpc,
          sum(pl.frequency * pl.impressions) / nullif(sum(pl.impressions), 0) AS frequency,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS hook_rate,
          count(DISTINCT pl.date_start)::int AS days_in_window
        FROM performance_log pl
        WHERE pl.organization_id = ${organizationId}
          AND pl.date_start = pl.date_end
          AND pl.date_start >= ${from}::date
          AND pl.date_start <= ${to}::date
          AND ${basePl}
        GROUP BY pl.ad_id
      ),
      lifetime_m AS (
        SELECT
          pl.ad_id,
          sum(pl.spend) AS spend,
          sum(pl.conversions) AS conversions,
          coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) AS roas,
          coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0) AS ctr,
          ${clickWeightedCpc("pl")} AS cpc,
          avg(pl.frequency) AS frequency,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS thumbstop,
          max(pl.date_end)::date - min(pl.date_start)::date AS running_days,
          max(pl.date_end) AS last_log_at
        FROM performance_log pl
        WHERE pl.organization_id = ${organizationId}
          AND pl.date_start = pl.date_end
          AND ${basePl}
        GROUP BY pl.ad_id
      ),
      recent_m AS (
        SELECT
          pl.ad_id,
          sum(pl.conversions) AS conversions,
          coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0) AS ctr,
          sum(pl.spend) / nullif(sum(pl.link_clicks), 0) AS cpc,
          coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0) AS cpa,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS hook_rate
        FROM performance_log pl
        WHERE pl.organization_id = ${organizationId}
          AND pl.date_start = pl.date_end
          AND ${basePl}
          AND pl.date_start > (
            SELECT max(pl2.date_end) - 3
            FROM performance_log pl2
            WHERE pl2.ad_id = pl.ad_id
              AND pl2.organization_id = ${organizationId}
              AND pl2.date_start = pl2.date_end
              AND ${basePl2}
          )
        GROUP BY pl.ad_id
      ),
      prior_m AS (
        SELECT
          pl.ad_id,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS hook_rate
        FROM performance_log pl
        WHERE pl.organization_id = ${organizationId}
          AND pl.date_start = pl.date_end
          AND ${basePl}
          AND pl.date_end <= (
            SELECT max(pl2.date_end) - 3
            FROM performance_log pl2
            WHERE pl2.ad_id = pl.ad_id
              AND pl2.organization_id = ${organizationId}
              AND pl2.date_start = pl2.date_end
              AND ${basePl2}
          )
        GROUP BY pl.ad_id
      )
      SELECT
        ad.id AS ad_id,
        ad.meta_id AS meta_ad_id,
        ad.name AS ad_name,
        ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} AS ad_status,
        ast.status::text AS ad_set_status,
        ad.destination_url AS ad_destination_url,

        ac.id AS creative_id,
        ac.name AS creative_name,
        ac.format::text AS format,
        ac.angle AS angle,
        ac.persona AS persona,
        ac.awareness_level::text AS awareness_level,
        ac.attributes->>'hook' AS hook,
        ac.attributes->>'cta' AS cta,
        ac.asset_url AS asset_url,
        ac.video_url AS video_url,

        ast.id AS ad_set_id,
        ast.meta_id AS meta_ad_set_id,
        ast.name AS ad_set_name,
        c.id AS campaign_id,
        c.meta_id AS meta_campaign_id,
        c.name AS campaign_name,
        aa.id AS account_id,
        aa.name AS account_name,
        t.id AS team_id,
        t.name AS team_name,

        w.spend::text AS window_spend,
        w.revenue::text AS window_revenue,
        w.conversions::text AS window_conversions,
        (coalesce(w.revenue, 0) / nullif(w.spend, 0))::text AS window_roas,
        (coalesce(w.spend, 0) / nullif(w.conversions, 0))::text AS window_cpa,
        w.ctr::text AS window_ctr,
        w.cpc::text AS window_cpc,
        w.frequency::text AS window_frequency,
        w.impressions::text AS window_impressions,
        w.clicks::text AS window_clicks,
        w.hook_rate::text AS window_hook_rate,
        w.days_in_window::text AS window_days_with_logs,

        lm.spend::text AS lifetime_spend,
        lm.conversions::text AS lifetime_conversions,
        lm.roas::text AS lifetime_roas,
        lm.running_days::text AS running_days,
        lm.last_log_at::text AS last_log_at,

        rm.conversions::text AS recent_conversions,
        rm.ctr::text AS recent_ctr,
        rm.cpc::text AS recent_cpc,
        rm.cpa::text AS recent_cpa,
        rm.hook_rate::text AS recent_hook_rate,
        pm.hook_rate::text AS prior_hook_rate
      FROM ad
      JOIN ad_creative ac
        ON ac.id = ad.ad_creative_id
       AND ac.organization_id = ${organizationId}
      LEFT JOIN ad_set ast
        ON ast.id = ad.ad_set_id
       AND ast.organization_id = ${organizationId}
      LEFT JOIN campaign c
        ON c.id = ast.campaign_id
       AND c.organization_id = ${organizationId}
      LEFT JOIN ad_account aa
        ON aa.id = ad.account_id
       AND aa.organization_id = ${organizationId}
      LEFT JOIN team t
        ON t.id = ac.team_id
       AND t.organization_id = ${organizationId}
      LEFT JOIN window_m w ON w.ad_id = ad.id
      LEFT JOIN lifetime_m lm ON lm.ad_id = ad.id
      LEFT JOIN recent_m rm ON rm.ad_id = ad.id
      LEFT JOIN prior_m pm ON pm.ad_id = ad.id
      WHERE ${sql.join(whereParts, sql` AND `)}
      ORDER BY ac.name, ad.name
    `)
  ).rows as RawAdRow[];

  const demographicSummaries = await fetchAdDemographicSummaries({
    organizationId,
    from,
    to,
    adIds: rawRows.map((row) => row.ad_id),
  });

  // Portfolio CPA = sum(spend) / sum(conv) across the export window. Used as the
  // "fair shot" floor for the bleeder tier — under-spending an ad's CPA means
  // it can't statistically have converted yet. Floor at $50 in case the
  // portfolio CPA is unusually low or undefined.
  const totalSpend = rawRows.reduce((acc, r) => acc + (n(r.window_spend) ?? 0), 0);
  const totalConv = rawRows.reduce((acc, r) => acc + (n(r.window_conversions) ?? 0), 0);
  const portfolioCpaFloor = Math.max(50, totalConv > 0 ? totalSpend / totalConv : 50);

  const ads: AdExportRow[] = rawRows.map((r) => {
    const windowSpend = n(r.window_spend);
    const windowConv = n(r.window_conversions);
    const windowRoas = n(r.window_roas);
    const windowCtr = n(r.window_ctr);
    const windowCpc = n(r.window_cpc);
    const windowFreq = n(r.window_frequency);
    const windowHookRate = n(r.window_hook_rate);
    const lifetimeCtr = n(r.lifetime_roas); // reserved
    void lifetimeCtr;

    const verdict = computeHealth({
      roas: windowRoas,
      spend: windowSpend,
      conversions: windowConv,
      status: r.ad_status,
      format: r.format,
      recentConversions: n(r.recent_conversions),
      recentCtr: n(r.recent_ctr),
      avgCtr: windowCtr,
      recentCpc: n(r.recent_cpc),
      avgCpc: windowCpc,
      frequency: windowFreq,
      recentHookRate: n(r.recent_hook_rate),
      priorHookRate: n(r.prior_hook_rate),
      recentCpa: n(r.recent_cpa),
      avgCpa: n(r.window_cpa),
      thumbstopRatio: windowHookRate,
    });

    const dollarsAtRisk = windowSpend != null && windowRoas != null
      ? Math.max(0, windowSpend * (1 - windowRoas))
      : 0;

    // Trend deltas (positive = worse)
    const ctrDelta = windowCtr != null && windowCtr > 0
      ? pct(n(r.recent_ctr), windowCtr)
      : null;
    const cpcDelta = windowCpc != null && windowCpc > 0
      ? pct(n(r.recent_cpc), windowCpc)
      : null;
    const recentConv = n(r.recent_conversions);
    const cpaDelta = recentConv != null && recentConv >= 3 && n(r.window_cpa) != null
      ? pct(n(r.recent_cpa), n(r.window_cpa))
      : null;
    const hookDelta = (r.format === "video" || r.format === "ugc") && n(r.prior_hook_rate) != null
      ? pct(n(r.recent_hook_rate), n(r.prior_hook_rate))
      : null;

    const activeInWindow = r.ad_status === "active" && windowSpend != null && windowSpend > 0;

    // Tiered disable flag — same rule as the dashboard's Needs Attention panel
    // so CSV and UI never disagree. Tier reflects whether the ad has had a
    // "fair shot" (~one portfolio CPA worth of spend AND time to deliver).
    //   pause_now → spend >= fair-shot AND days >= 5
    //   watch     → one threshold met, the other not
    //   cooking   → too early to call (under-spent and under-aged)
    const isBleeding = r.ad_status === "active"
      && (windowSpend ?? 0) >= 25
      && (
        (windowConv ?? 0) === 0
        || (windowRoas != null && windowRoas < 1.0)
      );
    const days = n(r.running_days) ?? 0;
    const fairShot = (windowSpend ?? 0) >= portfolioCpaFloor;
    let disableTier: "pause_now" | "watch" | "cooking" | null = null;
    if (isBleeding) {
      if (fairShot && days >= 5) disableTier = "pause_now";
      else if (fairShot || days >= 7) disableTier = "watch";
      else disableTier = "cooking";
    }
    // flagDisable means "act on this today" — same semantics as the dashboard's
    // Needs Attention panel. Cooking ads are bleeding but haven't had a fair
    // shot yet; they show up in disableTier for tracking but should not be
    // recommended for pausing.
    const flagDisable = disableTier === "pause_now" || disableTier === "watch";
    const flagScale = r.ad_status === "active"
      && windowRoas != null && windowRoas >= 2
      && (n(r.running_days) ?? 0) >= 7
      && (windowFreq ?? 0) < 3
      && (windowSpend ?? 0) >= 50;
    const flagReview = verdict.health === "warning" || verdict.health === "critical";

    return {
      adId: r.ad_id,
      metaAdId: r.meta_ad_id,
      adName: r.ad_name,
      creativeId: r.creative_id,
      creativeName: r.creative_name,
      adSetId: r.ad_set_id,
      metaAdSetId: r.meta_ad_set_id,
      adSetName: r.ad_set_name,
      campaignId: r.campaign_id,
      metaCampaignId: r.meta_campaign_id,
      campaignName: r.campaign_name,
      accountId: r.account_id,
      accountName: r.account_name,
      teamId: r.team_id,
      teamName: r.team_name,
      format: r.format,
      angle: r.angle,
      persona: r.persona,
      awarenessLevel: r.awareness_level,
      hook: r.hook,
      cta: r.cta,
      destinationUrl: r.ad_destination_url,
      assetUrl: r.asset_url,
      videoUrl: r.video_url,
      status: r.ad_status,
      windowFrom: from,
      windowTo: to,
      runningDays: n(r.running_days),
      daysInWindow: n(r.window_days_with_logs),
      lastLogAt: r.last_log_at,
      activeInWindow,
      windowSpend,
      windowRevenue: n(r.window_revenue),
      windowConversions: windowConv,
      windowRoas,
      windowCpa: n(r.window_cpa),
      windowCtr,
      windowCpc,
      windowFrequency: windowFreq,
      windowImpressions: n(r.window_impressions),
      windowClicks: n(r.window_clicks),
      windowHookRate: r.format === "video" || r.format === "ugc" ? windowHookRate : null,
      demoWindowFrom: demographicSummaries.windowFrom,
      demoWindowTo: demographicSummaries.windowTo,
      genderBreakdown: demographicSummaries.byDimension.gender.get(r.ad_id) ?? null,
      ageBreakdown: demographicSummaries.byDimension.age.get(r.ad_id) ?? null,
      countryBreakdown: demographicSummaries.byDimension.country.get(r.ad_id) ?? null,
      deviceBreakdown: demographicSummaries.byDimension.device.get(r.ad_id) ?? null,
      lifetimeSpend: n(r.lifetime_spend),
      lifetimeConversions: n(r.lifetime_conversions),
      lifetimeRoas: n(r.lifetime_roas),
      ctrDeltaPct: ctrDelta,
      cpcDeltaPct: cpcDelta,
      cpaDeltaPct: cpaDelta,
      hookRateDeltaPct: hookDelta,
      adHealth: verdict.health,
      adHealthReasons: verdict.reasons,
      creativeRollupHealth: null, // filled after rollup pass
      creativeRollupReasons: [],
      dollarsAtRisk,
      flagDisableCandidate: flagDisable,
      flagScaleCandidate: flagScale,
      flagReviewCandidate: flagReview,
      disableTier,
      creativeHasWinners: false, // filled after rollup pass
    };
  });

  // Roll up per creative using the same spend-weighted logic
  type Grouped = {
    creative: AdExportRow;
    ads: AdExportRow[];
  };
  const byCreative = new Map<string, Grouped>();
  for (const a of ads) {
    const g = byCreative.get(a.creativeId) ?? { creative: a, ads: [] };
    g.ads.push(a);
    byCreative.set(a.creativeId, g);
  }

  const creatives: CreativeExportRow[] = [];
  for (const [creativeId, g] of byCreative) {
    const rollup = rollupCreativeHealth(
      g.ads.map((a) => ({
        spend: a.windowSpend,
        health: a.adHealth,
        reasons: a.adHealthReasons,
        status: a.status,
      })),
    );
    // Winner = active sibling with at least one conversion at break-even+ ROAS.
    // Conversion-gated rather than spend-gated: a $24.79 ad with 1 conv at 6x
    // is unambiguously a winner; an arbitrary spend floor would miss it.
    const hasWinners = g.ads.some(
      (a) =>
        a.status === "active"
        && (a.windowConversions ?? 0) >= 1
        && (a.windowRoas ?? 0) >= 1,
    );
    for (const a of g.ads) {
      a.creativeRollupHealth = rollup.health;
      a.creativeRollupReasons = rollup.reasons;
      // Propagate to ANY bleeder (any disableTier, including "cooking"), not
      // just pause_now/watch. The "concept works elsewhere" signal is the most
      // valuable on cooking ads — it tells the buyer "this isn't dead yet, and
      // a sibling is at 3x — likely audience pairing, not creative."
      if (a.disableTier) a.creativeHasWinners = hasWinners;
    }

    const sumWindow = <K extends keyof AdExportRow>(k: K): number | null => {
      let total = 0;
      let any = false;
      for (const a of g.ads) {
        const v = a[k];
        if (typeof v === "number") {
          total += v;
          any = true;
        }
      }
      return any ? total : null;
    };
    const windowSpend = sumWindow("windowSpend");
    const windowRevenue = sumWindow("windowRevenue");
    const windowConv = sumWindow("windowConversions");
    const windowImpressions = sumWindow("windowImpressions");
    const lifetimeSpend = sumWindow("lifetimeSpend");
    const lifetimeConv = sumWindow("lifetimeConversions");
    const roas = windowSpend != null && windowSpend > 0 && windowRevenue != null
      ? windowRevenue / windowSpend
      : null;
    const cpa = windowSpend != null && windowConv != null && windowConv > 0
      ? windowSpend / windowConv
      : null;
    const ctr = windowImpressions != null && windowImpressions > 0
      ? g.ads.reduce((acc, a) => acc + (a.windowCtr != null && a.windowImpressions != null ? a.windowCtr * a.windowImpressions : 0), 0) / windowImpressions
      : null;
    const lifetimeRoas = lifetimeSpend != null && lifetimeSpend > 0
      ? g.ads.reduce((acc, a) => acc + (a.lifetimeSpend ?? 0) * (a.lifetimeRoas ?? 0), 0) / lifetimeSpend
      : null;

    const activeAdCount = g.ads.filter((a) => a.status === "active").length;
    const activeInWindow = g.ads.some((a) => a.activeInWindow);
    const dollarsAtRisk = windowSpend != null && roas != null
      ? Math.max(0, windowSpend * (1 - roas))
      : 0;
    const runningDays = Math.max(0, ...g.ads.map((a) => a.runningDays ?? 0));
    const lastLogAt = g.ads.reduce<string | null>(
      (acc, a) => (a.lastLogAt && (!acc || a.lastLogAt > acc) ? a.lastLogAt : acc),
      null,
    );

    const flagDisable = g.ads.filter((a) => a.flagDisableCandidate).length >= Math.ceil(g.ads.length / 2);
    const flagScale = rollup.health === "healthy" && g.ads.some((a) => a.flagScaleCandidate);
    const flagReview = rollup.health === "warning" || rollup.health === "critical";

    const head = g.creative;
    creatives.push({
      creativeId,
      creativeName: head.creativeName,
      accountId: head.accountId,
      accountName: head.accountName,
      teamId: head.teamId,
      teamName: head.teamName,
      format: head.format,
      angle: head.angle,
      persona: head.persona,
      awarenessLevel: head.awarenessLevel,
      hook: head.hook,
      cta: head.cta,
      destinationUrl: head.destinationUrl,
      assetUrl: head.assetUrl,
      videoUrl: head.videoUrl,
      windowFrom: from,
      windowTo: to,
      adCount: g.ads.length,
      activeAdCount,
      activeInWindow,
      windowSpend,
      windowRevenue,
      windowConversions: windowConv,
      windowRoas: roas,
      windowCpa: cpa,
      windowCtr: ctr,
      lifetimeSpend,
      lifetimeConversions: lifetimeConv,
      lifetimeRoas,
      runningDays,
      lastLogAt,
      rollupHealth: rollup.health,
      rollupReasons: rollup.reasons,
      dollarsAtRisk,
      flagDisableCandidate: flagDisable,
      flagScaleCandidate: flagScale,
      flagReviewCandidate: flagReview,
    });
  }

  return { ads, creatives };
}
