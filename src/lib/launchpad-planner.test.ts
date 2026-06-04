import { describe, expect, it } from "vitest";
import {
  LAUNCHPAD_DRY_RUN_SMOKE_CAPABILITIES,
  parseLaunchpadDryRunSmokeArgs,
  runLaunchpadDryRunSmoke,
} from "@/lib/launchpad-dry-run-smoke";
import { createLaunchpadRunDraft } from "@/lib/launchpad-ledger";
import {
  buildLaunchpadPlannerOutput,
  type LaunchpadPlannerInput,
} from "@/lib/launchpad-planner";

function destination(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      id: "account-1",
      name: "Main Meta Account",
      metaAccountId: "act_123",
      defaultFacebookPageId: "page-123",
      defaultInstagramActorId: "ig-123",
      hasMetaAccessToken: true,
      canPublish: true,
      ineligibleReasons: [],
    },
    adSet: {
      id: "ad-set-1",
      name: "Prospecting / Static tests",
      metaId: "23800000000000000",
      accountId: "account-1",
      status: "active",
      campaign: {
        id: "campaign-1",
        name: "Campaign Alpha",
        metaId: "cmp_123",
        status: "active",
      },
    },
    ...overrides,
  };
}

function creative(overrides: Record<string, unknown> = {}) {
  return {
    id: "creative-1",
    name: "Summer static hero",
    format: "static",
    assetUrl: "https://cdn.example.com/static-hero.png",
    videoUrl: null,
    hook: "Drop-proof sandals for summer travel",
    cta: null,
    ...overrides,
  };
}

function basePlannerInput(
  overrides: Partial<LaunchpadPlannerInput> = {},
): LaunchpadPlannerInput {
  return {
    organizationId: "org-1",
    requestedBy: {
      userId: "user-1",
      principalType: "session" as const,
      orgRole: "admin" as const,
    },
    destination: destination(),
    creative: creative(),
    launch: {
      defaultDestinationUrl:
        "https://example.com/products?utm_source=meta&utm_medium=paid_social&utm_campaign=summer",
      primaryText: "Meet the static hero before the next drop.",
    },
    env: { ADSOLUTE_META_PUBLISH_ENABLED: "false" },
    ...overrides,
  };
}

