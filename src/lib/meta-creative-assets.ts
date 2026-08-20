import { put } from "@vercel/blob";

const GRAPH_API_VERSION = "v25.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type MetaCreativePreview = {
  assetUrl: string | null;
  format: "static" | "video" | null;
  videoUrl?: string;
  destinationUrl?: string;
  caption?: string;
};

export type MetaCreativePreviewBatch = {
  previews: Map<string, MetaCreativePreview>;
  successfulAdMetaIds: Set<string>;
};

type MetaAdCreativeResponse = {
  id?: string;
  creative?: {
    body?: string;
    image_hash?: string;
    image_url?: string;
    thumbnail_url?: string;
    link_url?: string;
    video_id?: string;
    object_type?: string;
    effective_object_story_id?: string;
    object_story_spec?: {
      link_data?: {
        message?: string;
        picture?: string;
        image_hash?: string;
        link?: string;
      };
      video_data?: {
        message?: string;
        image_url?: string;
        image_hash?: string;
        video_id?: string;
        call_to_action?: {
          value?: { link?: string };
        };
      };
      photo_data?: {
        message?: string;
        url?: string;
      };
    };
    asset_feed_spec?: {
      bodies?: Array<{ text?: string }>;
      images?: Array<{
        hash?: string;
        url?: string;
      }>;
      videos?: Array<{
        video_id?: string;
        thumbnail_url?: string;
      }>;
      link_urls?: Array<{
        website_url?: string;
      }>;
    };
  };
};

type MetaAdImagesResponse = {
  data?: Array<{
    hash?: string;
    url?: string;
  }>;
};

type MetaVideoSourceResponse = {
  source?: string;
};

const META_IDS_CHUNK_SIZE = 50;
const META_IMAGE_HASH_CHUNK_SIZE = 50;

function getStorySpecs(
  creative: MetaAdCreativeResponse["creative"],
): Array<
  NonNullable<MetaAdCreativeResponse["creative"]>["object_story_spec"]
> {
  return [creative?.object_story_spec].filter(Boolean);
}

function getCreativeVideoId(
  creative: MetaAdCreativeResponse["creative"],
): string | undefined {
  return creative?.video_id
    ?? creative?.object_story_spec?.video_data?.video_id
    ?? creative?.asset_feed_spec?.videos?.find((video) => video.video_id)?.video_id;
}

function inferCreativeFormat(
  creative: MetaAdCreativeResponse["creative"],
): "static" | "video" | null {
  const objectType = creative?.object_type?.toUpperCase();
  if (creative?.video_id) {
    return "video";
  }
  if (objectType === "VIDEO") {
    return "video";
  }
  if (
    creative?.object_story_spec?.video_data
  ) {
    return "video";
  }
  if (creative?.asset_feed_spec?.videos?.length) {
    return "video";
  }
  if (
    creative?.image_hash ||
    creative?.image_url ||
    creative?.object_story_spec?.link_data?.picture ||
    creative?.object_story_spec?.link_data?.image_hash ||
    creative?.object_story_spec?.video_data?.image_url ||
    creative?.object_story_spec?.video_data?.image_hash ||
    creative?.object_story_spec?.photo_data?.url ||
    creative?.asset_feed_spec?.images?.length ||
    creative?.thumbnail_url
  ) {
    return "static";
  }
  return null;
}

async function fetchJson<T>(url: URL): Promise<T | null> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as T;
}

/**
 * Extract the best available image URL from a creative.
 * Priority (highest quality first):
 *   1. image_url — the originally uploaded image
 *   2. object_story_spec link_data.picture — link ad image
 *   3. object_story_spec video_data.image_url — video poster
 *   4. object_story_spec photo_data.url — photo ad image
 *   5. resolved image hash from creative/story spec/asset_feed_spec
 *   6. asset_feed_spec image url — dynamic creative asset URL
 *   7. asset_feed_spec video thumbnail_url — dynamic video poster
 *   8. thumbnail_url — last resort (small)
 */
