import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ process: vi.fn(), load: vi.fn(), fail: vi.fn(), prepare: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), connections: vi.fn(), claim: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ schemaTask: (config: unknown) => config, schedules: { task: (config: unknown) => config }, wait: { for: m.wait } }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: m.connections }) }) } }));
vi.mock("./snapshot-collector", () => ({ processSnapshotBatch: m.process }));
vi.mock("./snapshot-dispatch", () => ({ dispatchSnapshotRun: m.dispatch }));
vi.mock("./snapshot-store", () => ({ loadSnapshotRun: m.load, failSnapshotRun: m.fail, prepareDailySnapshotRuns: m.prepare, claimSnapshotLease: m.claim }));
import { KlaviyoReadError } from "./read-transport";
import { collectSnapshot, klaviyoSnapshotsDailyTask, klaviyoSnapshotReportsTask } from "../../../trigger/klaviyo-snapshots";
beforeEach(() => {
  vi.clearAllMocks(); m.load.mockResolvedValue({ scope: {}, row: { dataset: "metrics", heartbeatAt: new Date(), leaseOwner: "owner", leaseToken: "lease" } });
  m.claim.mockResolvedValue("lease");
  m.process.mockResolvedValue({ done: true, state: "published" }); m.wait.mockResolvedValue(undefined);
});
it("continues batches in the same worker, without a competing handoff", async () => {
  m.process.mockResolvedValueOnce({ done: false, page: 20 });
  await collectSnapshot({ snapshotRunId: "run" }, false, "owner");
  expect(m.process).toHaveBeenCalledTimes(2); expect(m.dispatch).not.toHaveBeenCalled();
});
it("does no provider work when another worker owns the lease", async () => {
  m.claim.mockResolvedValue(null);
  expect(await collectSnapshot({ snapshotRunId: "run" }, false, "owner")).toMatchObject({ state: "not_owned" });
  expect(m.process).not.toHaveBeenCalled(); expect(m.fail).not.toHaveBeenCalled();
});
it("durably honors provider Retry-After", async () => {
  m.process.mockRejectedValueOnce(new KlaviyoReadError("rate_limited", 90100));
  await collectSnapshot({ snapshotRunId: "run" }, false, "owner");
  expect(m.wait).toHaveBeenCalledWith({ seconds: 91 }); expect(m.fail).not.toHaveBeenCalled();
});
it("finalizes safely after exhausting transient retries", async () => {
  m.process.mockRejectedValue(new KlaviyoReadError("unavailable"));
  expect(await collectSnapshot({ snapshotRunId: "run" }, false, "owner")).toMatchObject({ state: "failed" });
  expect(m.process).toHaveBeenCalledTimes(3); expect(m.fail).toHaveBeenCalledOnce();
});
it("renews the lease during long Retry-After waits without extra provider calls", async () => {
  m.process.mockRejectedValueOnce(new KlaviyoReadError("rate_limited", 1300000));
  await collectSnapshot({ snapshotRunId: "run" }, false, "owner");
  expect(m.process).toHaveBeenCalledTimes(2);
  expect(m.wait.mock.calls.reduce((total, [value]) => total + value.seconds, 0)).toBe(1300);
  expect(m.claim).toHaveBeenCalledTimes(7);
  expect(m.fail).not.toHaveBeenCalled();
});
it("uses the existing scarce-report queue and strict run-only payload", () => {
  const config = klaviyoSnapshotReportsTask as unknown as { queue: { name: string }; schema: { safeParse: (v: unknown) => { success: boolean } } };
  expect(config.queue.name).toBe("klaviyo-reports-low-quota");
  expect(config.schema.safeParse({ snapshotRunId: "run", email: "private" }).success).toBe(false);
});
it("daily enumerates ready connections independently and isolates connection/dispatch failures", async () => {
  m.connections.mockResolvedValue([{ connectionId: "bad" }, { connectionId: "good" }]);
  m.prepare.mockRejectedValueOnce(new Error("ineligible definition")).mockResolvedValueOnce([{ snapshotRunId: "a" }, { snapshotRunId: "b" }]);
  m.dispatch.mockRejectedValueOnce(new Error("delivery")).mockResolvedValueOnce({ triggerRunId: "b" });
  const config = klaviyoSnapshotsDailyTask as unknown as { cron: { pattern: string; timezone: string }; run: () => Promise<unknown> };
  expect(config.cron).toEqual({ pattern: "30 20 * * *", timezone: "UTC" });
  expect(await config.run()).toEqual({ dispatched: 1, failed: 2 });
  expect(m.dispatch).toHaveBeenCalledTimes(2);
});
