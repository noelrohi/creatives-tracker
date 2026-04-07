import { put } from "@vercel/blob";

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type MetaCreativePreview = {
  assetUrl: string | null;
  format: "static" | "video" | null;
  videoUrl?: string;
  destinationUrl?: string;
  caption?: string;
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

function isBlobUrl(value: string): boolean {
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

async function fetchAndUploadImage(input: {
  adMetaId: string;
  assetUrl: string;
}): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return input.assetUrl;
  }
  if (isBlobUrl(input.assetUrl)) {
    return input.assetUrl;
  }

  try {
    const imageResponse = await fetch(input.assetUrl);
    if (!imageResponse.ok) {
      return null;
    }

    const contentType = imageResponse.headers.get("content-type");
    const extension = getImageExtension(contentType, input.assetUrl);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const pathname = `${env}/meta-previews/${input.adMetaId}.${extension}`;
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

  for (let i = 0; i < input.imageHashes.length; i += META_IMAGE_HASH_CHUNK_SIZE) {
    const chunk = input.imageHashes.slice(i, i + META_IMAGE_HASH_CHUNK_SIZE);
    const imageUrl = new URL(
      `${GRAPH_API_BASE}/act_${input.metaAccountId}/adimages`,
    );
    imageUrl.searchParams.set("access_token", input.accessToken);
    imageUrl.searchParams.set("hashes", JSON.stringify(chunk));
    imageUrl.searchParams.set("fields", "hash,url");

    const images = await fetchJson<MetaAdImagesResponse>(imageUrl);
    for (const image of images?.data ?? []) {
      if (image.hash && image.url) {
        resolved.set(image.hash, image.url);
      }
    }
  }

  return resolved;
}

export async function fetchMetaCreativePreviewsForAds(input: {
  adMetaIds: string[];
  metaAccountId: string;
  accessToken: string;
  assetUrlMode?: "direct" | "uploaded";
  videoUrlMode?: "none" | "uploaded" | "direct";
}) {
  const previews = new Map<string, MetaCreativePreview>();
  const creativesByAdId = new Map<string, MetaAdCreativeResponse["creative"]>();

  for (let i = 0; i < input.adMetaIds.length; i += META_IDS_CHUNK_SIZE) {
    const chunk = input.adMetaIds.slice(i, i + META_IDS_CHUNK_SIZE);
    const url = new URL(`${GRAPH_API_BASE}/`);
    url.searchParams.set("access_token", input.accessToken);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set(
      "fields",
      "creative{body,image_hash,image_url,thumbnail_url,link_url,video_id,object_type,object_story_spec,asset_feed_spec}",
    );

    const response = await fetchJson<Record<string, MetaAdCreativeResponse>>(url);
    if (!response) {
      continue;
    }

    for (const adMetaId of chunk) {
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
    const uploadedAssetUrls = new Map<string, string | null>();
    for (const adMetaId of input.adMetaIds) {
      const preview = previews.get(adMetaId);
      if (!preview?.assetUrl) {
        continue;
      }

      if (!uploadedAssetUrls.has(preview.assetUrl)) {
        uploadedAssetUrls.set(
          preview.assetUrl,
          await fetchAndUploadImage({
            adMetaId,
            assetUrl: preview.assetUrl,
          }),
        );
      }

      const uploadedAssetUrl = uploadedAssetUrls.get(preview.assetUrl);
      if (uploadedAssetUrl) {
        preview.assetUrl = uploadedAssetUrl;
      }
    }
  }

  const videoUrlMode = input.videoUrlMode ?? "none";
  if (videoUrlMode !== "none") {
    const videoUrls = new Map<string, string | null>();
    for (const adMetaId of input.adMetaIds) {
      const creative = creativesByAdId.get(adMetaId);
      const preview = previews.get(adMetaId);
      const videoId = getCreativeVideoId(creative);

      if (!preview || preview.format !== "video" || !videoId) {
        continue;
      }

      if (!videoUrls.has(videoId)) {
        videoUrls.set(
          videoId,
          videoUrlMode === "uploaded"
            ? await fetchAndUploadVideo({
                videoId,
                accessToken: input.accessToken,
              })
            : await fetchVideoSourceUrl({
                videoId,
                accessToken: input.accessToken,
              }),
        );
      }

      const videoUrl = videoUrls.get(videoId);
      if (videoUrl) {
        preview.videoUrl = videoUrl;
      }
    }
  }

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