function getBestImageUrl(
  creative: MetaAdCreativeResponse["creative"],
  resolvedImageUrls: Map<string, string>,
): string | null {
  if (creative?.image_url) return creative.image_url;

  const specs = getStorySpecs(creative);
  for (const spec of specs) {
    if (spec?.link_data?.picture) return spec.link_data.picture;
  }
  for (const spec of specs) {
    if (spec?.video_data?.image_url) return spec.video_data.image_url;
  }
  for (const spec of specs) {
    if (spec?.photo_data?.url) return spec.photo_data.url;
  }

  const imageHashes = [
    creative?.image_hash,
    ...specs.flatMap((spec) => [spec?.link_data?.image_hash, spec?.video_data?.image_hash]),
    ...(creative?.asset_feed_spec?.images?.map((image) => image.hash) ?? []),
  ].filter(Boolean) as string[];

  for (const imageHash of imageHashes) {
    const resolved = resolvedImageUrls.get(imageHash);
    if (resolved) return resolved;
  }

  const dynamicImageUrl = creative?.asset_feed_spec?.images?.find((image) => image.url)?.url;
  if (dynamicImageUrl) return dynamicImageUrl;

  const dynamicVideoThumbnail = creative?.asset_feed_spec?.videos?.find((video) => video.thumbnail_url)?.thumbnail_url;
  if (dynamicVideoThumbnail) return dynamicVideoThumbnail;

  if (creative?.thumbnail_url) return creative.thumbnail_url;

  return null;
}

/*
 * Known limitation: some ads return no URL from any field below and we cannot
 * recover one. These are typically VIDEO/SHARE creatives that only carry an
 * `object_story_id` pointing to the underlying Page post — the landing URL
 * lives on the post, not the creative. Verified 2026-04-20 on a Reviv 3 ad:
 * `GET /{object_story_id}` returns `(#100) Missing permissions` with the ad
 * account token, and anonymous fetches of the preview iframe return a Facebook
 * error page. Recovering these would require a Page access token with read
 * perms on the owning Page. Catalog/DPA ads are a separate bucket — the URL
 * is generated per-product from the product set and is not on the creative.
 */
function getDestinationUrl(
  creative: MetaAdCreativeResponse["creative"],
): string | undefined {
  if (creative?.link_url) return creative.link_url;
  for (const spec of getStorySpecs(creative)) {
    if (spec?.link_data?.link) return spec.link_data.link;
  }
  for (const spec of getStorySpecs(creative)) {
    if (spec?.video_data?.call_to_action?.value?.link) {
      return spec.video_data.call_to_action.value.link;
    }
  }
  const feedUrl = creative?.asset_feed_spec?.link_urls?.find((u) => u.website_url)?.website_url;
  if (feedUrl) return feedUrl;
  return undefined;
}

function getCaption(
  creative: MetaAdCreativeResponse["creative"],
): string | undefined {
  if (creative?.body) return creative.body;
  const spec = creative?.object_story_spec;
  if (spec?.link_data?.message) return spec.link_data.message;
  if (spec?.video_data?.message) return spec.video_data.message;
  if (spec?.photo_data?.message) return spec.photo_data.message;
  const bodies = creative?.asset_feed_spec?.bodies;
  if (bodies?.[0]?.text) return bodies[0].text;
  return undefined;
}

function toPreview(
  creative: MetaAdCreativeResponse["creative"],
  resolvedImageUrls: Map<string, string>,
): MetaCreativePreview {
  const format = inferCreativeFormat(creative);
  const assetUrl = getBestImageUrl(creative, resolvedImageUrls);

  return {
    assetUrl,
    format: format ?? (assetUrl ? "static" : null),
    destinationUrl: getDestinationUrl(creative),
    caption: getCaption(creative),
  };
}

function getVideoExtension(
  contentType: string | null,
  sourceUrl: string,
): string {
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
    case "video/x-msvideo":
      return "avi";
    default:
      break;
  }

  try {
    const pathname = new URL(sourceUrl).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  } catch {
    return "mp4";
  }

  return "mp4";
}

