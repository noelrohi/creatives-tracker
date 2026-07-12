import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/db";
import { resolveMetaDeliveryStatus } from "@/lib/ad-status";
import { mapMetaInsightsToRows } from "@/lib/meta-api-mapper";
import { fetchMetaCreativePreviewsForAds } from "@/lib/meta-creative-assets";
import type { MappedRow } from "@/lib/csv-parser";
import { adAccounts } from "@/schema/account";

const GRAPH_API_VERSION = "v22.0";
export const META_GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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

const META_DELIVERY_STATUS_FIELDS = [
  "effective_status",
  "configured_status",
].join(",");

export const metaInsightsLevelSchema = z.enum(["campaign", "adset", "ad"]);
export type MetaInsightsLevel = z.infer<typeof metaInsightsLevelSchema>;

export const metaInsightsBreakdownSchema = z.enum([
  "age",
  "gender",
  "country",
  "publisher_platform",
  "platform_position",
  "device_platform",
]);
export type MetaInsightsBreakdown = z.infer<typeof metaInsightsBreakdownSchema>;

type MetaErrorBody = {
  error?: {
    type?: string;
    message?: string;
  };
};

type MetaAccountWithToken = typeof adAccounts.$inferSelect & {
  metaAccessToken: string;
};

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getMetaAccountWithToken(input: {
  accountId: string;
  organizationId: string;
}) {
  const [account] = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.id, input.accountId),
        eq(adAccounts.organizationId, input.organizationId),
      ),
    );

  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
  }

  if (account.isDisabled) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This account is disabled.",
    });
  }

  if (!account.metaAccessToken) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This account has no access token.",
    });
  }

  return account as MetaAccountWithToken;
}

export function handleMetaApiError(
  response: { status: number; statusText: string },
  errorBody: MetaErrorBody | null,
) {
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

export async function fetchMetaAdDelivery(input: {
  adMetaIds: string[];
  accessToken: string;
}) {
  return fetchMetaDeliveryById({
    metaIds: input.adMetaIds,
    accessToken: input.accessToken,
  });
}

export async function fetchMetaAdSetDelivery(input: {
  adSetMetaIds: string[];
  accessToken: string;
}) {
  return fetchMetaDeliveryById({
    metaIds: input.adSetMetaIds,
    accessToken: input.accessToken,
  });
}

async function fetchMetaDeliveryById(input: {
  metaIds: string[];
  accessToken: string;
}) {
  const deliveries = new Map<string, string>();

  for (const batch of chunk(input.metaIds, 50)) {
    const params = new URLSearchParams({
      access_token: input.accessToken,
      ids: batch.join(","),
      fields: META_DELIVERY_STATUS_FIELDS,
    });

    const response: Response = await fetch(`${META_GRAPH_API_BASE}/?${params.toString()}`);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as MetaErrorBody | null;
      handleMetaApiError(response, errorBody);
    }

    const json = await response.json() as Record<string, {
      effective_status?: string;
      configured_status?: string;
    }>;

    for (const metaId of batch) {
      const status = json[metaId];
      const delivery = resolveMetaDeliveryStatus({
        effectiveStatus: status?.effective_status,
        configuredStatus: status?.configured_status,
      });
      if (delivery) {
        deliveries.set(metaId, delivery);
      }
    }
  }

  return deliveries;
}

export async function requestMetaInsightsReport(input: {
  organizationId: string;
  accountId: string;
  dateFrom: string;
  dateTo: string;
  level: MetaInsightsLevel;
  breakdowns?: MetaInsightsBreakdown[];
}) {
  const account = await getMetaAccountWithToken({
    accountId: input.accountId,
    organizationId: input.organizationId,
  });

  const params = new URLSearchParams({
    access_token: account.metaAccessToken,
    fields: INSIGHT_FIELDS,
    level: input.level,
    time_range: JSON.stringify({
      since: input.dateFrom,
      until: input.dateTo,
    }),
    time_increment: "1",
    limit: "500",
    async: "true",
  });

  if (input.breakdowns?.length) {
    params.set("breakdowns", input.breakdowns.join(","));
  }

  const url = `${META_GRAPH_API_BASE}/act_${account.metaAccountId}/insights`;
  const response: Response = await fetch(url, {
    method: "POST",
    body: params,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as MetaErrorBody | null;
    handleMetaApiError(response, errorBody);
  }

  const json = await response.json() as { report_run_id?: string };

  if (!json.report_run_id) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Meta did not return a report run id.",
    });
  }

  return {
    reportRunId: json.report_run_id,
  };
}

