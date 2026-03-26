import type { MappedRow } from "./csv-parser";
import { formatDateOnly } from "./date";

export const MAX_BULK_IMPORT_PAYLOAD_BYTES = 1_000_000;

export function mapRowsForImport(rows: MappedRow[]) {
  return rows.map((r) => ({
    name: r.name || "Imported Ad",
    assetUrl: r.assetUrl,
    format: r.format,
    roas: r.roas,
    cpa: r.cpa,
    ctr: r.ctr,
    conversionRate: r.conversionRate,
    spend: r.spend,
    conversions: r.conversions != null ? Number(r.conversions) : undefined,
    impressions: r.impressions != null ? Number(r.impressions) : undefined,
    reach: r.reach != null ? Number(r.reach) : undefined,
    frequency: r.frequency,
    cpm: r.cpm,
    qualityRanking: r.qualityRanking,
    engagementRateRanking: r.engagementRateRanking,
    conversionRateRanking: r.conversionRateRanking,
    linkClicks: r.linkClicks != null ? Number(r.linkClicks) : undefined,
    clicksAll: r.clicksAll != null ? Number(r.clicksAll) : undefined,
    cpc: r.cpc,
    ctrLinkClick: r.ctrLinkClick,
    landingPageViews:
      r.landingPageViews != null ? Number(r.landingPageViews) : undefined,
    costPerLpv: r.costPerLpv,
    purchaseValue: r.purchaseValue,
    addToCart: r.addToCart != null ? Number(r.addToCart) : undefined,
    initiateCheckout:
      r.initiateCheckout != null ? Number(r.initiateCheckout) : undefined,
    costPerAddToCart: r.costPerAddToCart,
    videoViews3s:
      r.videoViews3s != null ? Number(r.videoViews3s) : undefined,
    videoThruplay:
      r.videoThruplay != null ? Number(r.videoThruplay) : undefined,
    videoAvgWatchTime: r.videoAvgWatchTime,
    country: r.country,
    platform: r.platform,
    placement: r.placement,
    device: r.device,
    age: r.age,
    gender: r.gender,
    delivery: r.delivery,
    adId: r.adId,
    campaignName: r.campaignName,
    campaignId: r.campaignId,
    adSetName: r.adSetName,
    adSetId: r.adSetId,
    dateStart: r.dateStart || formatDateOnly(new Date()),
    dateEnd: r.dateEnd || formatDateOnly(new Date()),
  }));
}

export type BulkImportRow = ReturnType<typeof mapRowsForImport>[number];

export function splitBulkImportRows(
  rows: BulkImportRow[],
  accountId?: string,
) {
  const encoder = new TextEncoder();
  const emptyPayloadBytes = encoder.encode(
    JSON.stringify({ accountId, rows: [] }),
  ).length;
  const chunks: BulkImportRow[][] = [];
  let currentChunk: BulkImportRow[] = [];
  let currentChunkBytes = emptyPayloadBytes;

  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).length;
    const nextChunkBytes =
      currentChunkBytes + rowBytes + (currentChunk.length > 0 ? 1 : 0);

    if (
      currentChunk.length > 0 &&
      nextChunkBytes > MAX_BULK_IMPORT_PAYLOAD_BYTES
    ) {
      chunks.push(currentChunk);
      currentChunk = [row];
      currentChunkBytes = emptyPayloadBytes + rowBytes;
      continue;
    }

    if (
      currentChunk.length === 0 &&
      emptyPayloadBytes + rowBytes > MAX_BULK_IMPORT_PAYLOAD_BYTES
    ) {
      throw new Error(
        "A single import row is too large to send. Reduce the imported columns and try again.",
      );
    }

    currentChunk.push(row);
    currentChunkBytes = nextChunkBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
