import { TRPCError } from "@trpc/server";
import { tasks } from "@trigger.dev/sdk";
import { and, desc, eq, gt, isNotNull, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  findingBody,
  findingHeadline,
  type VoiceContext,
} from "@/components/blocks/attribution/copy";
import { getStoreForOrg } from "@/lib/attribution-queries";
import {
  getTodaysChecks,
  mutedUntilFrom,
  type FindingType,
} from "@/lib/findings";
import {
  findingMutes,
  findingResolutionEnum,
  findingTypeEnum,
  findings,
} from "@/schema/finding";
import { orgProcedure, orgWriteProcedure, router } from "../init";
import { openApiQueryMeta } from "../openapi-meta";
import { requireStore } from "./attribution.shared";
import type { metaSyncTask } from "../../../../trigger/meta-sync";
import type { shopifyIncrementalTask } from "../../../../trigger/shopify-sync";

// Derived from the pg enums, never hand-copied: these schemas are enforced at
// runtime on every response, so a literal list that drifts from the DB enum turns
// a new finding type into a 500 instead of a row.
const findingTypeSchema = z.enum(findingTypeEnum.enumValues);

// Output schemas exist for the OpenAPI surface (the generator requires a typed
// response) and must mirror the resolver returns exactly — these procedures
// also serve the web UI, and output parsing strips anything undeclared.
const findingListItemSchema = z.object({
  id: z.string().nullable(),
  type: findingTypeSchema,
  firedAt: z.date().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  resolvedAt: z.date().nullable(),
  resolution: z.enum(findingResolutionEnum.enumValues).nullable(),
  mutedUntil: z.date().nullable(),
  /** The headline the attribution screen shows for this finding, word for word. */
  summary: z.string(),
  /** The paragraphs under that headline, carrying the figures. */
  details: z.array(z.string()),
});

const listOutputSchema = z.object({ items: z.array(findingListItemSchema) });

const checksOutputSchema = z.object({
  checks: z.array(
    z.object({
      type: findingTypeSchema,
      status: z.enum(["ok", "needs_look", "waiting_for_data"]),
    }),
  ),
});

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

type RenderedFindingListItem = FindingListItem & {
  summary: string;
  details: string[];
};

/**
 * The finding sentences, rendered server-side in the store's currency and
 * timezone. Payload figures are frozen in mixed units — cents in some rules,
 * dollars in others — and an API client should not have to know which. These
 * are the same two functions the attribution screen renders through, so a
 * client quoting `summary` says exactly what the dashboard says.
 */
function render(
  items: FindingListItem[],
  voice: VoiceContext,
): RenderedFindingListItem[] {
  return items.map((item) => ({
    ...item,
    summary: findingHeadline(item, voice),
    details: findingBody(item, voice),
  }));
}

/**
 * The same fallbacks the attribution page uses. Findings are foreign-keyed to a
 * store, so a missing one means an empty list rather than an error — this read
 * stays a 200 for an org that has not connected Shopify yet.
 */
async function voiceContextFor(organizationId: string): Promise<VoiceContext> {
  const store = await getStoreForOrg(organizationId);
  return {
    currency: store?.currency ?? "USD",
    timeZone: store?.ianaTimezone ?? "UTC",
  };
}

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
    .meta(
      openApiQueryMeta(
        "findings",
        "list",
        "List findings",
        "Automated data-quality and performance findings for the org, filtered by status: open (unresolved, unmuted), handled (resolved), or snoozed (muted types).",
      ),
    )
    .input(z.object({ status: z.enum(["open", "handled", "snoozed"]) }))
    .output(listOutputSchema)
    .query(async ({ input, ctx }): Promise<{
      items: RenderedFindingListItem[];
    }> => {
      const now = new Date();
      const [mutes, voice] = await Promise.all([
        activeMutes(ctx.organizationId, now),
        voiceContextFor(ctx.organizationId),
      ]);
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
          items: render(
            items.sort(
              (a, b) =>
                (b.firedAt?.getTime() ?? 0) - (a.firedAt?.getTime() ?? 0),
            ),
            voice,
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

      return { items: render(rows.map((row) => toItem(row)), voice) };
    }),

  checks: orgProcedure
    .meta(
      openApiQueryMeta(
        "findings",
        "checks",
        "Today's finding checks",
        "Each finding rule with its current status: ok, needs_look (an open finding fired), or waiting_for_data (sync too stale to judge).",
      ),
    )
    .output(checksOutputSchema)
    .query(async ({ ctx }) => {
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
