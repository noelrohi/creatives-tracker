import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { accountSyncRuns } from "@/schema/sync-run";
import { formatDateOnly } from "@/lib/date";
import {
  baseWindowStart,
  breakdownWindowStart,
} from "@/lib/retention/policy";
import { mapRowsForImport } from "@/lib/import-utils";
import { mapMetaInsightsToRows } from "@/lib/meta-api-mapper";
import {
  enrichMetaCreativePreviews,
  importMetaBreakdownRows,
  importMetaRows,
  refreshMetaAdSetStatusesForAccount,
  refreshMetaAdStatusesForAccount,
} from "@/lib/meta-import";
import {
  fetchMetaAdDelivery,
  fetchMetaInsightsPage,
  getMetaAccountWithToken,
  syncMetaAccountTimezone,
  requestMetaInsightsReport,
  checkMetaInsightsReport,
} from "@/lib/meta-insights-sync";
import {
  createAccountSyncRun,
  deriveAccountSyncRunStatus,
  listRecentAccountSyncRuns,
  updateAccountSyncRun,
} from "@/lib/meta-sync-runs";
import {
  internalWorkerProcedure,
  router,
  orgProcedure,
  orgWriteProcedure,
} from "../init";

const breakdownSchema = z.enum(["age", "gender", "country", "device_platform"]);
type Breakdown = z.infer<typeof breakdownSchema>;

const syncStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "partial_success",
  "failed",
  "cancelled",
  "stale",
]);

const publicAccountSyncRunSchema = z.object({
  id: z.string(),
  orgSyncRunId: z.string().nullable(),
  organizationId: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  triggerType: z.enum(["scheduled", "manual_backfill"]),
  dateFrom: z.string(),
  dateTo: z.string(),
  breakdownsRequested: z.array(z.string()),
  breakdownsCompleted: z.array(z.string()),
  currentPhase: z.string().nullable(),
  requestedAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  result: z.string().nullable(),
  rowsSynced: z.number(),
  errorMessage: z.string().nullable(),
  status: syncStatusSchema,
});

type RunMeta = {
  reportRunId?: string;
  breakdown?: Breakdown | null;
  includeBase?: boolean;
  lastCursorApplied?: string;
  lastNextCursor?: string | null;
};

const INITIAL_CURSOR_SENTINEL = "__initial__";
const SUGGESTED_WINDOW_MAX_DAYS = 30;
const DEFAULT_STALE_HOURS = 20;
const ENRICH_PREVIEW_DEFAULT_LIMIT = 100;

type RecentSyncRunRow = Awaited<
  ReturnType<typeof listRecentAccountSyncRuns>
>["runs"][number];

function sanitizeRun(run: RecentSyncRunRow) {
  return publicAccountSyncRunSchema.parse({
    ...run,
    status: deriveAccountSyncRunStatus(run),
  });
}

function daysBetween(fromYmd: string, toYmd: string) {
  const from = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const to = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((to - from) / (1000 * 60 * 60 * 24)));
}

function subDaysYmd(ymd: string, days: number) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateOnly(date);
}

export function retainedMetaReportRange(input: {
  dateFrom: string;
  dateTo: string;
  breakdown?: Breakdown | null;
  today: string;
}) {
  const breakdown = input.breakdown ?? null;
  const windowStart = breakdown
    ? breakdownWindowStart(input.today)
    : baseWindowStart(input.today);
  const label = breakdown === "device_platform" ? "device" : breakdown ?? "base";

  if (input.dateTo < windowStart) {
    return { kind: "expired" as const, label, windowStart };
  }

  return {
    kind: "retained" as const,
    dateFrom: input.dateFrom < windowStart ? windowStart : input.dateFrom,
    dateTo: input.dateTo,
    label,
    windowStart,
  };
}

