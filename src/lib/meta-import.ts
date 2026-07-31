import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  normalizeImportedAdStatus,
  normalizeImportedAdStatusForUpdate,
} from "@/lib/ad-status";
import { fetchMetaCreativePreviewsBatch } from "@/lib/meta-creative-assets";
import type { BulkImportRow } from "@/lib/import-utils";
import {
  fetchMetaAdDelivery,
  fetchMetaAdSetDelivery,
  getMetaAccountWithToken,
} from "@/lib/meta-insights-sync";
import {
  creativeFormatMergeSql,
  mergeCreativeFormat,
  normalizeIncomingCreativeFormat,
  type CreativeFormat,
} from "@/lib/creative-format";
import { adAccounts } from "@/schema/account";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";

export type ImportMetaRow =
  Partial<BulkImportRow>
  & Pick<BulkImportRow, "name" | "dateStart" | "dateEnd">;

type PerformanceLogImportRow = Omit<
  typeof performanceLogs.$inferInsert,
  "id" | "createdAt"
>;

const PERF_IMPORT_BATCH_SIZE = 1_000;

type ImportedCreativeMeta = {
  assetUrl?: string;
  videoUrl?: string;
  format?: CreativeFormat;
};

function mergeImportedCreativeMeta(
  existing: ImportedCreativeMeta | undefined,
  incoming: ImportedCreativeMeta,
): ImportedCreativeMeta {
  const videoUrl = existing?.videoUrl ?? incoming.videoUrl;

  return {
    assetUrl: existing?.assetUrl ?? incoming.assetUrl,
    videoUrl,
    format: mergeCreativeFormat({
      existingFormat: existing?.format,
      incomingFormat: incoming.format,
      incomingVideoUrl: incoming.videoUrl,
    }),
  };
}

