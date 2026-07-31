import { TRPCError } from "@trpc/server";
import { tasks } from "@trigger.dev/sdk";
import { and, desc, eq, gt, isNotNull, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  FINDING_TYPES,
  getTodaysChecks,
  mutedUntilFrom,
  type FindingType,
} from "@/lib/findings";
import { findingMutes, findings } from "@/schema/finding";
import { orgProcedure, orgWriteProcedure, router } from "../init";
import { requireStore } from "./attribution.shared";
import type { metaSyncTask } from "../../../../trigger/meta-sync";
import type { shopifyIncrementalTask } from "../../../../trigger/shopify-sync";

const findingTypeSchema = z.enum(FINDING_TYPES);

type FindingRow = typeof findings.$inferSelect;

type FindingListItem = {
  /** Null only for a mute that has never had a finding fire behind it. */
  id: string | null;
  type: FindingType;
  firedAt: Date | null;
  periodStart: string | null;
  periodEnd: string | null;
  payload: Record<string, unknown> | null;
  resolvedAt: Date | null;
  /** How it closed. Null on rows closed before the two were told apart. */
  resolution: FindingRow["resolution"];
  mutedUntil: Date | null;
};

function toItem(
  row: FindingRow,
  mutedUntil: Date | null = null,
): FindingListItem {
  return {
    id: row.id,
    type: row.type,
    firedAt: row.firedAt,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payload: row.payload,
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
    mutedUntil,
  };
}

async function activeMutes(organizationId: string, now: Date) {
  return db
    .select({
      type: findingMutes.type,
      mutedUntil: findingMutes.mutedUntil,
    })
    .from(findingMutes)
    .where(
      and(
        eq(findingMutes.organizationId, organizationId),
        gt(findingMutes.mutedUntil, now),
      ),
    );
}

export const findingsRouter = router({
  list: orgProcedure
    .input(z.object({ status: z.enum(["open", "handled", "snoozed"]) }))
    .query(async ({ input, ctx }): Promise<{ items: FindingListItem[] }> => {
      const now = new Date();
      const mutes = await activeMutes(ctx.organizationId, now);
      const mutedTypes = mutes.map((mute) => mute.type);

      if (input.status === "snoozed") {
        // A mute row is the subject here; its newest finding is the detail.
        const items = await Promise.all(
          mutes.map(async (mute) => {
            const [row] = await db
              .select()
              .from(findings)
              .where(
                and(
                  eq(findings.organizationId, ctx.organizationId),
                  eq(findings.type, mute.type),
                ),
              )
              .orderBy(desc(findings.firedAt))
              .limit(1);

            return row
              ? toItem(row, mute.mutedUntil)
              : {
                  id: null,
                  type: mute.type,
                  firedAt: null,
                  periodStart: null,
                  periodEnd: null,
                  payload: null,
                  resolvedAt: null,
                  resolution: null,
                  mutedUntil: mute.mutedUntil,
                };
          }),
        );

        return {
          items: items.sort(
            (a, b) => (b.firedAt?.getTime() ?? 0) - (a.firedAt?.getTime() ?? 0),
          ),
        };
      }

      const rows = await db
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.organizationId, ctx.organizationId),
            input.status === "open"
              ? isNull(findings.resolvedAt)
              : isNotNull(findings.resolvedAt),
            input.status === "open" && mutedTypes.length > 0
              ? notInArray(findings.type, mutedTypes)
              : undefined,
          ),
        )
        .orderBy(desc(findings.firedAt));

      return { items: rows.map((row) => toItem(row)) };
    }),

  checks: orgProcedure.query(async ({ ctx }) => {
    const store = await requireStore(ctx.organizationId);
    const checks = await getTodaysChecks({
      organizationId: ctx.organizationId,
      storeId: store.id,
    });

    return { checks };
  }),

  markResolved: orgWriteProcedure
    .input(z.object({ findingId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .select({ id: findings.id })
        .from(findings)
        .where(
          and(
            eq(findings.id, input.findingId),
            eq(findings.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Finding not found" });
      }

      const resolvedAt = new Date();
      await db
        .update(findings)
        .set({ resolvedAt, resolution: "handled" })
        .where(eq(findings.id, row.id));

      return { findingId: row.id, resolvedAt };
    }),

  mute: orgWriteProcedure
    .input(z.object({ type: findingTypeSchema }))
    .mutation(async ({ input, ctx }) => {
      const mutedUntil = mutedUntilFrom(new Date());

      await db
        .insert(findingMutes)
        .values({
          organizationId: ctx.organizationId,
          type: input.type,
          mutedUntil,
        })
        .onConflictDoUpdate({
          target: [findingMutes.organizationId, findingMutes.type],
          set: { mutedUntil },
        });

      return { type: input.type, mutedUntil };
    }),

  rerunSync: orgWriteProcedure
    .input(z.object({ findingId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.id, input.findingId),
            eq(findings.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Finding not found" });
      }

      if (row.type !== "sync_failure") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only a sync_failure finding can be re-run",
        });
      }

      // The connector was frozen into the payload when the finding fired.
      const connector = row.payload?.connector;
      if (connector !== "shopify" && connector !== "meta") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Finding payload names no re-runnable connector",
        });
      }

      const handle =
        connector === "shopify"
          ? await tasks.trigger<typeof shopifyIncrementalTask>(
              "shopify-incremental",
              {
                organizationId: ctx.organizationId,
                triggerType: "manual",
              },
            )
          : await tasks.trigger<typeof metaSyncTask>("meta-sync", {
              organizationId: ctx.organizationId,
              triggerType: "manual_backfill",
            });

      return { connector, runId: handle.id };
    }),
});
