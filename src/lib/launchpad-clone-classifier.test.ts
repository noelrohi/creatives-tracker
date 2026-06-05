import { describe, expect, it } from "vitest";
import { classifyLaunchpadClone } from "@/lib/launchpad-clone-classifier";
import type { LaunchpadFreshSourceInspection } from "@/lib/launchpad-meta-source-inspection";
import type { LaunchpadSourceTemplate } from "@/lib/launchpad-source-templates";

function inspection(overrides: Partial<LaunchpadFreshSourceInspection> = {}): LaunchpadFreshSourceInspection {
  return {
    status: "available",
    inspectedAt: "2026-01-01T00:00:00.000Z",
    isFresh: true,
    campaign: { objective: "OUTCOME_SALES", buying_type: "AUCTION" },
    adSet: {
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      promoted_object: { pixel_id: "pixel-1", custom_event_type: "PURCHASE" },
    },
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

function template(overrides: Partial<LaunchpadSourceTemplate> = {}): LaunchpadSourceTemplate {
  return {
    id: "template-1",
    organizationId: "org-1",
    label: "Creative Testing",
    notes: null,
    status: "approved",
    approvedByUserId: "user-1",
    approvedAt: new Date("2026-01-01T00:00:00Z"),
    lastValidatedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    metadata: {},
    account: {
      id: "account-1",
      name: "Main Account",
      metaAccountId: "act_123",
      hasMetaAccessToken: true,
      defaultFacebookPageId: "page-1",
      defaultInstagramActorId: null,
    },
    sourceCampaign: {
      id: "campaign-1",
      name: "Campaign",
      metaId: "cmp_1",
      status: "active",
      accountId: "account-1",
    },
    sourceAdSet: {
      id: "ad-set-1",
      name: "Ad Set",
      metaId: "as_1",
      status: "active",
      accountId: "account-1",
      dailyBudget: "50",
      costCap: null,
      targetingMethod: null,
      geos: null,
      placements: null,
      demographics: null,
    },
    readiness: {
      status: "warning",
      blockers: [],
      warnings: [{ code: "INSTAGRAM_ACTOR_NOT_CONFIGURED", message: "No IG" }],
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("Launchpad clone classifier", () => {
  it("classifies an approved template with static creative as eligible with warnings", () => {
    const result = classifyLaunchpadClone({
      sourceTemplate: template(),
      creatives: [{ id: "creative-1", name: "Static", format: "static", assetUrl: "https://cdn.example.com/a.png" }],
      requestedStatus: "PAUSED",
      sourceInspection: inspection(),
    });

    expect(result.status).toBe("eligible_with_warning");
    expect(result.requiresCampaignClone).toBe(true);
    expect(result.requiresAdSetClone).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.copiedSettings.map((setting) => setting.key)).not.toContain("tracking");
    expect(result.copiedSettings.map((setting) => setting.key)).not.toContain("budget_style");
    expect(result.notCopiedSettings.map((setting) => setting.key)).toEqual(
      expect.arrayContaining(["budget"]),
    );
  });

  it("blocks unsupported source settings from fresh inspection", () => {
    const result = classifyLaunchpadClone({
      sourceTemplate: template({ readiness: { status: "ready", blockers: [], warnings: [] } }),
      creatives: [{ id: "creative-1", name: "Static", format: "static", assetUrl: "https://cdn.example.com/a.png" }],
      requestedStatus: "PAUSED",
      sourceInspection: inspection({
        campaign: {
          objective: "APP_INSTALLS",
          buying_type: "AUCTION",
          daily_budget: "1000",
          spend_cap: "5000",
          special_ad_categories: ["CREDIT"],
        },
        adSet: {
          lifetime_budget: "2000",
          dynamic_creative: true,
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          promoted_object: { product_set_id: "ps_1" },
          targeting: { publisher_platforms: ["facebook", "audience_network"] },
        },
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "UNSUPPORTED_OBJECTIVE",
      "CAMPAIGN_BUDGET_UNSUPPORTED",
      "CAMPAIGN_SPEND_CAP_UNSUPPORTED",
      "SPECIAL_AD_CATEGORY_UNSUPPORTED",
      "LIFETIME_BUDGET_UNSUPPORTED",
      "DYNAMIC_CREATIVE_UNSUPPORTED",
      "CATALOG_PROMOTED_OBJECT_UNSUPPORTED",
      "UNSUPPORTED_PLACEMENTS",
    ]));
  });

  it("blocks duplicate, unsupported, and missing-media creatives", () => {
    const result = classifyLaunchpadClone({
      sourceTemplate: template({ readiness: { status: "ready", blockers: [], warnings: [] } }),
      creatives: [
        { id: "creative-1", name: "Static", format: "static", assetUrl: null },
        { id: "creative-1", name: "Duplicate", format: "video", assetUrl: null, videoUrl: null },
        { id: "creative-2", name: "Carousel", format: "carousel", assetUrl: "https://cdn.example.com/a.png" },
      ],
      requestedStatus: "ACTIVE",
      sourceInspection: inspection(),
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "ACTIVE_META_STATUS_FORBIDDEN",
      "CREATIVE_ASSET_REQUIRED",
      "DUPLICATE_CREATIVE_SELECTED",
      "UNSUPPORTED_CREATIVE_FORMAT",
    ]));
  });
});