function getImageExtension(
  contentType: string | null,
  sourceUrl: string,
): string {
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
    case "image/svg+xml":
      return "svg";
    default:
      break;
  }

  try {
    const pathname = new URL(sourceUrl).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    if (match?.[1]) {
      const extension = match[1].toLowerCase();
      return extension === "jpeg" ? "jpg" : extension;
    }
  } catch {
    return "jpg";
  }

  return "jpg";
}

/**
 * Whether the URL points at storage we own. Meta's `scontent-*.fbcdn.net`
 * previews are signed and expire within days, so anything that is not on our
 * blob store has to be treated as possibly-dead on every later read.
 */
export function isDurableAssetUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname.endsWith("blob.vercel-storage.com");
  } catch {
    return false;
  }
}

async function fetchVideoSourceUrl(input: {
  videoId: string;
  accessToken: string;
}): Promise<string | null> {
  try {
    const videoUrl = new URL(`${GRAPH_API_BASE}/${input.videoId}`);
    videoUrl.searchParams.set("access_token", input.accessToken);
    videoUrl.searchParams.set("fields", "source");

    const video = await fetchJson<MetaVideoSourceResponse>(videoUrl);
    return video?.source ?? null;
  } catch {
    return null;
  }
}

async function fetchAndUploadVideo(input: {
  videoId: string;
  accessToken: string;
}): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return null;
  }

  try {
    const sourceUrl = await fetchVideoSourceUrl(input);
    if (!sourceUrl) {
      return null;
    }

    const videoResponse = await fetch(sourceUrl);
    if (!videoResponse.ok) {
      return null;
    }

    const contentType = videoResponse.headers.get("content-type");
    const extension = getVideoExtension(contentType, sourceUrl);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const pathname = `${env}/meta-videos/${input.videoId}.${extension}`;
    const body = videoResponse.body ?? await videoResponse.arrayBuffer();

    const blob = await put(pathname, body, {
      access: "public",
      allowOverwrite: true,
      contentType: contentType ?? undefined,
    });

    return blob.url;
  } catch {
    return null;
  }
}

/**
 * Copy a Meta preview image onto our own blob store and return the durable URL,
 * or null when it could not be mirrored (no token, source already gone, upload
 * failed). Callers keep whatever they had on null — a soon-to-expire URL still
 * renders today — and rely on a later repair pass to heal the row.
 */
export async function mirrorMetaImageToBlob(input: {
  /** Filename base under `meta-previews/`; unique per source image. */
  key: string;
  sourceUrl: string;
}): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return null;
  }
  if (isDurableAssetUrl(input.sourceUrl)) {
    return input.sourceUrl;
  }

  try {
    const imageResponse = await fetch(input.sourceUrl);
    if (!imageResponse.ok) {
      return null;
    }

    const contentType = imageResponse.headers.get("content-type");
    const extension = getImageExtension(contentType, input.sourceUrl);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const pathname = `${env}/meta-previews/${input.key}.${extension}`;
    const body = imageResponse.body ?? await imageResponse.arrayBuffer();

    const blob = await put(pathname, body, {
      access: "public",
      allowOverwrite: true,
      contentType: contentType ?? undefined,
    });

    return blob.url;
  } catch {
    return null;
  }
}

async function fetchAdImageUrls(input: {
  imageHashes: string[];
  metaAccountId: string;
  accessToken: string;
}) {
  const resolved = new Map<string, string>();

  const chunks: string[][] = [];
  for (let i = 0; i < input.imageHashes.length; i += META_IMAGE_HASH_CHUNK_SIZE) {
    chunks.push(input.imageHashes.slice(i, i + META_IMAGE_HASH_CHUNK_SIZE));
  }

  const results = await Promise.all(
    chunks.map((chunk) => {
      const imageUrl = new URL(
        `${GRAPH_API_BASE}/act_${input.metaAccountId}/adimages`,
      );
      imageUrl.searchParams.set("access_token", input.accessToken);
      imageUrl.searchParams.set("hashes", JSON.stringify(chunk));
      imageUrl.searchParams.set("fields", "hash,url");
      return fetchJson<MetaAdImagesResponse>(imageUrl);
    }),
  );

  for (const images of results) {
    for (const image of images?.data ?? []) {
      if (image.hash && image.url) {
        resolved.set(image.hash, image.url);
      }
    }
  }

  return resolved;
}

