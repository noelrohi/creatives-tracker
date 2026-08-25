import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";
import type { KlaviyoCompoundPage } from "@/lib/klaviyo/client";
import type { ConnectionRecord } from "@/lib/klaviyo/source-store";
import {
  nextEventCheckpoint,
  processEventSourceBatch,
  processOrderCoreBatch,
  startOrResumeConsentSync,
  startOrResumeOrderCoreSync,
  type EventRunRecord,
  type EventRunStore,
  type LockedEventRunOps,
  type RunningEventRun,
} from "@/lib/klaviyo/source-runner";
import {
  KLAVIYO_CONSENT_KINDS,
  consentSourceContract,
  inclusiveStoreDaysToHalfOpenUtc,
  initialEventCheckpoint,
  journeySourceContract,
  orderCoreSourceContract,
  type KlaviyoEventCheckpoint,
} from "@/lib/klaviyo/types";

const SOURCE_CONTRACT = orderCoreSourceContract();
const scope = {
  organizationId: "org-1",
  storeId: "store-1",
  connectionId: "connection-1",
};
const TEST_KEYRING = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE",
  IDENTITY_HMAC_KEY_VERSION: "v1",
});
const TEST_SUPPRESSION_KEY = parseErasureSuppressionKey({
  IDENTITY_ERASURE_HMAC_SECRET: "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M",
  IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
} as unknown as NodeJS.ProcessEnv);
const WINDOW_FROM = new Date("2026-05-02T04:00:00.000Z");
const WINDOW_TO = new Date("2026-07-30T04:00:00.000Z");

const connectionRecord: ConnectionRecord = {
  ...scope,
  shopDomain: "reviv.example.myshopify.com",
  storeTimezone: "America/New_York",
      accountTimezone: null,
  klaviyoAccountId: "account-reviv",
  initialSourceFrom: null,
  initialSourceTo: null,
  credentialReference: "reviv_environment",
  status: "ready",
};

const PLACED_METRIC = {
  metricRowId: "metric-row-placed",
  externalMetricId: "external-placed",
  metricKind: "placed_order" as const,
  approvedAliases: {
    orderId: "OrderId",
    uniqueEventId: "$event_id",
    productId: null,
    variantId: null,
    sku: null,
    productName: null,
    variantName: null,
    quantity: null,
    value: null,
    currency: null,
    items: null,
  },
};
const ORDERED_METRIC = {
  ...PLACED_METRIC,
  metricRowId: "metric-row-ordered",
  externalMetricId: "external-ordered",
  metricKind: "ordered_product" as const,
};

function eventResource(id: string, metricExternalId: string) {
  return {
    type: "event",
    id,
    attributes: {
      datetime: "2026-07-20T10:00:00.000Z",
      uuid: `uuid-${id}`,
      event_properties: {
        OrderId: "gid://shopify/Order/1001",
        $event_id: `provider-${id}`,
      },
    },
    relationships: {
      profile: { data: { type: "profile", id: "profile-1" } },
      metric: { data: { type: "metric", id: metricExternalId } },
    },
  };
}

function eventPage(input: {
  metricExternalId: string;
  eventIds: string[];
  nextCursor: string | null;
}): KlaviyoCompoundPage {
  return {
    data: input.eventIds.map((id) =>
      eventResource(id, input.metricExternalId),
    ),
    included: [],
    nextCursor: input.nextCursor,
    apiRevision: "2026-07-15",
  };
}

