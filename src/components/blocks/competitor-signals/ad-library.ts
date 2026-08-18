/**
 * Meta Ad Library deep links. The page view lists everything an advertiser
 * runs; the ad view (`?id=`) is one ad's own detail — spend ranges, versions,
 * placements — and is what per-ad links point at.
 */

export function adLibraryPageUrl(metaPageId: string): string {
  return `https://www.facebook.com/ads/library/?view_all_page_id=${metaPageId}`;
}

export function adLibraryAdUrl(archiveId: string): string {
  return `https://www.facebook.com/ads/library/?id=${archiveId}`;
}
