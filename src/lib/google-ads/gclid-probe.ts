import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { gclidProbeReports } from "@/schema/google-ads";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";
import { extractClickIdObservation } from "@/lib/google-ads/click-id-extractor";
import {
  EnvironmentGoogleAdsCredentialProvider,
  type GoogleAdsCredentialProvider,
} from "@/lib/google-ads/credential-provider";
import { accountDay, addDays } from "@/lib/google-ads/facts";
import type {
  ClickIdKind,
  GclidProbeParamFingerprint,
  GclidProbeSummary,
} from "@/lib/google-ads/types";

const SCAN_BATCH_SIZE = 500;
const PROBE_WINDOW_DAYS = 90;
const MAX_FINGERPRINT_KEYS = 50;
/** Keys that may appear literally in the fingerprint; everything else is hashed. */
const FINGERPRINT_KEY_ALLOWLIST = new Set([
  "gclid",
  "wbraid",
  "gbraid",
  "gad_source",
  "srsltid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
  "fbclid",
  "msclkid",
  "ttclid",
  "irclickid",
]);

export type ProbeReportRecord = typeof gclidProbeReports.$inferSelect;

export type PilotProbeStore = {
  id: string;
  organizationId: string;
  ianaTimezone: string | null;
};

/**
 * Resolves the pilot store directly from the provider's server-side
 * shop-domain binding — no connection row required. Readers (e.g. the
 * `probeReport` tRPC query) use this so a probe that ran before any Google
 * Ads connection existed is still resolvable; `null` means either the
 * binding's shop domain has no Shopify store yet, or the caller should treat
 * probe lookup as unavailable.
 */
export async function resolvePilotProbeStore(
  provider: GoogleAdsCredentialProvider = new EnvironmentGoogleAdsCredentialProvider(),
): Promise<PilotProbeStore | null> {
  const binding = await provider.getPilotBinding();
  const [store] = await db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      ianaTimezone: shopifyStores.ianaTimezone,
    })
    .from(shopifyStores)
    .where(eq(shopifyStores.shopDomain, binding.shopDomain))
    .limit(1);
  return store ?? null;
}

/**
 * Creates the durable running report row for the trailing 90 store-days.
 * Store scope resolves server-side from the environment shop-domain binding.
 */
export async function prepareGclidProbeRun(
  provider: GoogleAdsCredentialProvider = new EnvironmentGoogleAdsCredentialProvider(),
  now: Date = new Date(),
): Promise<ProbeReportRecord> {
  const store = await resolvePilotProbeStore(provider);
  if (!store) throw new Error("Configured Google Ads shop domain has no Shopify store");
  // orderDay is a store-timezone day, so the window boundary must be computed
  // in that timezone too — UTC slicing would be off by one near midnight for
  // any store not on UTC.
  const toDay = accountDay(now, store.ianaTimezone ?? "UTC");
  const fromDay = addDays(toDay, -(PROBE_WINDOW_DAYS - 1));
  const [report] = await db
    .insert(gclidProbeReports)
    .values({
      organizationId: store.organizationId,
      storeId: store.id,
      windowFromDay: fromDay,
      windowToDay: toDay,
    })
    .returning();
  return report;
}

/**
 * `probeReportId` must be a server-generated id (minted by
 * `prepareGclidProbeRun` and read back from the durable row) — never accept
 * one supplied by a caller/browser. This function trusts the id to resolve
 * the correct org/store scope with no separate authorization check, so a
 * caller-supplied id would let one org fail (or, in `runGclidProbe`, read)
 * another org's report: an IDOR. Routes must only ever pass ids they minted
 * themselves in the same request chain.
 */
