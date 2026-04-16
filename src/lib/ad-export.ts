import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { computeHealth, rollupCreativeHealth, type CreativeHealth } from "./creative-health";

type RawAdRow = {
  ad_id: string;
  meta_ad_id: string | null;
  ad_name: string;
  ad_status: string | null;
  ad_destination_url: string | null;

  creative_id: string;
  creative_name: string;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awareness_level: string | null;
  hook: string | null;
  cta: string | null;
  creative_destination_url: string | null;
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
  window_thumbstop: string | null;

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
  runningDays: number | null;
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
  windowThumbstop: number | null;

  // Lifetime
  lifetimeSpend: number | null;
  lifetimeConversions: number | null;
  lifetimeRoas: number | null;

  // Trend deltas (pct, positive = worse)
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

export async function fetchAgentExportRows(opts: {
  organizationId: string;
  from: string;
  to: string;
  filter?: {
    accountId?: string | null;
    adSetIds?: string[] | null;
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
  if (filter?.accountId) whereParts.push(sql`ad.account_id = ${filter.accountId}`);
  if (filter?.teamId) whereParts.push(sql`ac.team_id = ${filter.teamId}`);
  if (filter?.format) whereParts.push(sql`ac.format::text = ${filter.format}`);
  if (filter?.awarenessLevel) whereParts.push(sql`ac.awareness_level::text = ${filter.awarenessLevel}`);
  if (filter?.search) whereParts.push(sql`ac.name ILIKE ${"%" + filter.search + "%"}`);
  if (filter?.adSetIds?.length) {
    whereParts.push(sql`ad.ad_set_id IN (${sql.join(filter.adSetIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (filter?.ownership === "ours") whereParts.push(sql`ac.ownership = 'ours'`);
  if (filter?.ownership === "theirs") whereParts.push(sql`(ac.ownership IS NULL OR ac.ownership != 'ours')`);
  if (filter?.untaggedOnly) {
    whereParts.push(sql`(ac.format IS NULL AND ac.angle IS NULL AND ac.awareness_level IS NULL)`);
  }

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
          avg(pl.cpc) AS cpc,
          avg(pl.frequency) AS frequency,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS hook_rate
        FROM performance_log pl
        WHERE pl.date_start <= ${to}::date AND pl.date_end >= ${from}::date
        GROUP BY pl.ad_id
      ),
      lifetime_m AS (
        SELECT
          pl.ad_id,
          sum(pl.spend) AS spend,
          sum(pl.conversions) AS conversions,
          coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) AS roas,
          coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0) AS ctr,
          avg(pl.cpc) AS cpc,
          avg(pl.frequency) AS frequency,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS thumbstop,
          max(pl.date_end)::date - min(pl.date_start)::date AS running_days,
          max(pl.date_end) AS last_log_at
        FROM performance_log pl
        GROUP BY pl.ad_id
      ),
      recent_m AS (
        SELECT
          pl.ad_id,
          sum(pl.conversions) AS conversions,
          coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0) AS ctr,
          avg(pl.cpc) AS cpc,
          coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0) AS cpa,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS hook_rate
        FROM performance_log pl
        WHERE pl.date_start > (
          SELECT max(pl2.date_end) - 3 FROM performance_log pl2 WHERE pl2.ad_id = pl.ad_id
        )
        GROUP BY pl.ad_id
      ),
      prior_m AS (
        SELECT
          pl.ad_id,
          sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0) AS hook_rate
        FROM performance_log pl
        WHERE pl.date_end <= (
          SELECT max(pl2.date_end) - 3 FROM performance_log pl2 WHERE pl2.ad_id = pl.ad_id
        )
        GROUP BY pl.ad_id
      )
      SELECT
        ad.id AS ad_id,
        ad.meta_id AS meta_ad_id,
        ad.name AS ad_name,
        ad.status::text AS ad_status,
        ad.destination_url AS ad_destination_url,

        ac.id AS creative_id,
        ac.name AS creative_name,
        ac.format::text AS format,
        ac.angle AS angle,
        ac.persona AS persona,
        ac.awareness_level::text AS awareness_level,
        ac.hook AS hook,
        ac.cta AS cta,
        NULL::text AS creative_destination_url,
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
        w.hook_rate::text AS window_thumbstop,

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
      JOIN ad_creative ac ON ac.id = ad.ad_creative_id
      LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
      LEFT JOIN campaign c ON c.id = ast.campaign_id
      LEFT JOIN ad_account aa ON aa.id = ad.account_id
      LEFT JOIN team t ON t.id = ac.team_id
      LEFT JOIN window_m w ON w.ad_id = ad.id
      LEFT JOIN lifetime_m lm ON lm.ad_id = ad.id
      LEFT JOIN recent_m rm ON rm.ad_id = ad.id
      LEFT JOIN prior_m pm ON pm.ad_id = ad.id
      WHERE ${sql.join(whereParts, sql` AND `)}
      ORDER BY ac.name, ad.name
    `)
  ).rows as RawAdRow[];

  const ads: AdExportRow[] = rawRows.map((r) => {
    const windowSpend = n(r.window_spend);
    const windowConv = n(r.window_conversions);
    const windowRoas = n(r.window_roas);
    const windowCtr = n(r.window_ctr);
    const windowCpc = n(r.window_cpc);
    const windowFreq = n(r.window_frequency);
    const windowHookRate = n(r.window_hook_rate);
    const windowThumbstop = n(r.window_thumbstop);
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
      thumbstopRatio: windowThumbstop,
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

    // Flags (ad-level)
    const flagDisable = (r.ad_status === "active" && (windowConv ?? 0) === 0 && (windowSpend ?? 0) >= 100)
      || (windowRoas != null && windowRoas < 0.5 && (windowSpend ?? 0) >= 50);
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
      destinationUrl: r.ad_destination_url ?? r.creative_destination_url,
      assetUrl: r.asset_url,
      videoUrl: r.video_url,
      status: r.ad_status,
      windowFrom: from,
      windowTo: to,
      runningDays: n(r.running_days),
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
      windowThumbstop: r.format === "video" || r.format === "ugc" ? windowThumbstop : null,
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
      g.ads.map((a) => ({ spend: a.windowSpend, health: a.adHealth, reasons: a.adHealthReasons })),
    );
    for (const a of g.ads) {
      a.creativeRollupHealth = rollup.health;
      a.creativeRollupReasons = rollup.reasons;
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
