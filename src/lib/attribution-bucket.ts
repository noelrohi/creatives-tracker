/**
 * The attribution bucket rule. Frozen at v1 — changing behaviour means bumping
 * BUCKET_RULE_VERSION so stamped orders get re-bucketed.
 */

import { normalizeLower } from "@/lib/text";

// Stays at 5 even though the §4.2 name match now decodes `utm_content`: v5 has
// never stamped a production row (its migration is unapplied), so there is no
// stamped history for the widened match to invalidate.
export const BUCKET_RULE_VERSION = 5;

export const META_SOURCES = [
  "facebook",
  "instagram",
  "fb",
  "ig",
  "meta",
] as const;
/**
 * Link builders name Meta sources after the campaign as often as after the
 * platform: `fb_reviv3`, `meta-websitekeyinfo`. Only the delimiter forms count
 * — a bare `fb`/`meta` prefix would swallow unrelated words like "fbook" or
 * "metabolism".
 */
export const META_SOURCE_PREFIXES = ["fb_", "meta_", "meta-"] as const;
export const GOOGLE_SOURCES = ["google", "adwords"] as const;
export const TIKTOK_SOURCES = ["tiktok"] as const;
export const KLAVIYO_SOURCES = ["klaviyo"] as const;
/**
 * Assistants that send shoppers on. Only `chatgpt.com` appears in this store's
 * data so far; the other three are the same kind of referrer under different
 * names, listed so the next one to show up is already covered.
 */
export const AI_SOURCES = [
  "chatgpt.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
] as const;
export const PAID_MEDIUMS = ["paid", "cpc", "ppc", "paid_social"] as const;
/**
 * Google Shopping's free listing feed. Not paid search, so it never passes the
 * paid-medium gate, but it is Google traffic and belongs in the Google row.
 * Gated on the source too: Google must not own any medium, or `google` /
 * `organic` — organic search — would stop being organic_direct.
 */
export const GOOGLE_FEED_MEDIUMS = ["product_sync"] as const;

/**
 * Mediums that say "we know it wasn't paid" (spec §4.4: the last click is
 * direct, an organic referrer, or organic-medium traffic). Anything outside
 * both this table and PAID_MEDIUMS is a tag we have no rule for, so it lands in
 * unattributed rather than being assumed organic.
 */
export const ORGANIC_MEDIUMS = [
  "organic",
  "referral",
  "social",
  "direct",
  "none",
  "(none)",
  "unpaid",
] as const;

/**
 * Source names that can never carry journey data (spec §4.1: POS, draft,
 * subscription renewal). Every other channel — Shop app, mobile, headless —
 * does get a journey, so it goes through normal bucketing instead.
 */
export const UNTRACKED_SOURCE_NAMES = [
  "pos",
  "shopify_draft_order",
  "draft_order",
  "subscription_contract",
] as const;

/**
 * Substrings that mark a medium as *meant* to be paid even though it matches no
 * paid-medium rule ("paid-social", "facebook_ads", "cpc "). Finding rule 3 (§8)
 * counts unattributed orders whose medium looks paid, so the pattern is shared
 * with the SQL side via PAID_LOOKING_MEDIUM_REGEX_SOURCE.
 */
export const PAID_LOOKING_MEDIUM_HINTS = [
  "paid",
  "cpc",
  "ppc",
  "ads",
  "sem",
  "display",
] as const;

/** Same alternation, for Postgres `~` — keep in step with the hints above. */
export const PAID_LOOKING_MEDIUM_REGEX_SOURCE = `(${PAID_LOOKING_MEDIUM_HINTS.join("|")})`;

export type AttributionBucket =
  | "meta"
  | "google"
  | "klaviyo"
  | "tiktok"
  | "ai"
  | "organic_direct"
  | "unattributed"
  | "untracked";

export type BucketLastVisit = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** The ad set id Meta writes into the link. */
  utmTerm?: string | null;
  /** The ad — its Meta id on newer links, its name on older ones. */
  utmContent?: string | null;
  referrerUrl?: string | null;
  source?: string | null;
} | null;

export type BucketInput = {
  orderSourceName?: string | null;
  journeyReady: boolean;
  lastVisit?: BucketLastVisit;
  syncedMetaCampaignIds: ReadonlySet<string>;
  /** Ad set Meta id → the Meta id of the campaign it belongs to. */
  syncedMetaAdSets: ReadonlyMap<string, string>;
};

export type BucketResult = {
  /** null = still pending (journey not ready); caller leaves the row unbucketed. */
  bucket: AttributionBucket | null;
  metaVerified: boolean;
  metaCampaignId: string | null;
  verificationPending: boolean;
};

function includesInsensitive(
  table: readonly string[],
  value: string | null | undefined,
) {
  const normalized = normalizeLower(value);
  if (!normalized) return false;
  return table.some((entry) => entry.toLowerCase() === normalized);
}

