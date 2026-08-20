/**
 * Heal creative image URLs that Meta's CDN has already expired.
 *
 * Meta preview URLs (`scontent-*.fbcdn.net`) are signed and short-lived. Import
 * mirrors them onto our blob store, but when that mirror fails the raw URL is
 * stored as-is and nothing ever retries it — so the row keeps a URL that 403s
 * for every later reader, including the model that tags the creative. This
 * module resolves a creative to an image URL that still loads, repairing the
 * stored row when it can and reporting honestly when it cannot.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  fetchMetaCreativePreviewsBatch,
  isDurableAssetUrl,
  mirrorMetaImageToBlob,
} from "@/lib/meta-creative-assets";
import { getMetaAccountWithToken } from "@/lib/meta-insights-sync";
import { isVideoFile } from "@/lib/studio-assets";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";

/** Enough linked ads to survive dead accounts without fanning out forever. */
const MAX_RERESOLVE_ADS = 5;

export type CreativeImageResolution = {
  /** A URL that responded successfully, or null when none could be produced. */
  url: string | null;
  /** How the URL was obtained — for run logs and metrics, not control flow. */
  outcome:
    | "durable"
    | "mirrored"
    | "reresolved"
    | "unmirrored"
    | "no_image"
    | "unreachable";
  /**
   * True when `ad_creative.asset_url` was rewritten as part of resolving. False
   * on a lost race with a concurrent sync — the returned URL is still usable.
   */
  repaired: boolean;
};

/** Cheapest request that still proves the CDN will serve the bytes. */
async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
    // Drain the body so the connection is released; only the status matters.
    await response.arrayBuffer().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Compare-and-set on the URL we started from. Probing, mirroring and the Graph
 * round-trip all take time, and a sync running alongside may have written a
 * fresher URL meanwhile — that one wins, because it is the newer read of Meta.
 * Returns whether the row was actually rewritten.
 */
async function persistAssetUrl(input: {
  organizationId: string;
  creativeId: string;
  previousAssetUrl: string;
  assetUrl: string;
}): Promise<boolean> {
  const rows = await db
    .update(adCreatives)
    .set({ assetUrl: input.assetUrl })
    .where(
      and(
        eq(adCreatives.id, input.creativeId),
        eq(adCreatives.organizationId, input.organizationId),
        eq(adCreatives.assetUrl, input.previousAssetUrl),
      ),
    )
    .returning({ id: adCreatives.id });
  return rows.length > 0;
}

/**
 * Ask Meta for the creative's current preview URL.
 *
 * One creative can be linked to several ads, and any of them may be the one
 * still resolvable — the others can sit on a disabled account, a revoked token
 * or a deleted ad. So every linked ad gets a turn, newest first, and only an
 * exhausted list means the creative really has no image. All of those states
 * are ordinary for an old ad; none is worth failing a tagging run over.
 */
async function reresolveFromMeta(input: {
  organizationId: string;
  creativeId: string;
}): Promise<string | null> {
  const linkedAds = await db
    .select({ metaId: ads.metaId, accountId: ads.accountId })
    .from(ads)
    .where(
      and(
        eq(ads.adCreativeId, input.creativeId),
        eq(ads.organizationId, input.organizationId),
        isNotNull(ads.metaId),
        isNotNull(ads.accountId),
      ),
    )
    .orderBy(desc(ads.updatedAt))
    .limit(MAX_RERESOLVE_ADS);

  // Tokens are per account and several ads usually share one; resolve each
  // account at most once so a long list stays one query per distinct account.
  const accountCache = new Map<
    string,
    { metaAccountId: string; metaAccessToken: string } | null
  >();

  for (const ad of linkedAds) {
    if (!ad.metaId || !ad.accountId) continue;

    try {
      if (!accountCache.has(ad.accountId)) {
        accountCache.set(
          ad.accountId,
          await getMetaAccountWithToken({
            accountId: ad.accountId,
            organizationId: input.organizationId,
          }).catch(() => null),
        );
      }
      const account = accountCache.get(ad.accountId);
      if (!account) continue;

      const { previews } = await fetchMetaCreativePreviewsBatch({
        adMetaIds: [ad.metaId],
        metaAccountId: account.metaAccountId,
        accessToken: account.metaAccessToken,
        videoUrlMode: "none",
      });
      const assetUrl = previews.get(ad.metaId)?.assetUrl;
      if (assetUrl && !isVideoFile(assetUrl)) return assetUrl;
    } catch {
      // This ad cannot answer; the next one still might.
    }
  }

  return null;
}

/**
 * Resolve a creative to an image URL a remote consumer can actually fetch.
 *
 * Order matters: our own blob URLs are trusted without a probe, a live Meta URL
 * is mirrored so the next reader is spared this dance, and only a dead URL pays
 * for a Graph round-trip. A null `url` is a normal answer — callers degrade to
 * text-only rather than failing the creative.
 */
export async function resolveCreativeImageUrl(input: {
  organizationId: string;
  creativeId: string;
  assetUrl: string | null;
}): Promise<CreativeImageResolution> {
  const { assetUrl } = input;
  if (!assetUrl || isVideoFile(assetUrl)) {
    return { url: null, outcome: "no_image", repaired: false };
  }

  if (isDurableAssetUrl(assetUrl)) {
    return { url: assetUrl, outcome: "durable", repaired: false };
  }

  if (await isReachable(assetUrl)) {
    const mirrored = await mirrorMetaImageToBlob({
      key: `creative-${input.creativeId}`,
      sourceUrl: assetUrl,
    });
    if (!mirrored) {
      // Still serving today; usable now, and re-checked on the next pass.
      return { url: assetUrl, outcome: "unmirrored", repaired: false };
    }
    const repaired = await persistAssetUrl({
      ...input,
      previousAssetUrl: assetUrl,
      assetUrl: mirrored,
    });
    return { url: mirrored, outcome: "mirrored", repaired };
  }

  const refreshed = await reresolveFromMeta(input);
  if (!refreshed) {
    return { url: null, outcome: "unreachable", repaired: false };
  }
  const repaired = await persistAssetUrl({
    ...input,
    previousAssetUrl: assetUrl,
    assetUrl: refreshed,
  });
  return { url: refreshed, outcome: "reresolved", repaired };
}
