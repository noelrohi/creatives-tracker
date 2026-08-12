/**
 * Landing pages (spec §5): one identity for a URL however it reaches us, the
 * harvest that creates those rows from ads and journeys, and the pure pieces of
 * the classification job (text extraction, content hash, write rules).
 *
 * The model call and the page fetch live in trigger/classify-landing-pages.ts;
 * everything decidable without the network lives here so it can be tested.
 */

import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { landingPages } from "@/schema/landing-page";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";

/** Orders per keyset page. ~40k orders must not land in memory at once. */
const ORDER_SCAN_BATCH_SIZE = 500;
/** Ids per UPDATE, matching the ingest's own chunking. */
const STAMP_BATCH_SIZE = 200;

/**
 * Identity for a landing page: lowercased host + path, no scheme, no query, no
 * fragment, no trailing slash, no `www.`. The same function runs over ad
 * destination URLs and journey landing pages — one normalization, or the two
 * sources would never meet on the same row.
 *
 * Journey values are sometimes path-only, so a relative value resolves against
 * `fallbackHost` (the store domain). Anything unparseable, or not http(s),
 * returns null rather than a half-normalized string.
 */
export function normalizeLandingPageUrl(
  raw: string | null | undefined,
  fallbackHost?: string | null,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const host = normalizeHost(fallbackHost);
  const candidate = trimmed.startsWith("//")
    ? `https:${trimmed}`
    : trimmed.startsWith("/")
      ? host
        ? `https://${host}${trimmed}`
        : null
      : /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
        ? trimmed
        : // Scheme-less and not a path: `shop.example.com/pages/x` is a host,
          // `pages/x` is a relative path off the store domain.
          /^[^/]+\.[^/]+/.test(trimmed)
          ? `https://${trimmed}`
          : host
            ? `https://${host}/${trimmed}`
            : null;

  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hostname = normalizeHost(url.hostname);
  if (!hostname) return null;

  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  return `${hostname}${path}`;
}

function normalizeHost(value: string | null | undefined) {
  const host = (value ?? "").trim().toLowerCase().replace(/^www\./, "");
  return host.length > 0 ? host : null;
}

/**
 * The rollup key for a page's `-vN` variants: v4 and v5 of an advertorial are
 * separate pages with separate copy, but they answer the same question about
 * which offer is working, so the version suffix is dropped from the last
 * segment. A path with no suffix is its own family.
 */
export function landingPageFamily(normalizedUrl: string): string {
  const separator = normalizedUrl.lastIndexOf("/");
  if (separator < 0) return normalizedUrl;

  const head = normalizedUrl.slice(0, separator);
  const lastSegment = normalizedUrl.slice(separator + 1);
  const base = lastSegment.replace(/-v\d+$/, "");
  return `${head}/${base}`;
}

export type HarvestResult = {
  adsScanned: number;
  adsLinked: number;
  ordersScanned: number;
  ordersLinked: number;
  pages: number;
};

/**
 * Creates the `landing_page` rows both sources imply and stamps the FKs back.
 * Idempotent by construction — the unique (organizationId, normalizedUrl) key
 * absorbs the Meta and Shopify syncs racing on the same page, and every write
 * is a no-op once the row already says what this run would say.
 */
export async function harvestLandingPages(params: {
  organizationId: string;
  storeId?: string;
  now?: Date;
}): Promise<HarvestResult> {
  const now = params.now ?? new Date();
  const pageIdsByUrl = new Map<string, string>();

  const fromAds = await harvestFromAds({
    organizationId: params.organizationId,
    now,
    pageIdsByUrl,
  });
  const fromOrders = await harvestFromOrders({
    organizationId: params.organizationId,
    storeId: params.storeId,
    now,
    pageIdsByUrl,
  });

  return {
    ...fromAds,
    ...fromOrders,
    pages: pageIdsByUrl.size,
  };
}

/**
 * Upserts the pages and returns their ids. `firstSeen*` is a first-sighting
 * record, so it is only ever filled in, never moved forward.
 */
