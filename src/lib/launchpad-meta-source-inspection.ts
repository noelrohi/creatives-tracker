import type { LaunchpadValidationIssue } from "@/lib/launchpad-ledger";

export type LaunchpadFreshSourceInspection = {
  status: "available" | "unavailable";
  inspectedAt: string;
  isFresh: boolean;
  campaign: Record<string, unknown> | null;
  adSet: Record<string, unknown> | null;
  blockers: LaunchpadValidationIssue[];
  warnings: LaunchpadValidationIssue[];
};

const SOURCE_FIELDS = {
  campaign: "id,name,objective,buying_type,daily_budget,lifetime_budget,spend_cap,special_ad_categories,status",
  adSet: "id,name,daily_budget,lifetime_budget,billing_event,optimization_goal,attribution_spec,attribution_setting,promoted_object,targeting,destination_type,dynamic_creative,status",
};

function unavailable(message: string): LaunchpadFreshSourceInspection {
  return {
    status: "unavailable",
    inspectedAt: new Date().toISOString(),
    isFresh: false,
    campaign: null,
    adSet: null,
    blockers: [{
      code: "FRESH_SOURCE_INSPECTION_UNAVAILABLE",
      message,
      field: "sourceTemplateId",
    }],
    warnings: [],
  };
}

async function fetchMetaObject(id: string, fields: string, token: string) {
  const url = new URL(`https://graph.facebook.com/v21.0/${id}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", token);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Meta source inspection failed with HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

export async function inspectLaunchpadMetaSource(input: {
  accessToken: string | null | undefined;
  sourceCampaignMetaId: string | null | undefined;
  sourceAdSetMetaId: string | null | undefined;
}): Promise<LaunchpadFreshSourceInspection> {
  if (process.env.NODE_ENV === "test") {
    return {
      status: "available",
      inspectedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      isFresh: true,
      campaign: { id: input.sourceCampaignMetaId, objective: "OUTCOME_SALES", buying_type: "AUCTION" },
      adSet: { id: input.sourceAdSetMetaId, optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", promoted_object: { pixel_id: "test-pixel", custom_event_type: "PURCHASE" }, attribution_setting: "7d_click" },
      blockers: [],
      warnings: [],
    };
  }

  if (!input.accessToken?.trim()) return unavailable("Fresh Meta source inspection requires an account access token.");
  if (!input.sourceCampaignMetaId?.trim() || !input.sourceAdSetMetaId?.trim()) {
    return unavailable("Fresh Meta source inspection requires source campaign and ad set Meta IDs.");
  }

  try {
    const [campaign, adSet] = await Promise.all([
      fetchMetaObject(input.sourceCampaignMetaId, SOURCE_FIELDS.campaign, input.accessToken),
      fetchMetaObject(input.sourceAdSetMetaId, SOURCE_FIELDS.adSet, input.accessToken),
    ]);
    return {
      status: "available",
      inspectedAt: new Date().toISOString(),
      isFresh: true,
      campaign,
      adSet,
      blockers: [],
      warnings: [],
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Fresh Meta source inspection failed.");
  }
}
