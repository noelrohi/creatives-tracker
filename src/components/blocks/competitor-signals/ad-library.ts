/**
 * Meta Ad Library deep links. The page view lists everything an advertiser
 * runs; the ad view (`?id=`) is one ad's own detail — spend ranges, versions,
 * placements — and is what per-ad links point at.
 */

const META_AD_LIBRARY_URL = "https://www.facebook.com/ads/library/";

export function adLibrarySearchUrl(query: string): string {
  const url = new URL(META_AD_LIBRARY_URL);
  url.searchParams.set("active_status", "active");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", "ALL");
  url.searchParams.set("is_targeted_country", "false");
  url.searchParams.set("media_type", "all");

  const search = query.trim();
  if (search) {
    url.searchParams.set("q", search);
    url.searchParams.set("search_type", "keyword_unordered");
  }

  url.searchParams.set("sort_data[mode]", "total_impressions");
  url.searchParams.set("sort_data[direction]", "desc");
  return url.toString();
}

type MetaAdLibraryPageUrlResult =
  | { pageId: string; error: null }
  | { pageId: null; error: "individual_ad" | "invalid" };

export function parseMetaAdLibraryPageUrl(
  value: string,
): MetaAdLibraryPageUrlResult {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { pageId: null, error: "invalid" };
  }

  const isFacebook =
    url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com");
  const isAdLibrary = url.pathname.replace(/\/$/, "") === "/ads/library";
  if (url.protocol !== "https:" || !isFacebook || !isAdLibrary) {
    return { pageId: null, error: "invalid" };
  }

  const pageId = url.searchParams.get("view_all_page_id")?.trim();
  if (pageId && /^\d+$/.test(pageId)) {
    return { pageId, error: null };
  }

  if (!url.searchParams.has("view_all_page_id") && url.searchParams.has("id")) {
    return { pageId: null, error: "individual_ad" };
  }

  return { pageId: null, error: "invalid" };
}

export function adLibraryPageUrl(metaPageId: string): string {
  return `${META_AD_LIBRARY_URL}?view_all_page_id=${metaPageId}`;
}

export function adLibraryAdUrl(archiveId: string): string {
  return `https://www.facebook.com/ads/library/?id=${archiveId}`;
}
