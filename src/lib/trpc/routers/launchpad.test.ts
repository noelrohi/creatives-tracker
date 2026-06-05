import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaCallToAction } from "@/lib/launchpad-constants";
import {
  createLaunchpadRunDraft,
  hashLaunchpadPayload,
} from "@/lib/launchpad-ledger";
import { getOpenApiProcedures } from "@/lib/trpc/openapi";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import {
  launchpadPublishItems,
  launchpadPublishRuns,
} from "@/schema/launchpad";
import {
  createApiKeyCaller,
  createMockCaller,
  createWorkerCaller,
} from "../test-helpers";

const dbMocks = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[][],
  updateReturningQueue: [] as unknown[][],
  insertValues: [] as unknown[],
  insertTables: [] as unknown[],
  updateValues: [] as unknown[],
}));

const triggerMocks = vi.hoisted(() => ({
  trigger: vi.fn(),
  createPublicToken: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: triggerMocks.createPublicToken },
  tasks: { trigger: triggerMocks.trigger },
}));

vi.mock("@/db", () => {
  function nextSelectRows() {
    return dbMocks.selectQueue.shift() ?? [];
  }

  function createSelectBuilder(rows: unknown[]) {
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => Promise.resolve(rows)),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  }

  function createInsertBuilder() {
    const builder = {
      values: vi.fn((values: unknown) => {
        dbMocks.insertValues.push(values);
        return builder;
      }),
      onConflictDoNothing: vi.fn(() => builder),
      returning: vi.fn(() =>
        Promise.resolve(dbMocks.insertReturningQueue.shift() ?? []),
      ),
      then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  }

  function createUpdateBuilder() {
    const builder = {
      set: vi.fn((values: unknown) => {
        dbMocks.updateValues.push(values);
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(() =>
        Promise.resolve(dbMocks.updateReturningQueue.shift() ?? []),
      ),
      then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  }

  const tx = {
    select: vi.fn(() => createSelectBuilder(nextSelectRows())),
    insert: vi.fn((table: unknown) => {
      dbMocks.insertTables.push(table);
      return createInsertBuilder();
    }),
    update: vi.fn(() => createUpdateBuilder()),
  };

  return {
    db: {
      ...tx,
      transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    },
  };
});

const previousPublishFlag = process.env.ADSOLUTE_META_PUBLISH_ENABLED;
const previousLaunchpadFlag = process.env.ADSOLUTE_LAUNCHPAD_ENABLED;

function resetDbMocks() {
  dbMocks.selectQueue = [];
  dbMocks.insertReturningQueue = [];
  dbMocks.updateReturningQueue = [];
  dbMocks.insertValues = [];
  dbMocks.insertTables = [];
  dbMocks.updateValues = [];
}

function eligibleAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "account-1",
    name: "Main Meta Account",
    metaAccountId: "act_123",
    metaAccessToken: "secret-token",
    defaultFacebookPageId: "page-123",
    defaultInstagramActorId: "ig-123",
    ...overrides,
  };
}

function publicAccountRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    ...eligibleAccount(),
    notes: null,
    lastImportedAt: null,
    dataDateEnd: null,
    organizationId: "test-org-id",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function eligibleAdSet(overrides: Record<string, unknown> = {}) {
  return {
    id: "ad-set-1",
    name: "Prospecting / Static tests",
    metaId: "23800000000000000",
    accountId: "account-1",
    status: "active",
    campaignId: "campaign-1",
    campaignName: "Campaign Alpha",
    campaignMetaId: "cmp_123",
    campaignStatus: "active",
    ...overrides,
  };
}

function staticCreative(overrides: Record<string, unknown> = {}) {
  return {
    id: "creative-1",
    name: "Router static hero",
    format: "static",
    assetUrl: "https://cdn.example.com/router-static.png",
    videoUrl: null,
    hook: "Router hook fallback",
    cta: null,
    ...overrides,
  };
}

function videoCreative(overrides: Record<string, unknown> = {}) {
  return {
    id: "creative-video-1",
    name: "Router UGC video",
    format: "ugc",
    assetUrl: "https://cdn.example.com/router-video-thumb.jpg",
    videoUrl: "https://cdn.example.com/router-video.mp4",
    hook: "UGC hook fallback",
    cta: null,
    ...overrides,
  };
}

function approvedSourceTemplateRow(overrides: Record<string, unknown> = {}) {
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
    notes: "Safe paused-copy template",
    status: "approved",
    approvedByUserId: "approver-1",
    approvedAt: now,
    lastValidatedAt: now,
    expiresAt: null,
    metadata: { source: "router-test" },
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

type CreateValidationRunTestInput = {
  idempotencyKey?: string;
  actor?: {
    accountId?: string;
    accountMetaId?: string;
    facebookPageId?: string;
    instagramActorId?: string;
  };
  destination?: { adSetId?: string; adSetMetaId?: string };
  defaultDestinationUrl?: string;
  defaultPrimaryText?: string;
  defaultCaption?: string;
  defaultCta?: string;
  namingTemplate?: string;
  items?: Array<{
    creativeId?: string;
    adName?: string;
    primaryText?: string;
    caption?: string;
    headline?: string;
    destinationUrl?: string;
    cta?: string;
  }>;
};

function baseCreateValidationInput(
  overrides: CreateValidationRunTestInput = {},
) {
  return {
    idempotencyKey: "router-idempotency-key",
    actor: { accountId: "account-1" },
    destination: { adSetId: "ad-set-1" },
    defaultDestinationUrl:
      "https://example.com/products?utm_source=meta&utm_medium=paid_social",
    items: [
      {
        creativeId: "creative-1",
        adName: "Router demo",
        primaryText: "Router dry-run primary text",
      },
    ],
    ...overrides,
  };
}

type CreateCloneDryRunTestInput = {
  idempotencyKey?: string;
  sourceTemplateId: string;
  launchName: string;
  destinationUrl: string;
  defaultPrimaryText?: string;
  defaultHeadline?: string;
  defaultCta?: MetaCallToAction;
  creativeIds: string[];
};

function baseCreateCloneDryRunInput(
  overrides: Partial<CreateCloneDryRunTestInput> = {},
): CreateCloneDryRunTestInput {
  return {
    idempotencyKey: "router-clone-dry-run-key",
    sourceTemplateId: "source-template-1",
    launchName: "Router Clone Launch",
    destinationUrl:
      "https://example.com/clone?utm_source=meta&utm_medium=paid_social",
    defaultPrimaryText: "Router clone primary text",
    defaultHeadline: "Router clone headline",
    defaultCta: "LEARN_MORE",
    creativeIds: ["creative-1"],
    ...overrides,
  };
}

function baseRunInput() {
  return {
    organizationId: "test-org-id",
    requestedBy: {
      userId: "test-user-id",
      principalType: "session" as const,
      orgRole: "admin" as const,
    },
    actor: {
      accountId: "account-1",
      accountMetaId: "act_123",
      facebookPageId: "page-123",
      instagramActorId: "ig-123",
    },
    destination: {
      adSetId: "ad-set-1",
      adSetMetaId: "23800000000000000",
    },
    items: [
      {
        creativeId: "creative-1",
        creativeName: "Router static hero",
        format: "static",
        assetUrl: "https://cdn.example.com/router-static.png",
        videoUrl: null,
        hook: "Router hook fallback",
        adName: "Launchpad router demo",
        caption: "Router dry-run primary text",
        destinationUrl:
          "https://example.com/products?utm_source=meta&utm_medium=paid_social",
      },
    ],
    env: process.env,
  };
}

function videoRunInput() {
  return {
    ...baseRunInput(),
    items: [
      {
        creativeId: "creative-video-1",
        creativeName: "Router UGC video",
        format: "ugc",
        assetUrl: "https://cdn.example.com/router-video-thumb.jpg",
        videoUrl: "https://cdn.example.com/router-video.mp4",
        hook: "UGC hook fallback",
        adName: "Launchpad router UGC demo",
        caption: "Router UGC launch copy",
        headline: "UGC hook fallback",
        destinationUrl:
          "https://example.com/video?utm_source=meta&utm_medium=paid_social",
      },
    ],
  };
}

function persistedValidatedRun(overrides: Record<string, unknown> = {}) {
  const draft = createLaunchpadRunDraft(baseRunInput());
  return {
    id: "run-1",
    organizationId: "test-org-id",
    status: "validated",
    mode: "validation",
    requestedStatus: "PAUSED",
    itemCount: draft.items.length,
    maxItemCap: 25,
    manifest: draft.manifest,
    manifestHash: draft.manifestHash,
    manifestLockedAt: new Date("2026-01-01T00:00:00.000Z"),
    validatedAt: new Date("2026-01-01T00:00:00.000Z"),
    idempotencyKey: draft.idempotencyKey,
    dedupeKey: draft.dedupeKey,
    actorAccountId: "account-1",
    actorAccountMetaId: "act_123",
    actorPageId: "page-123",
    actorInstagramId: "ig-123",
    destinationAdSetId: "ad-set-1",
    destinationAdSetMetaId: "23800000000000000",
    ...overrides,
  };
}

function persistedCloneSetupRun(overrides: Record<string, unknown> = {}) {
  const manifest = {
    version: 2,
    kind: "creative_launchpad.clone_setup_manifest",
    launchMode: "clone_setup",
    safety: {
      dryRunOnly: true,
      campaignCreationAllowed: false,
      adSetCreationAllowed: false,
      adCreationAllowed: false,
      metaWritesAllowed: false,
    },
  };

  return persistedValidatedRun({
    id: "clone-run-1",
    mode: "clone_setup_validation",
    destinationAdSetId: null,
    destinationAdSetMetaId: null,
    manifest,
    manifestHash: hashLaunchpadPayload(manifest),
    ...overrides,
  });
}

function persistedValidatedItem(overrides: Record<string, unknown> = {}) {
  const draft = createLaunchpadRunDraft(baseRunInput());
  const item = draft.items[0];
  return {
    id: "item-1",
    runId: "run-1",
    organizationId: "test-org-id",
    position: 1,
    status: "validated",
    requestedStatus: "PAUSED",
    creativeId: item.creativeId,
    localAdId: null,
    accountId: "account-1",
    adSetId: "ad-set-1",
    actorPageId: "page-123",
    actorInstagramId: "ig-123",
    payload: item.payload,
    payloadHash: item.payloadHash,
    payloadLockedAt: new Date("2026-01-01T00:00:00.000Z"),
    idempotencyKey: item.idempotencyKey,
    dedupeKey: item.dedupeKey,
    requestedAdName: item.adName,
    externalMetaImageHash: null,
    externalMetaVideoId: null,
    externalMetaCreativeId: null,
    externalMetaAdId: null,
    rawMetaConfiguredStatus: null,
    rawMetaEffectiveStatus: null,
    createdByUserId: "test-user-id",
    createdByPrincipalType: "session",
    createdByRole: "admin",
    errorCategory: null,
    errorCode: null,
    errorMessage: null,
    errorDetails: null,
    reconciliationStatus: "not_required",
    reconciliationCheckedAt: null,
    manualInterventionReason: null,
    validatedAt: new Date("2026-01-01T00:00:00.000Z"),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function persistedQueuedRun(overrides: Record<string, unknown> = {}) {
  return persistedValidatedRun({
    status: "queued",
    mode: "publish",
    queuedAt: new Date("2026-01-01T00:01:00.000Z"),
    externalTriggerRunId: "trigger-run-1",
    reconciliationStatus: "pending",
    ...overrides,
  });
}

function persistedQueuedItem(overrides: Record<string, unknown> = {}) {
  return persistedValidatedItem({
    status: "queued",
    queuedAt: new Date("2026-01-01T00:01:00.000Z"),
    reconciliationStatus: "pending",
    ...overrides,
  });
}

function persistedVideoRun(overrides: Record<string, unknown> = {}) {
  const draft = createLaunchpadRunDraft(videoRunInput());
  return persistedValidatedRun({
    itemCount: draft.items.length,
    manifest: draft.manifest,
    manifestHash: draft.manifestHash,
    idempotencyKey: draft.idempotencyKey,
    dedupeKey: draft.dedupeKey,
    ...overrides,
  });
}

function persistedVideoItem(overrides: Record<string, unknown> = {}) {
  const draft = createLaunchpadRunDraft(videoRunInput());
  const item = draft.items[0];
  return persistedValidatedItem({
    creativeId: item.creativeId,
    payload: item.payload,
    payloadHash: item.payloadHash,
    idempotencyKey: item.idempotencyKey,
    dedupeKey: item.dedupeKey,
    requestedAdName: item.adName,
    ...overrides,
  });
}

function persistedQueuedVideoRun(overrides: Record<string, unknown> = {}) {
  return persistedVideoRun({
    status: "queued",
    mode: "publish",
    queuedAt: new Date("2026-01-01T00:01:00.000Z"),
    externalTriggerRunId: "trigger-run-1",
    reconciliationStatus: "pending",
    ...overrides,
  });
}

function persistedQueuedVideoItem(overrides: Record<string, unknown> = {}) {
  return persistedVideoItem({
    status: "queued",
    queuedAt: new Date("2026-01-01T00:01:00.000Z"),
    reconciliationStatus: "pending",
    ...overrides,
  });
}

function batchRunInput() {
  return {
    ...baseRunInput(),
    items: [
      baseRunInput().items[0],
      {
        creativeId: "creative-2",
        creativeName: "Router static second",
        format: "static",
        assetUrl: "https://cdn.example.com/router-static-2.png",
        videoUrl: null,
        hook: "Second hook fallback",
        adName: "Launchpad router demo 2",
        caption: "Router dry-run primary text 2",
        destinationUrl:
          "https://example.com/products-2?utm_source=meta&utm_medium=paid_social",
      },
    ],
  };
}

function persistedBatchRunAndItems() {
  const draft = createLaunchpadRunDraft(batchRunInput());
  const run = persistedValidatedRun({
    itemCount: draft.items.length,
    manifest: draft.manifest,
    manifestHash: draft.manifestHash,
    idempotencyKey: draft.idempotencyKey,
    dedupeKey: draft.dedupeKey,
  });
  const items = draft.items.map((item, index) =>
    persistedValidatedItem({
      id: `item-${index + 1}`,
      position: index + 1,
      creativeId: item.creativeId,
      payload: item.payload,
      payloadHash: item.payloadHash,
      idempotencyKey: item.idempotencyKey,
      dedupeKey: item.dedupeKey,
      requestedAdName: item.adName,
    }),
  );

  return { run, items };
}

function enqueueEligibleDestination() {
  dbMocks.selectQueue.push([eligibleAccount()], [eligibleAdSet()]);
}

function enqueueDryRunPlanningRows(
  options: { creative?: Record<string, unknown>; conflicts?: unknown[] } = {},
) {
  enqueueEligibleDestination();
  dbMocks.selectQueue.push(
    [options.creative ?? staticCreative()],
    options.conflicts ?? [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMocks();
  triggerMocks.trigger.mockResolvedValue({ id: "trigger-run-1" });
  process.env.ADSOLUTE_LAUNCHPAD_ENABLED = "true";
});

afterEach(() => {
  resetDbMocks();
  if (previousPublishFlag === undefined) {
    delete process.env.ADSOLUTE_META_PUBLISH_ENABLED;
  } else {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = previousPublishFlag;
  }

  if (previousLaunchpadFlag === undefined) {
    delete process.env.ADSOLUTE_LAUNCHPAD_ENABLED;
  } else {
    process.env.ADSOLUTE_LAUNCHPAD_ENABLED = previousLaunchpadFlag;
  }
});

describe("account publishing identity sanitization", () => {
  it("lists account publishing metadata without exposing access tokens", async () => {
    dbMocks.selectQueue = [[publicAccountRow({ metaAccessToken: "super-secret" })]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.adAccount.list();

    expect(result[0]).toMatchObject({
      id: "account-1",
      defaultFacebookPageId: "page-123",
      defaultInstagramActorId: "ig-123",
      hasMetaAccessToken: true,
    });
    expect(result[0]).not.toHaveProperty("metaAccessToken");
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("updates manual Page and Instagram actor metadata without returning tokens", async () => {
    dbMocks.updateReturningQueue = [[
      publicAccountRow({
        metaAccessToken: "new-secret",
        defaultFacebookPageId: "page-new",
        defaultInstagramActorId: null,
      }),
    ]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.adAccount.update({
      id: "account-1",
      defaultFacebookPageId: "page-new",
      defaultInstagramActorId: null,
      metaAccessToken: "new-secret",
    });

    expect(dbMocks.updateValues[0]).toMatchObject({
      defaultFacebookPageId: "page-new",
      defaultInstagramActorId: null,
      metaAccessToken: "new-secret",
    });
    expect(result).toMatchObject({
      defaultFacebookPageId: "page-new",
      defaultInstagramActorId: null,
      hasMetaAccessToken: true,
    });
    expect(result).not.toHaveProperty("metaAccessToken");
    expect(JSON.stringify(result)).not.toContain("new-secret");
  });
});

describe("ad set account link tenant safety", () => {
  it("rejects create links to accounts outside the active organization", async () => {
    dbMocks.selectQueue = [[{ id: "campaign-1" }], []];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.adSet.create({
        campaignId: "campaign-1",
        accountId: "foreign-account",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad account"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects create links to campaigns outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.adSet.create({
        campaignId: "foreign-campaign",
        accountId: "account-1",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Campaign"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects update links to accounts outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.adSet.update({
        id: "ad-set-1",
        accountId: "foreign-account",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad account"),
    });
    expect(dbMocks.updateValues).toEqual([]);
  });

  it("rejects update links to campaigns outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.adSet.update({
        id: "ad-set-1",
        campaignId: "foreign-campaign",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Campaign"),
    });
    expect(dbMocks.updateValues).toEqual([]);
  });
});

describe("ad tenant link safety", () => {
  it("rejects create links to ad sets outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.ad.create({ adSetId: "foreign-ad-set" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad set"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects create links to creatives outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.ad.create({ adCreativeId: "foreign-creative" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Creative"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects update links to ad sets outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.ad.update({
        id: "ad-1",
        adSetId: "foreign-ad-set",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad set"),
    });
    expect(dbMocks.updateValues).toEqual([]);
  });

  it("rejects update links to creatives outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.ad.update({
        id: "ad-1",
        adCreativeId: "foreign-creative",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Creative"),
    });
    expect(dbMocks.updateValues).toEqual([]);
  });

  it("rejects duplicate when the source ad carries an unsafe ad set link", async () => {
    dbMocks.selectQueue = [
      [
        {
          id: "ad-1",
          name: "Corrupted link ad",
          adSetId: "foreign-ad-set",
          adCreativeId: null,
          status: "active",
          notes: null,
        },
      ],
      [],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(adminCaller.ad.duplicate({ id: "ad-1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad set"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects bulk import into ad sets outside the active organization", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.ad.bulkImport({
        adSetId: "foreign-ad-set",
        rows: [{ name: "Imported ad" }],
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad set"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });
});

describe("launchpad destination selection", () => {
  it("lists destination accounts without token disclosure", async () => {
    dbMocks.selectQueue = [[eligibleAccount({ metaAccessToken: "secret" })]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.destinationAccounts();

    expect(result).toEqual([
      expect.objectContaining({
        id: "account-1",
        metaAccountId: "act_123",
        defaultFacebookPageId: "page-123",
        defaultInstagramActorId: "ig-123",
        hasMetaAccessToken: true,
        canPublish: true,
        ineligibleReasons: [],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("filters eligible ad sets to the selected account and linked Meta IDs", async () => {
    dbMocks.selectQueue = [
      [eligibleAccount()],
      [
        eligibleAdSet(),
        eligibleAdSet({ id: "wrong-account", accountId: "account-2" }),
        eligibleAdSet({ id: "missing-meta", metaId: null }),
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.eligibleAdSets({
      accountId: "account-1",
    });

    expect(result.map((adSet) => adSet.id)).toEqual(["ad-set-1"]);
  });

  it("returns read-only context for an eligible selected destination", async () => {
    enqueueEligibleDestination();
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.destinationContext({
      accountId: "account-1",
      adSetId: "ad-set-1",
    });

    expect(result).toMatchObject({
      account: {
        id: "account-1",
        metaAccountId: "act_123",
        defaultFacebookPageId: "page-123",
        hasMetaAccessToken: true,
      },
      adSet: {
        id: "ad-set-1",
        metaId: "23800000000000000",
        accountId: "account-1",
        campaign: {
          id: "campaign-1",
          name: "Campaign Alpha",
          metaId: "cmp_123",
          status: "active",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

describe("launchpad v2 source templates", () => {
  it("lists approved source templates without exposing account tokens", async () => {
    dbMocks.selectQueue = [
      [
        approvedSourceTemplateRow({
          accountHasMetaAccessToken: true,
          metaAccessToken: "secret-token-that-should-not-leak",
        }),
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.listSourceTemplates();

    expect(result).toEqual([
      expect.objectContaining({
        id: "source-template-1",
        label: "Approved prospecting template",
        account: expect.objectContaining({
          id: "account-1",
          metaAccountId: "act_123",
          hasMetaAccessToken: true,
        }),
        readiness: expect.objectContaining({ status: "ready" }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

describe("launchpad v2 clone dry-run", () => {
  it("persists a clone setup validation run and ledger items only", async () => {
    dbMocks.selectQueue = [
      [approvedSourceTemplateRow()],
      [staticCreative()],
      [],
      [],
    ];
    dbMocks.insertReturningQueue = [[{ id: "clone-run-new" }], [{ id: "clone-item-new" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.createCloneDryRun(
      baseCreateCloneDryRunInput(),
    );

    expect(result).toEqual({ id: "clone-run-new" });
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
    expect(triggerMocks.createPublicToken).not.toHaveBeenCalled();
    expect(dbMocks.updateValues).toEqual([]);
    expect(dbMocks.insertTables).toEqual([
      launchpadPublishRuns,
      launchpadPublishItems,
    ]);
    expect(dbMocks.insertTables).not.toContain(campaigns);
    expect(dbMocks.insertTables).not.toContain(adSets);
    expect(dbMocks.insertTables).not.toContain(ads);
    expect(dbMocks.insertValues[0]).toMatchObject({
      organizationId: "test-org-id",
      status: "validated",
      mode: "clone_setup_validation",
      requestedStatus: "PAUSED",
      itemCount: 1,
      actorAccountId: "account-1",
      actorAccountMetaId: "act_123",
      actorPageId: "page-123",
      actorInstagramId: "ig-123",
      livePublishEnabledAtValidation: false,
      reconciliationStatus: "not_required",
    });
    expect(dbMocks.insertValues[0]).not.toHaveProperty("destinationAdSetId");
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({
        organizationId: "test-org-id",
        status: "validated",
        requestedStatus: "PAUSED",
        creativeId: "creative-1",
        accountId: "account-1",
        actorPageId: "page-123",
        actorInstagramId: "ig-123",
        reconciliationStatus: "not_required",
      }),
    ]);
    expect(dbMocks.insertValues[0]).toMatchObject({
      dedupeKey: hashLaunchpadPayload({
        kind: "launchpad.clone_setup.dry_run.dedupe.v2",
        organizationId: "test-org-id",
        mode: "clone_setup_validation",
        manifestHash: (dbMocks.insertValues[0] as { manifestHash: string }).manifestHash,
      }),
    });
  });

  it("rejects wrong-org source templates before persistence", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createCloneDryRun(
        baseCreateCloneDryRunInput({ sourceTemplateId: "foreign-template" }),
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("source template"),
    });
    expect(dbMocks.insertValues).toEqual([]);
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });

  it("rejects wrong-org creatives before persistence", async () => {
    dbMocks.selectQueue = [[approvedSourceTemplateRow()], []];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createCloneDryRun(
        baseCreateCloneDryRunInput({ creativeIds: ["foreign-creative"] }),
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Creative"),
    });
    expect(dbMocks.insertValues).toEqual([]);
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });

  it("persists same-org failed business validation dry-runs", async () => {
    dbMocks.selectQueue = [
      [approvedSourceTemplateRow()],
      [staticCreative()],
      [],
      [],
    ];
    dbMocks.insertReturningQueue = [[{ id: "clone-run-failed" }], [{ id: "clone-item-failed" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createCloneDryRun(
        baseCreateCloneDryRunInput({ destinationUrl: "http://example.com" }),
      ),
    ).resolves.toEqual({ id: "clone-run-failed" });

    expect(dbMocks.insertValues[0]).toMatchObject({
      status: "failed",
      mode: "clone_setup_validation",
      errorCategory: "terminal",
      errorCode: "LAUNCHPAD_VALIDATION_FAILED",
    });
    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("INVALID_DESTINATION_URL"),
    );
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCategory: "terminal",
        errorCode: "LAUNCHPAD_VALIDATION_FAILED",
      }),
    ]);
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });

  it("rejects unready source templates before clone dry-run persistence", async () => {
    dbMocks.selectQueue = [
      [
        approvedSourceTemplateRow({
          campaignAccountId: "foreign-account",
          adSetAccountId: "foreign-account",
        }),
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createCloneDryRun(baseCreateCloneDryRunInput()),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("different ad account"),
    });

    expect(JSON.stringify(dbMocks.insertValues)).not.toContain("foreign-account");
    expect(dbMocks.insertValues).toEqual([]);
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });

  it("rejects clone dry-run idempotency replay with a different manifest", async () => {
    dbMocks.selectQueue = [
      [approvedSourceTemplateRow()],
      [staticCreative()],
      [
        persistedCloneSetupRun({
          idempotencyKey: "router-clone-dry-run-key",
          manifestHash: "different-manifest-hash",
        }),
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createCloneDryRun(
        baseCreateCloneDryRunInput({ defaultHeadline: "Changed headline" }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("different manifest or mode"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects invalid clone CTAs at the router boundary", async () => {
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createCloneDryRun(
        baseCreateCloneDryRunInput({ defaultCta: "NOT_A_META_CTA" } as never),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.selectQueue).toEqual([]);
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("does not promote clone setup validation runs to live publishing", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [[persistedCloneSetupRun()]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "clone-run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("validation previews only"),
    });
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
    expect(dbMocks.updateValues).toEqual([]);
  });
});

describe("launchpad router safety", () => {
  it("blocks ordinary members from the Launchpad ledger surface", async () => {
    const memberCaller = createMockCaller({ role: "member" });

    await expect(memberCaller.launchpad.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(memberCaller.launchpad.listSourceTemplates()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      memberCaller.launchpad.createValidationRun({
        idempotencyKey: "member-demo-key",
        actor: { accountId: "account-1" },
        destination: { adSetId: "ad-set-1" },
        items: [{ creativeId: "creative-1", adName: "Member demo" }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      memberCaller.launchpad.createCloneDryRun(baseCreateCloneDryRunInput()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks members and API keys from requesting live publishing", async () => {
    const memberCaller = createMockCaller({ role: "member" });
    const apiKeyCaller = createApiKeyCaller();

    await expect(
      memberCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      apiKeyCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gates Launchpad tRPC and OpenAPI surfaces behind the feature flag", async () => {
    expect(
      getOpenApiProcedures().some(
        (procedure) => procedure.routerName === "launchpad",
      ),
    ).toBe(true);

    process.env.ADSOLUTE_LAUNCHPAD_ENABLED = "false";
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(adminCaller.launchpad.list()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Launchpad is not enabled"),
    });
    expect(
      getOpenApiProcedures().some(
        (procedure) => procedure.routerName === "launchpad",
      ),
    ).toBe(false);
  });

  it("loads the persisted run before returning an env-disabled live publish rejection", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "false";
    dbMocks.selectQueue = [[persistedValidatedRun()]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("ADSOLUTE_META_PUBLISH_ENABLED"),
    });
    expect(dbMocks.selectQueue).toEqual([]);
  });

  it("requires the persisted run to be validated and hash-locked", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [
      [
        persistedValidatedRun({
          status: "validation",
          validatedAt: null,
        }),
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("previously validated"),
    });
  });
});

describe("launchpad router destination eligibility", () => {
  it("persists account and ad set readiness failures as inspectable dry-run QA errors", async () => {
    dbMocks.selectQueue = [
      [
        eligibleAccount({
          metaAccessToken: null,
          defaultFacebookPageId: null,
        }),
      ],
      [eligibleAdSet({ accountId: null, metaId: null })],
      [staticCreative()],
      [],
      [],
      [],
      [],
    ];
    dbMocks.insertReturningQueue = [[{ id: "run-failed" }], [{ id: "item-failed" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(baseCreateValidationInput()),
    ).resolves.toEqual({ id: "run-failed" });

    expect(dbMocks.insertValues[0]).toMatchObject({
      status: "failed",
      errorCategory: "terminal",
      errorCode: "LAUNCHPAD_VALIDATION_FAILED",
    });
    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("ACCOUNT_ACCESS_TOKEN_REQUIRED"),
    );
    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("FACEBOOK_PAGE_ID_REQUIRED"),
    );
    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("AD_SET_ACCOUNT_LINK_REQUIRED"),
    );
    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("AD_SET_META_ID_REQUIRED"),
    );
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({ status: "failed", errorCategory: "terminal" }),
    ]);
  });

  it("persists account/ad set mismatch as a failed destination dry-run", async () => {
    dbMocks.selectQueue = [
      [eligibleAccount()],
      [eligibleAdSet({ accountId: "account-2" })],
      [staticCreative()],
      [],
      [],
      [],
      [],
    ];
    dbMocks.insertReturningQueue = [[{ id: "run-mismatch" }], [{ id: "item-mismatch" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(baseCreateValidationInput()),
    ).resolves.toEqual({ id: "run-mismatch" });

    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("ACCOUNT_AD_SET_MISMATCH"),
    );
    expect(dbMocks.insertValues[0]).toMatchObject({ status: "failed" });
  });
});

describe("launchpad router ledger persistence", () => {
  it("persists a validation run and items with audit metadata", async () => {
    enqueueDryRunPlanningRows();
    dbMocks.selectQueue.push([], [], []);
    dbMocks.insertReturningQueue = [[{ id: "run-new" }], [{ id: "item-new" }]];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.createValidationRun(
      baseCreateValidationInput(),
    );

    expect(result).toEqual({ id: "run-new" });
    expect(dbMocks.insertValues).toHaveLength(2);
    expect(dbMocks.insertValues[0]).toMatchObject({
      organizationId: "test-org-id",
      status: "validated",
      requestedByUserId: "test-user-id",
      requestedByPrincipalType: "session",
      requestedByRole: "admin",
      requestedStatus: "PAUSED",
      itemCount: 1,
      maxItemCap: 25,
      actorAccountId: "account-1",
      actorAccountMetaId: "act_123",
      actorPageId: "page-123",
      actorInstagramId: "ig-123",
      destinationAdSetId: "ad-set-1",
      destinationAdSetMetaId: "23800000000000000",
    });
    expect(dbMocks.insertValues[0]).toHaveProperty("manifestHash");
    expect(dbMocks.insertValues[0]).toHaveProperty("dedupeKey");
    expect(dbMocks.insertValues[0]).toHaveProperty("idempotencyKey");
    expect(dbMocks.insertValues[0]).toHaveProperty("manifest");
    expect(JSON.stringify(dbMocks.insertValues[0])).toEqual(
      expect.stringContaining("expectedMetaObjectShape"),
    );
    expect(JSON.stringify(dbMocks.insertValues[0])).not.toContain("secret-token");
    expect(dbMocks.insertTables).not.toContain(ads);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({
        runId: "run-new",
        organizationId: "test-org-id",
        status: "validated",
        requestedStatus: "PAUSED",
        accountId: "account-1",
        adSetId: "ad-set-1",
        actorPageId: "page-123",
        actorInstagramId: "ig-123",
        createdByUserId: "test-user-id",
        createdByPrincipalType: "session",
        createdByRole: "admin",
        reconciliationStatus: "not_required",
      }),
    ]);
  });

  it("persists a batch validation run with defaults, per-item overrides, and generated names", async () => {
    enqueueEligibleDestination();
    dbMocks.selectQueue.push(
      [staticCreative({ id: "creative-1", name: "Router static hero" })],
      [],
      [staticCreative({ id: "creative-2", name: "Router static second" })],
      [],
      [],
      [],
      [],
    );
    dbMocks.insertReturningQueue = [[{ id: "run-batch" }], [{ id: "item-1" }, { id: "item-2" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.createValidationRun(
      baseCreateValidationInput({
        defaultPrimaryText: "Batch-level launch copy",
        defaultCta: "LEARN_MORE",
        namingTemplate: "Batch {{item.positionPadded}} / {{creative.name}}",
        items: [
          { creativeId: "creative-1", primaryText: "", destinationUrl: "", cta: "" },
          {
            creativeId: "creative-2",
            adName: "Manual item two",
            primaryText: "Item two copy override",
            headline: "Item two headline",
            destinationUrl:
              "https://example.com/override?utm_source=meta&utm_medium=paid_social",
          },
        ],
      }),
    );

    expect(result).toEqual({ id: "run-batch" });
    expect(dbMocks.insertValues[0]).toMatchObject({
      status: "validated",
      itemCount: 2,
      maxItemCap: 25,
    });
    expect(dbMocks.insertValues[0]).toHaveProperty("manifest.plannerManifest.batchDefaults", {
      destinationUrl:
        "https://example.com/products?utm_source=meta&utm_medium=paid_social",
      primaryText: "Batch-level launch copy",
      caption: null,
      cta: "LEARN_MORE",
      namingTemplate: "Batch {{item.positionPadded}} / {{creative.name}}",
      requiredUtmParameters: ["utm_source", "utm_medium"],
    });
    const insertedItems = dbMocks.insertValues[1] as Array<{
      requestedAdName: string;
      payload: {
        launch: {
          adName: string;
          primaryText: string | null;
          headline: string | null;
          destinationUrl: string | null;
          cta: string;
        };
        url: { source: string };
      };
    }>;
    expect(insertedItems).toHaveLength(2);
    expect(insertedItems[0]?.requestedAdName).toBe("Batch 01 / Router static hero");
    expect(insertedItems[0]?.payload.launch).toMatchObject({
      adName: "Batch 01 / Router static hero",
      primaryText: "Batch-level launch copy",
      destinationUrl:
        "https://example.com/products?utm_source=meta&utm_medium=paid_social",
      cta: "LEARN_MORE",
    });
    expect(insertedItems[0]?.payload.url).toMatchObject({ source: "batch_default" });
    expect(insertedItems[1]?.payload.launch).toMatchObject({
      adName: "Manual item two",
      primaryText: "Item two copy override",
      headline: "Item two headline",
      destinationUrl:
        "https://example.com/override?utm_source=meta&utm_medium=paid_social",
      cta: "LEARN_MORE",
    });
    expect(insertedItems[1]?.payload.url).toMatchObject({ source: "item_override" });
  });

  it("persists mixed static and video dry-run items with media-specific payload previews", async () => {
    enqueueEligibleDestination();
    dbMocks.selectQueue.push(
      [staticCreative({ id: "creative-1", name: "Router static hero" })],
      [],
      [videoCreative()],
      [],
      [],
      [],
      [],
    );
    dbMocks.insertReturningQueue = [[{ id: "run-mixed" }], [{ id: "item-1" }, { id: "item-2" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.createValidationRun(
      baseCreateValidationInput({
        items: [
          { creativeId: "creative-1" },
          { creativeId: "creative-video-1", adName: "Manual UGC launch" },
        ],
      }),
    );

    expect(result).toEqual({ id: "run-mixed" });
    expect(dbMocks.insertValues[0]).toMatchObject({ status: "validated", itemCount: 2 });
    expect(dbMocks.insertValues[0]).toHaveProperty(
      "manifest.plannerManifest.items.1.expectedMetaObjectShape.videoUpload.endpoint",
      "/act_123/advideos",
    );
    const insertedItems = dbMocks.insertValues[1] as Array<{
      requestedAdName: string;
      payload: {
        creative: { format: string; videoUrl: string | null };
        media: { type: string; uploadMethod: string; sourceUrl: string | null };
        expectedMetaObjectShape: { videoUpload?: unknown; imageUpload?: unknown };
      };
    }>;
    expect(insertedItems).toHaveLength(2);
    expect(insertedItems[0]?.payload.media).toMatchObject({ type: "image" });
    expect(insertedItems[1]).toMatchObject({
      requestedAdName: "Manual UGC launch",
      payload: {
        creative: {
          format: "ugc",
          videoUrl: "https://cdn.example.com/router-video.mp4",
        },
        media: {
          type: "video",
          uploadMethod: "file_url",
          sourceUrl: "https://cdn.example.com/router-video.mp4",
        },
      },
    });
    expect(insertedItems[1]?.payload.expectedMetaObjectShape.videoUpload).toBeDefined();
    expect(insertedItems[1]?.payload.expectedMetaObjectShape.imageUpload).toBeUndefined();
  });

  it("rejects duplicate creatives inside the same batch before persistence", async () => {
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          items: [
            { creativeId: "creative-1" },
            { creativeId: "creative-1" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.selectQueue).toEqual([]);
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("enforces the 25-item Launchpad batch cap at the router boundary", async () => {
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          items: Array.from({ length: 26 }, (_, index) => ({
            creativeId: `creative-${index + 1}`,
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.selectQueue).toEqual([]);
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("validates URL and UTM rules independently across batch items", async () => {
    enqueueEligibleDestination();
    dbMocks.selectQueue.push(
      [staticCreative({ id: "creative-1" })],
      [],
      [staticCreative({ id: "creative-2" })],
      [],
      [],
      [],
      [],
    );
    dbMocks.insertReturningQueue = [[{ id: "run-batch-failed" }], [{ id: "item-1" }, { id: "item-2" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          items: [
            { creativeId: "creative-1" },
            {
              creativeId: "creative-2",
              destinationUrl: "https://example.com/no-medium?utm_source=meta",
            },
          ],
        }),
      ),
    ).resolves.toEqual({ id: "run-batch-failed" });

    expect(dbMocks.insertValues[0]).toMatchObject({ status: "failed", itemCount: 2 });
    const insertedItems = dbMocks.insertValues[1] as Array<{
      status: string;
      errorCategory?: string;
      payload: { validation: { issues: Array<{ code: string }> } };
    }>;
    expect(insertedItems[0]?.status).toBe("validated");
    expect(insertedItems[1]).toMatchObject({
      status: "failed",
      errorCategory: "terminal",
    });
    expect(insertedItems[1]?.payload.validation.issues.map((issue) => issue.code)).toContain(
      "MISSING_REQUIRED_UTM_PARAMETERS",
    );
  });

  it("persists item QA failures for unsupported creatives, invalid CTA, URL issues, and Meta ad conflicts", async () => {
    enqueueDryRunPlanningRows({
      creative: staticCreative({ format: "carousel", assetUrl: null }),
      conflicts: [{ id: "ad-1", name: "Existing Meta ad", metaId: "1200" }],
    });
    dbMocks.selectQueue.push([], [], []);
    dbMocks.insertReturningQueue = [[{ id: "run-item-failed" }], [{ id: "item-failed" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          defaultDestinationUrl: "http://example.com/no-utm",
          items: [
            {
              creativeId: "creative-1",
              adName: "Failed QA demo",
              cta: "WATCH_NOW",
            },
          ],
        }),
      ),
    ).resolves.toEqual({ id: "run-item-failed" });

    const serializedRun = JSON.stringify(dbMocks.insertValues[0]);
    expect(dbMocks.insertValues[0]).toMatchObject({ status: "failed" });
    expect(serializedRun).toEqual(
      expect.stringContaining("UNSUPPORTED_CREATIVE_FORMAT"),
    );
    expect(serializedRun).toEqual(expect.stringContaining("INVALID_META_CTA"));
    expect(serializedRun).toEqual(expect.stringContaining("INVALID_DESTINATION_URL"));
    expect(serializedRun).toEqual(
      expect.stringContaining("MISSING_REQUIRED_UTM_PARAMETERS"),
    );
    expect(serializedRun).toEqual(
      expect.stringContaining("EXISTING_META_AD_ID_CONFLICT"),
    );
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({ status: "failed", errorCategory: "terminal" }),
    ]);
  });

  it("persists clear QA failures for video creatives without a usable video URL", async () => {
    enqueueDryRunPlanningRows({
      creative: videoCreative({ videoUrl: null }),
    });
    dbMocks.selectQueue.push([], [], []);
    dbMocks.insertReturningQueue = [[{ id: "run-video-failed" }], [{ id: "item-video-failed" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          items: [{ creativeId: "creative-video-1", adName: "Missing video" }],
        }),
      ),
    ).resolves.toEqual({ id: "run-video-failed" });

    const serializedRun = JSON.stringify(dbMocks.insertValues[0]);
    expect(serializedRun).toContain("CREATIVE_VIDEO_REQUIRED");
    expect(serializedRun).not.toContain("UNSUPPORTED_CREATIVE_FORMAT");
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({ status: "failed", errorCategory: "terminal" }),
    ]);
  });

  it("rejects idempotency-key replays with a different manifest", async () => {
    enqueueDryRunPlanningRows();
    dbMocks.selectQueue.push([
      {
        id: "existing-run",
        idempotencyKey: "router-idempotency-key",
        dedupeKey: "different-dedupe",
        manifestHash: "different-manifest-hash",
        mode: "validation",
      },
    ]);
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          items: [{ creativeId: "creative-1", adName: "Changed router demo" }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("different manifest"),
    });
  });

  it("rejects dedupe-key matches with a different manifest", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "false";
    const draft = createLaunchpadRunDraft(baseRunInput());
    const existing = {
      id: "existing-dedupe-run",
      idempotencyKey: "someone-elses-idempotency-key",
      dedupeKey: draft.dedupeKey,
      manifestHash: "older-order-or-audit-specific-manifest",
      mode: "validation",
    };
    enqueueDryRunPlanningRows();
    dbMocks.selectQueue.push([], [existing]);
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun({
        actor: { accountId: "account-1" },
        destination: { adSetId: "ad-set-1" },
        items: baseRunInput().items,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("different manifest or mode"),
    });
  });

  it("rejects item-level idempotency/dedupe conflicts before persistence", async () => {
    enqueueDryRunPlanningRows();
    dbMocks.selectQueue.push(
      [],
      [],
      [{ id: "existing-item", idempotencyKey: "item-key", dedupeKey: "dedupe" }],
    );
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          items: [{ creativeId: "creative-1", adName: "Item collision demo" }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("item idempotency or dedupe key"),
    });
  });

  it("rejects foreign-org account references before persistence", async () => {
    dbMocks.selectQueue = [[]];
    dbMocks.insertReturningQueue = [[{ id: "should-not-insert" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          actor: { accountId: "foreign-account-id" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad account"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects external Meta account IDs that mismatch org-owned accounts", async () => {
    enqueueEligibleDestination();
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          actor: { accountId: "account-1", accountMetaId: "act_foreign" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Meta ID does not match"),
    });
  });

  it("rejects external Meta ad set IDs that mismatch org-owned ad sets", async () => {
    enqueueEligibleDestination();
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun(
        baseCreateValidationInput({
          destination: { adSetId: "ad-set-1", adSetMetaId: "238_foreign" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Meta ID does not match"),
    });
  });
});

describe("launchpad run detail", () => {
  it("returns item local ad linkage and raw Meta status shadow fields without token disclosure", async () => {
    const run = persistedValidatedRun({
      status: "success",
      requestedByUserId: "user-1",
      requestedByPrincipalType: "session",
      requestedByRole: "admin",
    });
    const item = persistedValidatedItem({
      status: "success",
      localAdId: "local-ad-1",
      externalMetaCreativeId: "23800000000000111",
      externalMetaAdId: "23800000000000000",
      rawMetaConfiguredStatus: "PAUSED",
      rawMetaEffectiveStatus: "IN_PROCESS",
      reconciliationStatus: "reconciled",
    });
    dbMocks.selectQueue = [
      [run],
      [
        {
          item,
          localAd: {
            id: "local-ad-1",
            name: "Launchpad router demo",
            status: "paused",
            metaId: "23800000000000000",
            metaVideoId: null,
            destinationUrl:
              "https://example.com/products?utm_source=meta&utm_medium=paid_social",
            rawMetaConfiguredStatus: "PAUSED",
            rawMetaEffectiveStatus: "IN_PROCESS",
          },
        },
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.getById({ id: "run-1" });

    expect(result.run).toMatchObject({
      id: "run-1",
      status: "success",
      destinationAdSetMetaId: "23800000000000000",
      requestedByPrincipalType: "session",
      requestedByRole: "admin",
    });
    expect(result.items[0]).toMatchObject({
      id: "item-1",
      status: "success",
      localAdId: "local-ad-1",
      externalMetaAdId: "23800000000000000",
      rawMetaConfiguredStatus: "PAUSED",
      rawMetaEffectiveStatus: "IN_PROCESS",
      localAd: {
        id: "local-ad-1",
        status: "paused",
        metaId: "23800000000000000",
        rawMetaConfiguredStatus: "PAUSED",
        rawMetaEffectiveStatus: "IN_PROCESS",
      },
    });
    expect(JSON.stringify(result)).not.toContain("metaAccessToken");
  });
});

function jsonResponse(body: unknown, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function enqueueWorkerPublishRows(options: {
  run?: Record<string, unknown>;
  item?: Record<string, unknown>;
} = {}) {
  dbMocks.selectQueue = [
    [persistedQueuedRun(options.run)],
    [persistedQueuedItem(options.item)],
    [eligibleAccount()],
    [eligibleAdSet()],
    [{ metaAccessToken: "secret-token" }],
  ];
  dbMocks.insertReturningQueue = [[{ id: "local-ad-1" }]];
}

function enqueueVideoWorkerPublishRows(options: {
  run?: Record<string, unknown>;
  item?: Record<string, unknown>;
} = {}) {
  dbMocks.selectQueue = [
    [persistedQueuedVideoRun(options.run)],
    [persistedQueuedVideoItem(options.item)],
    [eligibleAccount()],
    [eligibleAdSet()],
    [{ metaAccessToken: "secret-token" }],
  ];
  dbMocks.insertReturningQueue = [[{ id: "local-ad-video-1" }]];
}

describe("launchpad live publish enqueue", () => {
  it("enqueues one validated run through Trigger and persists queued intent", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [
      [persistedValidatedRun()],
      [persistedValidatedItem()],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.requestLivePublish({
      runId: "run-1",
      confirmation: "PUBLISH_PAUSED_META_ADS",
    });

    expect(result).toEqual({
      runId: "run-1",
      itemIds: ["item-1"],
      triggerRunId: "trigger-run-1",
      status: "queued",
    });
    expect(triggerMocks.trigger).toHaveBeenCalledWith("launchpad-publish", {
      organizationId: "test-org-id",
      runId: "run-1",
      itemIds: ["item-1"],
      requestedStatus: "PAUSED",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "queued", mode: "publish" }),
        expect.objectContaining({ status: "queued" }),
        expect.objectContaining({ externalTriggerRunId: "trigger-run-1" }),
      ]),
    );
  });

  it("enqueues all validated batch items through Trigger and persists queued intent", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const { run, items } = persistedBatchRunAndItems();
    dbMocks.selectQueue = [
      [run],
      items,
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.requestLivePublish({
      runId: "run-1",
      confirmation: "PUBLISH_PAUSED_META_ADS",
    });

    expect(result).toEqual({
      runId: "run-1",
      itemIds: ["item-1", "item-2"],
      triggerRunId: "trigger-run-1",
      status: "queued",
    });
    expect(triggerMocks.trigger).toHaveBeenCalledWith("launchpad-publish", {
      organizationId: "test-org-id",
      runId: "run-1",
      itemIds: ["item-1", "item-2"],
      requestedStatus: "PAUSED",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "queued", mode: "publish" }),
        expect.objectContaining({ status: "queued" }),
        expect.objectContaining({ externalTriggerRunId: "trigger-run-1" }),
      ]),
    );
  });

  it("enqueues mixed static and video items without rejecting supported video payloads", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const staticItem = persistedValidatedItem({ id: "item-1", position: 1 });
    const videoItem = persistedVideoItem({ id: "item-2", position: 2 });
    dbMocks.selectQueue = [
      [persistedValidatedRun({ itemCount: 2 })],
      [staticItem, videoItem],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.requestLivePublish({
      runId: "run-1",
      confirmation: "PUBLISH_PAUSED_META_ADS",
    });

    expect(result).toMatchObject({
      runId: "run-1",
      itemIds: ["item-1", "item-2"],
      status: "queued",
    });
    expect(triggerMocks.trigger).toHaveBeenCalledWith("launchpad-publish", {
      organizationId: "test-org-id",
      runId: "run-1",
      itemIds: ["item-1", "item-2"],
      requestedStatus: "PAUSED",
    });
  });

  it("sanitizes Trigger enqueue errors before persisting failure details", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    triggerMocks.trigger.mockRejectedValueOnce(
      new Error("ADSOLUTE_WORKER_SECRET=super-secret failed to enqueue"),
    );
    dbMocks.selectQueue = [
      [persistedValidatedRun()],
      [persistedValidatedItem()],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Launchpad publish task could not be enqueued",
    });
    const serializedUpdates = JSON.stringify(dbMocks.updateValues);
    expect(serializedUpdates).not.toContain("super-secret");
    expect(serializedUpdates).not.toContain("ADSOLUTE_WORKER_SECRET");
  });

  it("rejects validation-failed runs before enqueue", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [[
      persistedValidatedRun({ status: "failed", validatedAt: null }),
    ]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("previously validated"),
    });
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });

  it("enforces PAUSED-only requested status from the persisted run", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [[persistedValidatedRun({ requestedStatus: "ACTIVE" })]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("PAUSED"),
    });
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });

  it("rejects live publish when the persisted destination is no longer eligible", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [
      [persistedValidatedRun()],
      [persistedValidatedItem()],
      [eligibleAccount({ metaAccessToken: null })],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("access token"),
    });
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
  });
});

describe("launchpad retry and reconciliation", () => {
  it("reconciles saved Meta IDs and retries only failed retryable items", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const run = persistedValidatedRun({
      status: "partial_success",
      mode: "publish",
      itemCount: 4,
      reconciliationStatus: "pending",
    });
    const successItem = persistedValidatedItem({
      id: "item-1",
      position: 1,
      status: "success",
      localAdId: "local-ad-1",
      externalMetaCreativeId: "meta-creative-1",
      externalMetaAdId: "meta-ad-1",
      rawMetaConfiguredStatus: "PAUSED",
      rawMetaEffectiveStatus: "PAUSED",
      reconciliationStatus: "reconciled",
    });
    const retryableItem = persistedValidatedItem({
      id: "item-2",
      position: 2,
      status: "failed",
      errorCategory: "retryable",
      errorCode: "META_RATE_LIMIT",
      errorMessage: "Meta API rate limit reached while publishing Launchpad item",
      reconciliationStatus: "pending",
      completedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    const terminalItem = persistedValidatedItem({
      id: "item-3",
      position: 3,
      status: "failed",
      errorCategory: "terminal",
      errorCode: "META_AUTH_ERROR",
      errorMessage: "Meta authorization failed",
      reconciliationStatus: "not_required",
      completedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    const savedMetaItem = persistedValidatedItem({
      id: "item-4",
      position: 4,
      status: "failed",
      errorCategory: "retryable",
      errorCode: "META_RECONCILIATION_AMBIGUOUS",
      errorMessage: "Created Meta ad could not be reconciled after publishing",
      localAdId: "local-ad-4",
      externalMetaImageHash: "meta-image-hash-4",
      externalMetaCreativeId: "meta-creative-4",
      externalMetaAdId: "meta-ad-4",
      reconciliationStatus: "manual_intervention",
      completedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    dbMocks.selectQueue = [
      [run],
      [successItem, retryableItem, terminalItem, savedMetaItem],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
      [
        { status: "success" },
        { status: "failed" },
        { status: "failed" },
        { status: "success" },
      ],
      [
        successItem,
        retryableItem,
        terminalItem,
        { ...savedMetaItem, status: "success", errorCategory: null, errorCode: null },
      ],
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: "meta-ad-4",
        adset_id: "23800000000000000",
        creative: { id: "meta-creative-4" },
        configured_status: "PAUSED",
        effective_status: "PAUSED",
      }),
    );
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.retryFailedItems({
      runId: "run-1",
      confirmation: "RETRY_FAILED_LAUNCHPAD_ITEMS",
    });

    expect(result).toMatchObject({
      runId: "run-1",
      itemIds: ["item-2"],
      skippedItemIds: ["item-1", "item-3", "item-4"],
      reconciledItemIds: ["item-4"],
      triggerRunId: "trigger-run-1",
      status: "queued",
      queued: true,
    });
    expect(triggerMocks.trigger).toHaveBeenCalledWith("launchpad-publish", {
      organizationId: "test-org-id",
      runId: "run-1",
      itemIds: ["item-2"],
      requestedStatus: "PAUSED",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reconciliationStatus: "checking" }),
        expect.objectContaining({ status: "success", externalMetaAdId: "meta-ad-4" }),
        expect.objectContaining({
          status: "queued",
          mode: "publish",
          completedAt: null,
          lastRetryRequestedByUserId: "test-user-id",
        }),
        expect.objectContaining({
          status: "queued",
          errorCategory: null,
          lastRetryRequestedByUserId: "test-user-id",
        }),
      ]),
    );
    expect(dbMocks.updateValues.flatMap((value) => Object.keys(value as object))).not.toContain("manifest");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("moves unresolved ambiguous items without Meta IDs to manual intervention instead of retrying", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const run = persistedValidatedRun({
      status: "ambiguous",
      mode: "publish",
      reconciliationStatus: "manual_intervention",
    });
    const ambiguousItem = persistedValidatedItem({
      status: "ambiguous",
      errorCategory: "ambiguous",
      errorCode: "META_AD_CREATE_AMBIGUOUS",
      errorMessage: "Meta ad creation needs reconciliation before retry",
      reconciliationStatus: "manual_intervention",
      manualInterventionReason: "Meta ad creation failed after the /ads request was sent",
      completedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    dbMocks.selectQueue = [
      [run],
      [ambiguousItem],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
      [{ status: "manual_intervention" }],
      [{ ...ambiguousItem, status: "manual_intervention", errorCategory: "manual_intervention" }],
      [{ status: "manual_intervention" }],
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.retryFailedItems({
      runId: "run-1",
      confirmation: "RETRY_FAILED_LAUNCHPAD_ITEMS",
    });

    expect(result).toMatchObject({
      itemIds: [],
      manualInterventionItemIds: ["item-1"],
      queued: false,
      status: "manual_intervention",
    });
    expect(triggerMocks.trigger).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "manual_intervention",
          errorCategory: "manual_intervention",
          errorCode: "META_AD_CREATE_UNRESOLVED",
        }),
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("allows authorized users to move stuck items to manual intervention", async () => {
    const run = persistedQueuedRun({ itemCount: 1, status: "publishing" });
    const item = persistedQueuedItem({ status: "publishing" });
    dbMocks.selectQueue = [
      [run],
      [item],
      [{ status: "manual_intervention" }],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.markItemManualIntervention({
      runId: "run-1",
      itemId: "item-1",
      reason: "Operator confirmed this worker run is stuck",
    });

    expect(result).toMatchObject({
      status: "manual_intervention",
      runStatus: "manual_intervention",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "manual_intervention",
          errorCategory: "manual_intervention",
          errorCode: "MANUAL_INTERVENTION_MARKED",
          manualInterventionReason: "Operator confirmed this worker run is stuck",
        }),
      ]),
    );
  });
});

describe("launchpad worker media publish", () => {
  it("creates a local paused ad, publishes one paused Meta ad, persists IDs, and stores raw statuses separately", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          expect(init?.method).toBe("POST");
          return jsonResponse({
            images: {
              "https://cdn.example.com/router-static.png": {
                hash: "meta-image-hash-1",
              },
            },
          });
        }
        if (url.includes("/adcreatives")) {
          expect(init?.method).toBe("POST");
          return jsonResponse({ id: "meta-creative-1" });
        }
        if (url.includes("/ads")) {
          expect(init?.method).toBe("POST");
          const body = init?.body as URLSearchParams;
          expect(body.get("status")).toBe("PAUSED");
          return jsonResponse({ id: "meta-ad-1" });
        }
        if (url.includes("/meta-ad-1")) {
          return jsonResponse({
            id: "meta-ad-1",
            adset_id: "23800000000000000",
            creative: { id: "meta-creative-1" },
            configured_status: "PAUSED",
            effective_status: "PAUSED",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "success",
      replayed: false,
      localAdId: "local-ad-1",
      metaImageHash: "meta-image-hash-1",
      metaCreativeId: "meta-creative-1",
      metaAdId: "meta-ad-1",
      rawMetaConfiguredStatus: "PAUSED",
      rawMetaEffectiveStatus: "PAUSED",
    });
    expect(dbMocks.insertValues[0]).toMatchObject({
      organizationId: "test-org-id",
      status: "paused",
      adSetId: "ad-set-1",
      adCreativeId: "creative-1",
      accountId: "account-1",
      destinationUrl: "https://example.com/products?utm_source=meta&utm_medium=paid_social",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalMetaImageHash: "meta-image-hash-1",
          externalMetaCreativeId: "meta-creative-1",
          externalMetaAdId: "meta-ad-1",
          rawMetaConfiguredStatus: "PAUSED",
          rawMetaEffectiveStatus: "PAUSED",
        }),
        expect.objectContaining({
          metaImageHash: "meta-image-hash-1",
          metaCreativeId: "meta-creative-1",
          metaId: "meta-ad-1",
          rawMetaConfiguredStatus: "PAUSED",
          rawMetaEffectiveStatus: "PAUSED",
          status: "paused",
        }),
        expect.objectContaining({
          status: "success",
          reconciliationStatus: "reconciled",
        }),
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("uploads one video asset, creates a video creative and paused Meta ad, then persists video linkage", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueVideoWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/advideos")) {
          expect(init?.method).toBe("POST");
          const body = init?.body as URLSearchParams;
          expect(body.get("file_url")).toBe("https://cdn.example.com/router-video.mp4");
          expect(body.get("name")).toBe("Launchpad router UGC demo / Video");
          return jsonResponse({ id: "meta-video-1" });
        }
        if (url.includes("/adcreatives")) {
          expect(init?.method).toBe("POST");
          const body = init?.body as URLSearchParams;
          const objectStorySpec = JSON.parse(body.get("object_story_spec") ?? "{}");
          expect(objectStorySpec).toMatchObject({
            page_id: "page-123",
            instagram_actor_id: "ig-123",
            video_data: {
              video_id: "meta-video-1",
              link: "https://example.com/video?utm_source=meta&utm_medium=paid_social",
              image_url: "https://cdn.example.com/router-video-thumb.jpg",
              message: "Router UGC launch copy",
              title: "UGC hook fallback",
              call_to_action: {
                type: "SHOP_NOW",
                value: {
                  link: "https://example.com/video?utm_source=meta&utm_medium=paid_social",
                },
              },
            },
          });
          expect(JSON.stringify(objectStorySpec)).not.toContain("image_hash");
          return jsonResponse({ id: "meta-creative-video-1" });
        }
        if (url.includes("/ads")) {
          expect(init?.method).toBe("POST");
          const body = init?.body as URLSearchParams;
          expect(body.get("status")).toBe("PAUSED");
          expect(body.get("creative")).toBe(JSON.stringify({ creative_id: "meta-creative-video-1" }));
          return jsonResponse({ id: "meta-ad-video-1" });
        }
        if (url.includes("/meta-ad-video-1")) {
          return jsonResponse({
            id: "meta-ad-video-1",
            adset_id: "23800000000000000",
            creative: { id: "meta-creative-video-1" },
            configured_status: "PAUSED",
            effective_status: "PAUSED",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "success",
      replayed: false,
      localAdId: "local-ad-video-1",
      metaImageHash: null,
      metaVideoId: "meta-video-1",
      metaCreativeId: "meta-creative-video-1",
      metaAdId: "meta-ad-video-1",
      rawMetaConfiguredStatus: "PAUSED",
      rawMetaEffectiveStatus: "PAUSED",
    });
    expect(dbMocks.insertValues[0]).toMatchObject({
      organizationId: "test-org-id",
      status: "paused",
      adSetId: "ad-set-1",
      adCreativeId: "creative-video-1",
      accountId: "account-1",
      destinationUrl: "https://example.com/video?utm_source=meta&utm_medium=paid_social",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalMetaVideoId: "meta-video-1",
          externalMetaCreativeId: "meta-creative-video-1",
          externalMetaAdId: "meta-ad-video-1",
          rawMetaConfiguredStatus: "PAUSED",
          rawMetaEffectiveStatus: "PAUSED",
        }),
        expect.objectContaining({
          metaVideoId: "meta-video-1",
          metaCreativeId: "meta-creative-video-1",
          metaId: "meta-ad-video-1",
          rawMetaConfiguredStatus: "PAUSED",
          rawMetaEffectiveStatus: "PAUSED",
          status: "paused",
        }),
        expect.objectContaining({ status: "success", reconciliationStatus: "reconciled" }),
      ]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    fetchSpy.mockRestore();
  });

  it("returns saved success on Trigger replay without duplicate local ads or Meta calls", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [
      [persistedQueuedRun({ status: "success" })],
      [
        persistedQueuedItem({
          status: "success",
          localAdId: "local-ad-1",
          externalMetaImageHash: "meta-image-hash-1",
          externalMetaCreativeId: "meta-creative-1",
          externalMetaAdId: "meta-ad-1",
          rawMetaConfiguredStatus: "PAUSED",
          rawMetaEffectiveStatus: "PAUSED",
        }),
      ],
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({ status: "success", replayed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbMocks.insertValues).toEqual([]);
    expect(dbMocks.updateValues).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("keeps a batch processable when one item becomes ambiguous and later items remain queued", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const { run, items } = persistedBatchRunAndItems();
    dbMocks.selectQueue = [
      [persistedQueuedRun({ ...run, status: "queued", itemCount: 2 })],
      [persistedQueuedItem({ ...items[0], id: "item-1", status: "queued" })],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
      [{ status: "ambiguous" }, { status: "queued" }],
    ];
    dbMocks.insertReturningQueue = [[{ id: "local-ad-1" }]];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          return jsonResponse({
            images: {
              "https://cdn.example.com/router-static.png": {
                hash: "meta-image-hash-1",
              },
            },
          });
        }
        if (url.includes("/adcreatives")) return jsonResponse({ id: "meta-creative-1" });
        if (url.includes("/ads")) return jsonResponse({ id: "meta-ad-1" });
        if (url.includes("/meta-ad-1")) {
          return jsonResponse({
            id: "meta-ad-1",
            adset_id: "23800000000000000",
            creative: { id: "meta-creative-1" },
            configured_status: "ACTIVE",
            effective_status: "ACTIVE",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      runStatus: "publishing",
      errorCode: "META_RECONCILIATION_FAILED",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "ambiguous", errorCode: "META_RECONCILIATION_FAILED" }),
        expect.objectContaining({ status: "publishing", errorCode: "META_RECONCILIATION_FAILED" }),
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("skips an already-successful batch item on replay even when the run is partial", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const { run, items } = persistedBatchRunAndItems();
    dbMocks.selectQueue = [
      [persistedQueuedRun({
        ...run,
        status: "partial_success",
        itemCount: 2,
      })],
      [persistedQueuedItem({
        ...items[0],
        status: "success",
        localAdId: "local-ad-1",
        externalMetaImageHash: "meta-image-hash-1",
        externalMetaCreativeId: "meta-creative-1",
        externalMetaAdId: "meta-ad-1",
        rawMetaConfiguredStatus: "PAUSED",
        rawMetaEffectiveStatus: "PAUSED",
      })],
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "success",
      runStatus: "partial_success",
      replayed: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbMocks.insertValues).toEqual([]);
    expect(dbMocks.updateValues).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("aggregates a batch item failure into partial success without touching successful items", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const { run, items } = persistedBatchRunAndItems();
    dbMocks.selectQueue = [
      [persistedQueuedRun({ ...run, status: "queued", itemCount: 2 })],
      [persistedQueuedItem({ ...items[1], id: "item-2", status: "queued" })],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
      [{ status: "success" }, { status: "failed" }],
    ];
    dbMocks.insertReturningQueue = [[{ id: "local-ad-2" }]];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "Server error" } }, 500, "Server Error"),
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-2",
    });

    expect(result).toMatchObject({
      status: "failed",
      runStatus: "partial_success",
      errorCategory: "retryable",
      errorCode: "META_SERVER_ERROR",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", errorCode: "META_SERVER_ERROR" }),
        expect.objectContaining({ status: "partial_success", errorCode: "META_SERVER_ERROR" }),
      ]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("classifies Meta OAuth errors as terminal publish failures", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { error: { type: "OAuthException", message: "Invalid token" } },
        401,
        "Unauthorized",
      ),
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCategory: "terminal",
      errorCode: "META_AUTH_ERROR",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          errorCategory: "terminal",
          errorCode: "META_AUTH_ERROR",
          reconciliationStatus: "not_required",
        }),
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("retries a queued failed item without duplicating its existing local paused ad", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    const { run, items } = persistedBatchRunAndItems();
    dbMocks.selectQueue = [
      [persistedQueuedRun({ ...run, status: "queued", itemCount: 2 })],
      [persistedQueuedItem({
        ...items[1],
        id: "item-2",
        status: "queued",
        localAdId: "local-ad-2",
        errorCategory: null,
        errorCode: null,
      })],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
      [{ status: "failed" }, { status: "success" }],
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          return jsonResponse({ images: { "https://cdn.example.com/router-static-2.png": { hash: "meta-image-hash-2" } } });
        }
        if (url.includes("/adcreatives")) return jsonResponse({ id: "meta-creative-2" });
        if (url.includes("/ads")) {
          const body = init?.body as URLSearchParams;
          expect(body.get("status")).toBe("PAUSED");
          return jsonResponse({ id: "meta-ad-2" });
        }
        if (url.includes("/meta-ad-2")) {
          return jsonResponse({
            id: "meta-ad-2",
            adset_id: "23800000000000000",
            creative: { id: "meta-creative-2" },
            configured_status: "PAUSED",
            effective_status: "PAUSED",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-2",
    });

    expect(result).toMatchObject({
      status: "success",
      runStatus: "partial_success",
      localAdId: "local-ad-2",
      metaAdId: "meta-ad-2",
    });
    expect(dbMocks.insertValues).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    fetchSpy.mockRestore();
  });

  it("retries a video item with a saved Meta video ID without uploading a duplicate video", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    dbMocks.selectQueue = [
      [persistedQueuedVideoRun({ status: "queued" })],
      [persistedQueuedVideoItem({
        status: "queued",
        localAdId: "local-ad-video-1",
        externalMetaVideoId: "meta-video-saved",
        errorCategory: null,
        errorCode: null,
      })],
      [eligibleAccount()],
      [eligibleAdSet()],
      [{ metaAccessToken: "secret-token" }],
      [{ status: "success" }],
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/advideos")) throw new Error("duplicate video upload");
        if (url.includes("/adcreatives")) {
          const body = init?.body as URLSearchParams;
          const objectStorySpec = JSON.parse(body.get("object_story_spec") ?? "{}");
          expect(objectStorySpec.video_data.video_id).toBe("meta-video-saved");
          return jsonResponse({ id: "meta-creative-video-retry" });
        }
        if (url.includes("/ads")) return jsonResponse({ id: "meta-ad-video-retry" });
        if (url.includes("/meta-ad-video-retry")) {
          return jsonResponse({
            id: "meta-ad-video-retry",
            adset_id: "23800000000000000",
            creative: { id: "meta-creative-video-retry" },
            configured_status: "PAUSED",
            effective_status: "PAUSED",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "success",
      metaVideoId: "meta-video-saved",
      metaCreativeId: "meta-creative-video-retry",
      metaAdId: "meta-ad-video-retry",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(dbMocks.insertValues).toEqual([]);
    fetchSpy.mockRestore();
  });

  it.each([
    { status: 429, body: { error: { message: "Rate limited" } }, code: "META_RATE_LIMIT" },
    { status: 500, body: { error: { message: "Server error" } }, code: "META_SERVER_ERROR" },
  ])("classifies Meta HTTP $status as a retryable publish failure", async ({ status, body, code }) => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(body, status, status === 429 ? "Too Many Requests" : "Server Error"),
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCategory: "retryable",
      errorCode: code,
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          errorCategory: "retryable",
          errorCode: code,
        }),
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("classifies Meta timeouts as retryable publish failures", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const timeout = new Error("request timed out");
    timeout.name = "AbortError";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCategory: "retryable",
      errorCode: "META_TIMEOUT",
    });
    fetchSpy.mockRestore();
  });

  it("classifies Meta video upload failures through the existing retryable taxonomy", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueVideoWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "Video upload temporarily failed" } }, 500, "Server Error"),
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCategory: "retryable",
      errorCode: "META_SERVER_ERROR",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(dbMocks.updateValues)).not.toContain("secret-token");
    fetchSpy.mockRestore();
  });

  it("classifies Meta video processing rejections as retryable without duplicating uploaded video IDs", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueVideoWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/advideos")) return jsonResponse({ id: "meta-video-processing" });
        if (url.includes("/adcreatives")) {
          return jsonResponse(
            { error: { message: "Video is still processing, please try again" } },
            400,
            "Bad Request",
          );
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCategory: "retryable",
      errorCode: "META_VIDEO_PROCESSING",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalMetaVideoId: "meta-video-processing" }),
        expect.objectContaining({
          status: "failed",
          errorCategory: "retryable",
          errorCode: "META_VIDEO_PROCESSING",
        }),
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("treats uncertain Meta ad creation network failures as ambiguous to prevent duplicate retries", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const networkError = new Error("socket hang up after /ads request");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          return jsonResponse({
            images: {
              "https://cdn.example.com/router-static.png": {
                hash: "meta-image-hash-1",
              },
            },
          });
        }
        if (url.includes("/adcreatives")) return jsonResponse({ id: "meta-creative-1" });
        if (url.includes("/ads")) throw networkError;
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      runStatus: "ambiguous",
      errorCategory: "ambiguous",
      errorCode: "META_AD_CREATE_AMBIGUOUS",
    });
    fetchSpy.mockRestore();
  });

  it("treats uncertain Meta ad creation server failures as ambiguous to prevent duplicate retries", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          return jsonResponse({
            images: {
              "https://cdn.example.com/router-static.png": {
                hash: "meta-image-hash-1",
              },
            },
          });
        }
        if (url.includes("/adcreatives")) return jsonResponse({ id: "meta-creative-1" });
        if (url.includes("/ads")) {
          return jsonResponse({ error: { message: "Server error" } }, 500, "Server Error");
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      runStatus: "ambiguous",
      errorCategory: "ambiguous",
      errorCode: "META_AD_CREATE_AMBIGUOUS",
    });
    fetchSpy.mockRestore();
  });

  it("records an ambiguous reconciliation failure when the created Meta ad omits required linkage fields", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          return jsonResponse({
            images: {
              "https://cdn.example.com/router-static.png": {
                hash: "meta-image-hash-1",
              },
            },
          });
        }
        if (url.includes("/adcreatives")) return jsonResponse({ id: "meta-creative-1" });
        if (url.includes("/ads")) return jsonResponse({ id: "meta-ad-1" });
        if (url.includes("/meta-ad-1")) {
          return jsonResponse({
            id: "meta-ad-1",
            configured_status: "PAUSED",
            effective_status: "PAUSED",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      errorCategory: "ambiguous",
      errorCode: "META_RECONCILIATION_FAILED",
    });
    expect(JSON.stringify(dbMocks.updateValues)).toContain("ad_set_missing");
    expect(JSON.stringify(dbMocks.updateValues)).toContain("creative_missing");
    fetchSpy.mockRestore();
  });

  it("records an ambiguous reconciliation failure when the created Meta ad is not safely paused", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "true";
    enqueueWorkerPublishRows();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/adimages")) {
          return jsonResponse({
            images: {
              "https://cdn.example.com/router-static.png": {
                hash: "meta-image-hash-1",
              },
            },
          });
        }
        if (url.includes("/adcreatives")) return jsonResponse({ id: "meta-creative-1" });
        if (url.includes("/ads")) return jsonResponse({ id: "meta-ad-1" });
        if (url.includes("/meta-ad-1")) {
          return jsonResponse({
            id: "meta-ad-1",
            adset_id: "23800000000000000",
            creative: { id: "meta-creative-1" },
            configured_status: "ACTIVE",
            effective_status: "ACTIVE",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const workerCaller = createWorkerCaller();

    const result = await workerCaller.launchpad.workerExecuteLivePublish({
      runId: "run-1",
      itemId: "item-1",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      errorCategory: "ambiguous",
      errorCode: "META_RECONCILIATION_FAILED",
    });
    expect(dbMocks.updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ambiguous",
          reconciliationStatus: "mismatched",
          rawMetaConfiguredStatus: "ACTIVE",
          rawMetaEffectiveStatus: "ACTIVE",
        }),
      ]),
    );
    fetchSpy.mockRestore();
  });
});