export async function failGclidProbeReport(params: {
  probeReportId: string;
  code: string;
  message: string;
}): Promise<void> {
  await db
    .update(gclidProbeReports)
    .set({
      status: "failed",
      errorCode: params.code,
      errorMessage: params.message,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(gclidProbeReports.id, params.probeReportId),
        eq(gclidProbeReports.status, "running"),
      ),
    );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintKey(key: string): { key: string; hashed: boolean } {
  if (FINGERPRINT_KEY_ALLOWLIST.has(key)) return { key, hashed: false };
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return { key: `sha256:${digest}`, hashed: true };
}

/**
 * Scans the report's window and publishes the aggregate summary.
 *
 * `probeReportId` must be a server-generated id (minted by
 * `prepareGclidProbeRun`) — never accept one supplied by a caller/browser.
 * The report row is trusted as-is to resolve the org/store scope for the
 * scan; a caller-supplied id would let one org read another org's report
 * data via this function's return value: an IDOR. Routes must only ever
 * pass ids they minted themselves in the same request chain.
 */
export async function runGclidProbe(params: {
  probeReportId: string;
}): Promise<GclidProbeSummary> {
  const [report] = await db
    .select()
    .from(gclidProbeReports)
    .where(eq(gclidProbeReports.id, params.probeReportId))
    .limit(1);
  if (!report) throw new Error("gclid probe report does not exist");
  if (report.status !== "running") {
    throw new Error("gclid probe report is not running");
  }

  const byKind: Record<ClickIdKind, number> = { gclid: 0, wbraid: 0, gbraid: 0 };
  const byBucket = new Map<string, { orders: number; withClickId: number }>();
  const keyCounts = new Map<string, number>();
  let ordersScanned = 0;
  let ordersWithAnyClickId = 0;
  let journeyMissing = 0;
  let parseFailures = 0;
  let multiKindOrders = 0;

  let cursor: string | null = null;
  for (;;) {
    const batch: Array<{
      id: string;
      bucket: string | null;
      customerJourney: Record<string, unknown> | null;
    }> = await db
      .select({
        id: shopifyOrders.id,
        bucket: shopifyOrders.bucket,
        customerJourney: shopifyOrders.customerJourney,
      })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, report.organizationId),
          eq(shopifyOrders.storeId, report.storeId),
          gte(shopifyOrders.orderDay, report.windowFromDay),
          lte(shopifyOrders.orderDay, report.windowToDay),
          cursor ? gt(shopifyOrders.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(shopifyOrders.id))
      .limit(SCAN_BATCH_SIZE);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const order of batch) {
      ordersScanned += 1;
      const observation = extractClickIdObservation(order.customerJourney);
      const bucket = order.bucket ?? "pending";
      const cell = byBucket.get(bucket) ?? { orders: 0, withClickId: 0 };
      cell.orders += 1;
      if (observation.journeyMissing) journeyMissing += 1;
      if (observation.parseFailed) parseFailures += 1;
      if (observation.kinds.length > 0) {
        ordersWithAnyClickId += 1;
        cell.withClickId += 1;
        for (const kind of observation.kinds) byKind[kind] += 1;
        if (observation.kinds.length > 1) multiKindOrders += 1;
      }
      byBucket.set(bucket, cell);
      for (const key of observation.paramKeys) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const paramKeyFingerprints: GclidProbeParamFingerprint[] = [...keyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FINGERPRINT_KEYS)
    .map(([key, count]) => ({ ...fingerprintKey(key), count }));

  const summary: GclidProbeSummary = {
    ordersScanned,
    ordersWithAnyClickId,
    byKind,
    byBucket: Object.fromEntries(byBucket),
    journeyMissing,
    parseFailures,
    multiKindOrders,
    paramKeyFingerprints,
  };
  const checksum = createHash("sha256").update(canonicalJson(summary)).digest("hex");

  const published = await db
    .update(gclidProbeReports)
    .set({
      status: "completed",
      ordersScanned,
      summary,
      checksum,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(gclidProbeReports.id, params.probeReportId),
        eq(gclidProbeReports.status, "running"),
      ),
    )
    .returning({ id: gclidProbeReports.id });
  if (published.length !== 1) {
    throw new Error("gclid probe publication raced");
  }
  return summary;
}
