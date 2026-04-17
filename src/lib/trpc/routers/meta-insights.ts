import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure, orgWriteProcedure, orgAdminProcedure } from "../init";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { mapMetaInsightsToRows } from "@/lib/meta-api-mapper";
import { fetchMetaCreativePreviewsForAds } from "@/lib/meta-creative-assets";
import { resolveMetaDeliveryStatus } from "@/lib/ad-status";

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

const META_AD_STATUS_FIELDS = [
  "effective_status",
  "configured_status",
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

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function fetchMetaAdDeliveryById(input: {
  adMetaIds: string[];
  accessToken: string;
}) {
  const deliveries = new Map<string, string>();

  for (const batch of chunk(input.adMetaIds, 50)) {
    const params = new URLSearchParams({
      access_token: input.accessToken,
      ids: batch.join(","),
      fields: META_AD_STATUS_FIELDS,
    });

    const response: Response = await fetch(`${GRAPH_API_BASE}/?${params.toString()}`);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      handleMetaError(response, errorBody);
    }

    const json = await response.json() as Record<string, {
      effective_status?: string;
      configured_status?: string;
    }>;

    for (const adMetaId of batch) {
      const status = json[adMetaId];
      const delivery = resolveMetaDeliveryStatus({
        effectiveStatus: status?.effective_status,
        configuredStatus: status?.configured_status,
      });
      if (delivery) {
        deliveries.set(adMetaId, delivery);
      }
    }
  }

  return deliveries;
}