export async function checkMetaInsightsReport(input: {
  organizationId: string;
  accountId: string;
  reportRunId: string;
}) {
  const account = await getMetaAccountWithToken({
    accountId: input.accountId,
    organizationId: input.organizationId,
  });

  const url = `${META_GRAPH_API_BASE}/${input.reportRunId}?access_token=${account.metaAccessToken}&fields=id,async_status,async_percent_completion`;
  const response: Response = await fetch(url);

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as MetaErrorBody | null;
    handleMetaApiError(response, errorBody);
  }

  const json = await response.json() as {
    async_status?: string;
    async_percent_completion?: number;
  };

  return {
    status: json.async_status ?? "Unknown",
    percentComplete: json.async_percent_completion ?? 0,
    isComplete: json.async_status === "Job Completed",
    isFailed: json.async_status === "Job Failed",
  };
}

export async function pollMetaInsightsReportUntilDone(input: {
  organizationId: string;
  accountId: string;
  reportRunId: string;
  pollIntervalMs?: number;
  maxAttempts?: number;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? 3000;
  const maxAttempts = input.maxAttempts ?? 120;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await checkMetaInsightsReport({
      organizationId: input.organizationId,
      accountId: input.accountId,
      reportRunId: input.reportRunId,
    });

    if (status.isFailed) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Report generation failed on Meta's side.",
      });
    }

    if (status.isComplete) {
      return status;
    }

    if (attempt < maxAttempts - 1) {
      await sleep(pollIntervalMs);
    }
  }

  throw new TRPCError({
    code: "TIMEOUT",
    message: "Meta report generation timed out.",
  });
}

export async function fetchMetaInsightsPage(input: {
  accessToken: string;
  reportRunId: string;
  cursor?: string | null;
}): Promise<{
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
}> {
  const url = input.cursor
    ?? `${META_GRAPH_API_BASE}/${input.reportRunId}/insights?access_token=${input.accessToken}&limit=500`;

  const response: Response = await fetch(url);

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as MetaErrorBody | null;
    handleMetaApiError(response, errorBody);
  }

  const json = await response.json() as {
    data?: Array<Record<string, unknown>>;
    paging?: { next?: string };
  };

  return {
    rows: json.data ?? [],
    nextCursor: json.paging?.next ?? null,
  };
}

export async function downloadMetaInsightsReport(input: {
  organizationId: string;
  accountId: string;
  reportRunId: string;
  level: MetaInsightsLevel;
}) {
  const account = await getMetaAccountWithToken({
    accountId: input.accountId,
    organizationId: input.organizationId,
  });

  const allData: Array<Record<string, unknown>> = [];
  let nextUrl: string | null =
    `${META_GRAPH_API_BASE}/${input.reportRunId}/insights?access_token=${account.metaAccessToken}&limit=500`;

  while (nextUrl) {
    const response: Response = await fetch(nextUrl);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as MetaErrorBody | null;
      handleMetaApiError(response, errorBody);
    }

    const json = await response.json() as {
      data?: Array<Record<string, unknown>>;
      paging?: { next?: string };
    };

    if (json.data) {
      allData.push(...json.data);
    }

    nextUrl = json.paging?.next ?? null;
  }

  const mapperLevel = input.level === "adset" ? "ad_set" : input.level;
  const adMetaIds = input.level === "ad"
    ? [...new Set(allData.map((row) => row.ad_id).filter(Boolean) as string[])]
    : [];
  const deliveryByAdId = adMetaIds.length > 0
    ? await fetchMetaAdDelivery({
        adMetaIds,
        accessToken: account.metaAccessToken,
      })
    : undefined;

  const rows = mapMetaInsightsToRows(
    allData,
    mapperLevel as "campaign" | "ad_set" | "ad",
    { deliveryByAdId },
  );

  if (input.level === "ad" && adMetaIds.length > 0) {
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

  return {
    rows: rows as MappedRow[],
    totalRows: rows.length,
  };
}
