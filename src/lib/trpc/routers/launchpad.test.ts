import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaunchpadRunDraft } from "@/lib/launchpad-ledger";
import { ads } from "@/schema/ad";
import {
  createApiKeyCaller,
  createMockCaller,
} from "../test-helpers";

const dbMocks = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[][],
  updateReturningQueue: [] as unknown[][],
  insertValues: [] as unknown[],
  insertTables: [] as unknown[],
  updateValues: [] as unknown[],
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

function persistedValidatedRun(overrides: Record<string, unknown> = {}) {
  const draft = createLaunchpadRunDraft(baseRunInput());
  return {
    id: "run-1",
    organizationId: "test-org-id",
    status: "validated",
    requestedStatus: "PAUSED",
    itemCount: draft.items.length,
    maxItemCap: 25,
    manifest: draft.manifest,
    manifestHash: draft.manifestHash,
    manifestLockedAt: new Date("2026-01-01T00:00:00.000Z"),
    validatedAt: new Date("2026-01-01T00:00:00.000Z"),
    idempotencyKey: draft.idempotencyKey,
    dedupeKey: draft.dedupeKey,
    ...overrides,
  };
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
});

afterEach(() => {
  resetDbMocks();
  if (previousPublishFlag === undefined) {
    delete process.env.ADSOLUTE_META_PUBLISH_ENABLED;
  } else {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = previousPublishFlag;
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

describe("launchpad router safety", () => {
  it("blocks ordinary members from the Launchpad ledger surface", async () => {
    const memberCaller = createMockCaller({ role: "member" });

    await expect(memberCaller.launchpad.list()).rejects.toMatchObject({
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
  });

  it("blocks API keys from requesting live publishing", async () => {
    const apiKeyCaller = createApiKeyCaller();

    await expect(
      apiKeyCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
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

  it("persists item QA failures for unsupported creatives, invalid CTA, URL issues, and Meta ad conflicts", async () => {
    enqueueDryRunPlanningRows({
      creative: staticCreative({ format: "video", assetUrl: null }),
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
    expect(serializedRun).toEqual(expect.stringContaining("CREATIVE_ASSET_REQUIRED"));
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

  it("rejects idempotency-key replays with a different manifest", async () => {
    enqueueDryRunPlanningRows();
    dbMocks.selectQueue.push([
      {
        id: "existing-run",
        idempotencyKey: "router-idempotency-key",
        dedupeKey: "different-dedupe",
        manifestHash: "different-manifest-hash",
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

  it("reselects and returns an existing run after a dedupe conflict", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "false";
    const draft = createLaunchpadRunDraft(baseRunInput());
    const existing = {
      id: "existing-dedupe-run",
      idempotencyKey: "someone-elses-idempotency-key",
      dedupeKey: draft.dedupeKey,
      manifestHash: "older-order-or-audit-specific-manifest",
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
    ).resolves.toEqual(existing);
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