function makeRunnerDependencies(input: {
  persistedCheckpoint?: KlaviyoEventCheckpoint | null;
  requestParameters?: unknown;
  pages?: Map<string, KlaviyoCompoundPage[]>;
  commitCommitted?: boolean[];
  keyringError?: Error;
  wrongRelationshipMetricId?: string;
}) {
  const run: EventRunRecord = {
    status: "running",
    requestParameters: input.requestParameters ?? orderCoreSourceContract(),
    checkpoint:
      input.persistedCheckpoint === undefined
        ? initialEventCheckpoint()
        : input.persistedCheckpoint,
    requestedFrom: WINDOW_FROM,
    requestedTo: WINDOW_TO,
  };
  const pages =
    input.pages ??
    new Map([
      [
        "external-placed",
        [
          eventPage({
            metricExternalId:
              input.wrongRelationshipMetricId ?? "external-placed",
            eventIds: ["placed-1"],
            nextCursor: null,
          }),
        ],
      ],
      [
        "external-ordered",
        [
          eventPage({
            metricExternalId: "external-ordered",
            eventIds: ["ordered-1"],
            nextCursor: null,
          }),
        ],
      ],
    ]);
  const pageIndex = new Map<string, number>();
  const listEvents = vi.fn(
    async (request: {
      metricId: string;
      includeAttributions: boolean;
      includeProfileEmail: boolean;
    }): Promise<KlaviyoCompoundPage> => {
      const index = pageIndex.get(request.metricId) ?? 0;
      const metricPages = pages.get(request.metricId) ?? [];
      const page = metricPages[index];
      if (!page) throw new Error("Event page fixture exhausted");
      pageIndex.set(request.metricId, index + 1);
      return page;
    },
  );
  const createClient = vi.fn(() => ({ listEvents }));
  const commitResults = [...(input.commitCommitted ?? [])];
  const commitPage = vi.fn(
    async (commit: { events: Array<{ metricId: string }> }) => {
      const committed = commitResults.length > 0 ? commitResults.shift()! : true;
      return {
        committed: committed as true,
        inserted: committed ? commit.events.length : 0,
        updated: 0,
        suppressed: 0,
      };
    },
  );
  const finishRun = vi.fn(async () => undefined);
  const renewHeartbeat = vi
    .fn<(request: unknown) => Promise<{ changed: true }>>()
    .mockResolvedValue({ changed: true });
  const services = {
    createClient,
    credentialProvider: {
      getPilotBinding: vi.fn(async () => ({
        expectedAccountId: "account-reviv",
        shopDomain: "reviv.example.myshopify.com",
        allowedUrlHosts: ["reviv.example.myshopify.com"],
      })),
      resolve: vi.fn(async () => ({
        privateApiKey: "pk_secret",
        reference: "reviv_environment" as const,
        expectedAccountId: "account-reviv",
        allowedUrlHosts: ["reviv.example.myshopify.com"],
      })),
    },
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    loadIdentityKeyring: vi.fn(() => {
      if (input.keyringError) throw input.keyringError;
      return TEST_KEYRING;
    }),
    loadSuppressionKey: vi.fn(() => TEST_SUPPRESSION_KEY),
    loadConnection: vi.fn(async () => connectionRecord),
    loadEnabledMetrics: vi.fn(async () => [PLACED_METRIC, ORDERED_METRIC] as [
      typeof PLACED_METRIC,
      typeof ORDERED_METRIC,
    ]),
    renewHeartbeat,
    commitPage,
    finishRun,
    loadEventRun: vi.fn(async () => run),
  };
  return { scope, run, createClient, listEvents, commitPage, finishRun, renewHeartbeat, services };
}

describe("nextEventCheckpoint", () => {
  it("advances a page cursor inside the current metric", () => {
    expect(
      nextEventCheckpoint(
        { ...SOURCE_CONTRACT, metricIndex: 0, cursor: null, page: 0 },
        "cursor-2",
      ),
    ).toEqual({
      ...SOURCE_CONTRACT,
      metricIndex: 0,
      cursor: "cursor-2",
      page: 1,
    });
  });

  it("moves to Ordered Product when Placed Order pagination ends", () => {
    expect(
      nextEventCheckpoint(
        { ...SOURCE_CONTRACT, metricIndex: 0, cursor: "cursor-2", page: 1 },
        null,
      ),
    ).toEqual({
      ...SOURCE_CONTRACT,
      metricIndex: 1,
      cursor: null,
      page: 0,
    });
  });

  it("marks completion after Ordered Product pagination ends", () => {
    expect(
      nextEventCheckpoint(
        { ...SOURCE_CONTRACT, metricIndex: 1, cursor: "cursor-9", page: 4 },
        null,
      ),
    ).toBeNull();
  });

  it("finishes a resumed run whose terminal null checkpoint was committed", async () => {
    const deps = makeRunnerDependencies({ persistedCheckpoint: null });
    await expect(
      processOrderCoreBatch(
        { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
        deps.services,
      ),
    ).resolves.toMatchObject({ done: true, pagesProcessed: 0 });
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        syncRunId: "run-1",
        operation: "events",
        status: "success",
      }),
    );
  });
});

