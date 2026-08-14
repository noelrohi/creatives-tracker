import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { getBucketTotals } from "@/lib/attribution-queries";
import { gclidProbeReports, googleAdsCampaignFacts } from "@/schema/google-ads";

export type CampaignFactsSummaryRow = {
  campaignId: string;
  campaignName: string;
  channelType: string | null;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionsValue: number;
};

/** Aggregates stored facts per campaign over an inclusive account-day range. */
export async function listCampaignFactsSummary(params: {
  connectionId: string;
  fromDay: string;
  toDay: string;
}): Promise<CampaignFactsSummaryRow[]> {
  const rows = await db
    .select({
      campaignId: googleAdsCampaignFacts.campaignId,
      campaignName: sql<string>`max(${googleAdsCampaignFacts.campaignName})`,
      channelType: sql<string | null>`max(${googleAdsCampaignFacts.channelType})`,
      costMicros: sql<string>`coalesce(sum(${googleAdsCampaignFacts.costMicros}), 0)`,
      impressions: sql<string>`coalesce(sum(${googleAdsCampaignFacts.impressions}), 0)`,
      clicks: sql<string>`coalesce(sum(${googleAdsCampaignFacts.clicks}), 0)`,
      conversions: sql<string>`coalesce(sum(${googleAdsCampaignFacts.conversions}), 0)`,
      conversionsValue: sql<string>`coalesce(sum(${googleAdsCampaignFacts.conversionsValue}), 0)`,
    })
    .from(googleAdsCampaignFacts)
    .where(
      and(
        eq(googleAdsCampaignFacts.connectionId, params.connectionId),
        gte(googleAdsCampaignFacts.factDate, params.fromDay),
        lte(googleAdsCampaignFacts.factDate, params.toDay),
      ),
    )
    .groupBy(googleAdsCampaignFacts.campaignId)
    .orderBy(sql`sum(${googleAdsCampaignFacts.costMicros}) desc`);
  return rows.map((row) => ({
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    channelType: row.channelType,
    costMicros: Number(row.costMicros),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    conversions: Number(row.conversions),
    conversionsValue: Number(row.conversionsValue),
  }));
}

export type GoogleBucketReference = {
  /**
   * Integer cents: gross Net sales minus refunds for the "google" bucket,
   * matching `getBucketTotals`'s `BucketTotal.revenueCents` on the
   * attribution page (refunds carry no bucket of their own — they inherit
   * the order's, per attribution-queries.ts). Never a float.
   */
  netSalesCents: number;
  orderCount: number;
};

/**
 * The captioned reference beside the "Google says" table: our google-bucket
 * Shopify Net sales (gross minus refunds) over the same inclusive store-day
 * range. Different measurement system from Google's own numbers — the lab
 * labels it as non-reconciling context — but it must still agree with the
 * "google" row on the attribution page, so this reuses `getBucketTotals`
 * rather than re-deriving gross-only totals locally.
 */
export async function getGoogleBucketNetSales(params: {
  organizationId: string;
  storeId: string;
  fromDay: string;
  toDay: string;
}): Promise<GoogleBucketReference> {
  const totals = await getBucketTotals({
    organizationId: params.organizationId,
    storeId: params.storeId,
    dateFrom: params.fromDay,
    dateTo: params.toDay,
  });
  const google = totals.buckets.find((bucket) => bucket.bucket === "google");
  return {
    netSalesCents: google?.revenueCents ?? 0,
    orderCount: google?.orderCount ?? 0,
  };
}

export async function getLatestGclidProbeReport(params: {
  organizationId: string;
  storeId: string;
}) {
  const [report] = await db
    .select()
    .from(gclidProbeReports)
    .where(
      and(
        eq(gclidProbeReports.organizationId, params.organizationId),
        eq(gclidProbeReports.storeId, params.storeId),
      ),
    )
    .orderBy(desc(gclidProbeReports.createdAt))
    .limit(1);
  return report ?? null;
}
