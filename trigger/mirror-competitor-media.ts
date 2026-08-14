/** Mirror a competitor fill's expiring CDN media into Blob, in bounded child batches. */
import { put } from "@vercel/blob";
import { logger, metadata, tags, task } from "@trigger.dev/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { fetchRemoteImage } from "@/lib/remote-image";
import { competitorAds, intelSnapshots } from "@/schema/competitor-signals";

const MEDIA_BATCH_SIZE = 10;

export type CompetitorMediaSource = {
  archiveId: string;
  imageUrl: string | null;
  videoHdUrl: string | null;
  videoSdUrl: string | null;
  videoPreviewImageUrl: string | null;
};

export type MirrorCompetitorMediaPayload = {
  organizationId: string;
  competitorId: string;
  snapshotId: string;
  /** Source URLs ride in the payload — they expire and are never persisted. */
  media: CompetitorMediaSource[];
};

type MirrorCompetitorMediaBatchPayload = {
  organizationId: string;
  competitorId: string;
  media: CompetitorMediaSource[];
};

type MirrorSlot = "image" | "video" | "preview";

function blobEnvPrefix() {
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

function getImageExtension(contentType: string | null, sourceUrl: string): string {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalizedContentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      break;
  }

  try {
    const match = new URL(sourceUrl).pathname.match(/\.([a-z0-9]+)$/i);
    if (match?.[1]) {
      const extension = match[1].toLowerCase();
      return extension === "jpeg" ? "jpg" : extension;
    }
  } catch {
    return "jpg";
  }

  return "jpg";
}

function getVideoExtension(contentType: string | null, sourceUrl: string): string {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalizedContentType) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "video/ogg":
      return "ogv";
    default:
      break;
  }

  try {
    const match = new URL(sourceUrl).pathname.match(/\.([a-z0-9]+)$/i);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    return "mp4";
  }

  return "mp4";
}

async function mirrorImage(input: {
  archiveId: string;
  slot: MirrorSlot;
  sourceUrl: string;
}): Promise<string> {
  const image = await fetchRemoteImage(input.sourceUrl);
  const extension = getImageExtension(null, input.sourceUrl);
  const blob = await put(
    `${blobEnvPrefix()}/competitor-media/${input.archiveId}-${input.slot}.${extension}`,
    Buffer.from(image),
    { access: "public", allowOverwrite: true },
  );
  return blob.url;
}

