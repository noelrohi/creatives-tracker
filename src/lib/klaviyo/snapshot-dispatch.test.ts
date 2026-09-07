import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ load: vi.fn(), key: vi.fn(), trigger: vi.fn() }));
vi.mock("./snapshot-store", () => ({ loadSnapshotRun: m.load }));
vi.mock("@trigger.dev/sdk", () => ({ idempotencyKeys: { create: m.key }, tasks: { trigger: m.trigger } }));
import { dispatchSnapshotRun } from "./snapshot-dispatch";
beforeEach(() => {
  vi.clearAllMocks(); m.load.mockResolvedValue({ row: { state: "running", dataset: "metrics" } });
  m.key.mockResolvedValue("global-key"); m.trigger.mockResolvedValue({ id: "trigger" });
});
it("uses a global run-only initial handoff key on every retry", async () => {
  await dispatchSnapshotRun("run"); await dispatchSnapshotRun("run");
  expect(m.key).toHaveBeenCalledWith("klaviyo:snapshots:first:run", { scope: "global" });
  expect(m.trigger).toHaveBeenCalledWith("klaviyo-snapshots", { snapshotRunId: "run" }, { idempotencyKey: "global-key", idempotencyKeyTTL: "7d" });
});
it("routes scarce reports to their dedicated task", async () => {
  m.load.mockResolvedValue({ row: { state: "running", dataset: "campaign_values" } });
  await dispatchSnapshotRun("run"); expect(m.trigger.mock.calls[0][0]).toBe("klaviyo-snapshot-reports");
});
it("does not dispatch terminal runs", async () => {
  m.load.mockResolvedValue({ row: { state: "published" } });
  expect(await dispatchSnapshotRun("run")).toEqual({ triggerRunId: null }); expect(m.trigger).not.toHaveBeenCalled();
});
it("keeps ambiguous delivery recoverable using the same key", async () => {
  m.trigger.mockRejectedValueOnce(new Error("network"));
  await expect(dispatchSnapshotRun("run")).rejects.toThrow();
  await expect(dispatchSnapshotRun("run")).resolves.toEqual({ triggerRunId: "trigger" });
  expect(m.trigger.mock.calls[0]).toEqual(m.trigger.mock.calls[1]);
});
