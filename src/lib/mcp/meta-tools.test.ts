import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { buildReporting } from "@/lib/analytics-reporting";
import { metaCreativesInput, metaPerformanceInput, registerMetaTools } from "./meta-tools";

const account = (id: string) => ({ id, name: id, metaAccountId: `meta-${id}`, currency: "USD", timezone: "Asia/Manila", isDisabled: false, metaAccessToken: "must-not-leak", notes: "private" });
const reporting = buildReporting({ now: new Date("2026-09-03T00:00:00Z"), metaAccounts: [
  { accountId: "a", currency: "USD", timezone: "Asia/Manila", connection: "connected", observedImportedThrough: null, lastSuccessMs: null, latestAttempt: null },
] });
const caller = {
  adAccount: { list: vi.fn() },
  adCreative: { dashboardStats: vi.fn(), getMerAccountBreakdown: vi.fn() },
};
const loadReporting = vi.fn();
type Tool = { config: { inputSchema: { parse: (value: unknown) => unknown } }; call: (input: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> };
let registered: Map<string, Tool>;
async function call(name: string, input: unknown = {}) {
  const tool = registered.get(name)!;
  const response = await tool.call(tool.config.inputSchema.parse(input));
  return { error: response.isError, data: response.isError ? response.content[0].text : JSON.parse(response.content[0].text) };
}
beforeEach(() => {
  vi.resetAllMocks();
  registered = new Map();
  const server = { registerTool: (name: string, config: Tool["config"], handler: Tool["call"]) => registered.set(name, { config, call: handler }) };
  registerMetaTools(server as unknown as McpServer, { caller: caller as unknown as Parameters<typeof registerMetaTools>[1]["caller"], loadReporting });
  caller.adAccount.list.mockResolvedValue([account("a"), { ...account("b"), isDisabled: true }]);
  loadReporting.mockResolvedValue(reporting);
});

describe("Meta MCP reports", () => {
  it("rejects invalid, missing, and reversed calendar bounds", () => {
    for (const input of [{}, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-09-03", to: "2026-09-02" }]) {
      expect(metaPerformanceInput.safeParse(input).success).toBe(false);
      expect(metaCreativesInput.safeParse(input).success).toBe(false);
    }
  });

  it("includes disabled accounts and evidence without private fields", async () => {
    const { data } = await call("list_meta_accounts");
    expect(caller.adAccount.list).toHaveBeenCalledWith({ includeDisabled: true });
    expect(data.accounts).toHaveLength(2);
    expect(data.accounts[1].isDisabled).toBe(true);
    expect(data.reporting.meta.freshness).toBe("never_synced");
    expect(JSON.stringify(data)).not.toMatch(/must-not-leak|private|metaAccessToken/);
  });

  it("does not load evidence after authorization fails", async () => {
    caller.adAccount.list.mockRejectedValue(new Error("UNAUTHORIZED"));
    expect((await call("list_meta_accounts")).error).toBe(true);
    expect(loadReporting).not.toHaveBeenCalled();
  });

  it("rejects account IDs outside the authorized inventory before reporting", async () => {
    const response = await call("get_meta_account_performance", { from: "2026-09-01", to: "2026-09-01", accountId: "other-org" });
    expect(response.error).toBe(true);
    expect(caller.adCreative.getMerAccountBreakdown).not.toHaveBeenCalled();
    expect(loadReporting).not.toHaveBeenCalled();
  });

  it("keeps missing observations and unknown revenue distinct from zero", async () => {
    caller.adCreative.getMerAccountBreakdown.mockResolvedValue([{ accountId: "a", spend: "100", revenue: null, roas: "0" }]);
    const { data } = await call("get_meta_account_performance", { from: "2026-09-01", to: "2026-09-01" });
    expect(data.accounts[0]).toMatchObject({ spend: "100", revenue: null, roas: null, state: "observed" });
    expect(data.accounts[1]).toMatchObject({ spend: null, revenue: null, roas: null, state: "unavailable" });
    expect(data.reporting).toEqual(reporting);
    expect(data.salesDefinition).toBe("meta_attributed_purchase_value");
  });

  it("passes explicit dates and scopes to both performance and health reads", async () => {
    caller.adCreative.getMerAccountBreakdown.mockResolvedValue([{ accountId: "a", spend: "100", revenue: "200", roas: "2" }]);
    const input = { from: "2026-09-02", to: "2026-09-02", accountId: "a" };
    const { data } = await call("get_meta_account_performance", input);
    expect(caller.adCreative.getMerAccountBreakdown).toHaveBeenCalledWith(input);
    expect(loadReporting).toHaveBeenCalledWith("a");
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].roas).toBe("2");
  });

  it("defaults to historical top ten purchases and omits unrelated dashboard lists", async () => {
    caller.adCreative.dashboardStats.mockResolvedValue({ topPerformers: [{ id: "winner" }], bottomPerformers: [{ id: "unrelated" }], reporting, effectiveWindow: { dateFrom: "2026-08-31", dateTo: "2026-09-01" }, leaderboards: { rankingMode: "historical", qualification: { minSpend: 50 }, samples: [], topPerformers: { returnedCount: 1 } } });
    const { data } = await call("get_top_meta_creatives", { from: "2026-08-31", to: "2026-09-01" });
    expect(caller.adCreative.dashboardStats).toHaveBeenCalledWith({ from: "2026-08-31", to: "2026-09-01", limit: 10, sortBy: "conversions", rankingMode: "historical", includePortfolio: false, includeSurviving: false });
    expect(data.creatives).toEqual([{ id: "winner" }]);
    expect(data.ranking.qualification.minSpend).toBe(50);
    expect(JSON.stringify(data)).not.toContain("unrelated");
  });

  it("does not return a misleading ranking when currency aggregation is unsafe", async () => {
    caller.adCreative.dashboardStats.mockResolvedValue({ topPerformers: [{ id: "misleading" }], reporting: { ...reporting, meta: { ...reporting.meta, currencyEvidence: { aggregateAmountsUsable: false } } }, leaderboards: { samples: [{ creativeId: "misleading" }] } });
    const { data } = await call("get_top_meta_creatives", { from: "2026-08-31", to: "2026-09-01", sortBy: "roas" });
    expect(data.state).toBe("unavailable");
    expect(data.creatives).toEqual([]);
    expect(data.ranking.samples).toEqual([]);
    expect(caller.adCreative.dashboardStats.mock.calls[0][0].sortBy).toBe("roas");
  });
});