export const metaSyncRouter = router({
  listOrganizations: internalWorkerProcedure
    .output(z.array(z.object({ organizationId: z.string() })))
    .query(async () => {
      const rows = await db
        .selectDistinct({ organizationId: adAccounts.organizationId })
        .from(adAccounts)
        .where(
          and(
            isNotNull(adAccounts.organizationId),
            isNotNull(adAccounts.metaAccessToken),
            eq(adAccounts.isDisabled, false),
          ),
        );

      return rows.flatMap((row) =>
        row.organizationId ? [{ organizationId: row.organizationId }] : [],
      );
    }),

  listSyncableAccounts: orgProcedure
    .input(
      z
        .object({
          staleThresholdHours: z
            .number()
            .int()
            .min(1)
            .max(168)
            .default(DEFAULT_STALE_HOURS),
        })
        .optional(),
    )
    .output(
      z.array(
        z.object({
          accountId: z.string(),
          name: z.string(),
          metaAccountId: z.string(),
          lastSyncedAt: z.date().nullable(),
          dataDateEnd: z.string().nullable(),
          isStale: z.boolean(),
          suggestedDateFrom: z.string(),
          suggestedDateTo: z.string(),
          gapDays: z.number().int(),
        }),
      ),
    )
    .query(async ({ input, ctx }) => {
      const staleHours = input?.staleThresholdHours ?? DEFAULT_STALE_HOURS;
      const today = formatDateOnly(new Date());
      const staleCutoff = Date.now() - staleHours * 60 * 60 * 1000;

      const rows = await db
        .select({
          accountId: adAccounts.id,
          name: adAccounts.name,
          metaAccountId: adAccounts.metaAccountId,
          lastSyncedAt: adAccounts.lastImportedAt,
          dataDateEnd: adAccounts.dataDateEnd,
        })
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.organizationId, ctx.organizationId),
            isNotNull(adAccounts.metaAccessToken),
            eq(adAccounts.isDisabled, false),
          ),
        );

      return rows.map((row) => {
        const lastSyncedAt = row.lastSyncedAt;
        const isStale =
          !lastSyncedAt || new Date(lastSyncedAt).getTime() < staleCutoff;

        let suggestedDateFrom: string;
        let gapDays: number;
        if (row.dataDateEnd) {
          const overlapStart = subDaysYmd(row.dataDateEnd, 1);
          const earliestAllowed = subDaysYmd(today, SUGGESTED_WINDOW_MAX_DAYS);
          suggestedDateFrom =
            overlapStart < earliestAllowed ? earliestAllowed : overlapStart;
          gapDays = Math.min(
            daysBetween(row.dataDateEnd, today),
            SUGGESTED_WINDOW_MAX_DAYS,
          );
        } else {
          suggestedDateFrom = subDaysYmd(today, 7);
          gapDays = 7;
        }

        return {
          ...row,
          isStale,
          suggestedDateFrom,
          suggestedDateTo: today,
          gapDays,
        };
      });
    }),

  startReport: orgWriteProcedure
    .input(
      z.object({
        accountId: z.string(),
        dateFrom: z.string(),
        dateTo: z.string(),
        breakdown: breakdownSchema.nullable().optional(),
        triggerType: z
          .enum(["scheduled", "manual_backfill"])
          .default("manual_backfill"),
      }),
    )
    .output(
      z.object({
        syncRunId: z.string(),
        reportRunId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const breakdown = input.breakdown ?? null;
      const retainedRange = retainedMetaReportRange({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        breakdown,
        today: formatDateOnly(new Date()),
      });
      if (retainedRange.kind === "expired") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `RETENTION_WINDOW_EXPIRED: ${retainedRange.label} data before ${retainedRange.windowStart} is no longer stored`,
        });
      }

      const account = await getMetaAccountWithToken({
        accountId: input.accountId,
        organizationId: ctx.organizationId,
      });

      await syncMetaAccountTimezone(account);

      const { reportRunId } = await requestMetaInsightsReport({
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        dateFrom: retainedRange.dateFrom,
        dateTo: retainedRange.dateTo,
        level: "ad",
        breakdowns: breakdown ? [breakdown] : undefined,
      });

      const run = await createAccountSyncRun({
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        triggerType: input.triggerType,
        dateFrom: retainedRange.dateFrom,
        dateTo: retainedRange.dateTo,
        breakdownsRequested: breakdown ? [breakdown] : [],
        meta: {
          reportRunId,
          breakdown,
          includeBase: !breakdown,
        },
      });

      await updateAccountSyncRun({
        id: run.id,
        startedAt: new Date(),
        currentPhase: "polling",
      });

      // Reference `account` to keep the token validation as a side effect of this call.
      void account;

      return { syncRunId: run.id, reportRunId };
    }),

  pollReport: orgProcedure
    .input(z.object({ syncRunId: z.string() }))
    .output(
      z.object({
        phase: z.enum(["polling", "ready", "importing", "done", "failed"]),
        percentComplete: z.number(),
        ready: z.boolean(),
        errorMessage: z.string().nullable(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const [run] = await db
        .select()
        .from(accountSyncRuns)
        .where(
          and(
            eq(accountSyncRuns.id, input.syncRunId),
            eq(accountSyncRuns.organizationId, ctx.organizationId),
          ),
        );

      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sync run not found",
        });
      }

      if (run.finishedAt) {
        const phase =
          run.result === "success" || run.result === "partial_success"
            ? "done"
            : "failed";
        return {
          phase,
          percentComplete: 100,
          ready: false,
          errorMessage: run.errorMessage,
        };
      }

      const meta = (run.meta ?? {}) as RunMeta;
      if (!meta.reportRunId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Sync run is missing reportRunId",
        });
      }

      const status = await checkMetaInsightsReport({
        organizationId: ctx.organizationId,
        accountId: run.accountId,
        reportRunId: meta.reportRunId,
      });

      if (status.isFailed) {
        await updateAccountSyncRun({
          id: run.id,
          currentPhase: null,
          finishedAt: new Date(),
          result: "failed",
          errorMessage: "Report generation failed on Meta's side.",
        });
        return {
          phase: "failed" as const,
          percentComplete: status.percentComplete,
          ready: false,
          errorMessage: "Report generation failed on Meta's side.",
        };
      }

      if (status.isComplete) {
        if (run.currentPhase !== "ready") {
          await updateAccountSyncRun({ id: run.id, currentPhase: "ready" });
        }
        return {
          phase: "ready" as const,
          percentComplete: 100,
          ready: true,
          errorMessage: null,
        };
      }

      return {
        phase: "polling" as const,
        percentComplete: status.percentComplete,
        ready: false,
        errorMessage: null,
      };
    }),

  importReport: orgWriteProcedure
    .input(
      z.object({
        syncRunId: z.string(),
        cursor: z.string().nullable().optional(),
      }),
    )
    .output(
      z.object({
        done: z.boolean(),
        nextCursor: z.string().nullable(),
        importedThisCall: z.number(),
        totalImported: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [run] = await db
        .select()
        .from(accountSyncRuns)
        .where(
          and(
            eq(accountSyncRuns.id, input.syncRunId),
            eq(accountSyncRuns.organizationId, ctx.organizationId),
          ),
        );

      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sync run not found",
        });
      }

      if (run.finishedAt) {
        return {
          done: true,
          nextCursor: null,
          importedThisCall: 0,
          totalImported: run.rowsSynced,
        };
      }

      const meta = (run.meta ?? {}) as RunMeta;
      if (!meta.reportRunId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Sync run is missing reportRunId",
        });
      }

      const incomingCursor = input.cursor ?? INITIAL_CURSOR_SENTINEL;

      if (meta.lastCursorApplied === incomingCursor) {
        const cachedNext = meta.lastNextCursor ?? null;
        return {
          done: cachedNext === null,
          nextCursor: cachedNext,
          importedThisCall: 0,
          totalImported: run.rowsSynced,
        };
      }

      const account = await getMetaAccountWithToken({
        accountId: run.accountId,
        organizationId: ctx.organizationId,
      });

      if (run.currentPhase !== "importing") {
        await updateAccountSyncRun({ id: run.id, currentPhase: "importing" });
      }

      const page = await fetchMetaInsightsPage({
        accessToken: account.metaAccessToken,
        reportRunId: meta.reportRunId,
        cursor: input.cursor ?? null,
      });

      const breakdown = meta.breakdown ?? null;
      const adMetaIds = [
        ...new Set(
          page.rows.map((row) => row.ad_id).filter(Boolean) as string[],
        ),
      ];

      const deliveryByAdId =
        !breakdown && adMetaIds.length > 0
          ? await fetchMetaAdDelivery({
              adMetaIds,
              accessToken: account.metaAccessToken,
            })
          : undefined;

      const mapped = mapMetaInsightsToRows(
        page.rows as Parameters<typeof mapMetaInsightsToRows>[0],
        "ad",
        { deliveryByAdId },
      );
      const importRows = mapRowsForImport(mapped);

      let importedThisCall = 0;
      if (importRows.length > 0) {
        if (breakdown) {
          const result = await importMetaBreakdownRows({
            organizationId: ctx.organizationId,
            accountId: run.accountId,
            rows: importRows,
          });
          importedThisCall = result.perfLogs;
        } else {
          const result = await importMetaRows({
            organizationId: ctx.organizationId,
            accountId: run.accountId,
            rows: importRows,
          });
          importedThisCall = result.perfLogs;
        }
      }

      const totalImported = run.rowsSynced + importedThisCall;
      const done = page.nextCursor === null;
      const nextMeta: RunMeta = {
        ...meta,
        lastCursorApplied: incomingCursor,
        lastNextCursor: page.nextCursor,
      };

      await updateAccountSyncRun({
        id: run.id,
        rowsSynced: totalImported,
        meta: nextMeta,
        ...(done
          ? {
              currentPhase: null,
              finishedAt: new Date(),
              result: "success" as const,
              breakdownsCompleted: breakdown ? [breakdown] : [],
            }
          : {}),
      });

      return {
        done,
        nextCursor: page.nextCursor,
        importedThisCall,
        totalImported,
      };
    }),

  refreshStatuses: orgWriteProcedure
    .input(z.object({ accountId: z.string() }))
    .output(
      z.object({
        ads: z.object({ checked: z.number(), updated: z.number() }),
        adSets: z.object({ checked: z.number(), updated: z.number() }),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [adResult, adSetResult] = await Promise.all([
        refreshMetaAdStatusesForAccount({
          organizationId: ctx.organizationId,
          accountId: input.accountId,
        }),
        refreshMetaAdSetStatusesForAccount({
          organizationId: ctx.organizationId,
          accountId: input.accountId,
        }),
      ]);

      return { ads: adResult, adSets: adSetResult };
    }),

  enrichPreviews: orgWriteProcedure
    .input(
      z.object({
        accountId: z.string(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(ENRICH_PREVIEW_DEFAULT_LIMIT),
      }),
    )
    .output(
      z.object({
        updatedAds: z.number(),
        updatedCreatives: z.number(),
        remaining: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await getMetaAccountWithToken({
        accountId: input.accountId,
        organizationId: ctx.organizationId,
      });

      const linkedCreativeNeedsEnrichment = sql`exists (
        select 1 from ${adCreatives}
        where ${adCreatives.id} = ${ads.adCreativeId}
          and ${adCreatives.enrichmentAttemptedAt} is null
          and (
            ${adCreatives.assetUrl} is null
            or ${adCreatives.videoUrl} is null
            or ${adCreatives.format} is null
          )
      )`;

      const urlTagsNeedEnrichment = and(
        isNull(ads.urlTagsCheckedAt),
        or(
          isNull(ads.enrichmentAttemptedAt),
          sql`${ads.enrichmentAttemptedAt} < now() - interval '1 hour'`,
        ),
      );

      const needsEnrichment = and(
        eq(ads.accountId, input.accountId),
        eq(ads.organizationId, ctx.organizationId),
        isNotNull(ads.metaId),
        or(
          urlTagsNeedEnrichment,
          and(
            isNull(ads.enrichmentAttemptedAt),
            or(
              isNull(ads.destinationUrl),
              isNull(ads.caption),
              isNull(ads.adCreativeId),
            ),
          ),
          linkedCreativeNeedsEnrichment,
        ),
      );

      const candidates = await db
        .select({ metaId: ads.metaId })
        .from(ads)
        .where(needsEnrichment)
        .orderBy(asc(ads.enrichmentAttemptedAt), asc(ads.id))
        .limit(input.limit);

      const adMetaIds = candidates
        .map((row) => row.metaId)
        .filter((value): value is string => Boolean(value));

      if (adMetaIds.length === 0) {
        return { updatedAds: 0, updatedCreatives: 0, remaining: 0 };
      }

      const result = await enrichMetaCreativePreviews({
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        adMetaIds,
      });

      const [{ remaining = 0 } = { remaining: 0 }] = await db
        .select({ remaining: sql<number>`count(*)::int` })
        .from(ads)
        .where(needsEnrichment);

      return {
        updatedAds: result.updatedAds,
        updatedCreatives: result.updatedCreatives,
        remaining,
      };
    }),

  listRecentRuns: orgProcedure
    .input(
      z
        .object({
          accountId: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(20),
          cursor: z.string().nullable().optional(),
        })
        .optional(),
    )
    .output(
      z.object({
        runs: z.array(publicAccountSyncRunSchema),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const result = await listRecentAccountSyncRuns({
        organizationId: ctx.organizationId,
        accountId: input?.accountId,
        limit: input?.limit ?? 20,
        cursor: input?.cursor ?? null,
      });

      return {
        runs: result.runs.map(sanitizeRun),
        nextCursor: result.nextCursor,
      };
    }),
});
