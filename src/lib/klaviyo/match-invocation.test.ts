import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  MatchInvocationUnavailableError,
  UnknownProviderRunStateError,
  baseInvocationKey,
  mapProviderRunState,
  recoveryInvocationKey,
  triggerOrRepairMatchInvocation,
} = await import("@/lib/klaviyo/match-invocation");

describe("mapProviderRunState", () => {
  it("maps every documented state into the closed union", () => {
    for (const live of ["QUEUED", "EXECUTING", "WAITING", "REATTEMPTING", "DELAYED", "FROZEN"]) {
      expect(mapProviderRunState(live)).toBe("live");
    }
    expect(mapProviderRunState("COMPLETED")).toBe("completed");
    expect(mapProviderRunState("FAILED")).toBe("failed_auto_cleared");
    for (const dead of ["CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"]) {
      expect(mapProviderRunState(dead)).toBe("terminal_without_publication");
    }
  });

  it("fails closed on unknown states", () => {
    expect(() => mapProviderRunState("SOMETHING_NEW")).toThrow(
      UnknownProviderRunStateError,
    );
  });
});

function makeAdapters(script: {
  runs: Array<{ id: string; status: string; verified?: boolean }>;
}) {
  let index = 0;
  const triggered: string[] = [];
  const adapters = {
    triggerWithKey: vi.fn(async (key: string) => {
      triggered.push(key);
      const run = script.runs[Math.min(index, script.runs.length - 1)];
      index += 1;
      return { triggerRunId: run.id };
    }),
    getRunStatus: vi.fn(async (runId: string) => {
      const run = script.runs.find((entry) => entry.id === runId)!;
      return { status: run.status };
    }),
    verifyPublishedRun: vi.fn(async (runId: string) => {
      const run = script.runs.find((entry) => entry.id === runId)!;
      return run.verified ?? false;
    }),
  };
  return { adapters, triggered };
}

describe("triggerOrRepairMatchInvocation", () => {
  it("returns a live run on the untouched base key", async () => {
    const { adapters, triggered } = makeAdapters({
      runs: [{ id: "run-1", status: "EXECUTING" }],
    });
    const result = await triggerOrRepairMatchInvocation({
      invocationFingerprint: "fp",
      adapters,
    });
    expect(result).toEqual({ triggerRunId: "run-1", key: baseInvocationKey("fp") });
    expect(triggered).toEqual([baseInvocationKey("fp")]);
  });

  it("returns a completed run only after publication verification", async () => {
    const { adapters } = makeAdapters({
      runs: [{ id: "run-1", status: "COMPLETED", verified: true }],
    });
    const result = await triggerOrRepairMatchInvocation({
      invocationFingerprint: "fp",
      adapters,
    });
    expect(result.triggerRunId).toBe("run-1");
    expect(adapters.verifyPublishedRun).toHaveBeenCalledWith("run-1");
  });

  it("hops to a deterministic recovery key on a dead terminal run", async () => {
    const { adapters, triggered } = makeAdapters({
      runs: [
        { id: "run-dead", status: "CRASHED" },
        { id: "run-2", status: "QUEUED" },
      ],
    });
    const result = await triggerOrRepairMatchInvocation({
      invocationFingerprint: "fp",
      adapters,
    });
    expect(result.triggerRunId).toBe("run-2");
    expect(triggered).toEqual([
      baseInvocationKey("fp"),
      recoveryInvocationKey("fp", "run-dead"),
    ]);
  });

  it("treats completed-without-publication as a recovery hop", async () => {
    const { adapters, triggered } = makeAdapters({
      runs: [
        { id: "run-empty", status: "COMPLETED", verified: false },
        { id: "run-2", status: "EXECUTING" },
      ],
    });
    const result = await triggerOrRepairMatchInvocation({
      invocationFingerprint: "fp",
      adapters,
    });
    expect(result.triggerRunId).toBe("run-2");
    expect(triggered[1]).toBe(recoveryInvocationKey("fp", "run-empty"));
  });

  it("retriggers the exact same key for an auto-cleared failure", async () => {
    const { adapters, triggered } = makeAdapters({
      runs: [
        { id: "run-failed", status: "FAILED" },
        { id: "run-retry", status: "QUEUED" },
      ],
    });
    const result = await triggerOrRepairMatchInvocation({
      invocationFingerprint: "fp",
      adapters,
    });
    expect(result.triggerRunId).toBe("run-retry");
    expect(triggered).toEqual([
      baseInvocationKey("fp"),
      baseInvocationKey("fp"),
    ]);
  });

  it("bounds recovery to three hops then fails safe", async () => {
    const { adapters, triggered } = makeAdapters({
      runs: [
        { id: "dead-1", status: "CRASHED" },
        { id: "dead-2", status: "CANCELED" },
        { id: "dead-3", status: "EXPIRED" },
        { id: "dead-4", status: "SYSTEM_FAILURE" },
      ],
    });
    await expect(
      triggerOrRepairMatchInvocation({ invocationFingerprint: "fp", adapters }),
    ).rejects.toThrow(MatchInvocationUnavailableError);
    expect(triggered).toHaveLength(4);
    expect(triggered[3]).toBe(recoveryInvocationKey("fp", "dead-3"));
  });

  it("deduplicates concurrent callers through the same key chain", async () => {
    const first = makeAdapters({
      runs: [
        { id: "dead-1", status: "CRASHED" },
        { id: "run-live", status: "QUEUED" },
      ],
    });
    const second = makeAdapters({
      runs: [
        { id: "dead-1", status: "CRASHED" },
        { id: "run-live", status: "QUEUED" },
      ],
    });
    const [left, right] = await Promise.all([
      triggerOrRepairMatchInvocation({
        invocationFingerprint: "fp",
        adapters: first.adapters,
      }),
      triggerOrRepairMatchInvocation({
        invocationFingerprint: "fp",
        adapters: second.adapters,
      }),
    ]);
    expect(left.key).toBe(right.key);
    expect(left.triggerRunId).toBe(right.triggerRunId);
  });

  it("fails closed on unknown provider states without mutating keys", async () => {
    const { adapters, triggered } = makeAdapters({
      runs: [{ id: "run-odd", status: "MYSTERY" }],
    });
    await expect(
      triggerOrRepairMatchInvocation({ invocationFingerprint: "fp", adapters }),
    ).rejects.toThrow(UnknownProviderRunStateError);
    expect(triggered).toEqual([baseInvocationKey("fp")]);
  });
});
