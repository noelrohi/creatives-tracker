const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type MetaCreativePreview = {
  assetUrl: string | null;
  format: "static" | "video" | null;
};

type MetaAdCreativeResponse = {
  id?: string;
  creative?: {
    image_url?: string;
    thumbnail_url?: string;
    object_type?: string;
    object_story_spec?: {
      video_data?: {
        image_url?: string;
      };
    };
    asset_feed_spec?: {
      images?: Array<{
        hash?: string;
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

const META_IDS_CHUNK_SIZE = 50;
const META_IMAGE_HASH_CHUNK_SIZE = 50;

function inferCreativeFormat(
  creative: MetaAdCreativeResponse["creative"],
): "static" | "video" | null {
  const objectType = creative?.object_type?.toUpperCase();
  if (objectType === "VIDEO" || creative?.object_story_spec?.video_data) {
    return "video";
  }
  if (
    creative?.image_url ||
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

function toPreview(
  creative: MetaAdCreativeResponse["creative"],
  resolvedImageUrls: Map<string, string>,
): MetaCreativePreview {
  const format = inferCreativeFormat(creative);

  if (format === "video") {
    const videoPoster = creative?.object_story_spec?.video_data?.image_url;
    if (videoPoster) {
      return {
        assetUrl: videoPoster,
        format,
      };
    }

    if (creative?.thumbnail_url) {
      return {
        assetUrl: creative.thumbnail_url,
        format,
      };
    }
  }

  if (creative?.image_url) {
    return {
      assetUrl: creative.image_url,
      format: format ?? "static",
    };
  }

  const imageHash = creative?.asset_feed_spec?.images?.find((image) => image.hash)
    ?.hash;
  const resolved = imageHash ? resolvedImageUrls.get(imageHash) : undefined;
  if (resolved) {
    return {
      assetUrl: resolved,
      format: format ?? "static",
    };
  }

  if (creative?.thumbnail_url) {
    return {
      assetUrl: creative.thumbnail_url,
      format: format ?? "static",
    };
  }

  return {
    assetUrl: null,
    format,
  };
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
      "creative{image_url,thumbnail_url,object_type,object_story_spec,asset_feed_spec}",
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
      .map((creative) => creative?.asset_feed_spec?.images?.find((image) => image.hash)?.hash)
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

  return previews;
}

export async function fetchMetaCreativePreview(input: {
  adMetaId: string;
  metaAccountId: string;
  accessToken: string;
}): Promise<MetaCreativePreview | null> {
  const previews = await fetchMetaCreativePreviewsForAds({
    adMetaIds: [input.adMetaId],
    metaAccountId: input.metaAccountId,
    accessToken: input.accessToken,
  });
  return previews.get(input.adMetaId) ?? null;
}
