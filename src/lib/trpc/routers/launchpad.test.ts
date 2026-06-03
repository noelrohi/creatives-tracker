import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaunchpadRunDraft } from "@/lib/launchpad-ledger";
import {
  createApiKeyCaller,
  createMockCaller,
} from "../test-helpers";

const dbMocks = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[][],
  insertValues: [] as unknown[],
}));

vi.mock("@/db", () => {
  function nextSelectRows() {
    return dbMocks.selectQueue.shift() ?? [];
  }

  function createSelectBuilder(rows: unknown[]) {
    const builder = {
      from: vi.fn(() => builder),
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

  const tx = {
    select: vi.fn(() => createSelectBuilder(nextSelectRows())),
    insert: vi.fn(() => createInsertBuilder()),
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
  dbMocks.insertValues = [];
}

function baseRunInput() {
  return {
    organizationId: "test-org-id",
    requestedBy: {
      userId: "test-user-id",
      principalType: "session" as const,
      orgRole: "admin" as const,
    },
    items: [
      {
        adName: "Launchpad router demo",
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

describe("launchpad router safety", () => {
  it("blocks ordinary members from the Launchpad ledger surface", async () => {
    const memberCaller = createMockCaller({ role: "member" });

    await expect(memberCaller.launchpad.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      memberCaller.launchpad.createValidationRun({
        idempotencyKey: "member-demo-key",
        items: [{ adName: "Member demo" }],
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

describe("launchpad router ledger persistence", () => {
  it("persists a validation run and items with audit metadata", async () => {
    dbMocks.selectQueue = [[], [], []];
    dbMocks.insertReturningQueue = [[{ id: "run-new" }], [{ id: "item-new" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    const result = await adminCaller.launchpad.createValidationRun({
      idempotencyKey: "router-idempotency-key",
      items: [
        {
          adName: "Router demo",
          destinationUrl:
            "https://example.com/products?utm_source=meta&utm_medium=paid_social",
        },
      ],
    });

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
    });
    expect(dbMocks.insertValues[0]).toHaveProperty("manifestHash");
    expect(dbMocks.insertValues[0]).toHaveProperty("dedupeKey");
    expect(dbMocks.insertValues[0]).toHaveProperty("idempotencyKey");
    expect(dbMocks.insertValues[1]).toEqual([
      expect.objectContaining({
        runId: "run-new",
        organizationId: "test-org-id",
        status: "validated",
        requestedStatus: "PAUSED",
        createdByUserId: "test-user-id",
        createdByPrincipalType: "session",
        createdByRole: "admin",
        reconciliationStatus: "not_required",
      }),
    ]);
  });

  it("rejects idempotency-key replays with a different manifest", async () => {
    dbMocks.insertReturningQueue = [[]];
    dbMocks.selectQueue = [
      [
        {
          id: "existing-run",
          idempotencyKey: "router-idempotency-key",
          dedupeKey: "different-dedupe",
          manifestHash: "different-manifest-hash",
        },
      ],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun({
        idempotencyKey: "router-idempotency-key",
        items: [{ adName: "Changed router demo" }],
      }),
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
    dbMocks.selectQueue = [[], [existing]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun({
        items: baseRunInput().items,
      }),
    ).resolves.toEqual(existing);
  });

  it("rejects item-level idempotency/dedupe conflicts before persistence", async () => {
    dbMocks.selectQueue = [
      [],
      [],
      [{ id: "existing-item", idempotencyKey: "item-key", dedupeKey: "dedupe" }],
    ];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun({
        items: [{ adName: "Item collision demo", idempotencyKey: "item-key" }],
      }),
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
      adminCaller.launchpad.createValidationRun({
        actor: { accountId: "foreign-account-id" },
        items: [{ adName: "Foreign account demo" }],
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad account"),
    });
    expect(dbMocks.insertValues).toEqual([]);
  });

  it("rejects external Meta account IDs that mismatch org-owned accounts", async () => {
    dbMocks.selectQueue = [[{ id: "account-1", metaAccountId: "act_owned" }]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun({
        actor: { accountId: "account-1", accountMetaId: "act_foreign" },
        items: [{ adName: "Meta mismatch demo" }],
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Meta ID does not match"),
    });
  });

  it("rejects external Meta ad set IDs that are not org-owned", async () => {
    dbMocks.selectQueue = [[]];
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.createValidationRun({
        destination: { adSetMetaId: "238_foreign" },
        items: [{ adName: "Foreign Meta ad set demo" }],
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Ad set"),
    });
  });
});
