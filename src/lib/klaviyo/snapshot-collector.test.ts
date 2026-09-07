import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), commit: vi.fn(), publish: vi.fn(), fail: vi.fn(), connection: vi.fn(), metrics: vi.fn(), campaigns: vi.fn(), events: vi.fn(), reports: vi.fn(), account: vi.fn() }));
vi.mock("./snapshot-store", () => ({ loadSnapshotRun: mocks.load, commitSnapshotPage: mocks.commit, publishSnapshotRun: mocks.publish, failSnapshotRun: mocks.fail }));
vi.mock("./source-store", () => ({ getConnectionRecord: mocks.connection }));
vi.mock("./collection-reads", () => ({ readMetrics: mocks.metrics, readCampaigns: mocks.campaigns, readEventsForCollection: mocks.events }));
vi.mock("./campaign-value-reads", () => ({ readCampaignValues: mocks.reports }));
import { processSnapshotBatch } from "./snapshot-collector";
import { KlaviyoReadError } from "./read-transport";
const scope = { organizationId: "org", storeId: "store", connectionId: "connection" };
const anchor = new Date("2026-09-07T00:00:00Z");
const dependencies = { credentialProvider: { getPilotBinding: vi.fn(), resolve: vi.fn().mockResolvedValue({ expectedAccountId: "account", privateApiKey: "private-key" }) }, createClient: vi.fn(), now: () => anchor };
function run(dataset = "metrics", page = 0) {
  const row = { state: "running", accountId: "account", timezone: "UTC", resolvedScope: { dataset, metricIds: ["M1"], since: "2026-09-01T00:00:00Z", until: anchor.toISOString(), conversionMetricId: "M1" }, checkpoint: { dataset, continuation: null, page }, leaseToken: "lease", pageCount: page, anchorAt: anchor, warnings: [], providerCompleteness: "complete" };
  mocks.load.mockResolvedValue({ scope, row });
  return row;
}
beforeEach(() => {
  vi.clearAllMocks(); run();
  mocks.connection.mockResolvedValue({ ...scope, status: "ready", klaviyoAccountId: "account", accountTimezone: "UTC" });
  dependencies.createClient.mockReturnValue({ request: mocks.account });
  mocks.account.mockResolvedValue({ data: [{ type: "account", id: "account" }], links: { next: null } });
  mocks.commit.mockResolvedValue({ committed: true });
  mocks.publish.mockResolvedValue({ published: true });
  mocks.metrics.mockResolvedValue({ metrics: [], nextContinuation: null });
});
describe("snapshot collector", () => {
  it.each(["campaigns", "metrics"])("rejects an actual foreign key owner for %s despite matching environment binding", async (dataset) => {
    run(dataset);
    mocks.account.mockResolvedValue({ data: [{ type: "account", id: "foreign-account", attributes: { email: "private@example.test" } }] });
    const result = await processSnapshotBatch("run", dependencies);
    expect(result).toMatchObject({ done: true, state: "failed" });
    expect(mocks.account).toHaveBeenCalledWith({ resource: "accounts" });
    expect(mocks.campaigns).not.toHaveBeenCalled(); expect(mocks.metrics).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith({ scope, snapshotRunId: "run", leaseToken: "lease", code: "failed", now: anchor });
    expect(JSON.stringify([result, mocks.fail.mock.calls])).not.toMatch(/foreign-account|private@example|private-key/);
  });
  it("collects only after the actual provider account matches the persisted binding", async () => {
    await expect(processSnapshotBatch("run", dependencies)).resolves.toMatchObject({ state: "published" });
    expect(dependencies.createClient).toHaveBeenCalledWith("private-key");
    expect(mocks.account.mock.invocationCallOrder[0]).toBeLessThan(mocks.metrics.mock.invocationCallOrder[0]);
    expect(mocks.commit).toHaveBeenCalledOnce();
  });
  it.each([{ data: [] }, { data: [{ type: "account", id: "account" }, { type: "account", id: "other" }] }, { data: [{ type: "account", id: "account" }], links: { next: "provider-cursor" } }])("fails closed on missing, ambiguous or incomplete account proof", async (response) => {
    mocks.account.mockResolvedValue(response);
    await processSnapshotBatch("run", dependencies);
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("preserves Retry-After from account verification without collecting", async () => {
    mocks.account.mockRejectedValue(new KlaviyoReadError("rate_limited", 120000));
    await expect(processSnapshotBatch("run", dependencies)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 120000 });
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("commits an empty complete page before publishing", async () => {
    expect(await processSnapshotBatch("run", dependencies)).toMatchObject({ state: "published" });
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ records: [], expectedCheckpoint: { dataset: "metrics", continuation: null, page: 0 } }));
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]);
  });
  it("resumes directly into publication without repeating provider reads", async () => {
    run("metrics", 1); await processSnapshotBatch("run", dependencies);
    expect(mocks.metrics).not.toHaveBeenCalled(); expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it("preserves Retry-After without persisting provider exceptions", async () => {
    mocks.metrics.mockRejectedValue(new KlaviyoReadError("rate_limited", 123456));
    await expect(processSnapshotBatch("run", dependencies)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 123456 });
    expect(mocks.fail).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects timezone drift before spending report quota", async () => {
    run("campaign_values").timezone = "Asia/Kolkata";
    expect(await processSnapshotBatch("run", dependencies)).toMatchObject({ state: "failed" });
    expect(mocks.reports).not.toHaveBeenCalled();
  });
  it("fails known incomplete reports without publishing", async () => {
    run("campaign_values"); mocks.reports.mockResolvedValue({ completeness: "more_available" });
    await processSnapshotBatch("run", dependencies);
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ code: "incomplete" }));
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("pins event adapter validation to the stored anchor and fails unresolved profiles", async () => {
    run("events"); mocks.events.mockResolvedValue({ events: [{ eventId: "E1", profileId: "P1", metricId: "M1", datetime: "2026-09-02T00:00:00Z" }], profileEmailById: new Map(), nextContinuation: null });
    await processSnapshotBatch("run", { ...dependencies, loadSuppressionKey: () => ({ version: "v1", secret: Buffer.alloc(32) }), loadIdentityKeyring: () => ({ current: { version: "v1", secret: Buffer.alloc(32) } }) });
    expect(mocks.events.mock.calls[0][3]).toEqual(anchor);
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ code: "privacyUnresolved" }));
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("deduplicates identical shared messages and rejects differing ones", async () => {
    run("campaigns"); const message = { messageId: "message" };
    mocks.campaigns.mockResolvedValue({ campaigns: [], messages: [message, message], nextContinuation: null });
    await processSnapshotBatch("run", dependencies);
    expect(mocks.commit.mock.calls[0][0].records).toHaveLength(1);
    mocks.commit.mockClear(); mocks.publish.mockClear();
    run("campaigns"); mocks.campaigns.mockResolvedValue({ campaigns: [], messages: [message, { ...message, subject: "different" }], nextContinuation: null });
    await processSnapshotBatch("run", dependencies);
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("never persists plaintext identity and reloads privacy keys on publication resume", async () => {
    run("events");
    const email = "snapshot-only@example.test";
    mocks.events.mockResolvedValue({ events: [{ eventId: "E1", profileId: "P1", metricId: "M1", datetime: "2026-09-02T00:00:00Z" }], profileEmailById: new Map([["P1", email]]), nextContinuation: null });
    const privateDependencies = { ...dependencies, loadSuppressionKey: () => ({ version: "v1", secret: Buffer.alloc(32, 1) }), loadIdentityKeyring: () => ({ current: { version: "v1", secret: Buffer.alloc(32, 2) } }) };
    await processSnapshotBatch("run", privateDependencies);
    expect(JSON.stringify(mocks.commit.mock.calls)).not.toContain(email);
    expect(mocks.commit.mock.calls[0][0].records[0].identity.emailDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    mocks.events.mockClear(); mocks.publish.mockClear();
    run("events", 1);
    await processSnapshotBatch("run", privateDependencies);
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ privacyKeys: expect.objectContaining({ suppressionKey: expect.objectContaining({ version: "v1" }) }) }));
  });
  it("rejects a superseded worker token before provider IO", async () => {
    expect(await processSnapshotBatch("run", { ...dependencies, leaseToken: "old" })).toMatchObject({ state: "lease_lost" });
    expect(mocks.metrics).not.toHaveBeenCalled(); expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("does not publish after a checkpoint race", async () => {
    mocks.commit.mockResolvedValue({ committed: false });
    expect(await processSnapshotBatch("run", dependencies)).toMatchObject({ done: false });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
