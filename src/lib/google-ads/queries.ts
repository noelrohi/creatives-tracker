import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gclidProbeReports, googleAdsCampaignFacts } from "@/schema/google-ads";
import { shopifyOrders } from "@/schema/shopify";

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

/**
 * The captioned reference beside the "Google says" table: our google-bucket
 * Shopify Net sales over the same inclusive store-day range. Different
 * measurement system — the lab labels it as non-reconciling context.
 */
export async function getGoogleBucketNetSales(params: {
  organizationId: string;
  storeId: string;
  fromDay: string;
  toDay: string;
}): Promise<{ netSales: number; orderCount: number }> {
  const [row] = await db
    .select({
      netSales: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      orderCount: sql<string>`count(*)`,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, params.organizationId),
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.bucket, "google"),
        gte(shopifyOrders.orderDay, params.fromDay),
        lte(shopifyOrders.orderDay, params.toDay),
      ),
    );
  return { netSales: Number(row.netSales), orderCount: Number(row.orderCount) };
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
