import { TRPCError } from "@trpc/server";
import { tasks } from "@trigger.dev/sdk";
import { and, asc, count, desc, eq, inArray, isNull, min, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { normalizeAngle } from "@/lib/creative-tag-enrichment";
import {
  clusterVerdictEnum,
  competitorAds,
  competitors,
  copyClusters,
  intelSnapshots,
  intelSourceEnum,
} from "@/schema/competitor-signals";
import { openApiMutationMeta } from "../openapi-meta";
import { orgProcedure, orgWriteProcedure, router } from "../init";
import type {
  CompetitorMediaSource,
  mirrorCompetitorMediaTask,
} from "../../../../trigger/mirror-competitor-media";

// §4: one POST per competitor page carries the full active-ad snapshot; the cap
// keeps a mega-advertiser from making fills and mirroring unbounded.
const MAX_ADS_PER_FILL = 200;
const MAX_TOP_CLUSTERS = 3;

const variantSchema = z.object({
  bodyText: z.string().nullable(),
  title: z.string().nullable(),
  linkUrl: z.string().nullable(),
  media: z.record(z.string(), z.unknown()).nullable(),
});

const normalizedAdSchema = z.object({
  archiveId: z.string(),
  pageId: z.string(),
  pageName: z.string(),
  isActive: z.boolean(),
  startDate: z.coerce.date(),
  bodyText: z.string(),
  linkUrl: z.string(),
  displayFormat: z.enum(["IMAGE", "VIDEO", "CAROUSEL", "DCO", "DPA"]),
  publisherPlatforms: z.array(z.string()),
  raw: z.unknown(),
  title: z.string().nullable(),
  endDate: z.coerce.date().nullable(),
  ctaText: z.string().nullable(),
  ctaType: z.string().nullable(),
  linkDescription: z.string().nullable(),
  collationId: z.string().nullable(),
  collationCount: z.number().int().nullable(),
  imageUrl: z.string().nullable(),
  videoHdUrl: z.string().nullable(),
  videoSdUrl: z.string().nullable(),
  videoPreviewImageUrl: z.string().nullable(),
  variants: z.array(variantSchema).nullable(),
});

// `angle` and `verdict` cross the boundary as free text: the harness is an LLM,
// so the server gatekeeps them (§5) rather than rejecting the whole fill.
const clusterSchema = z.object({
  label: z.string(),
  angle: z.string(),
  summary: z.string(),
  memberArchiveIds: z.array(z.string()),
  verdict: z.string(),
  verdictRationale: z.string(),
});

function normalizeVerdict(
  value: string,
): (typeof clusterVerdictEnum.enumValues)[number] | null {
  const normalized = value.trim().toLowerCase();
  return (
    clusterVerdictEnum.enumValues.find((entry) => entry === normalized) ?? null
  );
}

export const signalsRouter = router({
  addCompetitor: orgWriteProcedure
    .input(z.object({ name: z.string().min(1), metaPageId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const [existing] = await db
        .select({ id: competitors.id })
        .from(competitors)
        .where(
          and(
            eq(competitors.organizationId, ctx.organizationId),
            eq(competitors.metaPageId, input.metaPageId),
          ),
        )
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That Meta page is already tracked as a competitor",
        });
      }

      const [competitor] = await db
        .insert(competitors)
        .values({
          organizationId: ctx.organizationId,
          metaPageId: input.metaPageId,
          name: input.name,
        })
        .returning();

      return competitor;
    }),

  archiveCompetitor: orgWriteProcedure
    .input(z.object({ competitorId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [archived] = await db
        .update(competitors)
        .set({ status: "archived" })
        .where(
          and(
            eq(competitors.id, input.competitorId),
            eq(competitors.organizationId, ctx.organizationId),
          ),
        )
        .returning();

      if (!archived) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Competitor not found",
        });
      }

      return archived;
    }),

  /** Card data for /competitors (§10, Phase 1). */
  listCompetitors: orgProcedure.query(async ({ ctx }) => {
    const [tracked, adStats, clusters, lastFills] = await Promise.all([
      db
        .select()
        .from(competitors)
        .where(
          and(
            eq(competitors.organizationId, ctx.organizationId),
            eq(competitors.status, "active"),
          ),
        )
        .orderBy(asc(competitors.name)),
      db
        .select({
          competitorId: competitorAds.competitorId,
          activeAdCount: count(),
          oldestStartDate: min(competitorAds.startDate),
        })
        .from(competitorAds)
        .where(
          and(
            eq(competitorAds.organizationId, ctx.organizationId),
            isNull(competitorAds.noLongerSeenAt),
          ),
        )
        .groupBy(competitorAds.competitorId),
      db
        .select({
          id: copyClusters.id,
          competitorId: copyClusters.competitorId,
          label: copyClusters.label,
          angle: copyClusters.angle,
          tier: copyClusters.tier,
          score: copyClusters.score,
        })
        .from(copyClusters)
        .where(eq(copyClusters.organizationId, ctx.organizationId)),
      // One row per competitor: the most recent fill run backs the card's
      // "last filled" line.
      db
        .selectDistinctOn([intelSnapshots.competitorId], {
          competitorId: intelSnapshots.competitorId,
          filledAt: intelSnapshots.filledAt,
          adCount: intelSnapshots.adCount,
          source: intelSnapshots.source,
          pipelineStatus: intelSnapshots.pipelineStatus,
          error: intelSnapshots.error,
        })
        .from(intelSnapshots)
        .where(eq(intelSnapshots.organizationId, ctx.organizationId))
        .orderBy(
          asc(intelSnapshots.competitorId),
          desc(intelSnapshots.filledAt),
        ),
    ]);

    const statsByCompetitor = new Map(
      adStats.map((row) => [row.competitorId, row]),
    );
    const fillByCompetitor = new Map(
      lastFills.map((row) => [row.competitorId, row]),
    );
    const clustersByCompetitor = new Map<string, typeof clusters>();
    for (const cluster of clusters) {
      const bucket = clustersByCompetitor.get(cluster.competitorId) ?? [];
      bucket.push(cluster);
      clustersByCompetitor.set(cluster.competitorId, bucket);
    }

    return {
      items: tracked.map((competitor) => {
        const stats = statsByCompetitor.get(competitor.id);
        const ownClusters = clustersByCompetitor.get(competitor.id) ?? [];
        const lastFill = fillByCompetitor.get(competitor.id);

        return {
          id: competitor.id,
          name: competitor.name,
          metaPageId: competitor.metaPageId,
          activeAdCount: stats?.activeAdCount ?? 0,
          oldestStartDate: stats?.oldestStartDate ?? null,
          clusterCount: ownClusters.length,
          // Unscored clusters sort last — a fill that hasn't been scored yet
          // shouldn't outrank a scored one.
          topClusters: [...ownClusters]
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
            .slice(0, MAX_TOP_CLUSTERS)
            .map((cluster) => ({
              id: cluster.id,
              label: cluster.label,
              angle: cluster.angle,
              tier: cluster.tier,
              score: cluster.score,
            })),
          lastFill: lastFill
            ? {
                filledAt: lastFill.filledAt,
                adCount: lastFill.adCount,
                source: lastFill.source,
                pipelineStatus: lastFill.pipelineStatus,
                error: lastFill.error,
              }
            : null,
        };
      }),
    };
  }),

  /**
   * The fill push (§4/§5): one POST per competitor page carrying the full
   * active-ad snapshot. Idempotent — re-posting the same snapshot is safe.
   */
  ingestFill: orgWriteProcedure
    .meta(
      openApiMutationMeta(
        "signals",
        "ingestFill",
        "Push a competitor ad fill",
        "Full active-ad snapshot for one tracked competitor page.",
      ),
    )
    .input(
      z.object({
        competitorPageId: z.string(),
        source: z.enum(intelSourceEnum.enumValues),
        // A repeated archive ID would make the multi-row upsert hit the same
        // row twice ("cannot affect row a second time") — reject it at the
        // boundary as a clean BAD_REQUEST instead of a Postgres 500.
        ads: z
          .array(normalizedAdSchema)
          .max(MAX_ADS_PER_FILL)
          .superRefine((ads, ctx) => {
            const seen = new Set<string>();
            const duplicates = new Set<string>();
            for (const ad of ads) {
              if (seen.has(ad.archiveId)) duplicates.add(ad.archiveId);
              seen.add(ad.archiveId);
            }
            if (duplicates.size > 0) {
              ctx.addIssue({
                code: "custom",
                message: `Duplicate archiveId in fill: ${[...duplicates].join(", ")}`,
              });
            }
          }),
        clusters: z.array(clusterSchema).nullable(),
      }),
    )
    .output(z.object({ snapshotId: z.string(), adCount: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const now = new Date();

      // Source URLs are expiring signed CDN links (§4) — they ride in the job
      // payload and are never persisted.
      const media: CompetitorMediaSource[] = input.ads
        .map((ad) => ({
          archiveId: ad.archiveId,
          imageUrl: ad.imageUrl,
          videoHdUrl: ad.videoHdUrl,
          videoSdUrl: ad.videoSdUrl,
          videoPreviewImageUrl: ad.videoPreviewImageUrl,
        }))
        .filter(
          (item) =>
            item.imageUrl !== null ||
            item.videoHdUrl !== null ||
            item.videoSdUrl !== null ||
            item.videoPreviewImageUrl !== null,
        );

      // A media-less fill that carries clusters still needs the scoring stage
      // (§6/§8) — only a fill with neither is already done at ingest.
      const needsPipeline = media.length > 0 || Boolean(input.clusters?.length);

      const fill = await db.transaction(async (tx) => {
        const [competitor] = await tx
          .select({ id: competitors.id })
          .from(competitors)
          .where(
            and(
              eq(competitors.organizationId, ctx.organizationId),
              eq(competitors.metaPageId, input.competitorPageId),
              eq(competitors.status, "active"),
            ),
          )
          .limit(1);

        if (!competitor) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `No tracked competitor for Meta page ${input.competitorPageId}`,
          });
        }

        const [snapshot] = await tx
          .insert(intelSnapshots)
          .values({
            organizationId: ctx.organizationId,
            competitorId: competitor.id,
            source: input.source,
            adCount: input.ads.length,
            // Nothing to mirror and nothing to score means the pipeline is
            // already done — the status must not sit at "received" forever.
            pipelineStatus: needsPipeline ? "received" : "complete",
            filledAt: now,
          })
          .returning({ id: intelSnapshots.id });

        const archiveIds = input.ads.map((ad) => ad.archiveId);

        if (input.ads.length > 0) {
          await tx
            .insert(competitorAds)
            .values(
              input.ads.map((ad) => ({
                organizationId: ctx.organizationId,
                competitorId: competitor.id,
                archiveId: ad.archiveId,
                startDate: ad.startDate,
                endDate: ad.endDate,
                bodyText: ad.bodyText,
                title: ad.title,
                linkUrl: ad.linkUrl,
                linkDescription: ad.linkDescription,
                ctaText: ad.ctaText,
                ctaType: ad.ctaType,
                displayFormat: ad.displayFormat,
                publisherPlatforms: ad.publisherPlatforms,
                collationId: ad.collationId,
                collationCount: ad.collationCount,
                variants: ad.variants ?? [],
                raw: (ad.raw ?? {}) as Record<string, unknown>,
                firstSeenAt: now,
                lastSeenAt: now,
                noLongerSeenAt: null,
                lastSnapshotId: snapshot.id,
              })),
            )
            .onConflictDoUpdate({
              target: [competitorAds.organizationId, competitorAds.archiveId],
              set: {
                competitorId: sql`excluded.competitor_id`,
                startDate: sql`excluded.start_date`,
                endDate: sql`excluded.end_date`,
                bodyText: sql`excluded.body_text`,
                title: sql`excluded.title`,
                linkUrl: sql`excluded.link_url`,
                linkDescription: sql`excluded.link_description`,
                ctaText: sql`excluded.cta_text`,
                ctaType: sql`excluded.cta_type`,
                displayFormat: sql`excluded.display_format`,
                publisherPlatforms: sql`excluded.publisher_platforms`,
                collationId: sql`excluded.collation_id`,
                collationCount: sql`excluded.collation_count`,
                variants: sql`excluded.variants`,
                raw: sql`excluded.raw`,
                lastSeenAt: sql`excluded.last_seen_at`,
                lastSnapshotId: sql`excluded.last_snapshot_id`,
                // Reappearance: an ad back in the snapshot is live again.
                // firstSeenAt is deliberately absent — it stays at the insert.
                noLongerSeenAt: sql`null`,
                updatedAt: now,
              },
            });
        }

        // Everything this competitor still had live but the snapshot omits.
        await tx
          .update(competitorAds)
          .set({ noLongerSeenAt: now, updatedAt: now })
          .where(
            and(
              eq(competitorAds.organizationId, ctx.organizationId),
              eq(competitorAds.competitorId, competitor.id),
              isNull(competitorAds.noLongerSeenAt),
              archiveIds.length > 0
                ? notInArray(competitorAds.archiveId, archiveIds)
                : undefined,
            ),
          );

        if (input.clusters) {
          // Clusters are wiped and rebuilt per fill (§3) — they describe this
          // snapshot, not a running history.
          await tx
            .delete(copyClusters)
            .where(
              and(
                eq(copyClusters.organizationId, ctx.organizationId),
                eq(copyClusters.competitorId, competitor.id),
              ),
            );

          const memberArchiveIds = new Set<string>();
          for (const cluster of input.clusters) {
            for (const archiveId of cluster.memberArchiveIds) {
              memberArchiveIds.add(archiveId);
            }
          }

          const inserted = input.clusters.length
            ? await tx
                .insert(copyClusters)
                .values(
                  input.clusters.map((cluster) => {
                    const verdict = normalizeVerdict(cluster.verdict);
                    return {
                      organizationId: ctx.organizationId,
                      competitorId: competitor.id,
                      snapshotId: snapshot.id,
                      label: cluster.label,
                      // Gatekeeper (§5): unknown vocabulary degrades to null,
                      // it never rejects the fill.
                      angle: normalizeAngle(cluster.angle),
                      summary: cluster.summary,
                      adCount: cluster.memberArchiveIds.length,
                      verdict,
                      // A bad verdict takes its rationale with it — the UI
                      // shows "strategic read unavailable".
                      verdictRationale: verdict
                        ? cluster.verdictRationale
                        : null,
                    };
                  }),
                )
                .returning({ id: copyClusters.id })
            : [];

          await tx
            .update(competitorAds)
            .set({ copyClusterId: null, updatedAt: now })
            .where(
              and(
                eq(competitorAds.organizationId, ctx.organizationId),
                eq(competitorAds.competitorId, competitor.id),
                memberArchiveIds.size > 0
                  ? notInArray(competitorAds.archiveId, [...memberArchiveIds])
                  : undefined,
              ),
            );

          for (const [index, cluster] of input.clusters.entries()) {
            const clusterId = inserted[index]?.id;
            if (!clusterId || cluster.memberArchiveIds.length === 0) continue;

            await tx
              .update(competitorAds)
              .set({ copyClusterId: clusterId, updatedAt: now })
              .where(
                and(
                  eq(competitorAds.organizationId, ctx.organizationId),
                  eq(competitorAds.competitorId, competitor.id),
                  inArray(competitorAds.archiveId, cluster.memberArchiveIds),
                ),
              );
          }
        }

        return {
          snapshotId: snapshot.id,
          adCount: input.ads.length,
          competitorId: competitor.id,
        };
      });

      // Fired only after the transaction commits — the job reads the ad rows
      // it is about to mirror, so it must not race uncommitted writes.
      if (needsPipeline) {
        try {
          await tasks.trigger<typeof mirrorCompetitorMediaTask>(
            "mirror-competitor-media",
            {
              organizationId: ctx.organizationId,
              competitorId: fill.competitorId,
              snapshotId: fill.snapshotId,
              media,
            },
            // §6: overlapping fills for the same competitor serialize.
            { concurrencyKey: fill.competitorId },
          );
        } catch (error) {
          // Ingest committed but the pipeline never started; the card's failed
          // state is how the operator finds out.
          const message =
            error instanceof Error ? error.message : String(error);
          await db
            .update(intelSnapshots)
            .set({ pipelineStatus: "failed", error: message })
            .where(eq(intelSnapshots.id, fill.snapshotId));

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Fill stored but the mirror pipeline failed to start: ${message}`,
          });
        }
      }

      return { snapshotId: fill.snapshotId, adCount: fill.adCount };
    }),
});
