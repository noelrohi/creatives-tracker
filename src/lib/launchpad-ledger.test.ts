import { describe, expect, it } from "vitest";
import {
  LAUNCHPAD_MAX_ITEMS,
  launchpadItemStatuses,
  launchpadRunStatuses,
} from "@/lib/launchpad-constants";
import {
  LaunchpadLedgerError,
  assertItemStatusTransition,
  assertLaunchpadItemCap,
  assertLivePublishSafety,
  assertLockedHashStable,
  assertRunStatusTransition,
  computeRunAggregateStatus,
  createLaunchpadRunDraft,
} from "@/lib/launchpad-ledger";

function expectLaunchpadError(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchpadLedgerError);
    expect((error as LaunchpadLedgerError).code).toBe(code);
    return;
  }

  throw new Error(`Expected LaunchpadLedgerError with code ${code}`);
}

const baseDraftInput = {
  organizationId: "org-1",
  requestedBy: {
    userId: "user-1",
    principalType: "session" as const,
    orgRole: "admin" as const,
  },
  actor: {
    accountId: "account-1",
    accountMetaId: "act_123",
    facebookPageId: "page-1",
    instagramActorId: "ig-1",
  },
  destination: {
    adSetId: "ad-set-1",
    adSetMetaId: "23800000000000000",
  },
  items: [
    {
      creativeId: "creative-1",
      creativeName: "Static hero",
      format: "static",
      assetUrl: "https://cdn.example.com/creative.png",
      adName: "Launchpad / Static hero / 001",
      destinationUrl: "https://example.com/products?utm_source=meta&utm_medium=paid_social",
    },
  ],
  env: { ADSOLUTE_META_PUBLISH_ENABLED: "false" },
};

describe("Launchpad ledger state machine", () => {
  it("defines the controlled run and item lifecycle vocabulary", () => {
    expect(launchpadRunStatuses).toContain("validation");
    expect(launchpadRunStatuses).toContain("validated");
    expect(launchpadRunStatuses).toContain("queued");
    expect(launchpadRunStatuses).toContain("publishing");
    expect(launchpadRunStatuses).toContain("success");
    expect(launchpadRunStatuses).toContain("partial_success");
    expect(launchpadRunStatuses).toContain("failed");
    expect(launchpadRunStatuses).toContain("ambiguous");
    expect(launchpadRunStatuses).toContain("skipped");
    expect(launchpadRunStatuses).toContain("cancelled");
    expect(launchpadRunStatuses).toContain("manual_intervention");

    expect(launchpadItemStatuses).toContain("validation");
    expect(launchpadItemStatuses).toContain("validated");
    expect(launchpadItemStatuses).toContain("queued");
    expect(launchpadItemStatuses).toContain("publishing");
    expect(launchpadItemStatuses).toContain("success");
    expect(launchpadItemStatuses).toContain("failed");
    expect(launchpadItemStatuses).toContain("ambiguous");
    expect(launchpadItemStatuses).toContain("skipped");
    expect(launchpadItemStatuses).toContain("cancelled");
    expect(launchpadItemStatuses).toContain("manual_intervention");
  });

  it("allows valid transitions and rejects invalid run/item transitions", () => {
    expect(() => assertRunStatusTransition("validation", "validated")).not.toThrow();
    expect(() => assertRunStatusTransition("validated", "queued")).not.toThrow();
    expect(() => assertItemStatusTransition("queued", "publishing")).not.toThrow();
    expect(() => assertItemStatusTransition("publishing", "success")).not.toThrow();

    expectLaunchpadError(
      () => assertRunStatusTransition("success", "publishing"),
      "INVALID_RUN_STATUS_TRANSITION",
    );
    expectLaunchpadError(
      () => assertItemStatusTransition("success", "failed"),
      "INVALID_ITEM_STATUS_TRANSITION",
    );
  });

  it("aggregates item outcomes into run outcomes including partial/manual states", () => {
    expect(computeRunAggregateStatus(["success", "failed"])).toBe("partial_success");
    expect(computeRunAggregateStatus(["manual_intervention", "success"])).toBe(
      "manual_intervention",
    );
    expect(computeRunAggregateStatus(["ambiguous", "queued"])).toBe("ambiguous");
    expect(computeRunAggregateStatus(["validated", "validated"])).toBe("validated");
  });
});

