import type { MappedRow } from "./csv-parser";
import { formatDateOnly } from "./date";

interface MetaAction {
  action_type: string;
  value: string;
  "7d_click"?: string;
  "1d_view"?: string;
}

interface MetaInsightRow {
  campaign_name?: string;
  campaign_id?: string;
  adset_name?: string;
  adset_id?: string;
  ad_name?: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  cpm?: string;
  cpc?: string;
  ctr?: string;
  clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
  cost_per_action_type?: MetaAction[];
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
  date_start?: string;
  date_stop?: string;
  // Breakdown fields
  age?: string;
  gender?: string;
  country?: string;
  publisher_platform?: string;
  platform_position?: string;
  device_platform?: string;
  // Video
  video_play_actions?: MetaAction[];
  video_thruplay_watched_actions?: MetaAction[];
  video_avg_time_watched_actions?: MetaAction[];
}

function findActionEntry(
  actions: MetaAction[] | undefined,
  type: string,
): MetaAction | undefined {
  return actions?.find((action) => action.action_type === type);
}

function findAction(actions: MetaAction[] | undefined, type: string): string | undefined {
  return findActionEntry(actions, type)?.value;
}

export function mapMetaInsightsToRows(
  data: MetaInsightRow[],
  level: "campaign" | "ad_set" | "ad",
  options?: {
    deliveryByAdId?: Map<string, string>;
  },
): MappedRow[] {
  return data.map((row) => {
    const spend = row.spend;
    const purchaseValueAction = findActionEntry(row.action_values, "omni_purchase") ??
      findActionEntry(row.action_values, "purchase");
    const purchaseValue = purchaseValueAction?.value;
    const purchaseValue7dClick = purchaseValueAction?.["7d_click"] ?? null;
    const purchaseValue1dView = purchaseValueAction?.["1d_view"] ?? null;
    const conversions = findAction(row.actions, "omni_purchase") ??
      findAction(row.actions, "purchase");
    const linkClicks = findAction(row.actions, "link_click");
    const landingPageViews = findAction(row.actions, "landing_page_view");
    const addToCart = findAction(row.actions, "omni_add_to_cart") ??
      findAction(row.actions, "add_to_cart");
    const initiateCheckout = findAction(row.actions, "omni_initiated_checkout") ??
      findAction(row.actions, "initiate_checkout");
    const cpa = findAction(row.cost_per_action_type, "omni_purchase") ??
      findAction(row.cost_per_action_type, "purchase");

    // Compute ROAS if we have both values
    let roas: string | undefined;
    if (purchaseValue && spend && Number(spend) > 0) {
      roas = (Number(purchaseValue) / Number(spend)).toFixed(2);
    }

    // Name depends on level
    const name =
      level === "campaign"
        ? row.campaign_name
        : level === "ad_set"
          ? row.adset_name
          : row.ad_name;

    return {
      name: name ?? "Unknown",
      campaignName: row.campaign_name,
      campaignId: row.campaign_id,
      adSetName: row.adset_name,
      adSetId: row.adset_id,
      adId: row.ad_id,
      delivery: row.ad_id ? options?.deliveryByAdId?.get(row.ad_id) : undefined,
      spend,
      roas,
      cpa,
      ctr: row.ctr,
      impressions: row.impressions ? Number(row.impressions) : undefined,
      reach: row.reach ? Number(row.reach) : undefined,
      frequency: row.frequency,
      cpm: row.cpm,
      cpc: row.cpc,
      conversions: conversions ? Number(conversions) : undefined,
      linkClicks: linkClicks ? Number(linkClicks) : undefined,
      landingPageViews: landingPageViews
        ? Number(landingPageViews)
        : undefined,
      purchaseValue,
      purchaseValue7dClick,
      purchaseValue1dView,
      attributionWindows: "7d_click,1d_view",
      addToCart: addToCart ? Number(addToCart) : undefined,
      initiateCheckout: initiateCheckout
        ? Number(initiateCheckout)
        : undefined,
      qualityRanking: row.quality_ranking,
      engagementRateRanking: row.engagement_rate_ranking,
      conversionRateRanking: row.conversion_rate_ranking,
      dateStart: row.date_start ?? formatDateOnly(new Date()),
      dateEnd: row.date_stop ?? formatDateOnly(new Date()),
      // Breakdowns
      age: row.age,
      gender: row.gender,
      country: row.country,
      platform: row.publisher_platform,
      placement: row.platform_position,
      device: row.device_platform,
      // Video
      videoViews3s: row.video_play_actions
        ? Number(findAction(row.video_play_actions, "video_view") ?? 0)
        : undefined,
      videoThruplay: row.video_thruplay_watched_actions
        ? Number(
            findAction(
              row.video_thruplay_watched_actions,
              "video_view",
            ) ?? 0,
          )
        : undefined,
      videoAvgWatchTime: row.video_avg_time_watched_actions
        ? findAction(row.video_avg_time_watched_actions, "video_view")
        : undefined,
    };
  });
}