async function upsertLandingPages(params: {
  organizationId: string;
  normalizedUrls: string[];
  seenAt: Date;
  source: "ads" | "journeys";
  pageIdsByUrl: Map<string, string>;
}) {
  // Every url goes through, cached id or not: a page the ad pass already
  // created still needs its journey first-sighting recorded, and that is what
  // provenance is derived from.
  const urls = [...new Set(params.normalizedUrls)];
  const family = sql`coalesce(${landingPages.family}, excluded.family)`;
  const set =
    params.source === "ads"
      ? {
          family,
          firstSeenInAdsAt: sql`coalesce(${landingPages.firstSeenInAdsAt}, excluded.first_seen_in_ads_at)`,
        }
      : {
          family,
          firstSeenInJourneysAt: sql`coalesce(${landingPages.firstSeenInJourneysAt}, excluded.first_seen_in_journeys_at)`,
        };

  for (let index = 0; index < urls.length; index += STAMP_BATCH_SIZE) {
    const batch = urls.slice(index, index + STAMP_BATCH_SIZE);
    const rows = await db
      .insert(landingPages)
      .values(
        batch.map((normalizedUrl) => ({
          organizationId: params.organizationId,
          normalizedUrl,
          family: landingPageFamily(normalizedUrl),
          ...(params.source === "ads"
            ? { firstSeenInAdsAt: params.seenAt }
            : { firstSeenInJourneysAt: params.seenAt }),
        })),
      )
      .onConflictDoUpdate({
        target: [landingPages.organizationId, landingPages.normalizedUrl],
        set,
      })
      .returning({ id: landingPages.id, normalizedUrl: landingPages.normalizedUrl });

    for (const row of rows) params.pageIdsByUrl.set(row.normalizedUrl, row.id);
  }

  // A concurrent sync can win the conflict and leave a row out of `returning`
  // on some drivers; read back anything still missing rather than dropping it.
  const missing = urls.filter((url) => !params.pageIdsByUrl.has(url));
  if (missing.length > 0) {
    const rows = await db
      .select({ id: landingPages.id, normalizedUrl: landingPages.normalizedUrl })
      .from(landingPages)
      .where(
        and(
          eq(landingPages.organizationId, params.organizationId),
          inArray(landingPages.normalizedUrl, missing),
        ),
      );
    for (const row of rows) params.pageIdsByUrl.set(row.normalizedUrl, row.id);
  }
}

async function harvestFromAds(params: {
  organizationId: string;
  now: Date;
  pageIdsByUrl: Map<string, string>;
}) {
  const rows = await db
    .select({
      id: ads.id,
      destinationUrl: ads.destinationUrl,
      landingPageId: ads.landingPageId,
    })
    .from(ads)
    .where(
      and(
        eq(ads.organizationId, params.organizationId),
        isNotNull(ads.destinationUrl),
      ),
    );

  const adIdsByUrl = new Map<string, string[]>();
  for (const row of rows) {
    const normalizedUrl = normalizeLandingPageUrl(row.destinationUrl);
    if (!normalizedUrl) continue;
    const bucket = adIdsByUrl.get(normalizedUrl);
    if (bucket) bucket.push(row.id);
    else adIdsByUrl.set(normalizedUrl, [row.id]);
  }

  await upsertLandingPages({
    organizationId: params.organizationId,
    normalizedUrls: [...adIdsByUrl.keys()],
    seenAt: params.now,
    source: "ads",
    pageIdsByUrl: params.pageIdsByUrl,
  });

  let adsLinked = 0;
  for (const [normalizedUrl, adIds] of adIdsByUrl) {
    const landingPageId = params.pageIdsByUrl.get(normalizedUrl);
    if (!landingPageId) continue;

    for (let index = 0; index < adIds.length; index += STAMP_BATCH_SIZE) {
      const batch = adIds.slice(index, index + STAMP_BATCH_SIZE);
      // A destination URL that changed points the ad at a different page, so
      // stale links are corrected, not only null ones.
      const stamped = await db
        .update(ads)
        .set({ landingPageId })
        .where(
          and(
            inArray(ads.id, batch),
            or(
              isNull(ads.landingPageId),
              sql`${ads.landingPageId} <> ${landingPageId}`,
            ),
          ),
        )
        .returning({ id: ads.id });
      adsLinked += stamped.length;
    }
  }

  return { adsScanned: rows.length, adsLinked };
}

type JourneyLastVisit = {
  lastVisit?: { landingPage?: string | null } | null;
} | null;

/** The journey's landing page, read off the stored jsonb. */
export function journeyLandingPage(
  customerJourney: Record<string, unknown> | null,
): string | null {
  const journey = customerJourney as JourneyLastVisit;
  const landingPage = journey?.lastVisit?.landingPage;
  return typeof landingPage === "string" ? landingPage : null;
}

