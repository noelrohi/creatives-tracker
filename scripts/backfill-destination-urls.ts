/**
 * Backfill destination URLs for all ads from Meta creative data.
 *
 * Groups ads by account to minimize API calls (one batch per 50 ads per account).
 * Only fetches for ads that have a meta_id and are missing a destination_url.
 *
 * Usage: bun scripts/backfill-destination-urls.ts
 */

import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adAccounts } from "@/schema/account";
import { eq, isNull, isNotNull, and, sql } from "drizzle-orm";

const GRAPH_API_VERSION = "v25.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const CHUNK_SIZE = 50;

type StorySpec = {
  link_data?: { link?: string };
  video_data?: { call_to_action?: { value?: { link?: string } } };
};

type Creative = {
  link_url?: string;
  object_story_spec?: StorySpec;
  asset_feed_spec?: { bodies?: unknown[]; link_urls?: { website_url?: string }[] };
};

function getDestinationUrl(creative: Creative | undefined): string | undefined {
  if (!creative) return undefined;
  if (creative.link_url) return creative.link_url;
  const spec = creative.object_story_spec;
  if (spec?.link_data?.link) return spec.link_data.link;
  if (spec?.video_data?.call_to_action?.value?.link) {
    return spec.video_data.call_to_action.value.link;
  }
  // asset_feed_spec fallback for dynamic creatives
  const feedUrls = creative.asset_feed_spec?.link_urls;
  if (feedUrls?.[0]?.website_url) return feedUrls[0].website_url;
  return undefined;
}

async function fetchDestinationUrls(
  metaIds: string[],
  accessToken: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (let i = 0; i < metaIds.length; i += CHUNK_SIZE) {
    const chunk = metaIds.slice(i, i + CHUNK_SIZE);
    const url = new URL(`${GRAPH_API_BASE}/`);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set("fields", "creative{link_url,object_story_spec,asset_feed_spec}");

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  Meta API error (chunk ${i / CHUNK_SIZE + 1}): ${res.status} ${res.statusText}`);
      continue;
    }

    const data = (await res.json()) as Record<string, { creative?: Creative }>;
    for (const metaId of chunk) {
      const destUrl = getDestinationUrl(data[metaId]?.creative);
      if (destUrl) results.set(metaId, destUrl);
    }

    // Respect rate limits — small delay between chunks
    if (i + CHUNK_SIZE < metaIds.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

async function main() {
  // Get all accounts with access tokens
  const accounts = await db
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      metaAccountId: adAccounts.metaAccountId,
      metaAccessToken: adAccounts.metaAccessToken,
    })
    .from(adAccounts)
    .where(isNotNull(adAccounts.metaAccessToken));

  console.log(`Found ${accounts.length} account(s) with access tokens\n`);

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const account of accounts) {
    if (!account.metaAccessToken) continue;

    // Get ads missing destination URL for this account
    const adsToBackfill = await db
      .select({ id: ads.id, metaId: ads.metaId })
      .from(ads)
      .where(
        and(
          eq(ads.accountId, account.id),
          isNotNull(ads.metaId),
          isNull(ads.destinationUrl),
        ),
      );

    if (adsToBackfill.length === 0) {
      console.log(`${account.name}: no ads to backfill`);
      continue;
    }

    const metaIds = adsToBackfill.map((a) => a.metaId!);
    const chunks = Math.ceil(metaIds.length / CHUNK_SIZE);
    console.log(`${account.name}: ${adsToBackfill.length} ads → ${chunks} API call(s)`);

    const urlMap = await fetchDestinationUrls(metaIds, account.metaAccessToken);
    console.log(`  Got ${urlMap.size} destination URLs`);

    // Batch update in a single transaction
    let updated = 0;
    await db.transaction(async (tx) => {
      for (const ad of adsToBackfill) {
        const destUrl = urlMap.get(ad.metaId!);
        if (destUrl) {
          await tx
            .update(ads)
            .set({ destinationUrl: destUrl })
            .where(eq(ads.id, ad.id));
          updated++;
        }
      }
    });

    console.log(`  Updated ${updated} ads, skipped ${adsToBackfill.length - updated}\n`);
    totalUpdated += updated;
    totalSkipped += adsToBackfill.length - updated;
  }

  console.log(`Done. Updated: ${totalUpdated}, No URL found: ${totalSkipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