async function mirrorVideo(input: {
  archiveId: string;
  sourceUrl: string;
}): Promise<string> {
  const response = await fetch(input.sourceUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch competitor video: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type");
  const extension = getVideoExtension(contentType, input.sourceUrl);
  const body = response.body ?? (await response.arrayBuffer());
  const blob = await put(
    `${blobEnvPrefix()}/competitor-media/${input.archiveId}-video.${extension}`,
    body,
    {
      access: "public",
      allowOverwrite: true,
      contentType: contentType ?? undefined,
    },
  );
  return blob.url;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function failSnapshot(snapshotId: string, error: unknown) {
  await db
    .update(intelSnapshots)
    .set({
      pipelineStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
    })
    .where(eq(intelSnapshots.id, snapshotId));
}

export const mirrorCompetitorMediaBatchTask = task({
  id: "mirror-competitor-media-batch",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000 },
  queue: { name: "mirror-competitor-media-batch", concurrencyLimit: 1 },
  maxDuration: 600,
  run: async (payload: MirrorCompetitorMediaBatchPayload) => {
    const archiveIds = payload.media.map((item) => item.archiveId);
    if (archiveIds.length === 0) {
      return { processed: 0, mirroredAds: 0, assetsMirrored: 0, failed: 0 };
    }

    const existing = await db
      .select({
        id: competitorAds.id,
        archiveId: competitorAds.archiveId,
        mirroredImageUrl: competitorAds.mirroredImageUrl,
        mirroredVideoUrl: competitorAds.mirroredVideoUrl,
        mirroredPreviewUrl: competitorAds.mirroredPreviewUrl,
      })
      .from(competitorAds)
      .where(
        and(
          eq(competitorAds.organizationId, payload.organizationId),
          eq(competitorAds.competitorId, payload.competitorId),
          inArray(competitorAds.archiveId, archiveIds),
        ),
      );
    const rowByArchiveId = new Map(existing.map((row) => [row.archiveId, row]));

    let mirroredAds = 0;
    let assetsMirrored = 0;
    let failed = 0;

    for (const [index, item] of payload.media.entries()) {
      const row = rowByArchiveId.get(item.archiveId);
      if (!row) {
        logger.warn("No competitor ad row for archive id — skipping mirror", {
          archiveId: item.archiveId,
          competitorId: payload.competitorId,
        });
        continue;
      }

      metadata
        .set("step", `Ad ${index + 1}/${payload.media.length}: ${item.archiveId}`)
        .set("currentItem", {
          type: "competitor_ad",
          archiveId: item.archiveId,
          position: index + 1,
          total: payload.media.length,
        });

      const videoSourceUrl = item.videoHdUrl ?? item.videoSdUrl;
      const update: {
        mirroredImageUrl?: string;
        mirroredVideoUrl?: string;
        mirroredPreviewUrl?: string;
      } = {};

      // One broken URL must not kill the fill: log and skip per asset.
      if (item.imageUrl && !row.mirroredImageUrl) {
        try {
          update.mirroredImageUrl = await mirrorImage({
            archiveId: item.archiveId,
            slot: "image",
            sourceUrl: item.imageUrl,
          });
        } catch (error) {
          failed += 1;
          logger.error("Competitor image mirror failed", {
            archiveId: item.archiveId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (videoSourceUrl && !row.mirroredVideoUrl) {
        try {
          update.mirroredVideoUrl = await mirrorVideo({
            archiveId: item.archiveId,
            sourceUrl: videoSourceUrl,
          });
        } catch (error) {
          failed += 1;
          logger.error("Competitor video mirror failed", {
            archiveId: item.archiveId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (item.videoPreviewImageUrl && !row.mirroredPreviewUrl) {
        try {
          update.mirroredPreviewUrl = await mirrorImage({
            archiveId: item.archiveId,
            slot: "preview",
            sourceUrl: item.videoPreviewImageUrl,
          });
        } catch (error) {
          failed += 1;
          logger.error("Competitor preview mirror failed", {
            archiveId: item.archiveId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const mirroredKeys = Object.keys(update);
      if (mirroredKeys.length > 0) {
        await db
          .update(competitorAds)
          .set(update)
          .where(eq(competitorAds.id, row.id));
        assetsMirrored += mirroredKeys.length;
      }

      const hasAnyMirroredAsset =
        mirroredKeys.length > 0 ||
        Boolean(row.mirroredImageUrl ?? row.mirroredVideoUrl ?? row.mirroredPreviewUrl);
      if (hasAnyMirroredAsset) mirroredAds += 1;
    }

    return {
      processed: payload.media.length,
      mirroredAds,
      assetsMirrored,
      failed,
    };
  },
});

export const mirrorCompetitorMediaTask = task({
  id: "mirror-competitor-media",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000 },
  queue: { name: "mirror-competitor-media", concurrencyLimit: 1 },
  maxDuration: 3600,
  run: async (payload: MirrorCompetitorMediaPayload) => {
    await tags.add(`mirror-competitor-media:competitor:${payload.competitorId}`);

    try {
      await db
        .update(intelSnapshots)
        .set({ pipelineStatus: "mirroring", error: null })
        .where(eq(intelSnapshots.id, payload.snapshotId));

      const batches = chunk(payload.media, MEDIA_BATCH_SIZE);
      const totals = { processed: 0, mirroredAds: 0, assetsMirrored: 0, failed: 0 };

      for (const [index, batch] of batches.entries()) {
        metadata
          .set("status", "running")
          .set("phase", "mirroring")
          .set("step", `Mirroring batch ${index + 1}/${batches.length}`)
          .set("processed", totals.processed)
          .set("mirroredAds", totals.mirroredAds)
          .set("failed", totals.failed);

        const result = await mirrorCompetitorMediaBatchTask.triggerAndWait({
          organizationId: payload.organizationId,
          competitorId: payload.competitorId,
          media: batch,
        });
        if (!result.ok) {
          throw new Error(
            `Mirror batch ${index + 1}/${batches.length} failed: ${String(result.error)}`,
          );
        }

        totals.processed += result.output.processed;
        totals.mirroredAds += result.output.mirroredAds;
        totals.assetsMirrored += result.output.assetsMirrored;
        totals.failed += result.output.failed;

        // Absolute running total, so a retried parent converges instead of doubling.
        await db
          .update(intelSnapshots)
          .set({ mirroredCount: totals.mirroredAds })
          .where(eq(intelSnapshots.id, payload.snapshotId));
      }

      // Phase 1 has no scoring stage: received → mirroring → complete.
      await db
        .update(intelSnapshots)
        .set({ pipelineStatus: "complete", error: null })
        .where(eq(intelSnapshots.id, payload.snapshotId));

      metadata.set("status", "completed").set("step", "Completed competitor media mirror");
      logger.info("Completed competitor media mirror", {
        organizationId: payload.organizationId,
        competitorId: payload.competitorId,
        snapshotId: payload.snapshotId,
        ...totals,
      });

      return {
        ...totals,
        summary: `Mirrored ${totals.assetsMirrored} assets across ${totals.mirroredAds} ads (${totals.failed} asset failures)`,
      };
    } catch (error) {
      metadata.set("status", "failed");
      await failSnapshot(payload.snapshotId, error);
      throw error;
    }
  },
});
