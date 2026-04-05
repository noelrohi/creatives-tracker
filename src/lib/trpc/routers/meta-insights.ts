import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure } from "../init";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { mapMetaInsightsToRows } from "@/lib/meta-api-mapper";
import { fetchMetaCreativePreviewsForAds } from "@/lib/meta-creative-assets";

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const INSIGHT_FIELDS = [
  "campaign_name",
  "campaign_id",
  "adset_name",
  "adset_id",
  "ad_name",
  "ad_id",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "cpm",
  "cpc",
  "ctr",
  "clicks",
  "actions",
  "action_values",
  "cost_per_action_type",
  "quality_ranking",
  "engagement_rate_ranking",
  "conversion_rate_ranking",
  "video_play_actions",
  "video_thruplay_watched_actions",
  "video_avg_time_watched_actions",
].join(",");

const breakdownEnum = z.enum([
  "age",
  "gender",
  "country",
  "publisher_platform",
  "platform_position",
  "device_platform",
]);

async function getAccountWithToken(accountId: string, organizationId: string) {
  const [account] = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.id, accountId),
        eq(adAccounts.organizationId, organizationId),
      ),
    );

  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
  }

  if (!account.metaAccessToken) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This account has no access token.",
    });
  }

  return account as typeof account & { metaAccessToken: string };
}

function handleMetaError(response: { status: number; statusText: string }, errorBody: { error?: { type?: string; message?: string } } | null) {
  const metaError = errorBody?.error;

  if (metaError?.type === "OAuthException") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Auth error: ${metaError.message}. Your access token may have expired.`,
    });
  }

  if (response.status === 429) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Meta API rate limit reached. Wait a few minutes and try again.",
    });
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Meta API error: ${metaError?.message ?? response.statusText}`,
  });
}

export const metaInsightsRouter = router({
  /**
   * Step 1: Request an async report from Meta.
   * Returns a report_run_id to poll with checkReport.
   */
  requestReport: orgProcedure
    .input(
      z.object({
        accountId: z.string(),
        dateFrom: z.string(),
        dateTo: z.string(),
        level: z.enum(["campaign", "adset", "ad"]),
        breakdowns: z.array(breakdownEnum).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const account = await getAccountWithToken(input.accountId, ctx.organizationId);

      const params = new URLSearchParams({
        access_token: account.metaAccessToken,
        fields: INSIGHT_FIELDS,
        level: input.level,
        time_range: JSON.stringify({
          since: input.dateFrom,
          until: input.dateTo,
        }),
        limit: "500",
        async: "true",
      });

      if (input.breakdowns?.length) {
        params.set("breakdowns", input.breakdowns.join(","));
      }

      const url = `${GRAPH_API_BASE}/act_${account.metaAccountId}/insights`;
      const response: Response = await fetch(url, {
        method: "POST",
        body: params,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        handleMetaError(response, errorBody);
      }

      const json = await response.json();

      return {
        reportRunId: json.report_run_id as string,
      };
    }),

  /**
   * Step 2: Poll report status.
   * Returns async_status and async_percent_completion.
   */
  checkReport: orgProcedure
    .input(z.object({ reportRunId: z.string(), accountId: z.string() }))
    .query(async ({ input, ctx }) => {
      const account = await getAccountWithToken(input.accountId, ctx.organizationId);

      const url = `${GRAPH_API_BASE}/${input.reportRunId}?access_token=${account.metaAccessToken}&fields=id,async_status,async_percent_completion`;
      const response: Response = await fetch(url);

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        handleMetaError(response, errorBody);
      }

      const json = await response.json();

      return {
        status: json.async_status as string,
        percentComplete: (json.async_percent_completion as number) ?? 0,
        isComplete: json.async_status === "Job Completed",
        isFailed: json.async_status === "Job Failed",
      };
    }),

  /**
   * Step 3: Download completed report data.
   * Follows pagination to get all rows, maps to MappedRow[].
   */
  downloadReport: orgProcedure
    .input(
      z.object({
        reportRunId: z.string(),
        accountId: z.string(),
        level: z.enum(["campaign", "adset", "ad"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const account = await getAccountWithToken(input.accountId, ctx.organizationId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allData: any[] = [];
      let nextUrl: string | null =
        `${GRAPH_API_BASE}/${input.reportRunId}/insights?access_token=${account.metaAccessToken}&limit=500`;

      while (nextUrl) {
        const response: Response = await fetch(nextUrl);

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          handleMetaError(response, errorBody);
        }

        const json = await response.json();
        if (json.data) {
          allData.push(...json.data);
        }

        nextUrl = json.paging?.next ?? null;
      }

      const mapperLevel = input.level === "adset" ? "ad_set" : input.level;
      const rows = mapMetaInsightsToRows(
        allData,
        mapperLevel as "campaign" | "ad_set" | "ad",
      );

      if (input.level === "ad") {
        const adMetaIds = [...new Set(rows.map((row) => row.adId).filter(Boolean) as string[])];
        if (adMetaIds.length > 0) {
          const previews = await fetchMetaCreativePreviewsForAds({
            adMetaIds,
            metaAccountId: account.metaAccountId,
            accessToken: account.metaAccessToken,
            videoUrlMode: "none",
          });

          for (const row of rows) {
            if (!row.adId) continue;
            const preview = previews.get(row.adId);
            if (!preview) continue;
            if (preview.assetUrl) {
              row.assetUrl = preview.assetUrl;
            }
            if (preview.videoUrl) {
              row.videoUrl = preview.videoUrl;
            }
            if (preview.format) {
              row.format = preview.format;
            }
            if (preview.destinationUrl) {
              row.destinationUrl = preview.destinationUrl;
            }
          }
        }
      }

      return {
        rows,
        totalRows: rows.length,
      };
    }),
});
