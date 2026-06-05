import { describe, expect, it } from "vitest";
import { buildLaunchpadCloneDryRun } from "@/lib/launchpad-clone-planner";
import type { LaunchpadClonePlannerInput } from "@/lib/launchpad-clone-planner";

function input(overrides: Partial<LaunchpadClonePlannerInput> = {}): LaunchpadClonePlannerInput {
  return {
    organizationId: "org-1",
    requestedBy: { userId: "user-1", principalType: "session", orgRole: "admin" },
    sourceTemplate: {
      id: "template-1",
      organizationId: "org-1",
      label: "Creative Testing",
      notes: "Use for new angles",
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
        defaultInstagramActorId: "ig-1",
      },
      sourceCampaign: {
        id: "campaign-1",
        name: "Testing Campaign",
        metaId: "cmp_1",
        status: "active",
        accountId: "account-1",
      },
      sourceAdSet: {
        id: "ad-set-1",
        name: "Purchases Ad Set",
        metaId: "as_1",
        status: "active",
        accountId: "account-1",
        dailyBudget: "50",
        costCap: null,
        targetingMethod: ["broad"],
        geos: ["US"],
        placements: ["facebook_feed", "instagram_reels"],
        demographics: null,
      },
      readiness: { status: "ready", blockers: [], warnings: [] },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
    launch: {
      launchName: "June Hook Test",
      destinationUrl: "https://example.com/products?utm_source=meta&utm_medium=paid_social",
      dailyBudgetMinorUnits: 5000,
      defaultPrimaryText: "Try the new hook.",
      defaultHeadline: "New drop",
      defaultCta: "SHOP_NOW",
    },
    creatives: [
      { id: "creative-1", name: "UGC Hook", format: "ugc", assetUrl: "https://cdn.example.com/thumb.jpg", videoUrl: "https://cdn.example.com/video.mp4" },
      { id: "creative-2", name: "Static Hook", format: "static", assetUrl: "https://cdn.example.com/static.jpg" },
    ],
    ...overrides,
  };
}

describe("Launchpad clone dry-run planner", () => {
  it("builds a v2 paused Launch Plan manifest", () => {
    const result = buildLaunchpadCloneDryRun(input());

    expect(result.status).toBe("validated");
    expect(result.manifest).toMatchObject({
      version: 2,
      kind: "creative_launchpad.clone_setup_manifest",
      launchMode: "clone_setup",
      requestedStatus: "PAUSED",
      plannedCampaign: { requestedStatus: "PAUSED" },
      plannedAdSet: {
        requestedStatus: "PAUSED",
        budget: {
          dailyBudgetMinorUnits: 5000,
          currency: null,
          source: "user_input",
          sourceDailyBudgetCopied: false,
          sourceSpendCapCopied: false,
        },
      },
      safety: {
        dryRunOnly: true,
        metaWritesAllowed: false,
        allCreatedObjectsPaused: true,
      },
    });
    expect(result.manifest.plannedAds).toHaveLength(2);
    expect(result.manifest.plannedAds.every((ad) => ad.requestedStatus === "PAUSED")).toBe(true);
    expect(result.manifest.sourceSnapshot.adSet?.dailyBudget).toBeNull();
    expect(result.manifestHash).toHaveLength(64);
    expect(result.sourceTemplateHash).toHaveLength(64);
    expect(result.clonePlanHash).toHaveLength(64);
    expect(JSON.stringify(result.manifest)).not.toContain('"50"');
  });

  it("keeps hashes stable for equivalent inputs and changes when launch details change", () => {
    const first = buildLaunchpadCloneDryRun(input());
    const second = buildLaunchpadCloneDryRun(input());
    const changed = buildLaunchpadCloneDryRun(input({
      launch: {
        launchName: "Different Test",
        destinationUrl: "https://example.com/products?utm_source=meta&utm_medium=paid_social",
        dailyBudgetMinorUnits: 5000,
      },
    }));

    expect(second.manifestHash).toBe(first.manifestHash);
    expect(changed.manifestHash).not.toBe(first.manifestHash);
  });

  it("normalizes missing UTMs as warnings but blocks invalid URLs, CTAs, and missing budget", () => {
    const missingUtm = buildLaunchpadCloneDryRun(input({
      launch: { launchName: "Missing UTM", destinationUrl: "https://example.com/products", dailyBudgetMinorUnits: 5000 },
    }));
    const invalid = buildLaunchpadCloneDryRun(input({
      launch: { launchName: "Bad URL", destinationUrl: "http://example.com/products", dailyBudgetMinorUnits: 5000 },
    }));
    const invalidCta = buildLaunchpadCloneDryRun(input({
      launch: {
        launchName: "Bad CTA",
        destinationUrl: "https://example.com/products?utm_source=meta&utm_medium=paid_social",
        dailyBudgetMinorUnits: 5000,
        defaultCta: "NOT_A_CTA",
      },
    }));

    expect(missingUtm.status).toBe("validated");
    expect(missingUtm.manifest.validation.warnings.map((issue) => issue.code)).toContain(
      "REQUIRED_UTM_PARAMETERS_NORMALIZED",
    );
    expect(missingUtm.manifest.tracking.finalUrl).toBe(
      "https://example.com/products?utm_source=meta&utm_medium=paid_social",
    );
    expect(invalid.status).toBe("failed");
    expect(invalid.manifest.validation.blockers.map((issue) => issue.code)).toContain(
      "INVALID_DESTINATION_URL",
    );
    expect(invalidCta.status).toBe("failed");
    expect(invalidCta.manifest.validation.blockers.map((issue) => issue.code)).toContain(
      "INVALID_CTA",
    );

    const missingBudget = buildLaunchpadCloneDryRun(input({
      launch: {
        launchName: "No Budget",
        destinationUrl: "https://example.com/products?utm_source=meta&utm_medium=paid_social",
      },
    }));
    expect(missingBudget.status).toBe("failed");
    expect(missingBudget.manifest.validation.blockers.map((issue) => issue.code)).toContain(
      "DAILY_BUDGET_REQUIRED",
    );
  });
});