function normalizeName(value?: string | null) {
  return value?.trim() || undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function toStagingPerfRow(row: PerformanceLogImportRow) {
  return {
    ad_id: row.adId,
    meta_ad_id: row.metaAdId ?? null,
    roas: row.roas ?? null,
    cpa: row.cpa ?? null,
    ctr: row.ctr ?? null,
    conversion_rate: row.conversionRate ?? null,
    spend: row.spend ?? null,
    conversions: row.conversions ?? null,
    impressions: row.impressions ?? null,
    reach: row.reach ?? null,
    frequency: row.frequency ?? null,
    cpm: row.cpm ?? null,
    link_clicks: row.linkClicks ?? null,
    clicks_all: row.clicksAll ?? null,
    cpc: row.cpc ?? null,
    ctr_link_click: row.ctrLinkClick ?? null,
    landing_page_views: row.landingPageViews ?? null,
    cost_per_lpv: row.costPerLpv ?? null,
    purchase_value: row.purchaseValue ?? null,
    purchase_value_7d_click: row.purchaseValue7dClick ?? null,
    purchase_value_1d_view: row.purchaseValue1dView ?? null,
    attribution_windows: row.attributionWindows ?? null,
    add_to_cart: row.addToCart ?? null,
    initiate_checkout: row.initiateCheckout ?? null,
    cost_per_add_to_cart: row.costPerAddToCart ?? null,
    video_views_3s: row.videoViews3s ?? null,
    video_thruplay: row.videoThruplay ?? null,
    video_avg_watch_time: row.videoAvgWatchTime ?? null,
    country: row.country ?? null,
    platform: row.platform ?? null,
    placement: row.placement ?? null,
    device: row.device ?? null,
    age: row.age ?? null,
    gender: row.gender ?? null,
    quality_ranking: row.qualityRanking ?? null,
    engagement_rate_ranking: row.engagementRateRanking ?? null,
    conversion_rate_ranking: row.conversionRateRanking ?? null,
    date_start: row.dateStart,
    date_end: row.dateEnd,
    organization_id: row.organizationId ?? null,
  };
}

async function replacePerformanceLogRowsViaStaging(rows: PerformanceLogImportRow[]) {
  if (rows.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      create temp table temp_meta_perf_import (
        ad_id text not null,
        meta_ad_id text,
        roas numeric,
        cpa numeric,
        ctr numeric,
        conversion_rate numeric,
        spend numeric,
        conversions integer,
        impressions integer,
        reach integer,
        frequency numeric,
        cpm numeric,
        link_clicks integer,
        clicks_all integer,
        cpc numeric,
        ctr_link_click numeric,
        landing_page_views integer,
        cost_per_lpv numeric,
        purchase_value numeric,
        purchase_value_7d_click numeric,
        purchase_value_1d_view numeric,
        attribution_windows text,
        add_to_cart integer,
        initiate_checkout integer,
        cost_per_add_to_cart numeric,
        video_views_3s integer,
        video_thruplay integer,
        video_avg_watch_time numeric,
        country text,
        platform text,
        placement text,
        device text,
        age text,
        gender text,
        quality_ranking text,
        engagement_rate_ranking text,
        conversion_rate_ranking text,
        date_start date not null,
        date_end date not null,
        organization_id text
      ) on commit drop
    `);

    for (const batch of chunk(rows, PERF_IMPORT_BATCH_SIZE)) {
      await tx.execute(sql`truncate temp_meta_perf_import`);

      const payload = JSON.stringify(batch.map(toStagingPerfRow));

      await tx.execute(sql`
        insert into temp_meta_perf_import (
          ad_id,
          meta_ad_id,
          roas,
          cpa,
          ctr,
          conversion_rate,
          spend,
          conversions,
          impressions,
          reach,
          frequency,
          cpm,
          link_clicks,
          clicks_all,
          cpc,
          ctr_link_click,
          landing_page_views,
          cost_per_lpv,
          purchase_value,
          purchase_value_7d_click,
          purchase_value_1d_view,
          attribution_windows,
          add_to_cart,
          initiate_checkout,
          cost_per_add_to_cart,
          video_views_3s,
          video_thruplay,
          video_avg_watch_time,
          country,
          platform,
          placement,
          device,
          age,
          gender,
          quality_ranking,
          engagement_rate_ranking,
          conversion_rate_ranking,
          date_start,
          date_end,
          organization_id
        )
        select
          ad_id,
          meta_ad_id,
          roas,
          cpa,
          ctr,
          conversion_rate,
          spend,
          conversions,
          impressions,
          reach,
          frequency,
          cpm,
          link_clicks,
          clicks_all,
          cpc,
          ctr_link_click,
          landing_page_views,
          cost_per_lpv,
          purchase_value,
          purchase_value_7d_click,
          purchase_value_1d_view,
          attribution_windows,
          add_to_cart,
          initiate_checkout,
          cost_per_add_to_cart,
          video_views_3s,
          video_thruplay,
          video_avg_watch_time,
          country,
          platform,
          placement,
          device,
          age,
          gender,
          quality_ranking,
          engagement_rate_ranking,
          conversion_rate_ranking,
          date_start,
          date_end,
          organization_id
        from jsonb_to_recordset(${payload}::jsonb) as x(
          ad_id text,
          meta_ad_id text,
          roas numeric,
          cpa numeric,
          ctr numeric,
          conversion_rate numeric,
          spend numeric,
          conversions integer,
          impressions integer,
          reach integer,
          frequency numeric,
          cpm numeric,
          link_clicks integer,
          clicks_all integer,
          cpc numeric,
          ctr_link_click numeric,
          landing_page_views integer,
          cost_per_lpv numeric,
          purchase_value numeric,
          purchase_value_7d_click numeric,
          purchase_value_1d_view numeric,
          attribution_windows text,
          add_to_cart integer,
          initiate_checkout integer,
          cost_per_add_to_cart numeric,
          video_views_3s integer,
          video_thruplay integer,
          video_avg_watch_time numeric,
          country text,
          platform text,
          placement text,
          device text,
          age text,
          gender text,
          quality_ranking text,
          engagement_rate_ranking text,
          conversion_rate_ranking text,
          date_start date,
          date_end date,
          organization_id text
        )
      `);

      await tx.execute(sql`
        delete from performance_log pl
        using temp_meta_perf_import tmp
        where pl.organization_id = tmp.organization_id
          and pl.ad_id = tmp.ad_id
          and pl.date_start = tmp.date_start
          and pl.date_end = tmp.date_end
          and coalesce(pl.country, '') = coalesce(tmp.country, '')
          and coalesce(pl.platform, '') = coalesce(tmp.platform, '')
          and coalesce(pl.placement, '') = coalesce(tmp.placement, '')
          and coalesce(pl.device, '') = coalesce(tmp.device, '')
          and coalesce(pl.age, '') = coalesce(tmp.age, '')
          and coalesce(pl.gender, '') = coalesce(tmp.gender, '')
      `);

      await tx.execute(sql`
        insert into performance_log (
          id,
          ad_id,
          meta_ad_id,
          roas,
          cpa,
          ctr,
          conversion_rate,
          spend,
          conversions,
          impressions,
          reach,
          frequency,
          cpm,
          link_clicks,
          clicks_all,
          cpc,
          ctr_link_click,
          landing_page_views,
          cost_per_lpv,
          purchase_value,
          purchase_value_7d_click,
          purchase_value_1d_view,
          attribution_windows,
          add_to_cart,
          initiate_checkout,
          cost_per_add_to_cart,
          video_views_3s,
          video_thruplay,
          video_avg_watch_time,
          country,
          platform,
          placement,
          device,
          age,
          gender,
          quality_ranking,
          engagement_rate_ranking,
          conversion_rate_ranking,
          date_start,
          date_end,
          organization_id
        )
        select
          md5(
            random()::text
            || clock_timestamp()::text
            || ad_id
            || date_start::text
            || date_end::text
            || coalesce(country, '')
            || coalesce(platform, '')
            || coalesce(placement, '')
            || coalesce(device, '')
            || coalesce(age, '')
            || coalesce(gender, '')
          ),
          ad_id,
          meta_ad_id,
          roas,
          cpa,
          ctr,
          conversion_rate,
          spend,
          conversions,
          impressions,
          reach,
          frequency,
          cpm,
          link_clicks,
          clicks_all,
          cpc,
          ctr_link_click,
          landing_page_views,
          cost_per_lpv,
          purchase_value,
          purchase_value_7d_click,
          purchase_value_1d_view,
          attribution_windows,
          add_to_cart,
          initiate_checkout,
          cost_per_add_to_cart,
          video_views_3s,
          video_thruplay,
          video_avg_watch_time,
          country,
          platform,
          placement,
          device,
          age,
          gender,
          quality_ranking,
          engagement_rate_ranking,
          conversion_rate_ranking,
          date_start,
          date_end,
          organization_id
        from temp_meta_perf_import
      `);
    }
  });
}

export function buildPerformanceLogRows(input: {
  rows: ImportMetaRow[];
  adIdByName: Map<string, string>;
  adIdByMetaId: Map<string, string>;
  organizationId: string;
}) {
  const perfRows: PerformanceLogImportRow[] = [];

  for (const row of input.rows) {
    // An ID-bearing row resolves by Meta ad id or not at all — falling back to
    // the name would attach it to a same-named sibling ad.
    const adId = row.adId
      ? input.adIdByMetaId.get(row.adId)
      : input.adIdByName.get(row.name);
    if (!adId) continue;

    const {
      name: _name,
      delivery: _delivery,
      adId: _adId,
      campaignName: _campaignName,
      campaignId: _campaignId,
      adSetName: _adSetName,
      adSetId: _adSetId,
      ...perfData
    } = row;
    void _name;
    void _delivery;
    void _adId;
    void _campaignName;
    void _campaignId;
    void _adSetName;
    void _adSetId;

    const hasPerf =
      perfData.spend
      || perfData.roas
      || perfData.conversions
      || perfData.linkClicks
      || perfData.impressions;
    if (!hasPerf) continue;

    const { conversionRate: initialConversionRate, ...perfPayload } = perfData;
    let conversionRate = initialConversionRate;
    if (
      !conversionRate
      && perfPayload.conversions
      && perfPayload.linkClicks
      && perfPayload.linkClicks > 0
    ) {
      conversionRate = ((perfPayload.conversions / perfPayload.linkClicks) * 100).toFixed(2);
    }

    perfRows.push({
      ...perfPayload,
      conversionRate,
      adId,
      metaAdId: row.adId ?? null,
      organizationId: input.organizationId,
    });
  }

  return perfRows;
}

async function updateAccountFreshness(input: {
  organizationId: string;
  accountId?: string;
  currentDataDateEnd?: string | null;
  perfRows: PerformanceLogImportRow[];
}) {
  if (!input.accountId) {
    return;
  }

  const dateEnds = input.perfRows.map((row) => row.dateEnd).filter(Boolean) as string[];
  const maxDataDate = dateEnds.sort().reverse()[0] ?? null;
  const nextDataDateEnd = input.currentDataDateEnd && maxDataDate
    ? (input.currentDataDateEnd > maxDataDate ? input.currentDataDateEnd : maxDataDate)
    : input.currentDataDateEnd ?? maxDataDate;

  await db.update(adAccounts).set({
    lastImportedAt: new Date(),
    ...(nextDataDateEnd ? { dataDateEnd: nextDataDateEnd } : {}),
  }).where(
    and(
      eq(adAccounts.id, input.accountId),
      eq(adAccounts.organizationId, input.organizationId),
    ),
  );
}

// Name matching is a legacy/CSV-only path, so keep it inside the account being
// imported. Ads predating account assignment carry a null accountId, which is
// still the same account's history — those stay eligible.
function adAccountScope(accountId?: string) {
  return accountId
    ? sql`(${ads.accountId} = ${accountId} or ${ads.accountId} is null)`
    : undefined;
}

export async function resolveAdsForRows(input: {
  organizationId: string;
  accountId?: string;
  rows: ImportMetaRow[];
}) {
  const metaIds = [...new Set(input.rows.map((row) => row.adId).filter(Boolean) as string[])];
  const adsByMetaId = metaIds.length > 0
    ? await db
        .select({ id: ads.id, name: ads.name, metaId: ads.metaId })
        .from(ads)
        .where(
          and(
            sql`${ads.metaId} IN (${sql.join(metaIds.map((metaId) => sql`${metaId}`), sql`, `)})`,
            eq(ads.organizationId, input.organizationId),
          ),
        )
    : [];

  const adIdByMetaId = new Map(
    adsByMetaId.filter((row) => row.metaId).map((row) => [row.metaId!, row.id]),
  );

  const unmatchedNames = [...new Set(
    input.rows.filter((row) => !row.adId).map((row) => row.name),
  )];

  const adsByName = unmatchedNames.length > 0
    ? await db
        .select({ id: ads.id, name: ads.name })
        .from(ads)
        .where(
          and(
            sql`${ads.name} IN (${sql.join(unmatchedNames.map((name) => sql`${name}`), sql`, `)})`,
            eq(ads.organizationId, input.organizationId),
            adAccountScope(input.accountId),
          ),
        )
    : [];

  return {
    adIdByMetaId,
    adIdByName: new Map(adsByName.map((row) => [row.name, row.id])),
  };
}

export type ExistingAdRow = {
  id: string;
  name: string;
  adCreativeId: string | null;
  adSetId: string | null;
  metaId: string | null;
};

export function matchExistingAdsForImport(input: {
  adInfoMap: Map<string, { name: string; metaAdId?: string }>;
  existingByMetaId: Map<string, ExistingAdRow>;
  existingByName: Map<string, ExistingAdRow>;
  adoptableByName: Map<string, ExistingAdRow[]>;
}) {
  const existingMap = new Map<string, ExistingAdRow>();
  const claimedAdIds = new Set<string>();

  for (const [key, info] of input.adInfoMap) {
    if (info.metaAdId) {
      const byMetaId = input.existingByMetaId.get(info.metaAdId);
      if (byMetaId) {
        existingMap.set(key, byMetaId);
        claimedAdIds.add(byMetaId.id);
        continue;
      }
      // First ID-bearing sync of an ad created by a name-keyed import: adopt
      // the legacy row (the update below stamps its metaId) instead of
      // inserting a twin beside it. Never adopt a row that already has a
      // metaId — that would be a same-named sibling, not this ad.
      const adoptable = (input.adoptableByName.get(info.name) ?? [])
        .find((row) => !claimedAdIds.has(row.id));
      if (adoptable) {
        existingMap.set(key, adoptable);
        claimedAdIds.add(adoptable.id);
      }
      continue;
    }

    const byName = input.existingByName.get(info.name);
    if (byName) {
      existingMap.set(key, byName);
      claimedAdIds.add(byName.id);
    }
  }

  return existingMap;
}

export async function refreshMetaAdStatusesForAccount(input: {
  organizationId: string;
  accountId: string;
}) {
  const account = await getMetaAccountWithToken({
    accountId: input.accountId,
    organizationId: input.organizationId,
  });

  const adRows = await db
    .select({ id: ads.id, metaId: ads.metaId })
    .from(ads)
    .where(
      and(
        eq(ads.accountId, input.accountId),
        eq(ads.organizationId, input.organizationId),
        sql`${ads.metaId} IS NOT NULL`,
      ),
    );

  const adMetaIds = adRows
    .map((row) => row.metaId)
    .filter((metaId): metaId is string => Boolean(metaId));

  if (adMetaIds.length === 0) {
    return { checked: 0, updated: 0 };
  }

  const deliveryByAdId = await fetchMetaAdDelivery({
    adMetaIds,
    accessToken: account.metaAccessToken,
  });

  let updated = 0;
  for (const adRow of adRows) {
    if (!adRow.metaId) continue;
    const delivery = deliveryByAdId.get(adRow.metaId);
    if (!delivery) continue;

    await db
      .update(ads)
      .set({ status: normalizeImportedAdStatus(delivery) })
      .where(
        and(
          eq(ads.id, adRow.id),
          eq(ads.organizationId, input.organizationId),
        ),
      );
    updated += 1;
  }

  return { checked: adMetaIds.length, updated };
}

export async function refreshMetaAdSetStatusesForAccount(input: {
  organizationId: string;
  accountId: string;
}) {
  const account = await getMetaAccountWithToken({
    accountId: input.accountId,
    organizationId: input.organizationId,
  });

  const adSetRows = await db
    .select({ id: adSets.id, metaId: adSets.metaId })
    .from(adSets)
    .where(
      and(
        eq(adSets.organizationId, input.organizationId),
        sql`${adSets.metaId} IS NOT NULL`,
        sql`exists (
          select 1 from ${ads}
          where ${ads.adSetId} = ${adSets.id}
            and ${ads.accountId} = ${input.accountId}
            and ${ads.organizationId} = ${input.organizationId}
        )`,
      ),
    );

  const adSetMetaIds = adSetRows
    .map((row) => row.metaId)
    .filter((metaId): metaId is string => Boolean(metaId));

  if (adSetMetaIds.length === 0) {
    return { checked: 0, updated: 0 };
  }

  const deliveryByAdSetId = await fetchMetaAdSetDelivery({
    adSetMetaIds,
    accessToken: account.metaAccessToken,
  });

  let updated = 0;
  for (const adSetRow of adSetRows) {
    if (!adSetRow.metaId) continue;
    const delivery = deliveryByAdSetId.get(adSetRow.metaId);
    if (!delivery) continue;

    await db
      .update(adSets)
      .set({ status: normalizeImportedAdStatus(delivery) })
      .where(
        and(
          eq(adSets.id, adSetRow.id),
          eq(adSets.organizationId, input.organizationId),
        ),
      );
    updated += 1;
  }

  return { checked: adSetMetaIds.length, updated };
}

export async function enrichMetaCreativePreviews(input: {
  organizationId: string;
  accountId: string;
  adMetaIds: string[];
}) {
  if (input.adMetaIds.length === 0) {
    return { updatedAds: 0, updatedCreatives: 0 };
  }

  const account = await getMetaAccountWithToken({
    accountId: input.accountId,
    organizationId: input.organizationId,
  });

  const uniqueAdMetaIds = [...new Set(input.adMetaIds)];
  const knownDestinationUrlByAdId = new Map<string, string>();
  const existingDestinationRows = await db
    .select({ metaId: ads.metaId, destinationUrl: ads.destinationUrl })
    .from(ads)
    .where(
      and(
        sql`${ads.metaId} IN (${sql.join(uniqueAdMetaIds.map((metaId) => sql`${metaId}`), sql`, `)})`,
        eq(ads.organizationId, input.organizationId),
        sql`${ads.destinationUrl} IS NOT NULL`,
      ),
    );

  for (const row of existingDestinationRows) {
    if (row.metaId && row.destinationUrl) {
      knownDestinationUrlByAdId.set(row.metaId, row.destinationUrl);
    }
  }

  const { previews, successfulAdMetaIds } = await fetchMetaCreativePreviewsBatch({
    adMetaIds: uniqueAdMetaIds,
    metaAccountId: account.metaAccountId,
    accessToken: account.metaAccessToken,
    videoUrlMode: "none",
    knownDestinationUrlByAdId,
  });

  const adRows = await db
    .select({
      id: ads.id,
      metaId: ads.metaId,
      adCreativeId: ads.adCreativeId,
    })
    .from(ads)
    .where(
      and(
        sql`${ads.metaId} IN (${sql.join(uniqueAdMetaIds.map((metaId) => sql`${metaId}`), sql`, `)})`,
        eq(ads.organizationId, input.organizationId),
      ),
    );

  let updatedAds = 0;
  const now = new Date();
  const creativeUpdates = new Map<string, ImportedCreativeMeta>();
  const touchedCreativeIds = new Set<string>();

  for (const adRow of adRows) {
    if (!adRow.metaId) continue;
    if (!successfulAdMetaIds.has(adRow.metaId)) continue;
    const preview = previews.get(adRow.metaId);

    const adSet: Partial<typeof ads.$inferInsert> = {
      enrichmentAttemptedAt: now,
    };
    if (preview?.destinationUrl) adSet.destinationUrl = preview.destinationUrl;
    if (preview?.caption) adSet.caption = preview.caption;

    await db.update(ads).set(adSet).where(
      and(
        eq(ads.id, adRow.id),
        eq(ads.organizationId, input.organizationId),
      ),
    );
    updatedAds += 1;

    if (!adRow.adCreativeId) continue;
    touchedCreativeIds.add(adRow.adCreativeId);
    if (!preview) continue;
    creativeUpdates.set(adRow.adCreativeId, mergeImportedCreativeMeta(
      creativeUpdates.get(adRow.adCreativeId),
      {
        assetUrl: preview.assetUrl ?? undefined,
        videoUrl: preview.videoUrl,
        format: normalizeIncomingCreativeFormat({
          format: preview.format,
          videoUrl: preview.videoUrl,
        }),
      },
    ));
  }

  let updatedCreatives = 0;
  for (const creativeId of touchedCreativeIds) {
    const preview = creativeUpdates.get(creativeId);
    const creativeSet = {
      enrichmentAttemptedAt: now,
      ...(preview?.assetUrl ? { assetUrl: preview.assetUrl } : {}),
      ...(preview?.videoUrl ? { videoUrl: preview.videoUrl } : {}),
      ...(preview?.format
        ? {
            format: creativeFormatMergeSql({
              existingFormat: sql`${adCreatives.format}`,
              incomingFormat: sql`${preview.format}`,
              incomingVideoUrl: preview.videoUrl ? sql`${preview.videoUrl}` : undefined,
            }),
          }
        : {}),
    };

    await db.update(adCreatives).set(creativeSet).where(
      and(
        eq(adCreatives.id, creativeId),
        eq(adCreatives.organizationId, input.organizationId),
      ),
    );
    updatedCreatives += 1;
  }

  return { updatedAds, updatedCreatives };
}

export async function importMetaBreakdownRows(input: {
  organizationId: string;
  accountId?: string;
  rows: ImportMetaRow[];
}) {
  const [accountRecord] = input.accountId
    ? await db
        .select({ dataDateEnd: adAccounts.dataDateEnd })
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.id, input.accountId),
            eq(adAccounts.organizationId, input.organizationId),
          ),
        )
    : [];

  const { adIdByMetaId, adIdByName } = await resolveAdsForRows({
    organizationId: input.organizationId,
    accountId: input.accountId,
    rows: input.rows,
  });

  const perfRows = buildPerformanceLogRows({
    rows: input.rows,
    adIdByMetaId,
    adIdByName,
    organizationId: input.organizationId,
  });

  await replacePerformanceLogRowsViaStaging(perfRows);
  await updateAccountFreshness({
    organizationId: input.organizationId,
    accountId: input.accountId,
    currentDataDateEnd: accountRecord?.dataDateEnd ?? null,
    perfRows,
  });

  return {
    totalRows: input.rows.length,
    perfLogs: perfRows.length,
  };
}

export async function importMetaRows(input: {
  organizationId: string;
  accountId?: string;
  rows: ImportMetaRow[];
}) {
  const rows = input.rows.map((row) => ({ ...row }));

  const [accountRecord] = input.accountId
    ? await db
        .select({
          id: adAccounts.id,
          dataDateEnd: adAccounts.dataDateEnd,
        })
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.id, input.accountId),
            eq(adAccounts.organizationId, input.organizationId),
          ),
        )
    : [];
  const knownAccountId = accountRecord?.id;

  const campaignInfoMap = new Map<string, { name: string; metaId?: string }>();
  for (const row of rows) {
    const campaignName = normalizeName(row.campaignName);
    const campaignMetaId = normalizeName(row.campaignId);
    if (!campaignName && !campaignMetaId) continue;
    const key = campaignMetaId ?? `name:${campaignName}`;
    if (!campaignInfoMap.has(key)) {
      campaignInfoMap.set(key, {
        name: campaignName ?? `Campaign ${campaignMetaId}`,
        metaId: campaignMetaId,
      });
    }
  }

  type ExistingCampaignRow = {
    id: string;
    name: string;
    metaId: string | null;
    accountId: string | null;
  };
  const existingCampaignByMetaId = new Map<string, ExistingCampaignRow>();
  const campaignMetaIds = [...campaignInfoMap.values()]
    .map((campaign) => campaign.metaId)
    .filter(Boolean) as string[];
  if (campaignMetaIds.length > 0) {
    const existingCampaignRows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        metaId: campaigns.metaId,
        accountId: campaigns.accountId,
      })
      .from(campaigns)
      .where(
        and(
          sql`${campaigns.metaId} IN (${sql.join(campaignMetaIds.map((id) => sql`${id}`), sql`, `)})`,
          eq(campaigns.organizationId, input.organizationId),
        ),
      );
    for (const row of existingCampaignRows) {
      if (row.metaId) existingCampaignByMetaId.set(row.metaId, row);
    }
  }

  const campaignNamesWithoutMeta = [...campaignInfoMap.values()]
    .filter((campaign) => !campaign.metaId)
    .map((campaign) => campaign.name);
  const existingCampaignByName = new Map<string, ExistingCampaignRow>();
  if (campaignNamesWithoutMeta.length > 0) {
    const existingCampaignRows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        metaId: campaigns.metaId,
        accountId: campaigns.accountId,
      })
      .from(campaigns)
      .where(
        and(
          sql`${campaigns.name} IN (${sql.join(campaignNamesWithoutMeta.map((name) => sql`${name}`), sql`, `)})`,
          eq(campaigns.organizationId, input.organizationId),
        ),
      );
    for (const row of existingCampaignRows) {
      existingCampaignByName.set(row.name, row);
    }
  }

  const campaignIdByKey = new Map<string, string>();
  const campaignsToCreate: { key: string; name: string; metaId?: string }[] = [];

  for (const [key, campaign] of campaignInfoMap) {
    const existing = (campaign.metaId && existingCampaignByMetaId.get(campaign.metaId))
      || existingCampaignByName.get(campaign.name);
    if (existing) {
      campaignIdByKey.set(key, existing.id);
      const needsUpdate =
        existing.name !== campaign.name ||
        (campaign.metaId && existing.metaId !== campaign.metaId) ||
        (knownAccountId && existing.accountId !== knownAccountId);
      if (needsUpdate) {
        await db.update(campaigns).set({
          name: campaign.name,
          ...(campaign.metaId ? { metaId: campaign.metaId } : {}),
          ...(knownAccountId ? { accountId: knownAccountId } : {}),
        }).where(
          and(
            eq(campaigns.id, existing.id),
            eq(campaigns.organizationId, input.organizationId),
          ),
        );
      }
      continue;
    }
    campaignsToCreate.push({ key, name: campaign.name, metaId: campaign.metaId });
  }

  if (campaignsToCreate.length > 0) {
    for (let i = 0; i < campaignsToCreate.length; i += 500) {
      const batch = campaignsToCreate.slice(i, i + 500);
      const inserted = await db.insert(campaigns).values(
        batch.map((campaign) => ({
          name: campaign.name,
          metaId: campaign.metaId,
          accountId: knownAccountId,
          organizationId: input.organizationId,
        })),
      ).returning({ id: campaigns.id, name: campaigns.name, metaId: campaigns.metaId });
      inserted.forEach((row, index) => {
        campaignIdByKey.set(batch[index]!.key, row.id);
      });
    }
  }

  const adSetInfoMap = new Map<string, { name: string; metaId?: string; campaignDbId: string; accountId?: string }>();
  for (const row of rows) {
    const adSetName = normalizeName(row.adSetName);
    const adSetMetaId = normalizeName(row.adSetId);
    const campaignName = normalizeName(row.campaignName);
    const campaignMetaId = normalizeName(row.campaignId);
    const campaignKey = campaignMetaId ?? (campaignName ? `name:${campaignName}` : undefined);
    const campaignDbId = campaignKey ? campaignIdByKey.get(campaignKey) : undefined;
    if (!campaignDbId || (!adSetName && !adSetMetaId)) continue;
    const key = adSetMetaId ?? `${campaignDbId}:${adSetName}`;
    if (!adSetInfoMap.has(key)) {
      adSetInfoMap.set(key, {
        name: adSetName ?? `Ad Set ${adSetMetaId}`,
        metaId: adSetMetaId,
        campaignDbId,
        accountId: knownAccountId,
      });
    }
  }

  const existingAdSetByMetaId = new Map<string, { id: string; name: string; metaId: string | null; campaignId: string; accountId: string | null }>();
  const adSetMetaIds = [...adSetInfoMap.values()]
    .map((adSet) => adSet.metaId)
    .filter(Boolean) as string[];
  if (adSetMetaIds.length > 0) {
    const existingAdSetRows = await db
      .select({
        id: adSets.id,
        name: adSets.name,
        metaId: adSets.metaId,
        campaignId: adSets.campaignId,
        accountId: adSets.accountId,
      })
      .from(adSets)
      .where(
        and(
          sql`${adSets.metaId} IN (${sql.join(adSetMetaIds.map((id) => sql`${id}`), sql`, `)})`,
          eq(adSets.organizationId, input.organizationId),
        ),
      );
    for (const row of existingAdSetRows) {
      if (row.metaId) existingAdSetByMetaId.set(row.metaId, row);
    }
  }

  const adSetNamesWithoutMeta = [...new Set(
    [...adSetInfoMap.values()].filter((adSet) => !adSet.metaId).map((adSet) => adSet.name),
  )];
  const existingAdSetsByName = new Map<string, { id: string; name: string; metaId: string | null; campaignId: string; accountId: string | null }[]>();
  if (adSetNamesWithoutMeta.length > 0) {
    const existingAdSetRows = await db
      .select({
        id: adSets.id,
        name: adSets.name,
        metaId: adSets.metaId,
        campaignId: adSets.campaignId,
        accountId: adSets.accountId,
      })
      .from(adSets)
      .where(
        and(
          sql`${adSets.name} IN (${sql.join(adSetNamesWithoutMeta.map((name) => sql`${name}`), sql`, `)})`,
          eq(adSets.organizationId, input.organizationId),
        ),
      );
    for (const row of existingAdSetRows) {
      const matches = existingAdSetsByName.get(row.name) ?? [];
      matches.push(row);
      existingAdSetsByName.set(row.name, matches);
    }
  }

  const adSetIdByKey = new Map<string, string>();
  const adSetsToCreate: { key: string; name: string; metaId?: string; campaignDbId: string; accountId?: string }[] = [];

  for (const [key, adSet] of adSetInfoMap) {
    const existing = (adSet.metaId && existingAdSetByMetaId.get(adSet.metaId))
      || (existingAdSetsByName.get(adSet.name) ?? []).find((row) => row.campaignId === adSet.campaignDbId);
    if (existing) {
      adSetIdByKey.set(key, existing.id);
      const needsUpdate =
        existing.name !== adSet.name
        || existing.campaignId !== adSet.campaignDbId
        || (adSet.accountId && existing.accountId !== adSet.accountId)
        || (adSet.metaId && existing.metaId !== adSet.metaId);
      if (needsUpdate) {
        await db.update(adSets).set({
          name: adSet.name,
          campaignId: adSet.campaignDbId,
          ...(adSet.accountId ? { accountId: adSet.accountId } : {}),
          ...(adSet.metaId ? { metaId: adSet.metaId } : {}),
        }).where(
          and(
            eq(adSets.id, existing.id),
            eq(adSets.organizationId, input.organizationId),
          ),
        );
      }
      continue;
    }
    adSetsToCreate.push({
      key,
      name: adSet.name,
      metaId: adSet.metaId,
      campaignDbId: adSet.campaignDbId,
      accountId: adSet.accountId,
    });
  }

  if (adSetsToCreate.length > 0) {
    for (let i = 0; i < adSetsToCreate.length; i += 500) {
      const batch = adSetsToCreate.slice(i, i + 500);
      const inserted = await db.insert(adSets).values(
        batch.map((adSet) => ({
          name: adSet.name,
          metaId: adSet.metaId,
          campaignId: adSet.campaignDbId,
          accountId: adSet.accountId,
          organizationId: input.organizationId,
        })),
      ).returning({ id: adSets.id });
      inserted.forEach((row, index) => {
        adSetIdByKey.set(batch[index]!.key, row.id);
      });
    }
  }

  const adInfoMap = new Map<string, {
    name: string;
    delivery?: string;
    metaAdId?: string;
    adSetDbId?: string;
    destinationUrl?: string;
    caption?: string;
  }>();
  for (const row of rows) {
    const key = row.adId || row.name;
    const adSetKey = normalizeName(row.adSetId)
      ?? (() => {
        const adSetName = normalizeName(row.adSetName);
        const campaignKey = normalizeName(row.campaignId)
          ?? (normalizeName(row.campaignName) ? `name:${normalizeName(row.campaignName)}` : undefined);
        const campaignDbId = campaignKey ? campaignIdByKey.get(campaignKey) : undefined;
        return adSetName && campaignDbId ? `${campaignDbId}:${adSetName}` : undefined;
      })();
    if (!adInfoMap.has(key)) {
      adInfoMap.set(key, {
        name: row.name,
        delivery: row.delivery,
        metaAdId: row.adId,
        adSetDbId: adSetKey ? adSetIdByKey.get(adSetKey) : undefined,
        destinationUrl: row.destinationUrl,
        caption: undefined,
      });
    }
  }

  const metaIds = [...adInfoMap.values()].map((ad) => ad.metaAdId).filter(Boolean) as string[];
  const existingByMetaId = new Map<string, ExistingAdRow>();
  if (metaIds.length > 0) {
    const existingAdRows = await db
      .select({ id: ads.id, name: ads.name, adCreativeId: ads.adCreativeId, adSetId: ads.adSetId, metaId: ads.metaId })
      .from(ads)
      .where(
        and(
          sql`${ads.metaId} IN (${sql.join(metaIds.map((metaId) => sql`${metaId}`), sql`, `)})`,
          eq(ads.organizationId, input.organizationId),
        ),
      );
    for (const row of existingAdRows) {
      if (row.metaId) existingByMetaId.set(row.metaId, row);
    }
  }

  const unmatchedNames = [...new Set(
    [...adInfoMap.values()]
      .filter((info) => !info.metaAdId || !existingByMetaId.has(info.metaAdId))
      .map((info) => info.name),
  )];

  const existingByName = new Map<string, ExistingAdRow>();
  const adoptableByName = new Map<string, ExistingAdRow[]>();
  if (unmatchedNames.length > 0) {
    const existingAdRows = await db
      .select({ id: ads.id, name: ads.name, adCreativeId: ads.adCreativeId, adSetId: ads.adSetId, metaId: ads.metaId })
      .from(ads)
      .where(
        and(
          sql`${ads.name} IN (${sql.join(unmatchedNames.map((name) => sql`${name}`), sql`, `)})`,
          eq(ads.organizationId, input.organizationId),
          adAccountScope(knownAccountId),
        ),
      );
    for (const row of existingAdRows) {
      if (!existingByName.has(row.name)) existingByName.set(row.name, row);
      if (row.metaId === null) {
        adoptableByName.set(row.name, [...(adoptableByName.get(row.name) ?? []), row]);
      }
    }
  }

  const existingMap = matchExistingAdsForImport({
    adInfoMap,
    existingByMetaId,
    existingByName,
    adoptableByName,
  });

  const newKeys = [...adInfoMap.keys()].filter((key) => !existingMap.has(key));

  const importedCreativeNames = [...new Set([...adInfoMap.values()].map((ad) => ad.name))];
  const importedCreativeMetaByName = new Map<string, ImportedCreativeMeta>();
  for (const row of rows) {
    if (!row.assetUrl && !row.videoUrl && !row.format) continue;
    importedCreativeMetaByName.set(row.name, mergeImportedCreativeMeta(
      importedCreativeMetaByName.get(row.name),
      {
        assetUrl: row.assetUrl,
        videoUrl: row.videoUrl,
        format: normalizeIncomingCreativeFormat({
          format: row.format,
          videoUrl: row.videoUrl,
        }),
      },
    ));
  }
  const creativeIdByName = new Map<string, string>();
  const createdCreatives: { id: string; name: string }[] = [];

  if (importedCreativeNames.length > 0) {
    const existingCreativeRows = await db
      .select({
        id: adCreatives.id,
        name: adCreatives.name,
        createdAt: adCreatives.createdAt,
        linkedAds: sql<number>`count(${ads.id})`.as("linked_ads"),
      })
      .from(adCreatives)
      .leftJoin(ads, eq(ads.adCreativeId, adCreatives.id))
      .where(and(
        sql`${adCreatives.name} IN (${sql.join(importedCreativeNames.map((name) => sql`${name}`), sql`, `)})`,
        eq(adCreatives.organizationId, input.organizationId),
      ))
      .groupBy(adCreatives.id, adCreatives.name, adCreatives.createdAt)
      .orderBy(adCreatives.name, desc(sql<number>`count(${ads.id})`), adCreatives.createdAt);

    for (const row of existingCreativeRows) {
      if (!creativeIdByName.has(row.name)) {
        creativeIdByName.set(row.name, row.id);
      }
    }
  }

  const creativeNamesToCreate = importedCreativeNames.filter((name) => !creativeIdByName.has(name));
  if (creativeNamesToCreate.length > 0) {
    for (let i = 0; i < creativeNamesToCreate.length; i += 500) {
      const batch = creativeNamesToCreate.slice(i, i + 500);
      const inserted = await db.insert(adCreatives).values(
        batch.map((name) => ({
          name,
          organizationId: input.organizationId,
          assetUrl: importedCreativeMetaByName.get(name)?.assetUrl,
          videoUrl: importedCreativeMetaByName.get(name)?.videoUrl,
          format: importedCreativeMetaByName.get(name)?.format,
        })),
      ).returning({ id: adCreatives.id, name: adCreatives.name });
      for (const creative of inserted) {
        creativeIdByName.set(creative.name, creative.id);
        createdCreatives.push(creative);
      }
    }
  }

  for (const [name, creativeId] of creativeIdByName) {
    const meta = importedCreativeMetaByName.get(name);
    if (!meta?.assetUrl && !meta?.videoUrl && !meta?.format) continue;

    await db.update(adCreatives).set({
      ...(meta.assetUrl ? { assetUrl: meta.assetUrl } : {}),
      ...(meta.videoUrl ? { videoUrl: meta.videoUrl } : {}),
      ...(meta.format
        ? {
            format: creativeFormatMergeSql({
              existingFormat: sql`${adCreatives.format}`,
              incomingFormat: sql`${meta.format}`,
              incomingVideoUrl: meta.videoUrl ? sql`${meta.videoUrl}` : undefined,
            }),
          }
        : {}),
    }).where(
      and(
        eq(adCreatives.id, creativeId),
        eq(adCreatives.organizationId, input.organizationId),
      ),
    );
  }

  if (newKeys.length > 0) {
    const newAdsValues = newKeys.map((key) => {
      const info = adInfoMap.get(key)!;
      return {
        name: info.name,
        adSetId: info.adSetDbId,
        adCreativeId: creativeIdByName.get(info.name),
        status: normalizeImportedAdStatus(info.delivery),
        metaId: info.metaAdId,
        destinationUrl: info.destinationUrl,
        caption: info.caption,
        accountId: knownAccountId,
        organizationId: input.organizationId,
      };
    });

    for (let i = 0; i < newAdsValues.length; i += 500) {
      const batch = newAdsValues.slice(i, i + 500);
      await db.insert(ads).values(batch).returning();
    }
  }

  for (const [key, existing] of existingMap) {
    const info = adInfoMap.get(key)!;
    const status = normalizeImportedAdStatusForUpdate(info.delivery);
    await db.update(ads).set({
      name: info.name,
      ...(status ? { status } : {}),
      ...(creativeIdByName.get(info.name) ? { adCreativeId: creativeIdByName.get(info.name) } : {}),
      ...(info.adSetDbId ? { adSetId: info.adSetDbId } : {}),
      ...(info.metaAdId ? { metaId: info.metaAdId } : {}),
      ...(info.destinationUrl ? { destinationUrl: info.destinationUrl } : {}),
      ...(info.caption ? { caption: info.caption } : {}),
      ...(knownAccountId ? { accountId: knownAccountId } : {}),
    }).where(
      and(eq(ads.id, existing.id), eq(ads.organizationId, input.organizationId)),
    );
  }

  if (importedCreativeNames.length > 0) {
    const canonicalCreativeIds = [...new Set([...creativeIdByName.values()])];
    const orphanDuplicateCreatives = await db
      .select({ id: adCreatives.id })
      .from(adCreatives)
      .leftJoin(ads, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          sql`${adCreatives.name} IN (${sql.join(importedCreativeNames.map((name) => sql`${name}`), sql`, `)})`,
          sql`${adCreatives.id} NOT IN (${sql.join(canonicalCreativeIds.map((id) => sql`${id}`), sql`, `)})`,
          eq(adCreatives.organizationId, input.organizationId),
        ),
      )
      .groupBy(adCreatives.id)
      .having(sql`count(${ads.id}) = 0`);

    if (orphanDuplicateCreatives.length > 0) {
      await db.delete(adCreatives).where(
        sql`${adCreatives.id} IN (${sql.join(orphanDuplicateCreatives.map((creative) => sql`${creative.id}`), sql`, `)})`,
      );
    }
  }

  const allAdNames = [...new Set([...adInfoMap.values()].map((ad) => ad.name))];
  const allAdMetaIds = [...new Set(metaIds)];
  const allAds = allAdNames.length > 0 || allAdMetaIds.length > 0
    ? await db
        .select({ id: ads.id, name: ads.name, metaId: ads.metaId })
        .from(ads)
        .where(
          and(
            or(
              allAdNames.length > 0
                ? sql`${ads.name} IN (${sql.join(allAdNames.map((name) => sql`${name}`), sql`, `)})`
                : undefined,
              allAdMetaIds.length > 0
                ? sql`${ads.metaId} IN (${sql.join(allAdMetaIds.map((metaId) => sql`${metaId}`), sql`, `)})`
                : undefined,
            ),
            eq(ads.organizationId, input.organizationId),
            adAccountScope(knownAccountId),
          ),
        )
    : [];
  const adIdByName = new Map(allAds.map((ad) => [ad.name, ad.id]));
  const adIdByMetaId = new Map(allAds.filter((ad) => ad.metaId).map((ad) => [ad.metaId!, ad.id]));

  const perfRows = buildPerformanceLogRows({
    rows,
    adIdByMetaId,
    adIdByName,
    organizationId: input.organizationId,
  });

  await replacePerformanceLogRowsViaStaging(perfRows);

  const results = newKeys.map((key) => {
    const info = adInfoMap.get(key)!;
    const adId = (info.metaAdId ? adIdByMetaId.get(info.metaAdId) : adIdByName.get(info.name)) || key;
    return { id: adId, name: info.name };
  });

  await updateAccountFreshness({
    organizationId: input.organizationId,
    accountId: knownAccountId,
    currentDataDateEnd: accountRecord?.dataDateEnd ?? null,
    perfRows,
  });

  return {
    created: results,
    totalRows: rows.length,
    uniqueAds: adInfoMap.size,
    perfLogs: perfRows.length,
    createdCreatives,
    previewAdMetaIds: [...new Set(rows.map((row) => row.adId).filter(Boolean) as string[])],
  };
}
