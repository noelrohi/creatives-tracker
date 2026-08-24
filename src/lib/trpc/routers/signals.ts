import { TRPCError } from "@trpc/server";
import { tasks } from "@trigger.dev/sdk";
import { and, asc, count, desc, eq, inArray, isNull, min, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import type { ScorableAdRow } from "@/lib/competitor-signals/score";
import {
  creativeCount,
  landingFocusShare,
  resolveFormat,
  scoreCompetitorClusters,
  stripQuery,
  toScoredAdInput,
} from "@/lib/competitor-signals/score";
import {
  adIsVideo,
  adThumbnailUrl,
  previewAdSchema,
  toPreviewAd,
} from "@/lib/competitor-signals/preview-ads";
import { extractRawPrimaryMedia } from "@/lib/competitor-signals/raw-media";
import { normalizeAngle } from "@/lib/creative-tag-enrichment";
import {
  clusterTierEnum,
  clusterVerdictEnum,
  competitorAds,
  competitors,
  copyClusters,
  intelPipelineStatusEnum,
  intelSnapshots,
  intelSourceEnum,
} from "@/schema/competitor-signals";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { orgProcedure, orgWriteProcedure, router } from "../init";
import { signalsFeedbackProcedures } from "./signals.feedback";
import { signalsPlanProcedures } from "./signals.plan";
import type {
  CompetitorMediaSource,
  mirrorCompetitorMediaTask,
} from "../../../../trigger/mirror-competitor-media";

// §4: one POST per competitor page carries the full active-ad snapshot; the cap
// keeps a mega-advertiser from making fills and mirroring unbounded.
const MAX_ADS_PER_FILL = 200;
const MAX_TOP_CLUSTERS = 3;
// Thumbnails shown inline on cards and in the evidence panel; the full grid
// lives on the competitor page.
const MAX_CARD_PREVIEWS = 4;
const MAX_SIGNAL_PREVIEWS = 5;

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
  // What the ad's creatives actually carry, resolved device-side from the
  // source creatives (§4). Nullable so a harness that predates the field still
  // fills; those ads fall back to mirrored media for format breadth (§8).
  mediaKinds: z.array(z.enum(["image", "video"])).nullable(),
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

/** Canonical order for the three resolved formats (§8) so output is stable. */
const FORMAT_ORDER = ["image", "video", "carousel"] as const;

/**
 * The member-ad columns the evidence extras (§9) need: the scoring inputs plus
 * the body text that becomes the cluster's representative copy, and the
 * identity/media columns the evidence panel's ad previews render from.
 */
type EvidenceAdRow = ScorableAdRow & {
  bodyText: string;
  archiveId: string;
  mirroredPreviewUrl: string | null;
};

/**
 * Evidence extras the plan generator gets per cluster (§9). Derived from the
 * same rows and the same helpers the score uses — never re-derived by hand.
 */
function clusterEvidence(ads: EvidenceAdRow[]) {
  const inputs = ads.map(toScoredAdInput);

  const formats = new Set(
    inputs.map(resolveFormat).filter((format) => format !== null),
  );

  // The modal landing page is the destination the cluster actually points at;
  // stripQuery drops the tracking noise so variants of one URL collapse.
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const url = stripQuery(input.linkUrl);
    if (!url) continue;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  let landingFocusUrl: string | null = null;
  let modalCount = 0;
  for (const [url, value] of counts) {
    if (value > modalCount) {
      modalCount = value;
      landingFocusUrl = url;
    }
  }

  // Longest-running = earliest start date, the same evidence longevity scores.
  const representative = ads.reduce<EvidenceAdRow | null>(
    (oldest, ad) =>
      !oldest || ad.startDate.getTime() < oldest.startDate.getTime()
        ? ad
        : oldest,
    null,
  );

  return {
    formatsObserved: FORMAT_ORDER.filter((format) => formats.has(format)),
    landingFocusUrl,
    landingFocusShare: landingFocusShare(inputs),
    // Total creatives (primary + variants[] per ad) — the same count variant
    // multiplication scores, so the Variations meter and its bar agree.
    creativeCount: creativeCount(inputs),
    representativeCopy: representative?.bodyText ?? null,
    oldestStartDate: representative?.startDate ?? null,
    // Longest-running first, mirroring the competitor ad grid's default sort.
    previewAds: [...ads]
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
      .flatMap((ad) => toPreviewAd(ad) ?? [])
      .slice(0, MAX_SIGNAL_PREVIEWS),
  };
}

/** Member ads keyed by cluster; ads with no cluster are dropped. */
function groupAdsByCluster<T extends { copyClusterId: string | null }>(
  ads: T[],
): Map<string, T[]> {
  const byCluster = new Map<string, T[]>();
  for (const ad of ads) {
    if (!ad.copyClusterId) continue;
    const bucket = byCluster.get(ad.copyClusterId) ?? [];
    bucket.push(ad);
    byCluster.set(ad.copyClusterId, bucket);
  }
  return byCluster;
}

// The `signals.*` namespace stays flat (§5) as the router splits by domain —
// the plan procedures spread in rather than nesting under a sub-router.
export const signalsRouter = router({
  ...signalsPlanProcedures,
  ...signalsFeedbackProcedures,

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
    const [tracked, adStats, clusters, lastFills, liveAds, successfulFills] =
      await Promise.all([
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
          adCount: copyClusters.adCount,
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
      // Live ads, longest-running first: the card's creative strip and each
      // cluster's "N days" line derive from these rows.
      db
        .select({
          competitorId: competitorAds.competitorId,
          copyClusterId: competitorAds.copyClusterId,
          archiveId: competitorAds.archiveId,
          startDate: competitorAds.startDate,
          mediaKinds: competitorAds.mediaKinds,
          mirroredPreviewUrl: competitorAds.mirroredPreviewUrl,
          mirroredImageUrl: competitorAds.mirroredImageUrl,
          mirroredVideoUrl: competitorAds.mirroredVideoUrl,
        })
        .from(competitorAds)
        .where(
          and(
            eq(competitorAds.organizationId, ctx.organizationId),
            isNull(competitorAds.noLongerSeenAt),
          ),
        )
        .orderBy(asc(competitorAds.startDate)),
      // When the latest fill failed, the card still names the date the data on
      // it actually comes from.
      db
        .selectDistinctOn([intelSnapshots.competitorId], {
          competitorId: intelSnapshots.competitorId,
          filledAt: intelSnapshots.filledAt,
        })
        .from(intelSnapshots)
        .where(
          and(
            eq(intelSnapshots.organizationId, ctx.organizationId),
            eq(intelSnapshots.pipelineStatus, "complete"),
          ),
        )
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
    const successByCompetitor = new Map(
      successfulFills.map((row) => [row.competitorId, row.filledAt]),
    );
    const clustersByCompetitor = new Map<string, typeof clusters>();
    for (const cluster of clusters) {
      const bucket = clustersByCompetitor.get(cluster.competitorId) ?? [];
      bucket.push(cluster);
      clustersByCompetitor.set(cluster.competitorId, bucket);
    }
    const liveAdsByCompetitor = new Map<string, typeof liveAds>();
    const clusterOldestStart = new Map<string, Date>();
    for (const ad of liveAds) {
      const bucket = liveAdsByCompetitor.get(ad.competitorId) ?? [];
      bucket.push(ad);
      liveAdsByCompetitor.set(ad.competitorId, bucket);
      // Rows arrive startDate-ascending, so the first ad per cluster wins.
      if (ad.copyClusterId && !clusterOldestStart.has(ad.copyClusterId)) {
        clusterOldestStart.set(ad.copyClusterId, ad.startDate);
      }
    }

    return {
      items: tracked.map((competitor) => {
        const stats = statsByCompetitor.get(competitor.id);
        const ownClusters = clustersByCompetitor.get(competitor.id) ?? [];
        const lastFill = fillByCompetitor.get(competitor.id);
        const ownAds = liveAdsByCompetitor.get(competitor.id) ?? [];
        const recentAds = ownAds
          .flatMap((ad) => toPreviewAd(ad) ?? [])
          .slice(0, MAX_CARD_PREVIEWS);

        return {
          id: competitor.id,
          name: competitor.name,
          metaPageId: competitor.metaPageId,
          activeAdCount: stats?.activeAdCount ?? 0,
          oldestStartDate: stats?.oldestStartDate ?? null,
          clusterCount: ownClusters.length,
          recentAds,
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
              adCount: cluster.adCount,
              oldestStartDate: clusterOldestStart.get(cluster.id) ?? null,
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
          lastSuccessfulFillAt: successByCompetitor.get(competitor.id) ?? null,
        };
      }),
    };
  }),

  /**
   * The competitor ad grid (/competitors/[competitorId]): every ad still
   * active as of the last fill, with its mirrored creative, longest-running
   * first. Filters and sorting are client-side — a fill caps at 200 ads, so
   * the whole set ships at once.
   */
  listCompetitorAds: orgProcedure
    .input(z.object({ competitorId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [competitor] = await db
        .select({
          id: competitors.id,
          name: competitors.name,
          metaPageId: competitors.metaPageId,
        })
        .from(competitors)
        .where(
          and(
            eq(competitors.id, input.competitorId),
            eq(competitors.organizationId, ctx.organizationId),
            eq(competitors.status, "active"),
          ),
        )
        .limit(1);

      if (!competitor) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Competitor not found",
        });
      }

      const [ads, clusters, fills] = await Promise.all([
        db
          .select({
            id: competitorAds.id,
            archiveId: competitorAds.archiveId,
            workflowStatus: competitorAds.workflowStatus,
            startDate: competitorAds.startDate,
            displayFormat: competitorAds.displayFormat,
            copyClusterId: competitorAds.copyClusterId,
            mediaKinds: competitorAds.mediaKinds,
            mirroredPreviewUrl: competitorAds.mirroredPreviewUrl,
            mirroredImageUrl: competitorAds.mirroredImageUrl,
            mirroredVideoUrl: competitorAds.mirroredVideoUrl,
          })
          .from(competitorAds)
          .where(
            and(
              eq(competitorAds.organizationId, ctx.organizationId),
              eq(competitorAds.competitorId, input.competitorId),
              isNull(competitorAds.noLongerSeenAt),
            ),
          )
          .orderBy(asc(competitorAds.startDate)),
        db
          .select({ id: copyClusters.id, label: copyClusters.label })
          .from(copyClusters)
          .where(
            and(
              eq(copyClusters.organizationId, ctx.organizationId),
              eq(copyClusters.competitorId, input.competitorId),
            ),
          ),
        db
          .selectDistinctOn([intelSnapshots.competitorId], {
            competitorId: intelSnapshots.competitorId,
            filledAt: intelSnapshots.filledAt,
          })
          .from(intelSnapshots)
          .where(
            and(
              eq(intelSnapshots.organizationId, ctx.organizationId),
              eq(intelSnapshots.competitorId, input.competitorId),
            ),
          )
          .orderBy(
            asc(intelSnapshots.competitorId),
            desc(intelSnapshots.filledAt),
          ),
      ]);

      const clusterLabelById = new Map(
        clusters.map((cluster) => [cluster.id, cluster.label]),
      );

      return {
        competitor,
        updatedAt: fills[0]?.filledAt ?? null,
        ads: ads.map((ad) => ({
          id: ad.id,
          archiveId: ad.archiveId,
          workflowStatus: ad.workflowStatus,
          startDate: ad.startDate,
          displayFormat: ad.displayFormat,
          mediaKinds: ad.mediaKinds,
          thumbnailUrl: adThumbnailUrl(ad),
          isVideo: adIsVideo(ad),
          videoUrl: ad.mirroredVideoUrl,
          theme: ad.copyClusterId
            ? (clusterLabelById.get(ad.copyClusterId) ?? null)
            : null,
        })),
      };
    }),

  /**
   * Bulk workflow-status move for the competitor ad triage board. Any org
   * member can move rows; organization scoping prevents cross-org updates.
   */
  setAdWorkflowStatus: orgWriteProcedure
    .input(
      z.object({
        adIds: z.array(z.string()).min(1).max(200),
        status: z.enum(["inbox", "shortlist", "deprioritised", "made"]),
      }),
    )
    .output(z.object({ updated: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const updated = await db
        .update(competitorAds)
        .set({ workflowStatus: input.status })
        .where(
          and(
            eq(competitorAds.organizationId, ctx.organizationId),
            inArray(competitorAds.id, input.adIds),
          ),
        )
        .returning({ id: competitorAds.id });

      return { updated: updated.length };
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
      // payload and are never persisted. A harness that missed the primary
      // creative's media (card-based ads keep it in raw cards, not top-level)
      // sends all four as null; recover them from the verbatim raw payload
      // rather than leaving the ad with nothing to mirror.
      const media: CompetitorMediaSource[] = input.ads
        .map((ad) => {
          const hasTopLevelMedia =
            ad.imageUrl !== null ||
            ad.videoHdUrl !== null ||
            ad.videoSdUrl !== null ||
            ad.videoPreviewImageUrl !== null;
          const fallback = hasTopLevelMedia
            ? null
            : extractRawPrimaryMedia(ad.raw);
          return {
            archiveId: ad.archiveId,
            imageUrl: ad.imageUrl ?? fallback?.imageUrl ?? null,
            videoHdUrl: ad.videoHdUrl ?? fallback?.videoHdUrl ?? null,
            videoSdUrl: ad.videoSdUrl ?? fallback?.videoSdUrl ?? null,
            videoPreviewImageUrl:
              ad.videoPreviewImageUrl ?? fallback?.videoPreviewImageUrl ?? null,
          };
        })
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
                mediaKinds: ad.mediaKinds ?? [],
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
                mediaKinds: sql`excluded.media_kinds`,
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

  /**
   * The harness read-back (§9/§11 step 7): the cross-fill, cross-competitor
   * ranking plus each competitor's latest fill status, so one GET both drives
   * the poll loop and feeds plan generation.
   */
  rankedSignals: orgProcedure
    .meta(
      openApiQueryMeta(
        "signals",
        "rankedSignals",
        "Read the ranked competitor signals",
        "Cross-competitor cluster ranking with evidence extras and per-competitor fill status.",
      ),
    )
    .output(
      z.object({
        signals: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            angle: z.string().nullable(),
            summary: z.string(),
            adCount: z.number().int(),
            score: z.number().nullable(),
            tier: z.enum(clusterTierEnum.enumValues).nullable(),
            longevityPoints: z.number().nullable(),
            variantPoints: z.number().nullable(),
            strategicPoints: z.number().nullable(),
            formatPoints: z.number().nullable(),
            landingPoints: z.number().nullable(),
            verdict: z.enum(clusterVerdictEnum.enumValues).nullable(),
            verdictRationale: z.string().nullable(),
            competitor: z.object({
              id: z.string(),
              name: z.string(),
              metaPageId: z.string(),
            }),
            formatsObserved: z.array(z.enum(FORMAT_ORDER)),
            landingFocusUrl: z.string().nullable(),
            landingFocusShare: z.number(),
            creativeCount: z.number().int(),
            representativeCopy: z.string().nullable(),
            oldestStartDate: z.date().nullable(),
            previewAds: z.array(previewAdSchema),
          }),
        ),
        fills: z.array(
          z.object({
            competitorId: z.string(),
            snapshotId: z.string(),
            pipelineStatus: z.enum(intelPipelineStatusEnum.enumValues),
            error: z.string().nullable(),
            filledAt: z.date(),
          }),
        ),
      }),
    )
    .query(async ({ ctx }) => {
      const tracked = await db
        .select({
          id: competitors.id,
          name: competitors.name,
          metaPageId: competitors.metaPageId,
        })
        .from(competitors)
        .where(
          and(
            eq(competitors.organizationId, ctx.organizationId),
            eq(competitors.status, "active"),
          ),
        )
        .orderBy(asc(competitors.name));

      if (tracked.length === 0) return { signals: [], fills: [] };

      const competitorIds = tracked.map((competitor) => competitor.id);

      const [clusters, fills] = await Promise.all([
        db
          .select()
          .from(copyClusters)
          .where(
            and(
              eq(copyClusters.organizationId, ctx.organizationId),
              inArray(copyClusters.competitorId, competitorIds),
            ),
          ),
        db
          .selectDistinctOn([intelSnapshots.competitorId], {
            competitorId: intelSnapshots.competitorId,
            snapshotId: intelSnapshots.id,
            pipelineStatus: intelSnapshots.pipelineStatus,
            error: intelSnapshots.error,
            filledAt: intelSnapshots.filledAt,
          })
          .from(intelSnapshots)
          .where(
            and(
              eq(intelSnapshots.organizationId, ctx.organizationId),
              inArray(intelSnapshots.competitorId, competitorIds),
            ),
          )
          .orderBy(
            asc(intelSnapshots.competitorId),
            desc(intelSnapshots.filledAt),
          ),
      ]);

      const clusterIds = clusters.map((cluster) => cluster.id);
      const ads: EvidenceAdRow[] = clusterIds.length
        ? await db
            .select({
              copyClusterId: competitorAds.copyClusterId,
              archiveId: competitorAds.archiveId,
              bodyText: competitorAds.bodyText,
              startDate: competitorAds.startDate,
              displayFormat: competitorAds.displayFormat,
              linkUrl: competitorAds.linkUrl,
              variants: competitorAds.variants,
              mediaKinds: competitorAds.mediaKinds,
              mirroredImageUrl: competitorAds.mirroredImageUrl,
              mirroredVideoUrl: competitorAds.mirroredVideoUrl,
              mirroredPreviewUrl: competitorAds.mirroredPreviewUrl,
            })
            .from(competitorAds)
            .where(
              and(
                eq(competitorAds.organizationId, ctx.organizationId),
                inArray(competitorAds.copyClusterId, clusterIds),
              ),
            )
        : [];

      const adsByCluster = groupAdsByCluster(ads);
      const competitorById = new Map(
        tracked.map((competitor) => [competitor.id, competitor]),
      );

      const signals = clusters
        // An unscored cluster sorts last but is never dropped — the harness
        // still needs to see it (and the poll loop to notice it exists).
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .flatMap((cluster) => {
          const competitor = competitorById.get(cluster.competitorId);
          if (!competitor) return [];

          return [
            {
              id: cluster.id,
              label: cluster.label,
              angle: cluster.angle,
              summary: cluster.summary,
              adCount: cluster.adCount,
              score: cluster.score,
              tier: cluster.tier,
              longevityPoints: cluster.longevityPoints,
              variantPoints: cluster.variantPoints,
              strategicPoints: cluster.strategicPoints,
              formatPoints: cluster.formatPoints,
              landingPoints: cluster.landingPoints,
              verdict: cluster.verdict,
              verdictRationale: cluster.verdictRationale,
              competitor: {
                id: competitor.id,
                name: competitor.name,
                metaPageId: competitor.metaPageId,
              },
              ...clusterEvidence(adsByCluster.get(cluster.id) ?? []),
            },
          ];
        });

      return { signals, fills };
    }),

  /**
   * In-app rescore (§2): the score is a pure function over stored inputs, so
   * this runs synchronously — no Trigger.dev, no re-cluster, no re-fill.
   */
  rescore: orgWriteProcedure.mutation(async ({ ctx }) => {
    const tracked = await db
      .select({ id: competitors.id })
      .from(competitors)
      .where(
        and(
          eq(competitors.organizationId, ctx.organizationId),
          eq(competitors.status, "active"),
        ),
      );

    if (tracked.length === 0) return { clustersRescored: 0 };

    const competitorIds = tracked.map((competitor) => competitor.id);

    const clusters = await db
      .select({
        id: copyClusters.id,
        competitorId: copyClusters.competitorId,
        verdict: copyClusters.verdict,
      })
      .from(copyClusters)
      .where(
        and(
          eq(copyClusters.organizationId, ctx.organizationId),
          inArray(copyClusters.competitorId, competitorIds),
        ),
      );

    if (clusters.length === 0) return { clustersRescored: 0 };

    const ads = await db
      .select({
        copyClusterId: competitorAds.copyClusterId,
        startDate: competitorAds.startDate,
        displayFormat: competitorAds.displayFormat,
        linkUrl: competitorAds.linkUrl,
        variants: competitorAds.variants,
        mediaKinds: competitorAds.mediaKinds,
        mirroredImageUrl: competitorAds.mirroredImageUrl,
        mirroredVideoUrl: competitorAds.mirroredVideoUrl,
      })
      .from(competitorAds)
      .where(
        and(
          eq(competitorAds.organizationId, ctx.organizationId),
          inArray(
            competitorAds.copyClusterId,
            clusters.map((cluster) => cluster.id),
          ),
        ),
      );

    const adsByCluster = groupAdsByCluster(ads);
    const now = new Date();

    // Scored per competitor (§8 is per-cluster, but the grouping keeps one
    // competitor's ads from ever leaking into another's cluster).
    const updates = competitorIds.flatMap((competitorId) => {
      const own = clusters.filter(
        (cluster) => cluster.competitorId === competitorId,
      );
      if (own.length === 0) return [];

      return scoreCompetitorClusters({
        clusters: own,
        ads: own.flatMap((cluster) => adsByCluster.get(cluster.id) ?? []),
        now,
      });
    });

    for (const update of updates) {
      await db
        .update(copyClusters)
        .set({
          score: update.score,
          tier: update.tier,
          longevityPoints: update.longevityPoints,
          variantPoints: update.variantPoints,
          strategicPoints: update.strategicPoints,
          formatPoints: update.formatPoints,
          landingPoints: update.landingPoints,
        })
        .where(
          and(
            eq(copyClusters.id, update.clusterId),
            eq(copyClusters.organizationId, ctx.organizationId),
          ),
        );
    }

    return { clustersRescored: updates.length };
  }),
});