describe("processOrderCoreBatch", () => {
  it("completes a two-metric run and keeps internal/external metric IDs apart", async () => {
    const deps = makeRunnerDependencies({});
    const result = await processOrderCoreBatch(
      { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
      deps.services,
    );
    expect(result).toEqual({
      done: true,
      pagesProcessed: 2,
      eventsRead: 2,
      checkpoint: null,
    });
    expect(deps.listEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metricId: "external-placed",
        includeAttributions: true,
        includeProfileEmail: true,
      }),
    );
    expect(deps.listEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ metricId: "external-ordered" }),
    );
    const [firstCommit, secondCommit] = deps.commitPage.mock.calls.map(
      ([call]) =>
        call as unknown as {
          events: Array<{ metricId: string; metricKind: string }>;
        },
    );
    expect(firstCommit.events.map((event) => event.metricId)).toEqual([
      "metric-row-placed",
    ]);
    expect(secondCommit.events.map((event) => event.metricId)).toEqual([
      "metric-row-ordered",
    ]);
    expect(deps.finishRun).toHaveBeenCalledTimes(1);
    // The entry heartbeat renews before the first remote request.
    expect(
      deps.renewHeartbeat.mock.invocationCallOrder[0]!,
    ).toBeLessThan(deps.listEvents.mock.invocationCallOrder[0]!);
  });

  it("stops without advancing when a replayed checkpoint returns committed false", async () => {
    const deps = makeRunnerDependencies({ commitCommitted: [false] });
    const result = await processOrderCoreBatch(
      { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
      deps.services,
    );
    expect(result).toEqual({
      done: false,
      pagesProcessed: 0,
      eventsRead: 0,
      checkpoint: initialEventCheckpoint(),
    });
    expect(deps.finishRun).not.toHaveBeenCalled();
    expect(deps.listEvents).toHaveBeenCalledTimes(1);
  });

  it("fails before fetch when the persisted contract or checkpoint is wrong", async () => {
    const journey = makeRunnerDependencies({
      requestParameters: {
        sourceMode: "journey",
        metricKinds: ["placed_order"],
      },
    });
    await expect(
      processOrderCoreBatch(
        { scope: journey.scope, syncRunId: "run-1", maxPages: 5 },
        journey.services,
      ),
    ).rejects.toThrow("invalid source contract");
    expect(journey.createClient).not.toHaveBeenCalled();
    expect(journey.commitPage).not.toHaveBeenCalled();

    const extraKey = makeRunnerDependencies({
      requestParameters: { ...orderCoreSourceContract(), unsafeExtra: true },
    });
    await expect(
      processOrderCoreBatch(
        { scope: extraKey.scope, syncRunId: "run-1", maxPages: 5 },
        extraKey.services,
      ),
    ).rejects.toThrow("not immutable order core");
    expect(extraKey.createClient).not.toHaveBeenCalled();

    const badCheckpoint = makeRunnerDependencies({
      persistedCheckpoint: {
        ...orderCoreSourceContract(),
        metricIndex: 7,
        cursor: null,
        page: 0,
      },
    });
    await expect(
      processOrderCoreBatch(
        { scope: badCheckpoint.scope, syncRunId: "run-1", maxPages: 5 },
        badCheckpoint.services,
      ),
    ).rejects.toThrow("does not match the run contract");
    expect(badCheckpoint.createClient).not.toHaveBeenCalled();
  });

  it("fails before persistence when the raw metric relationship differs", async () => {
    const deps = makeRunnerDependencies({
      wrongRelationshipMetricId: "metric-row-placed",
    });
    await expect(
      processOrderCoreBatch(
        { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
        deps.services,
      ),
    ).rejects.toThrow();
    expect(deps.commitPage).not.toHaveBeenCalled();
  });

  it("fails before any load or remote call when HMAC secrets are missing", async () => {
    const deps = makeRunnerDependencies({
      keyringError: new Error("IDENTITY_HMAC_SECRET is required"),
    });
    await expect(
      processOrderCoreBatch(
        { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
        deps.services,
      ),
    ).rejects.toThrow("IDENTITY_HMAC_SECRET is required");
    expect(deps.services.loadEventRun).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });
});

type StartState = {
  connection: {
    status: string;
    storeTimezone: string;
    initialSourceFrom: Date | null;
    initialSourceTo: Date | null;
  };
  passedProbe: boolean;
  running: RunningEventRun | null;
  inserted: Array<{ window: { from: Date; to: Date }; triggerType: string }>;
  persistedInitialWindows: Array<{ from: Date; to: Date }>;
  reaped: string[];
};

function makeStartStore(state: StartState): EventRunStore {
  return {
    async withConnectionLock(_scope, work) {
      const ops: LockedEventRunOps = {
        async getLockedConnection() {
          return { ...state.connection };
        },
        async hasPassedProbe() {
          return state.passedProbe;
        },
        async findRunningEventRun() {
          return state.running;
        },
        async failExpiredEventRun(syncRunId) {
          state.reaped.push(syncRunId);
          state.running = null;
          return { changed: true };
        },
        async persistInitialWindow(window) {
          state.persistedInitialWindows.push(window);
          state.connection.initialSourceFrom = window.from;
          state.connection.initialSourceTo = window.to;
        },
        async insertEventRun(input) {
          state.inserted.push(input);
          return { syncRunId: `run-${state.inserted.length}` };
        },
      };
      return work(ops);
    },
  };
}

describe("startOrResumeOrderCoreSync", () => {
  const NOW = new Date("2026-07-30T12:00:00.000Z");
  const TIMEZONE = "America/New_York";
  const allowed = inclusiveStoreDaysToHalfOpenUtc({
    dateFrom: "2026-05-02",
    dateTo: "2026-07-30",
    timeZone: TIMEZONE,
  });

  function startState(overrides: Partial<StartState> = {}): StartState {
    return {
      connection: {
        status: "ready",
        storeTimezone: TIMEZONE,
        initialSourceFrom: null,
        initialSourceTo: null,
      },
      passedProbe: true,
      running: null,
      inserted: [],
      persistedInitialWindows: [],
      reaped: [],
      ...overrides,
    };
  }

  const baseDeps = (state: StartState) => ({
    loadIdentityKeyring: vi.fn(() => TEST_KEYRING),
    loadSuppressionKey: vi.fn(() => TEST_SUPPRESSION_KEY),
    initializeGate: vi.fn(async () => ({ initialized: false })),
    now: () => NOW,
    runStore: makeStartStore(state),
  });

  it("accepts a first 90-store-day window and persists the fixed floor", async () => {
    const state = startState();
    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(state),
      ),
    ).resolves.toEqual({ syncRunId: "run-1", resumed: false });
    expect(state.persistedInitialWindows).toEqual([allowed]);
    expect(state.inserted[0].window).toEqual(allowed);
  });

  it("persists the full floor for a short first run and later extends back to it", async () => {
    const state = startState();
    const short = {
      from: new Date("2026-07-01T04:00:00.000Z"),
      to: allowed.to,
    };
    await startOrResumeOrderCoreSync(
      { scope, window: short, triggerType: "manual_backfill" },
      baseDeps(state),
    );
    expect(state.persistedInitialWindows).toEqual([allowed]);

    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(state),
      ),
    ).resolves.toEqual({ syncRunId: "run-2", resumed: false });
  });

  it("rejects pre-floor and future windows before any run insert", async () => {
    const preFloor = startState();
    await expect(
      startOrResumeOrderCoreSync(
        {
          scope,
          window: {
            from: new Date(allowed.from.getTime() - 24 * 60 * 60 * 1000),
            to: allowed.to,
          },
          triggerType: "manual_backfill",
        },
        baseDeps(preFloor),
      ),
    ).rejects.toThrow("90-store-day boundary");
    expect(preFloor.inserted).toHaveLength(0);

    const future = startState();
    await expect(
      startOrResumeOrderCoreSync(
        {
          scope,
          window: {
            from: allowed.from,
            to: new Date(allowed.to.getTime() + 24 * 60 * 60 * 1000),
          },
          triggerType: "manual_backfill",
        },
        baseDeps(future),
      ),
    ).rejects.toThrow("90-store-day boundary");
    expect(future.inserted).toHaveLength(0);
  });

  it("blocks an incremental from crossing the approved floor", async () => {
    const state = startState({
      connection: {
        status: "ready",
        storeTimezone: TIMEZONE,
        initialSourceFrom: allowed.from,
        initialSourceTo: allowed.to,
      },
    });
    await expect(
      startOrResumeOrderCoreSync(
        {
          scope,
          window: {
            from: new Date(allowed.from.getTime() - 1),
            to: allowed.to,
          },
          triggerType: "scheduled",
        },
        baseDeps(state),
      ),
    ).rejects.toThrow("cannot begin before the approved initial floor");
    expect(state.inserted).toHaveLength(0);
  });

  it("resumes an identical live run and rejects a different live window", async () => {
    const liveRun: RunningEventRun = {
      syncRunId: "run-live",
      requestedFrom: allowed.from,
      requestedTo: allowed.to,
      requestParameters: orderCoreSourceContract(),
      heartbeatAt: NOW,
    };
    const same = startState({ running: { ...liveRun } });
    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(same),
      ),
    ).resolves.toEqual({ syncRunId: "run-live", resumed: true });
    expect(same.inserted).toHaveLength(0);

    const different = startState({ running: { ...liveRun } });
    await expect(
      startOrResumeOrderCoreSync(
        {
          scope,
          window: {
            from: new Date("2026-07-01T04:00:00.000Z"),
            to: allowed.to,
          },
          triggerType: "manual_backfill",
        },
        baseDeps(different),
      ),
    ).rejects.toThrow("already running with a different window");
    expect(different.inserted).toHaveLength(0);
  });

  it("reaps an expired different-window run and inserts the replacement atomically", async () => {
    const state = startState({
      running: {
        syncRunId: "run-stale",
        requestedFrom: new Date("2026-07-01T04:00:00.000Z"),
        requestedTo: allowed.to,
        requestParameters: orderCoreSourceContract(),
        heartbeatAt: new Date(NOW.getTime() - 25 * 60 * 1000),
      },
    });
    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(state),
      ),
    ).resolves.toEqual({ syncRunId: "run-1", resumed: false });
    expect(state.reaped).toEqual(["run-stale"]);
  });

  it("requires a ready connection and a passed probe", async () => {
    const pending = startState();
    pending.connection.status = "pending";
    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(pending),
      ),
    ).rejects.toThrow("requires a ready connection");

    const unproven = startState({ passedProbe: false });
    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(unproven),
      ),
    ).rejects.toThrow("requires a passed probe report");
  });

  it("fails before any store interaction when HMAC secrets are missing", async () => {
    const state = startState();
    const runStore = makeStartStore(state);
    const withConnectionLock = vi.spyOn(runStore, "withConnectionLock");
    await expect(
      startOrResumeOrderCoreSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        {
          loadIdentityKeyring: () => {
            throw new Error("IDENTITY_HMAC_SECRET is required");
          },
          now: () => NOW,
          runStore,
        },
      ),
    ).rejects.toThrow("IDENTITY_HMAC_SECRET is required");
    expect(withConnectionLock).not.toHaveBeenCalled();
  });
});

