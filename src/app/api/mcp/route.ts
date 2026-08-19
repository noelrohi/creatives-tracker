import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { auth, mcpResource } from "@/lib/auth";
import { createCallerFactory, createMcpContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";

const createCaller = createCallerFactory(appRouter);

function toolResult(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return toolResult(await fn());
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Tool call failed",
        },
      ],
      isError: true,
    };
  }
}

const handler = createMcpHandler(
  async (ctx) => {
    const server = new McpServer({ name: "adsolute", version: "1.0.0" });

    const userId = ctx.authInfo?.extra?.userId;
    if (typeof userId !== "string") {
      // requireMcpAuth always forwards a subject; a server without tools is
      // the safe answer if that ever breaks.
      return server;
    }
    const organizationId = ctx.authInfo?.extra?.organizationId;
    const caller = createCaller(
      await createMcpContext(
        userId,
        typeof organizationId === "string" ? organizationId : null,
      ),
    );

    server.registerTool(
      "list_campaigns",
      {
        description:
          "List the organization's ad campaigns, newest first, with status, objective, and budget fields.",
        inputSchema: z.object({}),
      },
      async () => run(() => caller.campaign.list()),
    );

    server.registerTool(
      "get_monthly_performance",
      {
        description:
          "Monthly ad performance overview: spend, purchase value, ROAS, CPA, and CTR per calendar month, newest first.",
        inputSchema: z.object({
          months: z
            .number()
            .int()
            .min(1)
            .max(60)
            .default(24)
            .describe("How many months to return"),
        }),
      },
      async ({ months }) =>
        run(() => caller.performanceSummary.monthlyOverview({ months })),
    );

    server.registerTool(
      "list_findings",
      {
        description:
          "Automated data-quality and performance findings for the organization, filtered by status.",
        inputSchema: z.object({
          status: z
            .enum(["open", "handled", "snoozed"])
            .default("open")
            .describe(
              "open = unresolved, handled = resolved, snoozed = muted types",
            ),
        }),
      },
      async ({ status }) => run(() => caller.findings.list({ status })),
    );

    return server;
  },
  { legacy: "reject" },
);

export const POST = requireMcpAuth(
  auth,
  (request, accessTokenClaims) =>
    handler.fetch(request, {
      authInfo: {
        token:
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "",
        clientId:
          typeof accessTokenClaims.client_id === "string"
            ? accessTokenClaims.client_id
            : "",
        scopes:
          typeof accessTokenClaims.scope === "string"
            ? accessTokenClaims.scope.split(" ")
            : [],
        expiresAt: accessTokenClaims.exp,
        extra: {
          userId: accessTokenClaims.sub,
          organizationId: accessTokenClaims.organization_id,
        },
      },
    }),
  { resource: mcpResource },
);
