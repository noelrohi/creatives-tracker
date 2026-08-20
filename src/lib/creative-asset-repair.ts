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
import { and, eq, isNotNull } from "drizzle-orm";
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
  /** True when `ad_creative.asset_url` was rewritten as part of resolving. */
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

async function persistAssetUrl(input: {
  organizationId: string;
  creativeId: string;
  assetUrl: string;
}) {
  await db
    .update(adCreatives)
    .set({ assetUrl: input.assetUrl })
    .where(
      and(
        eq(adCreatives.id, input.creativeId),
        eq(adCreatives.organizationId, input.organizationId),
      ),
    );
}

/**
 * Ask Meta for the creative's current preview URL. Returns null whenever the
 * ad, the account or the token is gone — all ordinary states for an old ad, and
 * none of them worth failing a tagging run over.
 */
async function reresolveFromMeta(input: {
  organizationId: string;
  creativeId: string;
}): Promise<string | null> {
  const [ad] = await db
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
    .limit(1);

  if (!ad?.metaId || !ad.accountId) return null;

  try {
    const account = await getMetaAccountWithToken({
      accountId: ad.accountId,
      organizationId: input.organizationId,
    });
    const { previews } = await fetchMetaCreativePreviewsBatch({
      adMetaIds: [ad.metaId],
      metaAccountId: account.metaAccountId,
      accessToken: account.metaAccessToken,
      videoUrlMode: "none",
    });
    const assetUrl = previews.get(ad.metaId)?.assetUrl;
    if (!assetUrl || isVideoFile(assetUrl)) return null;
    return assetUrl;
  } catch {
    return null;
  }
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
    await persistAssetUrl({ ...input, assetUrl: mirrored });
    return { url: mirrored, outcome: "mirrored", repaired: true };
  }

  const refreshed = await reresolveFromMeta(input);
  if (!refreshed) {
    return { url: null, outcome: "unreachable", repaired: false };
  }
  await persistAssetUrl({ ...input, assetUrl: refreshed });
  return { url: refreshed, outcome: "reresolved", repaired: true };
}
