import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildReporting, type EffectiveWindow, type MetaAccountEvidence, type SyncEvidence } from "./analytics-reporting";

export async function resolveDashboardWindow(input?: { from?: string; to?: string; days?: number }): Promise<EffectiveWindow> {
  const explicit = Boolean(input?.from && input?.to);
  const days = input?.days ?? 7;
  const result = await db.execute<{ date_from: string; date_to: string; timezone: string }>(sql`
    SELECT
      (${explicit ? sql`${input!.from}::date` : sql`current_date - ${days}::int`})::text AS date_from,
      (${explicit ? sql`${input!.to}::date` : sql`current_date`})::text AS date_to,
      current_setting('TimeZone') AS timezone
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Database did not resolve analytics window");
  return {
    dateFrom: row.date_from,
    dateTo: row.date_to,
    boundaries: "inclusive",
    selection: explicit ? "explicit" : "rolling",
    rollingDays: explicit ? null : days,
    ignoredOneSidedBound: !explicit && Boolean(input?.from || input?.to),
    resolutionTimezone: explicit ? null : row.timezone,
    rowSelection: "reporting_interval_overlap",
  };
}

/** Inventory includes unsynced/disconnected accounts; successful runs are evidence, not the inventory. */
export async function loadAnalyticsReporting(input: {
  organizationId: string;
  accountId?: string;
  includeMeta?: boolean;
  store?: { id: string; ianaTimezone: string };
}) {
  const [metaResult, shopifyResult] = await Promise.all([
    input.includeMeta !== false ? db.execute<{ evidence: MetaAccountEvidence }>(sql`
      SELECT json_build_object(
        'accountId', a.id, 'timezone', a.timezone,
        'connection', CASE WHEN a.is_disabled THEN 'disabled' WHEN a.meta_access_token IS NULL THEN 'disconnected' ELSE 'connected' END,
        'observedImportedThrough', a.data_date_end::text,
        'lastSuccessMs', good.last_success_ms,
        'latestAttempt', CASE WHEN latest.id IS NULL THEN NULL ELSE json_build_object(
          'requestedMs', extract(epoch FROM latest.requested_at AT TIME ZONE 'UTC') * 1000,
          'finishedMs', extract(epoch FROM latest.finished_at AT TIME ZONE 'UTC') * 1000,
          'result', latest.result
        ) END
      ) AS evidence
      FROM ad_account a
      LEFT JOIN LATERAL (
        SELECT extract(epoch FROM max(r.finished_at) AT TIME ZONE 'UTC') * 1000 AS last_success_ms
        FROM account_sync_run r
        WHERE r.organization_id = ${input.organizationId} AND r.account_id = a.id
          AND r.result IN ('success', 'partial_success')
      ) good ON true
      LEFT JOIN LATERAL (
        SELECT r.id, r.requested_at, r.finished_at, r.result FROM account_sync_run r
        WHERE r.organization_id = ${input.organizationId} AND r.account_id = a.id
        ORDER BY r.requested_at DESC, r.id ASC LIMIT 1
      ) latest ON true
      WHERE a.organization_id = ${input.organizationId}
        ${input.accountId ? sql`AND a.id = ${input.accountId}` : sql``}
      ORDER BY a.id
    `) : null,
    input.store ? db.execute<{ evidence: SyncEvidence }>(sql`
      SELECT json_build_object(
        'lastSuccessMs', (
          SELECT extract(epoch FROM max(r.finished_at) AT TIME ZONE 'UTC') * 1000
          FROM shopify_sync_run r WHERE r.organization_id = ${input.organizationId}
            AND r.store_id = ${input.store.id} AND r.result = 'success'
            AND r.phase IN ('incremental', 'backfill')
        ),
        'latestAttempt', (
          SELECT json_build_object(
            'requestedMs', extract(epoch FROM r.requested_at AT TIME ZONE 'UTC') * 1000,
            'finishedMs', extract(epoch FROM r.finished_at AT TIME ZONE 'UTC') * 1000,
            'result', r.result
          ) FROM shopify_sync_run r WHERE r.organization_id = ${input.organizationId}
            AND r.store_id = ${input.store.id} AND r.phase IN ('incremental', 'backfill')
          ORDER BY r.requested_at DESC, r.id ASC LIMIT 1
        )
      ) AS evidence
    `) : null,
  ]);
  return buildReporting({
    now: new Date(),
    metaAccounts: metaResult?.rows.map((row) => row.evidence),
    shopify: input.store && shopifyResult?.rows[0] ? {
      ...shopifyResult.rows[0].evidence,
      storeId: input.store.id,
      timezone: input.store.ianaTimezone,
    } : undefined,
  });
}
