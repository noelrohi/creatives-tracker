/**
 * Backfill captions for all ads from Meta creative data.
 *
 * Fetches the caption/body text from the ad's creative object_story_spec
 * or asset_feed_spec. Groups ads by account to minimize API calls.
 *
 * Usage: bun scripts/backfill-captions.ts
 */

import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adAccounts } from "@/schema/account";
import { eq, isNull, isNotNull, and } from "drizzle-orm";

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const CHUNK_SIZE = 50;

type StorySpec = {
  link_data?: { message?: string };
  video_data?: { message?: string };
  photo_data?: { message?: string };
};

type FeedSpec = {
  bodies?: { text?: string }[];
};

type Creative = {
  body?: string;
  object_story_spec?: StorySpec;
  asset_feed_spec?: FeedSpec;
};

function getCaption(creative: Creative | undefined): string | undefined {
  if (!creative) return undefined;
  // Top-level body field
  if (creative.body) return creative.body;
  // object_story_spec message fields
  const spec = creative.object_story_spec;
  if (spec?.link_data?.message) return spec.link_data.message;
  if (spec?.video_data?.message) return spec.video_data.message;
  if (spec?.photo_data?.message) return spec.photo_data.message;
  // asset_feed_spec fallback for dynamic creatives
  const bodies = creative.asset_feed_spec?.bodies;
  if (bodies?.[0]?.text) return bodies[0].text;
  return undefined;
}

async function fetchCaptions(
  metaIds: string[],
  accessToken: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (let i = 0; i < metaIds.length; i += CHUNK_SIZE) {
    const chunk = metaIds.slice(i, i + CHUNK_SIZE);
    const url = new URL(`${GRAPH_API_BASE}/`);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set(
      "fields",
      "creative{body,object_story_spec,asset_feed_spec}",
    );

    const res = await fetch(url);
    if (!res.ok) {
      console.error(
        `  Meta API error (chunk ${i / CHUNK_SIZE + 1}): ${res.status} ${res.statusText}`,
      );
      continue;
    }

    const data = (await res.json()) as Record<
      string,
      { creative?: Creative }
    >;
    for (const metaId of chunk) {
      const caption = getCaption(data[metaId]?.creative);
      if (caption) results.set(metaId, caption);
    }

    // Respect rate limits
    if (i + CHUNK_SIZE < metaIds.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

async function main() {
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

    const adsToBackfill = await db
      .select({ id: ads.id, metaId: ads.metaId })
      .from(ads)
      .where(
        and(
          eq(ads.accountId, account.id),
          isNotNull(ads.metaId),
          isNull(ads.caption),
        ),
      );

    if (adsToBackfill.length === 0) {
      console.log(`${account.name}: no ads to backfill`);
      continue;
    }

    const metaIds = adsToBackfill.map((a) => a.metaId!);
    const chunks = Math.ceil(metaIds.length / CHUNK_SIZE);
    console.log(
      `${account.name}: ${adsToBackfill.length} ads → ${chunks} API call(s)`,
    );

    const captionMap = await fetchCaptions(metaIds, account.metaAccessToken);
    console.log(`  Got ${captionMap.size} captions`);

    let updated = 0;
    await db.transaction(async (tx) => {
      for (const ad of adsToBackfill) {
        const caption = captionMap.get(ad.metaId!);
        if (caption) {
          await tx
            .update(ads)
            .set({ caption })
            .where(eq(ads.id, ad.id));
          updated++;
        }
      }
    });

    console.log(
      `  Updated ${updated} ads, skipped ${adsToBackfill.length - updated}\n`,
    );
    totalUpdated += updated;
    totalSkipped += adsToBackfill.length - updated;
  }

  console.log(`Done. Updated: ${totalUpdated}, No caption found: ${totalSkipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
