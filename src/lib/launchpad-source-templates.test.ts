import { describe, expect, it } from "vitest";
import { adAccounts } from "@/schema/account";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import { launchpadSourceTemplates } from "@/schema/launchpad";
import { listApprovedLaunchpadSourceTemplates } from "./launchpad-source-templates";

function sourceTemplateRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "source-template-1",
    organizationId: "test-org-id",
    accountLinkConfigured: true,
    accountId: "account-1",
    sourceCampaignLinkConfigured: true,
    sourceCampaignId: "campaign-1",
    sourceCampaignMetaId: "cmp_123",
    sourceAdSetLinkConfigured: true,
    sourceAdSetId: "ad-set-1",
    sourceAdSetMetaId: "23800000000000000",
    label: "Approved prospecting template",
    notes: null,
    status: "approved",
    approvedByUserId: "approver-1",
    approvedAt: now,
    lastValidatedAt: now,
    expiresAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    accountName: "Main Meta Account",
    accountMetaAccountId: "act_123",
    accountHasMetaAccessToken: true,
    accountDefaultFacebookPageId: "page-123",
    accountDefaultInstagramActorId: "ig-123",
    campaignName: "Campaign Alpha",
    campaignMetaId: "cmp_123",
    campaignStatus: "active",
    campaignAccountId: "account-1",
    adSetName: "Prospecting / Static tests",
    adSetMetaId: "23800000000000000",
    adSetStatus: "active",
    adSetAccountId: "account-1",
    adSetCampaignId: "campaign-1",
    adSetDailyBudget: "2500",
    adSetCostCap: null,
    adSetTargetingMethod: ["broad"],
    adSetGeos: ["US"],
    adSetPlacements: ["advantage_plus"],
    adSetDemographics: "18-55",
    ...overrides,
  };
}

function createReader(rows: unknown[]) {
  let selected: Record<string, unknown> | null = null;
  const builder = {
    from: () => builder,
    leftJoin: () => builder,
    where: () => Promise.resolve(rows),
  };

  return {
    client: {
      select(selection: Record<string, unknown>) {
        selected = selection;
        return builder;
      },
    },
    getSelected: () => selected,
  };
}

describe("Launchpad source templates", () => {
  it("projects linked resource IDs from org-scoped joins instead of raw template FKs", async () => {
    const reader = createReader([sourceTemplateRow()]);

    await listApprovedLaunchpadSourceTemplates(reader.client as never, "test-org-id");

    expect(reader.getSelected()).toMatchObject({
      accountId: adAccounts.id,
      sourceCampaignId: campaigns.id,
      sourceAdSetId: adSets.id,
    });
    expect(reader.getSelected()?.accountId).not.toBe(launchpadSourceTemplates.accountId);
    expect(reader.getSelected()?.sourceCampaignId).not.toBe(launchpadSourceTemplates.sourceCampaignId);
    expect(reader.getSelected()?.sourceAdSetId).not.toBe(launchpadSourceTemplates.sourceAdSetId);
  });

  it("nulls wrong-org linked resources and reports invalid-link blockers", async () => {
    const reader = createReader([
      sourceTemplateRow({
        accountLinkConfigured: true,
        accountId: null,
        accountMetaAccountId: null,
        accountHasMetaAccessToken: false,
        accountDefaultFacebookPageId: null,
        accountDefaultInstagramActorId: null,
        sourceCampaignLinkConfigured: true,
        sourceCampaignId: null,
        campaignName: null,
        campaignMetaId: null,
        campaignAccountId: null,
        sourceAdSetLinkConfigured: true,
        sourceAdSetId: null,
        adSetName: null,
        adSetMetaId: null,
        adSetAccountId: null,
        adSetCampaignId: null,
      }),
    ]);

    const [template] = await listApprovedLaunchpadSourceTemplates(
      reader.client as never,
      "test-org-id",
    );

    expect(template).toMatchObject({
      account: null,
      sourceCampaign: null,
      sourceAdSet: null,
      readiness: { status: "blocked" },
    });
    expect(template?.readiness.blockers.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "SOURCE_TEMPLATE_ACCOUNT_LINK_INVALID",
        "SOURCE_CAMPAIGN_LINK_INVALID",
        "SOURCE_AD_SET_LINK_INVALID",
      ]),
    );
  });

  it("blocks source campaign/ad set account mismatches without leaking foreign account IDs", async () => {
    const reader = createReader([
      sourceTemplateRow({
        campaignAccountId: "foreign-account",
        adSetAccountId: "foreign-account",
      }),
    ]);

    const [template] = await listApprovedLaunchpadSourceTemplates(
      reader.client as never,
      "test-org-id",
    );

    expect(template?.readiness.blockers.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "SOURCE_TEMPLATE_CAMPAIGN_ACCOUNT_MISMATCH",
        "SOURCE_TEMPLATE_AD_SET_ACCOUNT_MISMATCH",
      ]),
    );
    expect(template?.sourceCampaign?.accountId).toBeNull();
    expect(template?.sourceAdSet?.accountId).toBeNull();
    expect(JSON.stringify(template)).not.toContain("foreign-account");
  });

  it("uses joined org-owned Meta IDs and blocks raw template Meta ID mismatches", async () => {
    const reader = createReader([
      sourceTemplateRow({
        sourceCampaignMetaId: "foreign-campaign-meta-id",
        sourceAdSetMetaId: "foreign-ad-set-meta-id",
      }),
    ]);

    const [template] = await listApprovedLaunchpadSourceTemplates(
      reader.client as never,
      "test-org-id",
    );

    expect(template?.sourceCampaign?.metaId).toBe("cmp_123");
    expect(template?.sourceAdSet?.metaId).toBe("23800000000000000");
    expect(template?.readiness.blockers.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "SOURCE_CAMPAIGN_META_ID_MISMATCH",
        "SOURCE_AD_SET_META_ID_MISMATCH",
      ]),
    );
    expect(JSON.stringify(template)).not.toContain("foreign-campaign-meta-id");
    expect(JSON.stringify(template)).not.toContain("foreign-ad-set-meta-id");
  });

  it("blocks source ad sets that do not belong to the selected source campaign", async () => {
    const reader = createReader([
      sourceTemplateRow({ adSetCampaignId: "other-campaign" }),
    ]);

    const [template] = await listApprovedLaunchpadSourceTemplates(
      reader.client as never,
      "test-org-id",
    );

    expect(template?.readiness.blockers.map((issue) => issue.code)).toContain(
      "SOURCE_AD_SET_CAMPAIGN_MISMATCH",
    );
    expect(JSON.stringify(template)).not.toContain("other-campaign");
  });
});