describe("Launchpad single-static planner", () => {
  it("uses the same normalized manifest builder for dry-run and live publish paths", () => {
    const dryRun = buildLaunchpadPlannerOutput(basePlannerInput(), {
      publishPath: "dry_run",
    });
    const livePublish = buildLaunchpadPlannerOutput(basePlannerInput(), {
      publishPath: "live_publish",
    });

    expect(dryRun.normalizedManifest).toEqual(livePublish.normalizedManifest);
    expect(dryRun.publishPath).toBe("dry_run");
    expect(livePublish.publishPath).toBe("live_publish");
  });

  it("builds a frozen manifest and payload preview with target, media, URL, and Meta object shape", () => {
    const plannerOutput = buildLaunchpadPlannerOutput(basePlannerInput());
    const draft = createLaunchpadRunDraft(plannerOutput.runDraftInput);

    expect(draft.status).toBe("validated");
    expect(draft.manifest.plannerManifest).toMatchObject({
      kind: "creative_launchpad.normalized_publish_manifest",
      target: {
        account: {
          id: "account-1",
          metaAccountId: "act_123",
          hasMetaAccessToken: true,
        },
        adSet: {
          id: "ad-set-1",
          metaId: "23800000000000000",
        },
      },
    });
    expect(draft.manifest.items[0]).toMatchObject({
      creative: {
        id: "creative-1",
        format: "static",
        assetUrl: "https://cdn.example.com/static-hero.png",
      },
      launch: {
        adName: "Launchpad / Summer static hero / Prospecting / Static tests",
        primaryText: "Meet the static hero before the next drop.",
        headline: "Drop-proof sandals for summer travel",
        headlineSource: "creative_hook",
        cta: "SHOP_NOW",
        requestedStatus: "PAUSED",
      },
      media: {
        type: "image",
        uploadMethod: "url",
        sourceUrl: "https://cdn.example.com/static-hero.png",
      },
      url: {
        finalUrl:
          "https://example.com/products?utm_source=meta&utm_medium=paid_social&utm_campaign=summer",
        source: "batch_default",
        missingRequiredUtmParameters: [],
      },
      expectedMetaObjectShape: {
        ad: {
          fields: {
            adset_id: "23800000000000000",
            status: "PAUSED",
          },
        },
      },
    });
    expect(draft.items[0]?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back from missing headline to creative name when hook is blank", () => {
    const plannerOutput = buildLaunchpadPlannerOutput(
      basePlannerInput({ creative: creative({ hook: " " }) }),
    );

    expect(plannerOutput.normalizedManifest).toMatchObject({
      items: [
        {
          launch: {
            headline: "Summer static hero",
            headlineSource: "creative_name",
          },
        },
      ],
    });
  });

  it("defaults CTA, validates unsupported CTA, and preserves the validation issue", () => {
    const defaulted = buildLaunchpadPlannerOutput(basePlannerInput());
    const invalid = buildLaunchpadPlannerOutput(
      basePlannerInput({ launch: { ...basePlannerInput().launch, cta: "WATCH_NOW" } }),
    );

    expect(defaulted.normalizedManifest).toMatchObject({
      items: [{ launch: { cta: "SHOP_NOW", ctaSource: "default" } }],
    });
    expect(invalid.issues.map((issue) => issue.code)).toContain("INVALID_META_CTA");
    expect(invalid.normalizedManifest).toMatchObject({
      validation: { status: "failed" },
      items: [{ launch: { cta: "SHOP_NOW", ctaSource: "invalid_defaulted" } }],
    });
  });

  it("uses the single-item URL override instead of the batch default and validates required UTMs", () => {
    const plannerOutput = buildLaunchpadPlannerOutput(
      basePlannerInput({
        launch: {
          ...basePlannerInput().launch,
          destinationUrlOverride:
            "https://example.com/override?utm_source=meta&utm_medium=paid_social",
        },
      }),
    );
    const missingUtm = buildLaunchpadPlannerOutput(
      basePlannerInput({
        launch: {
          ...basePlannerInput().launch,
          destinationUrlOverride: "https://example.com/no-medium?utm_source=meta",
        },
      }),
    );

    expect(plannerOutput.normalizedManifest).toMatchObject({
      items: [
        {
          url: {
            finalUrl:
              "https://example.com/override?utm_source=meta&utm_medium=paid_social",
            source: "item_override",
            missingRequiredUtmParameters: [],
          },
        },
      ],
    });
    expect(missingUtm.issues.map((issue) => issue.code)).toContain(
      "MISSING_REQUIRED_UTM_PARAMETERS",
    );
  });

  it("persists a validation issue when the generated ad name is empty", () => {
    const plannerOutput = buildLaunchpadPlannerOutput(
      basePlannerInput({
        launch: {
          ...basePlannerInput().launch,
          namingTemplate: "{{unknown.token}}",
        },
      }),
    );

    expect(plannerOutput.issues.map((issue) => issue.code)).toContain(
      "AD_NAME_REQUIRED",
    );
    expect(createLaunchpadRunDraft(plannerOutput.runDraftInput).status).toBe(
      "failed",
    );
  });

  it("validates static image asset URL shape and HTTPS before publish", () => {
    const malformed = buildLaunchpadPlannerOutput(
      basePlannerInput({ creative: creative({ assetUrl: "not-a-url" }) }),
    );
    const httpAsset = buildLaunchpadPlannerOutput(
      basePlannerInput({ creative: creative({ assetUrl: "http://cdn.example.com/static.png" }) }),
    );

    expect(malformed.issues.map((issue) => issue.code)).toContain(
      "INVALID_CREATIVE_ASSET_URL",
    );
    expect(httpAsset.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_CREATIVE_ASSET_URL",
          message: expect.stringContaining("HTTPS"),
        }),
      ]),
    );
  });

  it("builds video/UGC media previews and Meta video object shapes", () => {
    const plannerOutput = buildLaunchpadPlannerOutput(
      basePlannerInput({
        creative: creative({
          id: "creative-video-1",
          name: "Summer UGC try-on",
          format: "ugc",
          assetUrl: "https://cdn.example.com/video-thumb.jpg",
          videoUrl: "https://cdn.example.com/video.mp4",
        }),
      }),
    );
    const draft = createLaunchpadRunDraft(plannerOutput.runDraftInput);

    expect(plannerOutput.issues).toEqual([]);
    expect(draft.status).toBe("validated");
    expect(draft.manifest.items[0]).toMatchObject({
      creative: {
        id: "creative-video-1",
        format: "ugc",
        videoUrl: "https://cdn.example.com/video.mp4",
      },
      media: {
        type: "video",
        uploadMethod: "file_url",
        sourceUrl: "https://cdn.example.com/video.mp4",
        thumbnailUrl: "https://cdn.example.com/video-thumb.jpg",
      },
      expectedMetaObjectShape: {
        videoUpload: {
          endpoint: "/act_123/advideos",
          fields: {
            file_url: "https://cdn.example.com/video.mp4",
          },
          resultReference: "<META_VIDEO_ID_FROM_URL_UPLOAD>",
        },
        creative: {
          fields: {
            object_story_spec: {
              video_data: {
                video_id: "<META_VIDEO_ID_FROM_URL_UPLOAD>",
                link:
                  "https://example.com/products?utm_source=meta&utm_medium=paid_social&utm_campaign=summer",
              },
            },
          },
        },
        ad: {
          fields: {
            status: "PAUSED",
          },
        },
      },
    });
  });

  it("validates video URLs and optional thumbnails for video/UGC creatives", () => {
    const missingVideo = buildLaunchpadPlannerOutput(
      basePlannerInput({
        creative: creative({ format: "video", assetUrl: null, videoUrl: null }),
      }),
    );
    const httpVideo = buildLaunchpadPlannerOutput(
      basePlannerInput({
        creative: creative({
          format: "ugc",
          assetUrl: "http://cdn.example.com/thumb.jpg",
          videoUrl: "http://cdn.example.com/video.mp4",
        }),
      }),
    );

    expect(missingVideo.issues.map((issue) => issue.code)).toContain(
      "CREATIVE_VIDEO_REQUIRED",
    );
    expect(httpVideo.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "INVALID_CREATIVE_VIDEO_URL",
        "INVALID_CREATIVE_ASSET_URL",
      ]),
    );
  });

  it("records unsupported format, HTTPS URL, and existing Meta ad conflict validation issues", () => {
    const plannerOutput = buildLaunchpadPlannerOutput(
      basePlannerInput({
        creative: creative({ format: "carousel", assetUrl: null }),
        launch: {
          ...basePlannerInput().launch,
          defaultDestinationUrl: "http://example.com/products",
        },
        existingMetaAdConflicts: [
          { id: "ad-1", name: "Existing", metaId: "120000000000" },
        ],
      }),
    );

    expect(plannerOutput.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_CREATIVE_FORMAT",
        "INVALID_DESTINATION_URL",
        "MISSING_REQUIRED_UTM_PARAMETERS",
        "EXISTING_META_AD_ID_CONFLICT",
      ]),
    );
    expect(createLaunchpadRunDraft(plannerOutput.runDraftInput).status).toBe(
      "failed",
    );
  });
});