export function isMetaSource(value: string | null | undefined) {
  if (includesInsensitive(META_SOURCES, value)) return true;
  const normalized = normalizeLower(value);
  if (!normalized) return false;
  return META_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isGoogleSource(value: string | null | undefined) {
  return includesInsensitive(GOOGLE_SOURCES, value);
}

export function isTiktokSource(value: string | null | undefined) {
  return includesInsensitive(TIKTOK_SOURCES, value);
}

export function isKlaviyoSource(value: string | null | undefined) {
  return includesInsensitive(KLAVIYO_SOURCES, value);
}

export function isAiSource(value: string | null | undefined) {
  return includesInsensitive(AI_SOURCES, value);
}

export function isGoogleFeedMedium(value: string | null | undefined) {
  return includesInsensitive(GOOGLE_FEED_MEDIUMS, value);
}

export function isPaidMedium(value: string | null | undefined) {
  return includesInsensitive(PAID_MEDIUMS, value);
}

export function isOrganicMedium(value: string | null | undefined) {
  return includesInsensitive(ORGANIC_MEDIUMS, value);
}

/** Paid by intent, whether or not it passes the paid-medium gate. */
export function isPaidLookingMedium(value: string | null | undefined) {
  const normalized = normalizeLower(value);
  if (!normalized) return false;
  return PAID_LOOKING_MEDIUM_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * The ad set id out of `utm_term`. One order arrived with `?fbclid=…` glued
 * onto the end of the term, so everything from the first `?` is dropped — the
 * same rule the campaign ledger applies in SQL.
 */
export function normalizeMetaAdSetTerm(value: string | null | undefined) {
  const normalized = normalizeLower(value);
  if (!normalized) return null;
  const [beforeQuery] = normalized.split("?");
  const term = beforeQuery.trim();
  return term.length > 0 ? term : null;
}

/** Meta ids as they appear in a link: digits only, 10–20 of them (spec §4.2). */
const META_AD_ID_PATTERN = /^[0-9]{10,20}$/;

/**
 * `{{ad.name}}` reaches Shopify percent-encoded — "My Ad" arrives as `my%20ad`
 * or `my+ad` — and a raw encoded value never matches a stored ad name. The
 * decoded form is tried *alongside* the raw one, never instead of it: a name
 * that genuinely contains a percent sign is still matched raw-first, and a
 * malformed sequence (`%zz`, a lone `%`) falls back to the raw string rather
 * than throwing.
 */
function decodeUtmValue(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
  const normalized = decoded.trim().toLowerCase();
  if (normalized.length === 0 || normalized === value) return null;
  return normalized;
}

/**
 * Two ads in the same ad set carrying the same name — a name can no longer pick
 * one of them, so the order resolves as unmatched rather than to a coin flip.
 */
export const AMBIGUOUS_AD_NAME = Symbol("ambiguous-ad-name");

export type MetaAdMatchMethod = "id" | "name" | "unmatched";

export type MetaAdIndex = {
  /** Every synced ad's Meta id. */
  adMetaIds: ReadonlySet<string>;
  /**
   * Ad set Meta id → lowercased ad name → that ad's Meta id. Names are only
   * near-unique inside one ad set (3,925 ads share 2,107 names across the
   * account), so the scope is what makes a name match trustworthy.
   */
  adMetaIdsByAdSetAndName: ReadonlyMap<
    string,
    ReadonlyMap<string, string | typeof AMBIGUOUS_AD_NAME>
  >;
};

export type MetaAdIdentity = {
  adSetId: string | null;
  adId: string | null;
  matchMethod: MetaAdMatchMethod | null;
};

/**
 * The ad set and ad behind a visit (spec §4.2–§4.3). A dimension stamped
 * alongside the bucket — it never changes the bucket or the verification.
 *
 * `utm_term` is stamped as-is whether or not it names a synced ad set, and an
 * extracted `utm_content` is always stamped too: an ad we have not synced yet
 * records as `unmatched` with its raw value, and the next re-stamp after that
 * ad arrives upgrades it.
 */
export function resolveMetaAdIdentity(
  input: { utmTerm?: string | null; utmContent?: string | null },
  index: MetaAdIndex,
): MetaAdIdentity {
  const adSetId = normalizeMetaAdSetTerm(input.utmTerm);
  const content = normalizeMetaAdSetTerm(input.utmContent);

  // Nothing identifies the ad — ad grain simply doesn't apply to this order.
  if (!content) return { adSetId, adId: null, matchMethod: null };

  // Decoded before the numeric test, so an encoded digit string still ids.
  const decoded = decodeUtmValue(content);

  const idForm = META_AD_ID_PATTERN.test(content)
    ? content
    : decoded && META_AD_ID_PATTERN.test(decoded)
      ? decoded
      : null;
  if (idForm) {
    return {
      adSetId,
      adId: idForm,
      matchMethod: index.adMetaIds.has(idForm) ? "id" : "unmatched",
    };
  }

  const namesInAdSet = adSetId
    ? index.adMetaIdsByAdSetAndName.get(adSetId)
    : undefined;
  // Raw first for exact fidelity, then the decoded form.
  for (const candidate of decoded ? [content, decoded] : [content]) {
    const named = namesInAdSet?.get(candidate);
    if (typeof named === "string") {
      return { adSetId, adId: named, matchMethod: "name" };
    }
  }

  return { adSetId, adId: content, matchMethod: "unmatched" };
}

/** POS, draft and subscription-renewal orders (spec §4.1). */
export function isUntrackedSourceName(value: string | null | undefined) {
  const normalized = normalizeLower(value);
  if (!normalized) return false;
  if (includesInsensitive(UNTRACKED_SOURCE_NAMES, normalized)) return true;
  // Apps name their own orders: "…_draft_order", "subscription_…".
  return normalized.includes("draft") || normalized.includes("subscription");
}

function result(
  bucket: AttributionBucket | null,
  overrides: Partial<Omit<BucketResult, "bucket">> = {},
): BucketResult {
  return {
    bucket,
    metaVerified: false,
    metaCampaignId: null,
    verificationPending: false,
    ...overrides,
  };
}

/**
 * Evaluation order matters: every order lands in exactly one bucket.
 *   1 untracked (POS/draft/subscription) → 2 pending (journey not ready)
 *   → 3 paid UTM buckets → 4 organic/direct → 5 unattributed
 */
export function assignBucket(input: BucketInput): BucketResult {
  // 1. POS, draft and subscription-renewal orders never carry journey data.
  if (isUntrackedSourceName(input.orderSourceName)) return result("untracked");

  // 2. Journey not ready yet — Shopify still resolving the visit chain.
  if (!input.journeyReady) return result(null);

  const lastVisit = input.lastVisit ?? null;
  const utmSource = normalizeLower(lastVisit?.utmSource);
  const utmMedium = normalizeLower(lastVisit?.utmMedium);
  const utmCampaign = normalizeLower(lastVisit?.utmCampaign);
  const hasUtms = Boolean(utmSource || utmMedium || utmCampaign);

  // A journey that reports ready with no visit at all is a journey missing
  // where it should exist (§4.5) — "we can't tell", not "came on their own".
  if (!lastVisit) return result("unattributed");

  // 3. Paid UTM buckets.
  if (isPaidMedium(utmMedium)) {
    if (isMetaSource(utmSource)) {
      if (utmCampaign && input.syncedMetaCampaignIds.has(utmCampaign)) {
        return result("meta", {
          metaVerified: true,
          metaCampaignId: utmCampaign,
        });
      }

      // About a fifth of these links carry the campaign's *name* where its id
      // belongs, and a name can never match an id. `utm_term` carries the ad
      // set id — the reliable side of the link — and an ad set names the
      // campaign it belongs to, so a matched term verifies the order too.
      const adSetTerm = normalizeMetaAdSetTerm(lastVisit.utmTerm);
      const campaignOfAdSet = adSetTerm
        ? (input.syncedMetaAdSets.get(adSetTerm) ?? null)
        : null;
      if (campaignOfAdSet) {
        return result("meta", {
          metaVerified: true,
          metaCampaignId: campaignOfAdSet,
        });
      }

      // Any campaign id we have not synced yet — numeric or named (§4.3).
      if (utmCampaign) return result("meta", { verificationPending: true });
      return result("meta");
    }
    if (isGoogleSource(utmSource)) return result("google");
    if (isTiktokSource(utmSource)) return result("tiktok");
  }

  // Google Shopping's free listing feed: unpaid, so it never reaches the gate
  // above, but it is still Google sending the shopper.
  if (isGoogleSource(utmSource) && isGoogleFeedMedium(utmMedium)) {
    return result("google");
  }

  // Klaviyo owns any medium (email, sms, flows all tag as klaviyo).
  if (isKlaviyoSource(utmSource)) return result("klaviyo");

  // AI assistants own any medium too — an assistant tags its outbound links
  // however it likes, and chatgpt.com arrives here with both no medium at all
  // and `feed`.
  if (isAiSource(utmSource)) return result("ai");

  // 4. Organic / direct: an untagged visit (direct or an organic referrer), or a
  // visit whose medium says it wasn't paid.
  if (!hasUtms) return result("organic_direct");
  if (isOrganicMedium(utmMedium)) return result("organic_direct");

  // 5. UTMs present that match no rule — mistagged paid links (a recognized
  // source that failed the paid-medium gate) deliberately surface here.
  //
  // `feedback` lands here on purpose and gets no rule of its own, despite being
  // 1,205 orders and $93,845 over three months. Every one of those visits is
  // the bare homepage with no referrer and no medium — only a utm_source — and
  // the visit hours are flat across all 24, so it is not a scheduled send.
  // Nobody has identified what writes it. Naming a channel for it would put
  // real money behind a guess; "we don't know" is the true answer until someone
  // finds the source.
  return result("unattributed");
}
