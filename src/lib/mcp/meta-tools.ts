import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppRouter } from "@/lib/trpc/routers/_app";
import type { Reporting } from "@/lib/analytics-reporting";

type Caller = ReturnType<AppRouter["createCaller"]>;
type Dependencies = {
  caller: Pick<Caller, "adAccount" | "adCreative">;
  loadReporting: (accountId?: string) => Promise<Reporting>;
};

const rangeShape = {
  from: z.iso.date().describe("Inclusive start, YYYY-MM-DD, in each Meta account's reporting timezone."),
  to: z.iso.date().describe("Inclusive end, YYYY-MM-DD. Resolve relative dates from the original question date."),
  accountId: z.string().min(1).optional().describe("Adsolute account ID from list_meta_accounts; omit for all accounts."),
};
const orderedRange = (input: { from: string; to: string }) => input.from <= input.to;
export const metaPerformanceInput = z.object(rangeShape).refine(orderedRange, "from must be on or before to");
export const metaCreativesInput = z.object({
  ...rangeShape,
  sortBy: z.enum(["purchases", "roas"]).default("purchases"),
  limit: z.number().int().min(1).max(50).default(10),
}).refine(orderedRange, "from must be on or before to");

const answerGuidance = "Answer concisely with the requested table and dates; mention caveats when they affect the answer. Revenue is Meta-attributed purchase value, not Shopify net sales. Missing data is not zero. Never sum different or unknown currencies. Freshness does not prove complete coverage; attribution is provisional.";

async function result(fn: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Tool call failed" }] };
  }
}

export function registerMetaTools(server: McpServer, { caller, loadReporting }: Dependencies) {
  // The authorized caller runs before the reporting loader, including when no
  // organization is selected. Only the public account projection crosses MCP.
  async function inventory(accountId?: string) {
    const accounts = await caller.adAccount.list({ includeDisabled: true });
    if (accountId && !accounts.some((account) => account.id === accountId)) {
      throw new Error("Account unavailable in this organization");
    }
    return accounts.filter((account) => !accountId || account.id === accountId).map((account) => ({
      accountId: account.id,
      accountName: account.name,
      metaAccountId: account.metaAccountId,
      currency: account.currency,
      timezone: account.timezone,
      isDisabled: account.isDisabled,
    }));
  }

  server.registerTool("list_meta_accounts", {
    description: "List Meta accounts, including disabled and unsynced accounts, with currency, timezone and reporting health. Use IDs to scope reports. " + answerGuidance,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => result(async () => ({
    accounts: await inventory(),
    reporting: await loadReporting(),
  })));

  server.registerTool("get_top_meta_creatives", {
    description: "Top Meta creatives for explicit inclusive dates, ranked by purchases (default) or ROAS before limit. Historical ranking includes now-paused creatives. Eligibility remains spend >= 50 and ROAS >= 1; may return fewer than requested. Inspect qualification and sample warnings. For mixed/unknown account currencies, request account-scoped rankings rather than treating the combined monetary ranking as valid. " + answerGuidance,
    inputSchema: metaCreativesInput,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async (input) => result(async () => {
    const accounts = await inventory(input.accountId);
    const report = await caller.adCreative.dashboardStats({
      ...input,
      sortBy: input.sortBy === "purchases" ? "conversions" : "roas",
      rankingMode: "historical",
      includePortfolio: false,
      includeSurviving: false,
    });
    const { rankingMode, qualification, samples, topPerformers } = report.leaderboards;
    const currencyUsable = report.reporting.meta?.currencyEvidence.aggregateAmountsUsable === true;
    return {
      state: currencyUsable ? "observed" : "unavailable",
      reason: currencyUsable ? null : "Request separate account rankings; combined currency is mixed or unknown.",
      accounts,
      creatives: currencyUsable ? report.topPerformers : [],
      ranking: { rankingMode, qualification, samples: currencyUsable ? samples : [], topPerformers: currencyUsable ? topPerformers : null },
      effectiveWindow: report.effectiveWindow,
      reporting: report.reporting,
    };
  }));

  server.registerTool("get_meta_account_performance", {
    description: "Meta spend, attributed sales and ROAS per account for explicit inclusive dates. Includes accounts without observations as unavailable with null metrics. Includes currency, timezone and freshness evidence. ROAS uses purchase value divided by spend; zero/unknown spend yields null. " + answerGuidance,
    inputSchema: metaPerformanceInput,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async (input) => result(async () => {
    const accounts = await inventory(input.accountId);
    const [rows, reporting] = await Promise.all([
      caller.adCreative.getMerAccountBreakdown(input),
      loadReporting(input.accountId),
    ]);
    const byAccount = new Map(rows.map((row) => [row.accountId, row]));
    return {
      range: { from: input.from, to: input.to, boundaries: "inclusive", calendarBasis: "meta_account_reporting_day" },
      salesDefinition: "meta_attributed_purchase_value",
      accounts: accounts.map((account) => {
        const row = byAccount.get(account.accountId);
        return {
          ...account,
          state: row ? "observed" : "unavailable",
          spend: row?.spend ?? null,
          revenue: row?.revenue ?? null,
          // The underlying dashboard coalesces unknown revenue to zero; MCP
          // preserves unknown revenue as unknown ROAS instead.
          roas: row?.revenue == null ? null : row.roas,
        };
      }),
      reporting,
    };
  }));
}
