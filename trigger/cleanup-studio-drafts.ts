import { logger, schedules } from "@trigger.dev/sdk";
import { del } from "@vercel/blob";
import { db } from "@/db";
import { studioGenerations, studioVariants } from "@/schema/studio";
import { and, eq, inArray, isNotNull, lt, notExists } from "drizzle-orm";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const cleanupStudioDraftsScheduled = schedules.task({
  id: "cleanup-studio-drafts",
  cron: "0 3 * * *",
  run: async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const savedVariantSubquery = db
      .select({ id: studioVariants.id })
      .from(studioVariants)
      .where(
        and(
          eq(studioVariants.generationId, studioGenerations.id),
          isNotNull(studioVariants.savedCreativeId),
        ),
      );

    const staleGenerations = await db
      .select({ id: studioGenerations.id })
      .from(studioGenerations)
      .where(
        and(
          lt(studioGenerations.createdAt, cutoff),
          notExists(savedVariantSubquery),
        ),
      );

    const generationIds = staleGenerations.map((generation) => generation.id);

    if (generationIds.length === 0) {
      logger.info("No stale unsaved Studio drafts to clean up", { cutoff });
      return { deletedGenerations: 0, deletedBlobs: 0 };
    }

    const variantsWithImages = await db
      .select({ imageUrl: studioVariants.imageUrl })
      .from(studioVariants)
      .where(
        and(
          inArray(studioVariants.generationId, generationIds),
          isNotNull(studioVariants.imageUrl),
        ),
      );

    let deletedBlobs = 0;

    for (const variant of variantsWithImages) {
      if (!variant.imageUrl) continue;

      try {
        await del(variant.imageUrl);
        deletedBlobs += 1;
      } catch (error) {
        logger.error("Failed to delete Studio draft blob", {
          imageUrl: variant.imageUrl,
          error: errorMessage(error),
        });
      }
    }

    await db
      .delete(studioGenerations)
      .where(inArray(studioGenerations.id, generationIds));

    logger.info("Cleaned up stale unsaved Studio drafts", {
      cutoff,
      deletedGenerations: generationIds.length,
      deletedBlobs,
    });

    return { deletedGenerations: generationIds.length, deletedBlobs };
  },
});