async function harvestFromOrders(params: {
  organizationId: string;
  storeId?: string;
  now: Date;
  pageIdsByUrl: Map<string, string>;
}) {
  const stores = await db
    .select({ id: shopifyStores.id, shopDomain: shopifyStores.shopDomain })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.organizationId, params.organizationId),
        params.storeId ? eq(shopifyStores.id, params.storeId) : undefined,
      ),
    );

  let ordersScanned = 0;
  let ordersLinked = 0;

  for (const store of stores) {
    let cursor: string | null = null;

    for (;;) {
      // Keyset over the id, so the scan stays bounded however many orders the
      // store has. Already-linked orders are skipped: their page exists.
      const batch: Array<{ id: string; customerJourney: Record<string, unknown> | null }> =
        await db
          .select({
            id: shopifyOrders.id,
            customerJourney: shopifyOrders.customerJourney,
          })
          .from(shopifyOrders)
          .where(
            and(
              eq(shopifyOrders.organizationId, params.organizationId),
              eq(shopifyOrders.storeId, store.id),
              eq(shopifyOrders.journeyReady, true),
              isNull(shopifyOrders.landingPageId),
              cursor ? gt(shopifyOrders.id, cursor) : undefined,
            ),
          )
          .orderBy(shopifyOrders.id)
          .limit(ORDER_SCAN_BATCH_SIZE);

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      ordersScanned += batch.length;

      const orderIdsByUrl = new Map<string, string[]>();
      for (const row of batch) {
        const normalizedUrl = normalizeLandingPageUrl(
          journeyLandingPage(row.customerJourney),
          store.shopDomain,
        );
        if (!normalizedUrl) continue;
        const ids = orderIdsByUrl.get(normalizedUrl);
        if (ids) ids.push(row.id);
        else orderIdsByUrl.set(normalizedUrl, [row.id]);
      }

      await upsertLandingPages({
        organizationId: params.organizationId,
        normalizedUrls: [...orderIdsByUrl.keys()],
        seenAt: params.now,
        source: "journeys",
        pageIdsByUrl: params.pageIdsByUrl,
      });

      for (const [normalizedUrl, orderIds] of orderIdsByUrl) {
        const landingPageId = params.pageIdsByUrl.get(normalizedUrl);
        if (!landingPageId) continue;

        for (let index = 0; index < orderIds.length; index += STAMP_BATCH_SIZE) {
          const ids = orderIds.slice(index, index + STAMP_BATCH_SIZE);
          const stamped = await db
            .update(shopifyOrders)
            .set({ landingPageId })
            .where(
              and(
                inArray(shopifyOrders.id, ids),
                isNull(shopifyOrders.landingPageId),
              ),
            )
            .returning({ id: shopifyOrders.id });
          ordersLinked += stamped.length;
        }
      }

      if (batch.length < ORDER_SCAN_BATCH_SIZE) break;
    }
  }

  return { ordersScanned, ordersLinked };
}

/**
 * The page's visible copy: title, meta description, headings and body text,
 * with script/style/noscript dropped. Deliberately hand-rolled — the hash only
 * has to be stable and the model only needs the words, neither needs a parser.
 */
export function stripHtmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ");

  const title = matchFirst(withoutHidden, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = matchFirst(
    withoutHidden,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i,
  );

  const body =
    matchFirst(withoutHidden, /<body[^>]*>([\s\S]*)<\/body>/i) ?? withoutHidden;

  const text = body
    // Block edges become spaces, or words either side of a tag would fuse.
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");

  return [title, description, text]
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function matchFirst(input: string, pattern: RegExp) {
  const match = input.match(pattern);
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  return value && value.length > 0 ? value : null;
}

/** Content identity for the re-classification cadence. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type LandingPageClassificationAction =
  /** Call the model and write fresh values. */
  | "classify"
  /** Confirmed values stay; the page is flagged for re-confirmation. */
  | "mark_stale"
  /** Bookkeeping only: store the hash, move `classifiedAt` on. */
  | "touch";

/**
 * The §5.4 write contract, decided before any model call so a page that needs
 * no fresh values costs nothing.
 *
 * A human confirmation is never silently overwritten: changed copy under a
 * `confirmed` page goes to `stale` and waits for a person. `stale` stays stale
 * for the same reason. An unchanged hash means nothing to re-read.
 */
export function planLandingPageClassification(params: {
  status: "suggested" | "confirmed" | "stale" | null;
  priorHash: string | null;
  newHash: string;
}): LandingPageClassificationAction {
  if (params.priorHash === params.newHash) return "touch";

  switch (params.status) {
    case null:
    case "suggested":
      return "classify";
    case "confirmed":
      // No prior hash is not a content change — it is the first time anyone
      // fetched the page. Record it without unsettling the confirmation.
      return params.priorHash === null ? "touch" : "mark_stale";
    case "stale":
      return "touch";
  }
}

export type LandingPageProvenance =
  | "ad_linked"
  | "journey_only"
  | "both"
  | "unknown";

/** Provenance is derived from the two first-seen columns, not stored (§5.1). */
export function landingPageProvenance(page: {
  firstSeenInAdsAt: Date | null;
  firstSeenInJourneysAt: Date | null;
}): LandingPageProvenance {
  if (page.firstSeenInAdsAt && page.firstSeenInJourneysAt) return "both";
  if (page.firstSeenInAdsAt) return "ad_linked";
  if (page.firstSeenInJourneysAt) return "journey_only";
  return "unknown";
}