export const metaInsightsRouter = router({
  /**
   * Step 1: Request an async report from Meta.
   * Returns a report_run_id to poll with checkReport.
   */
  requestReport: orgWriteProcedure
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
        time_increment: "1",
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
  downloadReport: orgWriteProcedure
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
      const adMetaIds = input.level === "ad"
        ? [...new Set(allData.map((row) => row.ad_id).filter(Boolean) as string[])]
        : [];
      const deliveryByAdId = adMetaIds.length > 0
        ? await fetchMetaAdDeliveryById({
            adMetaIds,
            accessToken: account.metaAccessToken,
          })
        : undefined;
      const rows = mapMetaInsightsToRows(
        allData,
        mapperLevel as "campaign" | "ad_set" | "ad",
        { deliveryByAdId },
      );

      if (input.level === "ad") {
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

  /**
   * Admin-only: delete multi-day performance_log rows for this account whose
   * entire [date_start, date_end] falls inside [from, to].
   *
   * Safety:
   * - Never touches rows whose range extends outside [from, to] — those
   *   still contain data you haven't re-imported yet.
   * - Never touches rows where date_start = date_end (already daily).
   * - With dryRun=true, counts what would be deleted without touching anything.
   */
  purgeMultiDayLogsInRange: orgAdminProcedure
    .input(
      z.object({
        accountId: z.string(),
        from: z.string(),
        to: z.string(),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const account = await getAccountWithToken(input.accountId, ctx.organizationId);

      if (input.dryRun) {
        const res = await db.execute(sql`
          SELECT
            count(*)::int AS n,
            min(pl.date_start)::text AS min_start,
            max(pl.date_end)::text AS max_end
          FROM performance_log pl
          JOIN ad ON ad.id = pl.ad_id
          WHERE ad.organization_id = ${ctx.organizationId}
            AND ad.account_id = ${account.id}
            AND pl.date_start <> pl.date_end
            AND pl.date_start >= ${input.from}::date
            AND pl.date_end <= ${input.to}::date
        `);
        const row = res.rows[0] as { n: number; min_start: string | null; max_end: string | null };
        return {
          affected: row?.n ?? 0,
          rangeStart: row?.min_start ?? null,
          rangeEnd: row?.max_end ?? null,
          dryRun: true,
        };
      }

      const result = await db.execute(sql`
        DELETE FROM performance_log pl
        USING ad
        WHERE ad.id = pl.ad_id
          AND ad.organization_id = ${ctx.organizationId}
          AND ad.account_id = ${account.id}
          AND pl.date_start <> pl.date_end
          AND pl.date_start >= ${input.from}::date
          AND pl.date_end <= ${input.to}::date
      `);

      return {
        affected: result.rowCount ?? 0,
        rangeStart: input.from,
        rangeEnd: input.to,
        dryRun: false,
      };
    }),

  /**
   * Admin-only: storage health report for performance_log in this org.
   * Returns row counts, date coverage, rows-per-month distribution,
   * and rough table size so you can decide whether retention is needed.
   */
  orgDataHealth: orgAdminProcedure.query(async ({ ctx }) => {
    type SummaryRow = {
      total_rows: number;
      multi_day_rows: number;
      daily_rows: number;
      oldest: string | null;
      newest: string | null;
    };
    const summary = await db.execute(sql`
      SELECT
        count(*)::int AS total_rows,
        count(*) FILTER (WHERE pl.date_start <> pl.date_end)::int AS multi_day_rows,
        count(*) FILTER (WHERE pl.date_start = pl.date_end)::int AS daily_rows,
        min(pl.date_start)::text AS oldest,
        max(pl.date_end)::text AS newest
      FROM performance_log pl
      JOIN ad ON ad.id = pl.ad_id
      WHERE ad.organization_id = ${ctx.organizationId}
    `);
    const s = (summary.rows[0] ?? {}) as SummaryRow;

    type MonthRow = { month: string; rows: number };
    const monthly = await db.execute(sql`
      SELECT
        to_char(date_trunc('month', pl.date_start), 'YYYY-MM') AS month,
        count(*)::int AS rows
      FROM performance_log pl
      JOIN ad ON ad.id = pl.ad_id
      WHERE ad.organization_id = ${ctx.organizationId}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 24
    `);

    // Whole-table size — informational, not scoped to org (PG can't cheaply
    // compute per-org size without full scan).
    type SizeRow = { total_bytes: number; pretty: string };
    const size = await db.execute(sql`
      SELECT
        pg_total_relation_size('performance_log')::bigint AS total_bytes,
        pg_size_pretty(pg_total_relation_size('performance_log')) AS pretty
    `);
    const sz = (size.rows[0] ?? {}) as SizeRow;

    return {
      totalRows: s.total_rows ?? 0,
      multiDayRows: s.multi_day_rows ?? 0,
      dailyRows: s.daily_rows ?? 0,
      oldest: s.oldest,
      newest: s.newest,
      monthly: (monthly.rows as MonthRow[]).map((r) => ({ month: r.month, rows: r.rows })),
      tableSize: { bytes: Number(sz.total_bytes ?? 0), pretty: sz.pretty ?? "—" },
    };
  }),

  /**
   * One-shot daily discrepancy check.
   * Single Meta call: account-level insights, time_increment=1, minimal fields.
   * Joined against local performance_log by day.
   */
  compareDailyMetaVsDb: orgProcedure
    .input(
      z.object({
        accountId: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const account = await getAccountWithToken(input.accountId, ctx.organizationId);

      // Meta: one synchronous call, account level, daily, spend + action_values only
      const params = new URLSearchParams({
        access_token: account.metaAccessToken,
        fields: "spend,action_values,date_start",
        level: "account",
        time_increment: "1",
        time_range: JSON.stringify({ since: input.from, until: input.to }),
        limit: "500",
      });
      const url = `${GRAPH_API_BASE}/act_${account.metaAccountId}/insights?${params.toString()}`;

      const response: Response = await fetch(url);
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        handleMetaError(response, errorBody);
      }
      const json = (await response.json()) as {
        data?: Array<{
          date_start?: string;
          spend?: string;
          action_values?: Array<{ action_type: string; value: string }>;
        }>;
      };

      const metaByDay = new Map<string, { spend: number; revenue: number }>();
      for (const row of json.data ?? []) {
        const day = row.date_start;
        if (!day) continue;
        const spend = row.spend ? parseFloat(row.spend) : 0;
        const av = row.action_values ?? [];
        const omni = av.find((a) => a.action_type === "omni_purchase");
        const pur = av.find((a) => a.action_type === "purchase");
        const revenue = omni ? parseFloat(omni.value) : pur ? parseFloat(pur.value) : 0;
        metaByDay.set(day, { spend, revenue });
      }

      // DB: daily aggregate for this account in the same range
      type DbRow = { day: string; spend: string | null; revenue: string | null };
      const dbResult = await db.execute(sql`
        SELECT
          pl.date_start::text as day,
          sum(pl.spend)::text as spend,
          sum(pl.purchase_value)::text as revenue
        FROM performance_log pl
        JOIN ad ON ad.id = pl.ad_id
        WHERE pl.date_start >= ${input.from}::date
          AND pl.date_start <= ${input.to}::date
          AND ad.account_id = ${input.accountId}
          AND ad.organization_id = ${ctx.organizationId}
        GROUP BY pl.date_start
        ORDER BY pl.date_start
      `);
      const dbByDay = new Map<string, { spend: number; revenue: number }>();
      for (const r of dbResult.rows as DbRow[]) {
        dbByDay.set(r.day, {
          spend: r.spend ? parseFloat(r.spend) : 0,
          revenue: r.revenue ? parseFloat(r.revenue) : 0,
        });
      }

      const allDays = new Set<string>([...metaByDay.keys(), ...dbByDay.keys()]);
      const days = [...allDays].sort();

      const rows = days.map((day) => {
        const m = metaByDay.get(day) ?? { spend: 0, revenue: 0 };
        const d = dbByDay.get(day) ?? { spend: 0, revenue: 0 };
        const metaRoas = m.spend > 0 ? m.revenue / m.spend : null;
        const dbRoas = d.spend > 0 ? d.revenue / d.spend : null;
        return {
          day,
          metaSpend: m.spend,
          dbSpend: d.spend,
          spendDiff: d.spend - m.spend,
          metaRevenue: m.revenue,
          dbRevenue: d.revenue,
          revenueDiff: d.revenue - m.revenue,
          metaRoas,
          dbRoas,
          roasDiff: metaRoas != null && dbRoas != null ? dbRoas - metaRoas : null,
        };
      });

      const totals = rows.reduce(
        (acc, r) => ({
          metaSpend: acc.metaSpend + r.metaSpend,
          dbSpend: acc.dbSpend + r.dbSpend,
          metaRevenue: acc.metaRevenue + r.metaRevenue,
          dbRevenue: acc.dbRevenue + r.dbRevenue,
        }),
        { metaSpend: 0, dbSpend: 0, metaRevenue: 0, dbRevenue: 0 },
      );

      return {
        rows,
        totals: {
          ...totals,
          spendDiff: totals.dbSpend - totals.metaSpend,
          revenueDiff: totals.dbRevenue - totals.metaRevenue,
          metaRoas: totals.metaSpend > 0 ? totals.metaRevenue / totals.metaSpend : null,
          dbRoas: totals.dbSpend > 0 ? totals.dbRevenue / totals.dbSpend : null,
        },
      };
    }),
});
