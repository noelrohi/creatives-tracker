import { describe, expect, it } from "vitest";
import { classifyLaunchpadClone } from "@/lib/launchpad-clone-classifier";
import type { LaunchpadSourceTemplate } from "@/lib/launchpad-source-templates";

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
    });

    expect(result.status).toBe("eligible_with_warning");
    expect(result.requiresCampaignClone).toBe(true);
    expect(result.requiresAdSetClone).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.copiedSettings.map((setting) => setting.key)).not.toContain("tracking");
    expect(result.copiedSettings.map((setting) => setting.key)).not.toContain("budget_style");
    expect(result.notCopiedSettings.map((setting) => setting.key)).toEqual(
      expect.arrayContaining(["tracking", "budget"]),
    );
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