describe("Launchpad dry-run smoke command contract", () => {
  it("is dry-run only and has no live publish capability", () => {
    expect(LAUNCHPAD_DRY_RUN_SMOKE_CAPABILITIES).toMatchObject({
      mode: "dry_run_only",
      canPublishLive: false,
      canCallMeta: false,
      canCreateLocalAds: false,
    });
    expect(parseLaunchpadDryRunSmokeArgs([])).toEqual({ scenario: "valid" });
    expect(() => parseLaunchpadDryRunSmokeArgs(["--publish"])).toThrow(
      /dry-run only/,
    );
  });

  it("exercises valid and validation-failed dry-run manifests safely", () => {
    expect(runLaunchpadDryRunSmoke()).toMatchObject({
      status: "validated",
      dryRunOnly: true,
      activePublishingPathAvailable: false,
      localAdsCreatedDuringValidation: false,
      requestedStatus: "PAUSED",
      issueCodes: [],
    });
    expect(runLaunchpadDryRunSmoke(["--failure"])).toMatchObject({
      status: "failed",
      dryRunOnly: true,
      activePublishingPathAvailable: false,
      localAdsCreatedDuringValidation: false,
      requestedStatus: "PAUSED",
      issueCodes: expect.arrayContaining([
        "ACCOUNT_ACCESS_TOKEN_REQUIRED",
        "FACEBOOK_PAGE_ID_REQUIRED",
        "CREATIVE_ASSET_REQUIRED",
        "INVALID_DESTINATION_URL",
      ]),
    });
  });
});
