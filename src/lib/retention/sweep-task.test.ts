import { describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  logger: { info: vi.fn() },
  metadata: { set: vi.fn() },
  schedules: { task: vi.fn((definition) => definition) },
  task: vi.fn((definition) => definition),
}));
vi.mock("@/db", () => ({ db: { execute: vi.fn() } }));
vi.mock("@/lib/retention/execute", () => ({
  executeRetention: vi.fn(),
}));
vi.mock("@/lib/retention/plan", () => ({ planRetention: vi.fn() }));
vi.mock("@/lib/retention/rollup", () => ({
  rollupMonthlySummaries: vi.fn(),
}));

import { mayExecuteRetention } from "../../../trigger/retention-sweep";
import { redactOrganizationId } from "./policy";

describe("retention sweep safety helpers", () => {
  it("redacts organization ids to six characters", () => {
    expect(redactOrganizationId("org_123456789")).toBe("org_12…");
  });

  it("executes only when explicitly requested and allowlisted", () => {
    const allowlist = new Set(["allowed-org"]);

    expect(mayExecuteRetention("allowed-org", true, allowlist)).toBe(true);
    expect(mayExecuteRetention("allowed-org", false, allowlist)).toBe(false);
    expect(mayExecuteRetention("other-org", true, allowlist)).toBe(false);
  });
});
