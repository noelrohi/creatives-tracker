/**
 * Backfill mirrored images for competitor ads whose fill sent no top-level
 * media URLs (card-based DCO/carousel ads keep them in raw cards — see
 * src/lib/competitor-signals/raw-media.ts). Re-extracts the primary creative's
 * image from the stored verbatim `raw` and mirrors it into Blob, exactly like
 * trigger/mirror-competitor-media.ts would have at ingest.
 *
 * The signed scontent.* URLs in `raw` expire, so ads whose fill is too old
 * fail with a fetch error and are reported — a fresh fill is the only fix
 * for those.
 *
 * Usage: bun scripts/backfill-competitor-card-media.ts --org <organizationId>
 *
 * `--org` is required: the script only ever rewrites one organization's rows.
 */

import { put } from "@vercel/blob";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { extractRawPrimaryMedia } from "@/lib/competitor-signals/raw-media";
import { fetchRemoteImage } from "@/lib/remote-image";
import { competitorAds } from "@/schema/competitor-signals";

const blobEnvPrefix = process.env.NODE_ENV === "production" ? "prod" : "dev";

const orgFlagIndex = process.argv.indexOf("--org");
const organizationId =
  orgFlagIndex === -1 ? null : (process.argv[orgFlagIndex + 1] ?? null);
if (!organizationId) {
  console.error(
    "Usage: bun scripts/backfill-competitor-card-media.ts --org <organizationId>",
  );
  process.exit(1);
}

function imageExtension(sourceUrl: string): string {
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

const rows = await db
  .select({
    id: competitorAds.id,
    archiveId: competitorAds.archiveId,
    raw: competitorAds.raw,
  })
  .from(competitorAds)
  .where(
    and(
      eq(competitorAds.organizationId, organizationId),
      isNull(competitorAds.mirroredImageUrl),
      isNull(competitorAds.mirroredPreviewUrl),
    ),
  );

console.log(`${rows.length} ads with no mirrored image or preview`);

let mirrored = 0;
let noSource = 0;
let failed = 0;

/** Candidate urls per slot, best quality first — an oversized or dead original
 * falls back to the resized copy instead of leaving the ad blank. */
function imageCandidates(raw: unknown): { slot: "image" | "preview"; url: string }[] {
  const media = extractRawPrimaryMedia(raw);
  const seen = new Set<string>();
  const candidates: { slot: "image" | "preview"; url: string }[] = [];
  for (const [slot, url] of [
    ["image", media.imageUrl],
    ["image", media.resizedImageUrl],
    ["preview", media.videoPreviewImageUrl],
  ] as const) {
    if (url && !seen.has(url)) {
      seen.add(url);
      candidates.push({ slot, url });
    }
  }
  return candidates;
}

for (const row of rows) {
  const candidates = imageCandidates(row.raw);
  if (candidates.length === 0) {
    noSource += 1;
    console.log(`  ${row.archiveId}: no image url in raw payload — skipped`);
    continue;
  }

  let lastError: unknown = null;
  let done = false;
  for (const { slot, url } of candidates) {
    try {
      const image = await fetchRemoteImage(url);
      const blob = await put(
        `${blobEnvPrefix}/competitor-media/${row.archiveId}-${slot}.${imageExtension(url)}`,
        Buffer.from(image),
        { access: "public", allowOverwrite: true },
      );
      await db
        .update(competitorAds)
        .set(
          slot === "image"
            ? { mirroredImageUrl: blob.url }
            : { mirroredPreviewUrl: blob.url },
        )
        .where(eq(competitorAds.id, row.id));
      mirrored += 1;
      console.log(`  ${row.archiveId}: mirrored ${slot}`);
      done = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!done) {
    failed += 1;
    console.log(
      `  ${row.archiveId}: failed — ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

console.log(
  `Done: ${mirrored} mirrored, ${noSource} without a source url, ${failed} failed (likely expired source urls — re-fill to fix)`,
);
process.exit(0);