describe("klaviyo source task boundary", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "trigger", "klaviyo-source-sync.ts"),
    "utf8",
  );

  it("exports discovery, probe, and order-core batch tasks with bounded duration", () => {
    for (const exported of [
      "export const klaviyoDiscoveryTask",
      "export const klaviyoProbeTask",
      "export const klaviyoOrderCoreBatchTask",
    ]) {
      expect(source).toContain(exported);
    }
    // Discovery and probe stay tight; the batch task carries headroom for
    // worst-case page cost (aborted attempts + full 429 waits per page).
    expect(source.match(/maxDuration: 600/g)).toHaveLength(2);
    expect(source.match(/maxDuration: 1_800/g)).toHaveLength(1);
    expect(source.match(/retry: KLAVIYO_TASK_RETRY/g)).toHaveLength(3);
    expect(source.match(/onFailure: async \(\{ payload \}\)/g)).toHaveLength(3);
  });

  it("routes every terminal hook through the fixed retry-exhaustion finalizer", () => {
    expect(source).toContain(
      'await finalizeExhaustedSourceRun(payload, "discovery");',
    );
    expect(source).toContain(
      'await finalizeExhaustedSourceRun(payload, "probe");',
    );
    expect(source).toContain(
      'await finalizeExhaustedSourceRun(payload, "events");',
    );
    expect(source).toContain("failKlaviyoSyncRunAfterRetryExhaustion({");
    // The fixed finalizer code is the only stored failure detail; the
    // Trigger/provider error object never reaches persistence.
    expect(source).not.toMatch(/failKlaviyoSyncRunAfterRetryExhaustion\([\s\S]{0,200}error/);
    expect(source).not.toMatch(/onFailure:[^}]*error\.message/);
  });

  it("accepts exactly one internal sync run ID per payload", () => {
    expect(source).toContain("type SourceBatchPayload = { syncRunId: string }");
    expect(source).toContain("Object.keys(input).length !== 1");
    expect(source.match(/assertExactSourceBatchPayload\(payload\);/g)).toHaveLength(3);
    // Payloads never carry authoritative scope; it is re-resolved from rows.
    expect(source).not.toContain("payload.organizationId");
    expect(source).not.toContain("payload.storeId");
    expect(source.match(/resolveTaskSyncRun\(payload\.syncRunId\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("hashes the persisted checkpoint into a global seven-day continuation key", () => {
    expect(source).toContain(
      "`klaviyo-${KEY_PREFIX[result.sourceMode]}:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`",
    );
    // The historical order-core prefix spelling survives the mode record;
    // rewording it would break idempotency continuity for in-flight runs.
    expect(source).toContain('order_core: "order-core"');
    expect(source).toContain('consent: "consent"');
    expect(source).toContain('{ scope: "global" }');
    expect(source).toContain('idempotencyKeyTTL: "7d"');
    expect(source).toContain('createHash("sha256")');
    // Provider cursors never enter task keys directly.
    expect(source).not.toMatch(/idempotencyKeys\.create\([^)]*cursor/);
  });
});

describe("processOrderCoreBatch identity flow", () => {
  it("passes server-resolved keys to normalization and leaks no plaintext email", async () => {
    const deps = makeRunnerDependencies({
      pages: new Map([
        [
          "external-placed",
          [
            {
              data: [
                {
                  ...eventResource("placed-identity", "external-placed"),
                  relationships: {
                    profile: {
                      data: { type: "profile", id: "profile-identity" },
                    },
                    metric: {
                      data: { type: "metric", id: "external-placed" },
                    },
                  },
                },
              ],
              included: [
                {
                  type: "profile",
                  id: "profile-identity",
                  attributes: { email: "subject@example.com" },
                },
              ],
              nextCursor: null,
              apiRevision: "2026-07-15",
            },
          ],
        ],
        [
          "external-ordered",
          [
            eventPage({
              metricExternalId: "external-ordered",
              eventIds: ["ordered-identity"],
              nextCursor: null,
            }),
          ],
        ],
      ]),
    });
    const result = await processOrderCoreBatch(
      { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
      deps.services,
    );
    expect(result.done).toBe(true);
    const [firstCommit] = deps.commitPage.mock.calls.map(
      ([call]) =>
        call as unknown as {
          events: Array<{
            identityDigests: Array<{ keyVersion: string }>;
            erasureSuppressionCandidates: Array<{ kind: string }>;
          }>;
        },
    );
    expect(firstCommit.events[0].identityDigests).toEqual([
      expect.objectContaining({ keyVersion: "v1" }),
    ]);
    expect(
      firstCommit.events[0].erasureSuppressionCandidates.map((c) => c.kind).sort(),
    ).toEqual(["email", "klaviyo_profile_id"]);
    // No plaintext email or raw profile document crosses into persistence.
    expect(JSON.stringify(deps.commitPage.mock.calls)).not.toContain(
      "subject@example.com",
    );
  });

  it("fails before any page write when the suppression key is invalid", async () => {
    const deps = makeRunnerDependencies({});
    deps.services.loadSuppressionKey = vi.fn(() => {
      throw new Error("IDENTITY_ERASURE_HMAC_SECRET is required");
    });
    await expect(
      processOrderCoreBatch(
        { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
        deps.services,
      ),
    ).rejects.toThrow("IDENTITY_ERASURE_HMAC_SECRET is required");
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.commitPage).not.toHaveBeenCalled();
  });
});

describe("consent sync", () => {
  const NOW = new Date("2026-07-30T12:00:00.000Z");
  const TIMEZONE = "America/New_York";
  const allowed = inclusiveStoreDaysToHalfOpenUtc({
    dateFrom: "2026-05-02",
    dateTo: "2026-07-30",
    timeZone: TIMEZONE,
  });

  function startState(overrides: Partial<StartState> = {}): StartState {
    return {
      connection: {
        status: "ready",
        storeTimezone: TIMEZONE,
        initialSourceFrom: null,
        initialSourceTo: null,
      },
      passedProbe: true,
      running: null,
      inserted: [],
      persistedInitialWindows: [],
      reaped: [],
      ...overrides,
    };
  }

  const baseDeps = (state: StartState) => ({
    loadIdentityKeyring: vi.fn(() => TEST_KEYRING),
    loadSuppressionKey: vi.fn(() => TEST_SUPPRESSION_KEY),
    initializeGate: vi.fn(async () => ({ initialized: false })),
    now: () => NOW,
    runStore: makeStartStore(state),
  });

  const SUBSCRIBED_BINDING = {
    metricRowId: "metric-row-subscribed",
    externalMetricId: "external-subscribed",
    metricKind: "subscribed_to_list" as const,
  };
  const UNSUBSCRIBED_BINDING = {
    metricRowId: "metric-row-unsubscribed",
    externalMetricId: "external-unsubscribed",
    metricKind: "unsubscribed_from_list" as const,
  };

  function consentPages(): Map<string, KlaviyoCompoundPage[]> {
    return new Map([
      [
        "external-subscribed",
        [
          eventPage({
            metricExternalId: "external-subscribed",
            eventIds: ["subscribed-1"],
            nextCursor: null,
          }),
        ],
      ],
      [
        "external-unsubscribed",
        [
          eventPage({
            metricExternalId: "external-unsubscribed",
            eventIds: ["unsubscribed-1"],
            nextCursor: null,
          }),
        ],
      ],
    ]);
  }

  it("creates a consent run with the consent contract and checkpoint", async () => {
    const state = startState();
    await expect(
      startOrResumeConsentSync(
        { scope, window: allowed, triggerType: "manual_backfill" },
        baseDeps(state),
      ),
    ).resolves.toEqual({ syncRunId: "run-1", resumed: false });
    expect(state.inserted).toEqual([
      expect.objectContaining({
        window: allowed,
        triggerType: "manual_backfill",
        contract: consentSourceContract(),
        checkpoint: {
          ...consentSourceContract(),
          metricIndex: 0,
          cursor: null,
          page: 0,
        },
      }),
    ]);
    // Consent (like journey) never persists an order-core initial floor.
    expect(state.persistedInitialWindows).toEqual([]);
  });

  it("rejects a start while a live journey run holds the one running-events slot", async () => {
    const liveJourneyRun: RunningEventRun = {
      syncRunId: "run-journey-live",
      requestedFrom: allowed.from,
      requestedTo: allowed.to,
      requestParameters: journeySourceContract(),
      heartbeatAt: NOW,
    };
    const state = startState({ running: { ...liveJourneyRun } });
    await expect(
      startOrResumeConsentSync(
        { scope, window: allowed, triggerType: "scheduled" },
        baseDeps(state),
      ),
    ).rejects.toThrow("already running in a different source mode");
    expect(state.inserted).toHaveLength(0);
  });

  it("resumes an identical live consent run", async () => {
    const liveConsentRun: RunningEventRun = {
      syncRunId: "run-consent-live",
      requestedFrom: allowed.from,
      requestedTo: allowed.to,
      requestParameters: consentSourceContract(),
      heartbeatAt: NOW,
    };
    const state = startState({ running: { ...liveConsentRun } });
    await expect(
      startOrResumeConsentSync(
        { scope, window: allowed, triggerType: "scheduled" },
        baseDeps(state),
      ),
    ).resolves.toEqual({ syncRunId: "run-consent-live", resumed: true });
    expect(state.inserted).toHaveLength(0);
  });

  it("dispatches a consent run to the timeline batch path", async () => {
    const deps = makeRunnerDependencies({
      requestParameters: consentSourceContract(),
      persistedCheckpoint: {
        ...consentSourceContract(),
        metricIndex: 0,
        cursor: null,
        page: 0,
      },
      pages: consentPages(),
    });
    const loadTimelineBindings = vi.fn(async () => [
      SUBSCRIBED_BINDING,
      UNSUBSCRIBED_BINDING,
    ]);
    const result = await processEventSourceBatch(
      { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
      { ...deps.services, loadTimelineBindings },
    );
    expect(result).toEqual({
      done: true,
      pagesProcessed: 2,
      eventsRead: 2,
      checkpoint: null,
      sourceMode: "consent",
    });
    expect(loadTimelineBindings).toHaveBeenCalledWith(
      scope,
      KLAVIYO_CONSENT_KINDS,
    );
    // Spec: consent ingestion never retrieves the profile email, so no
    // identity HMAC digests can be derived or persisted.
    expect(deps.listEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metricId: "external-subscribed",
        includeAttributions: false,
        includeProfileEmail: false,
      }),
    );
    expect(deps.listEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ metricId: "external-unsubscribed" }),
    );
    const [firstCommit, secondCommit] = deps.commitPage.mock.calls.map(
      ([call]) =>
        call as unknown as {
          sourceContract: unknown;
          events: Array<{
            metricId: string;
            identityDigests: unknown[];
          }>;
        },
    );
    expect(firstCommit.sourceContract).toEqual(consentSourceContract());
    expect(firstCommit.events.map((event) => event.metricId)).toEqual([
      "metric-row-subscribed",
    ]);
    expect(secondCommit.events.map((event) => event.metricId)).toEqual([
      "metric-row-unsubscribed",
    ]);
    // Committed consent events carry no email-derived identity digests.
    for (const event of [...firstCommit.events, ...secondCommit.events]) {
      expect(event.identityDigests).toEqual([]);
    }
    expect(deps.finishRun).toHaveBeenCalledTimes(1);
  });

  it("commits an empty page and advances when a consent metric is unbound", async () => {
    const deps = makeRunnerDependencies({
      requestParameters: consentSourceContract(),
      persistedCheckpoint: {
        ...consentSourceContract(),
        metricIndex: 0,
        cursor: null,
        page: 0,
      },
      pages: consentPages(),
    });
    const loadTimelineBindings = vi.fn(async () => [
      null,
      UNSUBSCRIBED_BINDING,
    ]);
    const result = await processEventSourceBatch(
      { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
      { ...deps.services, loadTimelineBindings },
    );
    expect(result).toEqual({
      done: true,
      pagesProcessed: 2,
      eventsRead: 1,
      checkpoint: null,
      sourceMode: "consent",
    });
    const [emptyCommit, boundCommit] = deps.commitPage.mock.calls.map(
      ([call]) =>
        call as unknown as {
          sourceContract: unknown;
          expectedCheckpoint: { metricIndex: number };
          events: unknown[];
          rowsRead: number;
        },
    );
    // The unbound canonical slot commits as an empty page and advances.
    expect(emptyCommit.sourceContract).toEqual(consentSourceContract());
    expect(emptyCommit.expectedCheckpoint.metricIndex).toBe(0);
    expect(emptyCommit.events).toEqual([]);
    expect(emptyCommit.rowsRead).toBe(0);
    expect(boundCommit.expectedCheckpoint.metricIndex).toBe(1);
    expect(boundCommit.events).toHaveLength(1);
    expect(deps.listEvents).toHaveBeenCalledTimes(1);
    expect(deps.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ metricId: "external-unsubscribed" }),
    );
    expect(deps.finishRun).toHaveBeenCalledTimes(1);
  });
});
