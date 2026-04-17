import { z } from "zod";
import { router, orgProcedure, orgWriteProcedure, orgAdminProcedure } from "../init";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  checkMetaInsightsReport,
  downloadMetaInsightsReport,
  getMetaAccountWithToken,
  handleMetaApiError,
  META_GRAPH_API_BASE,
  metaInsightsBreakdownSchema,
  metaInsightsLevelSchema,
  requestMetaInsightsReport,
} from "@/lib/meta-insights-sync";

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
          level: metaInsightsLevelSchema,
          breakdowns: z.array(metaInsightsBreakdownSchema).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return requestMetaInsightsReport({
          organizationId: ctx.organizationId,
          ...input,
        });
      }),

  /**
   * Step 2: Poll report status.
   * Returns async_status and async_percent_completion.
    */
  checkReport: orgProcedure
    .input(z.object({ reportRunId: z.string(), accountId: z.string() }))
    .query(async ({ input, ctx }) => checkMetaInsightsReport({
      organizationId: ctx.organizationId,
      ...input,
    })),

  /**
   * Step 3: Download completed report data.
   * Follows pagination to get all rows, maps to MappedRow[].
   */
  downloadReport: orgWriteProcedure
    .input(
        z.object({
          reportRunId: z.string(),
          accountId: z.string(),
          level: metaInsightsLevelSchema,
        }),
      )
    .mutation(async ({ input, ctx }) => downloadMetaInsightsReport({
      organizationId: ctx.organizationId,
      ...input,
    })),

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
      const account = await getMetaAccountWithToken({
        accountId: input.accountId,
        organizationId: ctx.organizationId,
      });

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
      const account = await getMetaAccountWithToken({
        accountId: input.accountId,
        organizationId: ctx.organizationId,
      });

      // Meta: one synchronous call, account level, daily, spend + action_values only
      const params = new URLSearchParams({
        access_token: account.metaAccessToken,
        fields: "spend,action_values,date_start",
        level: "account",
        time_increment: "1",
        time_range: JSON.stringify({ since: input.from, until: input.to }),
        limit: "500",
      });
      const url = `${META_GRAPH_API_BASE}/act_${account.metaAccountId}/insights?${params.toString()}`;

      const response: Response = await fetch(url);
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        handleMetaApiError(response, errorBody);
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