describe("Launchpad manifest and idempotency contract", () => {
  it("creates a validated dry-run manifest with audit, actor, destination, and safety fields", () => {
    const draft = createLaunchpadRunDraft(baseDraftInput);

    expect(draft.status).toBe("validated");
    expect(draft.manifest.mode).toBe("validation");
    expect(draft.manifest.audit.organizationId).toBe("org-1");
    expect(draft.manifest.audit.requestedBy).toEqual({
      userId: "user-1",
      principalType: "session",
      orgRole: "admin",
    });
    expect(draft.manifest.actor).toMatchObject({
      accountId: "account-1",
      accountMetaId: "act_123",
      facebookPageId: "page-1",
      instagramActorId: "ig-1",
    });
    expect(draft.manifest.destination).toMatchObject({
      adSetId: "ad-set-1",
      adSetMetaId: "23800000000000000",
    });
    expect(draft.manifest.safety).toMatchObject({
      dryRunOnly: true,
      activePublishingPathAvailable: false,
      campaignCreationAllowed: false,
      adSetCreationAllowed: false,
      localAdsCreatedDuringValidation: false,
      livePublishEnabled: false,
    });
    expect(draft.items[0]?.payload.safety).toEqual({
      localAdStatus: "paused",
      metaAdStatus: "PAUSED",
    });
  });

  it("keeps manifest hashes, payload hashes, idempotency keys, and dedupe keys stable", () => {
    const firstDraft = createLaunchpadRunDraft(baseDraftInput);
    const secondDraft = createLaunchpadRunDraft({
      ...baseDraftInput,
      items: [
        {
          destinationUrl:
            "https://example.com/products?utm_source=meta&utm_medium=paid_social",
          adName: "Launchpad / Static hero / 001",
          creativeName: "Static hero",
          creativeId: "creative-1",
          assetUrl: "https://cdn.example.com/creative.png",
          format: "static",
        },
      ],
    });

    expect(secondDraft.manifestHash).toBe(firstDraft.manifestHash);
    expect(secondDraft.idempotencyKey).toBe(firstDraft.idempotencyKey);
    expect(secondDraft.dedupeKey).toBe(firstDraft.dedupeKey);
    expect(secondDraft.items[0]?.payloadHash).toBe(firstDraft.items[0]?.payloadHash);
    expect(secondDraft.items[0]?.idempotencyKey).toBe(
      firstDraft.items[0]?.idempotencyKey,
    );
    expect(secondDraft.items[0]?.dedupeKey).toBe(firstDraft.items[0]?.dedupeKey);
  });

  it("detects attempts to change locked manifest or payload content", () => {
    const draft = createLaunchpadRunDraft(baseDraftInput);
    expect(() =>
      assertLockedHashStable({
        label: "manifest",
        lockedHash: draft.manifestHash,
        nextValue: draft.manifest,
      }),
    ).not.toThrow();

    expectLaunchpadError(
      () =>
        assertLockedHashStable({
          label: "manifest",
          lockedHash: draft.manifestHash,
          nextValue: {
            ...draft.manifest,
            requestedStatus: "ACTIVE",
          },
        }),
      "LOCKED_HASH_CHANGED",
    );
  });

  it("records live publish env flag awareness at validation time", () => {
    const enabledDraft = createLaunchpadRunDraft({
      ...baseDraftInput,
      env: { ADSOLUTE_META_PUBLISH_ENABLED: "true" },
    });

    expect(enabledDraft.manifest.safety.livePublishEnabled).toBe(true);
  });
});

describe("Launchpad live publish safety contract", () => {
  const safeLiveInput = {
    principalType: "session" as const,
    orgRole: "owner" as const,
    requestedStatus: "PAUSED",
    itemCount: 1,
    confirmationAccepted: true,
    previouslyValidatedManifest: true,
    activePublishingPathAvailable: true,
    env: { ADSOLUTE_META_PUBLISH_ENABLED: "true" },
  };

  it("knows and enforces the backend max item cap", () => {
    expect(LAUNCHPAD_MAX_ITEMS).toBe(25);
    expect(() => assertLaunchpadItemCap(25)).not.toThrow();
    expectLaunchpadError(() => assertLaunchpadItemCap(26), "ITEM_CAP_EXCEEDED");
    expectLaunchpadError(() => assertLaunchpadItemCap(0), "ITEM_COUNT_REQUIRED");
  });

  it("rejects API-key, worker, anonymous, and non-admin live publish attempts", () => {
    expectLaunchpadError(
      () =>
        assertLivePublishSafety({
          ...safeLiveInput,
          principalType: "apiKey",
          orgRole: null,
        }),
      "LIVE_PUBLISH_REQUIRES_ADMIN_SESSION",
    );
    expectLaunchpadError(
      () =>
        assertLivePublishSafety({
          ...safeLiveInput,
          principalType: "worker",
          orgRole: null,
        }),
      "LIVE_PUBLISH_REQUIRES_ADMIN_SESSION",
    );
    expectLaunchpadError(
      () =>
        assertLivePublishSafety({
          ...safeLiveInput,
          principalType: "anonymous",
          orgRole: null,
        }),
      "LIVE_PUBLISH_REQUIRES_ADMIN_SESSION",
    );
    expectLaunchpadError(
      () => assertLivePublishSafety({ ...safeLiveInput, orgRole: "member" }),
      "LIVE_PUBLISH_REQUIRES_ADMIN_SESSION",
    );
  });

  it("rejects live publish when the env flag is disabled", () => {
    expectLaunchpadError(
      () =>
        assertLivePublishSafety({
          ...safeLiveInput,
          env: { ADSOLUTE_META_PUBLISH_ENABLED: "false" },
        }),
      "LIVE_PUBLISH_ENV_DISABLED",
    );
  });

  it("rejects active statuses and campaign/ad set creation requests", () => {
    expectLaunchpadError(
      () => assertLivePublishSafety({ ...safeLiveInput, requestedStatus: "ACTIVE" }),
      "ACTIVE_META_STATUS_FORBIDDEN",
    );
    expectLaunchpadError(
      () => assertLivePublishSafety({ ...safeLiveInput, campaignCreationRequested: true }),
      "CAMPAIGN_CREATION_FORBIDDEN",
    );
    expectLaunchpadError(
      () => assertLivePublishSafety({ ...safeLiveInput, adSetCreationRequested: true }),
      "AD_SET_CREATION_FORBIDDEN",
    );
  });

  it("requires confirmation, a validated manifest, and an available live path", () => {
    expectLaunchpadError(
      () => assertLivePublishSafety({ ...safeLiveInput, confirmationAccepted: false }),
      "LIVE_PUBLISH_CONFIRMATION_REQUIRED",
    );
    expectLaunchpadError(
      () =>
        assertLivePublishSafety({
          ...safeLiveInput,
          previouslyValidatedManifest: false,
        }),
      "VALIDATED_MANIFEST_REQUIRED",
    );
    expectLaunchpadError(
      () =>
        assertLivePublishSafety({
          ...safeLiveInput,
          activePublishingPathAvailable: false,
        }),
      "LIVE_PUBLISH_PATH_UNAVAILABLE",
    );
  });
});