/**
 * For boosted-post (SHARE) creatives, the destination link isn't exposed on the
 * creative object — only on the underlying post, which needs page-level perms.
 * Workaround: scrape the rendered ad-preview iframe, which inlines a JSON blob
 * containing a linkshim `l.facebook.com/l.php?u=<url>`. Brittle — Meta can
 * change the markup — but daily imports give us a cadence to notice breakage.
 */
async function fetchLandingUrlFromPreview(input: {
  adMetaId: string;
  accessToken: string;
}): Promise<string | null> {
  const iframeSrc = await fetchMetaAdPreviewUrl({
    adMetaId: input.adMetaId,
    accessToken: input.accessToken,
  });
  if (!iframeSrc) return null;

  try {
    const response = await fetch(iframeSrc, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) return null;
    const html = await response.text();

    const matches = html.matchAll(/"link_url":"(https?:[^"\\]*(?:\\.[^"\\]*)*)"/g);
    for (const match of matches) {
      const candidate = extractOutboundUrl(match[1]);
      if (candidate) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

const META_OWNED_HOST_SUFFIXES = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "m.me",
  "instagram.com",
  "whatsapp.com",
  "messenger.com",
  "fbcdn.net",
];

function extractOutboundUrl(rawJsonEncoded: string): string | null {
  try {
    const decoded = JSON.parse(`"${rawJsonEncoded}"`) as string;
    const parsed = new URL(decoded);
    const isLinkshim = parsed.hostname.endsWith("l.facebook.com")
      && parsed.pathname === "/l.php";
    const final = isLinkshim ? parsed.searchParams.get("u") : decoded;
    if (!final) return null;

    const finalParsed = new URL(final);
    if (finalParsed.protocol !== "http:" && finalParsed.protocol !== "https:") {
      return null;
    }
    const host = finalParsed.hostname.toLowerCase();
    if (META_OWNED_HOST_SUFFIXES.some((suffix) =>
      host === suffix || host.endsWith(`.${suffix}`),
    )) {
      return null;
    }
    return final;
  } catch {
    return null;
  }
}

export async function fetchMetaCreativePreviewsBatch(input: {
  adMetaIds: string[];
  metaAccountId: string;
  accessToken: string;
  assetUrlMode?: "direct" | "uploaded";
  videoUrlMode?: "none" | "uploaded" | "direct";
  knownDestinationUrlByAdId?: Map<string, string>;
}): Promise<MetaCreativePreviewBatch> {
  const previews = new Map<string, MetaCreativePreview>();
  const successfulAdMetaIds = new Set<string>();
  const creativesByAdId = new Map<string, MetaAdCreativeResponse["creative"]>();

  const adChunks: string[][] = [];
  for (let i = 0; i < input.adMetaIds.length; i += META_IDS_CHUNK_SIZE) {
    adChunks.push(input.adMetaIds.slice(i, i + META_IDS_CHUNK_SIZE));
  }

  const creativeResponses = await Promise.all(
    adChunks.map((chunk) => {
      const url = new URL(`${GRAPH_API_BASE}/`);
      url.searchParams.set("access_token", input.accessToken);
      url.searchParams.set("ids", chunk.join(","));
      url.searchParams.set(
        "fields",
        "creative{body,image_hash,image_url,thumbnail_url,link_url,video_id,object_type,effective_object_story_id,object_story_spec,asset_feed_spec}",
      );
      return fetchJson<Record<string, MetaAdCreativeResponse>>(url);
    }),
  );

  for (let c = 0; c < adChunks.length; c++) {
    const response = creativeResponses[c];
    if (!response) continue;
    for (const adMetaId of adChunks[c]) {
      successfulAdMetaIds.add(adMetaId);
    }
    for (const adMetaId of adChunks[c]) {
      creativesByAdId.set(adMetaId, response[adMetaId]?.creative);
    }
  }

  const imageHashes = [...new Set(
    [...creativesByAdId.values()]
      .flatMap((creative) => [
        creative?.image_hash,
        creative?.object_story_spec?.link_data?.image_hash,
        creative?.object_story_spec?.video_data?.image_hash,
        ...(creative?.asset_feed_spec?.images?.map((image) => image.hash) ?? []),
      ])
      .filter(Boolean) as string[],
  )];
  const resolvedImageUrls = imageHashes.length > 0
    ? await fetchAdImageUrls({
        imageHashes,
        metaAccountId: input.metaAccountId,
        accessToken: input.accessToken,
      })
    : new Map<string, string>();

  for (const adMetaId of input.adMetaIds) {
    const creative = creativesByAdId.get(adMetaId);
    if (creative) {
      previews.set(adMetaId, toPreview(creative, resolvedImageUrls));
    }
  }

  const assetUrlMode = input.assetUrlMode ?? "uploaded";
  if (assetUrlMode === "uploaded") {
    // Deduplicate by original asset URL so we only upload each image once
    const uniqueAssets = new Map<string, { adMetaId: string }>();
    for (const adMetaId of input.adMetaIds) {
      const preview = previews.get(adMetaId);
      if (preview?.assetUrl && !uniqueAssets.has(preview.assetUrl)) {
        uniqueAssets.set(preview.assetUrl, { adMetaId });
      }
    }

    // Upload all unique images in parallel (bounded by chunk size)
    const entries = [...uniqueAssets.entries()];
    const uploadedAssetUrls = new Map<string, string | null>();
    const UPLOAD_CONCURRENCY = 10;
    for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
      const chunk = entries.slice(i, i + UPLOAD_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(([assetUrl, { adMetaId }]) =>
          mirrorMetaImageToBlob({ key: adMetaId, sourceUrl: assetUrl }).then(
            (uploaded) => [assetUrl, uploaded] as const,
          ),
        ),
      );
      for (const [assetUrl, uploaded] of results) {
        uploadedAssetUrls.set(assetUrl, uploaded);
      }
    }

    // Apply uploaded URLs back to previews
    for (const adMetaId of input.adMetaIds) {
      const preview = previews.get(adMetaId);
      if (!preview?.assetUrl) continue;
      const uploadedAssetUrl = uploadedAssetUrls.get(preview.assetUrl);
      if (uploadedAssetUrl) {
        preview.assetUrl = uploadedAssetUrl;
      }
    }
  }

  const videoUrlMode = input.videoUrlMode ?? "none";
  if (videoUrlMode !== "none") {
    // Deduplicate by video ID
    const uniqueVideos = new Map<string, true>();
    for (const adMetaId of input.adMetaIds) {
      const creative = creativesByAdId.get(adMetaId);
      const preview = previews.get(adMetaId);
      const videoId = getCreativeVideoId(creative);
      if (preview && preview.format === "video" && videoId && !uniqueVideos.has(videoId)) {
        uniqueVideos.set(videoId, true);
      }
    }

    // Fetch/upload all unique videos in parallel (bounded)
    const videoIds = [...uniqueVideos.keys()];
    const videoUrls = new Map<string, string | null>();
    const VIDEO_CONCURRENCY = 5;
    for (let i = 0; i < videoIds.length; i += VIDEO_CONCURRENCY) {
      const chunk = videoIds.slice(i, i + VIDEO_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((videoId) =>
          (videoUrlMode === "uploaded"
            ? fetchAndUploadVideo({ videoId, accessToken: input.accessToken })
            : fetchVideoSourceUrl({ videoId, accessToken: input.accessToken })
          ).then((url) => [videoId, url] as const),
        ),
      );
      for (const [videoId, url] of results) {
        videoUrls.set(videoId, url);
      }
    }

    // Apply video URLs back to previews
    for (const adMetaId of input.adMetaIds) {
      const creative = creativesByAdId.get(adMetaId);
      const preview = previews.get(adMetaId);
      const videoId = getCreativeVideoId(creative);
      if (!preview || !videoId) continue;
      const videoUrl = videoUrls.get(videoId);
      if (videoUrl) {
        preview.videoUrl = videoUrl;
      }
    }
  }

  // SHARE-post fallback: scrape the ad preview iframe for boosted-post ads
  // that have no inline link. Dedupe by effective_object_story_id so multiple
  // ads boosting the same post = one scrape. Skip when we already know the URL.
  const adIdsNeedingLanding: string[] = [];
  const scrapeKeyByAdId = new Map<string, string>();
  const seenScrapeKeys = new Set<string>();
  for (const adMetaId of input.adMetaIds) {
    const preview = previews.get(adMetaId);
    const creative = creativesByAdId.get(adMetaId);
    if (!preview || !creative) continue;
    if (preview.destinationUrl) continue;
    const known = input.knownDestinationUrlByAdId?.get(adMetaId);
    if (known) {
      preview.destinationUrl = known;
      continue;
    }
    if (creative.object_type?.toUpperCase() !== "SHARE") continue;

    const scrapeKey = creative.effective_object_story_id ?? adMetaId;
    scrapeKeyByAdId.set(adMetaId, scrapeKey);
    if (!seenScrapeKeys.has(scrapeKey)) {
      seenScrapeKeys.add(scrapeKey);
      adIdsNeedingLanding.push(adMetaId);
    }
  }

  if (adIdsNeedingLanding.length > 0) {
    const landingByKey = new Map<string, string | null>();
    const SCRAPE_CONCURRENCY = 5;
    for (let i = 0; i < adIdsNeedingLanding.length; i += SCRAPE_CONCURRENCY) {
      const chunk = adIdsNeedingLanding.slice(i, i + SCRAPE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((adMetaId) =>
          fetchLandingUrlFromPreview({
            adMetaId,
            accessToken: input.accessToken,
          }).then((url) => [scrapeKeyByAdId.get(adMetaId)!, url] as const),
        ),
      );
      for (const [key, url] of results) {
        landingByKey.set(key, url);
      }
    }

    for (const [adMetaId, key] of scrapeKeyByAdId) {
      const preview = previews.get(adMetaId);
      if (!preview) continue;
      const url = landingByKey.get(key);
      if (url) preview.destinationUrl = url;
    }
  }

  return {
    previews,
    successfulAdMetaIds,
  };
}

export async function fetchMetaCreativePreviewsForAds(input: {
  adMetaIds: string[];
  metaAccountId: string;
  accessToken: string;
  assetUrlMode?: "direct" | "uploaded";
  videoUrlMode?: "none" | "uploaded" | "direct";
  knownDestinationUrlByAdId?: Map<string, string>;
}) {
  const { previews } = await fetchMetaCreativePreviewsBatch(input);
  return previews;
}

/**
 * Fetch the ad preview iframe URL from Meta.
 * This works even without video download permissions since Meta hosts the player.
 */
export async function fetchMetaAdPreviewUrl(input: {
  adMetaId: string;
  accessToken: string;
}): Promise<string | null> {
  const url = new URL(`${GRAPH_API_BASE}/${input.adMetaId}/previews`);
  url.searchParams.set("access_token", input.accessToken);
  url.searchParams.set("ad_format", "MOBILE_FEED_STANDARD");

  const response = await fetchJson<{
    data?: Array<{ body?: string }>;
  }>(url);

  const body = response?.data?.[0]?.body;
  if (!body) return null;

  // Extract the iframe src URL from the HTML
  const srcMatch = body.match(/src="([^"]+)"/);
  if (!srcMatch) return null;

  // Decode HTML entities (&amp; -> &)
  return srcMatch[1].replace(/&amp;/g, "&");
}

export async function fetchMetaCreativePreview(input: {
  adMetaId: string;
  metaAccountId: string;
  accessToken: string;
  assetUrlMode?: "direct" | "uploaded";
  videoUrlMode?: "none" | "uploaded" | "direct";
}): Promise<MetaCreativePreview | null> {
  const previews = await fetchMetaCreativePreviewsForAds({
    adMetaIds: [input.adMetaId],
    metaAccountId: input.metaAccountId,
    accessToken: input.accessToken,
    assetUrlMode: input.assetUrlMode,
    videoUrlMode: input.videoUrlMode,
  });
  return previews.get(input.adMetaId) ?? null;
}
