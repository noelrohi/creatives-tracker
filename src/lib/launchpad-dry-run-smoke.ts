import { createLaunchpadRunDraft } from "@/lib/launchpad-ledger";
import { buildLaunchpadPlannerOutput } from "@/lib/launchpad-planner";

export const LAUNCHPAD_DRY_RUN_SMOKE_CAPABILITIES = {
  mode: "dry_run_only",
  canPublishLive: false,
  canCallMeta: false,
  canCreateLocalAds: false,
} as const;

export type LaunchpadDryRunSmokeArgs = {
  scenario: "valid" | "failure";
};

export function parseLaunchpadDryRunSmokeArgs(argv: string[]): LaunchpadDryRunSmokeArgs {
  const forbiddenFlags = new Set([
    "--publish",
    "--live",
    "--execute",
    "--meta",
    "--call-meta",
  ]);
  const forbiddenFlag = argv.find((arg) => forbiddenFlags.has(arg));

  if (forbiddenFlag) {
    throw new Error(
      `Launchpad smoke is dry-run only; ${forbiddenFlag} is not supported`,
    );
  }

  return {
    scenario: argv.includes("--failure") ? "failure" : "valid",
  };
}

export function runLaunchpadDryRunSmoke(argv: string[] = []) {
  const args = parseLaunchpadDryRunSmokeArgs(argv);
  const plannerOutput = buildLaunchpadPlannerOutput({
    organizationId: "smoke-org",
    requestedBy: {
      userId: "smoke-user",
      principalType: "session",
      orgRole: "admin",
    },
    destination: {
      account: {
        id: "smoke-account",
        name: "Smoke Meta Account",
        metaAccountId: "act_smoke",
        defaultFacebookPageId: args.scenario === "failure" ? null : "page-smoke",
        defaultInstagramActorId: null,
        hasMetaAccessToken: args.scenario !== "failure",
        canPublish: args.scenario !== "failure",
        ineligibleReasons:
          args.scenario === "failure"
            ? ["missing_access_token", "missing_facebook_page_id"]
            : [],
      },
      adSet: {
        id: "smoke-ad-set",
        name: "Smoke Static Tests",
        metaId: "23800000000000000",
        accountId: "smoke-account",
        status: "active",
        campaign: {
          id: "smoke-campaign",
          name: "Smoke Campaign",
          metaId: "cmp_smoke",
          status: "active",
          accountId: "smoke-account",
        },
      },
      issues:
        args.scenario === "failure"
          ? [
              {
                code: "ACCOUNT_ACCESS_TOKEN_REQUIRED" as const,
                message:
                  "The selected Meta ad account needs a stored access token before publishing",
                field: "accountId" as const,
                details: { accountId: "smoke-account" },
              },
              {
                code: "FACEBOOK_PAGE_ID_REQUIRED" as const,
                message:
                  "The selected Meta ad account needs a default Facebook Page ID before publishing",
                field: "accountId" as const,
                details: { accountId: "smoke-account" },
              },
            ]
          : [],
    },
    creative: {
      id: "smoke-creative",
      name: "Smoke static creative",
      format: "static",
      assetUrl:
        args.scenario === "failure"
          ? null
          : "https://cdn.example.com/smoke-static.png",
      videoUrl: null,
      hook: "Smoke-test headline fallback",
      cta: null,
    },
    launch: {
      defaultDestinationUrl:
        args.scenario === "failure"
          ? "http://example.com/no-utm"
          : "https://example.com/smoke?utm_source=meta&utm_medium=paid_social",
      primaryText: "Smoke-test primary text",
    },
    env: { ADSOLUTE_META_PUBLISH_ENABLED: "false" },
  });
  const draft = createLaunchpadRunDraft(plannerOutput.runDraftInput);

  return {
    ...LAUNCHPAD_DRY_RUN_SMOKE_CAPABILITIES,
    scenario: args.scenario,
    status: draft.status,
    itemCount: draft.items.length,
    manifestHash: draft.manifestHash,
    issueCodes: draft.validationIssues.map((issue) => issue.code),
    requestedStatus: draft.manifest.requestedStatus,
    dryRunOnly: draft.manifest.safety.dryRunOnly,
    activePublishingPathAvailable:
      draft.manifest.safety.activePublishingPathAvailable,
    localAdsCreatedDuringValidation:
      draft.manifest.safety.localAdsCreatedDuringValidation,
  };
}
