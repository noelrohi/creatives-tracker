/**
 * The attribution bucket rule. Frozen at v1 — changing behaviour means bumping
 * BUCKET_RULE_VERSION so stamped orders get re-bucketed.
 */

export const BUCKET_RULE_VERSION = 1;

export const META_SOURCES = [
  "facebook",
  "instagram",
  "fb",
  "ig",
  "meta",
] as const;
export const GOOGLE_SOURCES = ["google", "adwords"] as const;
export const TIKTOK_SOURCES = ["tiktok"] as const;
export const KLAVIYO_SOURCES = ["klaviyo"] as const;
export const PAID_MEDIUMS = ["paid", "cpc", "ppc", "paid_social"] as const;

export type AttributionBucket =
  | "meta"
  | "google"
  | "klaviyo"
  | "tiktok"
  | "organic_direct"
  | "unattributed"
  | "untracked";

export type BucketLastVisit = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrerUrl?: string | null;
  source?: string | null;
} | null;

export type BucketInput = {
  orderSourceName?: string | null;
  journeyReady: boolean;
  lastVisit?: BucketLastVisit;
  syncedMetaCampaignIds: ReadonlySet<string>;
};

export type BucketResult = {
  /** null = still pending (journey not ready); caller leaves the row unbucketed. */
  bucket: AttributionBucket | null;
  metaVerified: boolean;
  metaCampaignId: string | null;
  verificationPending: boolean;
};

function normalize(value: string | null | undefined) {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function includesInsensitive(
  table: readonly string[],
  value: string | null | undefined,
) {
  const normalized = normalize(value);
  if (!normalized) return false;
  return table.some((entry) => entry.toLowerCase() === normalized);
}

export function isMetaSource(value: string | null | undefined) {
  return includesInsensitive(META_SOURCES, value);
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

export function isPaidMedium(value: string | null | undefined) {
  return includesInsensitive(PAID_MEDIUMS, value);
}

/** A source we have a rule for at all — used by the organic/direct branch. */
function isRecognizedSource(value: string | null | undefined) {
  return (
    isMetaSource(value) ||
    isGoogleSource(value) ||
    isTiktokSource(value) ||
    isKlaviyoSource(value)
  );
}

const NUMERIC_CAMPAIGN = /^\d+$/;

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
 *   1 untracked (non-web order) → 2 pending (journey not ready)
 *   → 3 paid UTM buckets → 4 organic/direct → 5 unattributed
 */
export function assignBucket(input: BucketInput): BucketResult {
  // 1. Non-web orders (POS, draft, subscription) can never carry journey data.
  if (normalize(input.orderSourceName) !== "web") return result("untracked");

  // 2. Journey not ready yet — Shopify still resolving the visit chain.
  if (!input.journeyReady) return result(null);

  const lastVisit = input.lastVisit ?? null;
  const utmSource = normalize(lastVisit?.utmSource);
  const utmMedium = normalize(lastVisit?.utmMedium);
  const utmCampaign = normalize(lastVisit?.utmCampaign);
  const hasUtms = Boolean(utmSource || utmMedium || utmCampaign);

  // 3. Paid UTM buckets.
  if (isPaidMedium(utmMedium)) {
    if (isMetaSource(utmSource)) {
      if (utmCampaign && input.syncedMetaCampaignIds.has(utmCampaign)) {
        return result("meta", {
          metaVerified: true,
          metaCampaignId: utmCampaign,
        });
      }
      if (utmCampaign && NUMERIC_CAMPAIGN.test(utmCampaign)) {
        // Looks like a Meta campaign id we have not synced yet.
        return result("meta", { verificationPending: true });
      }
      return result("meta");
    }
    if (isGoogleSource(utmSource)) return result("google");
    if (isTiktokSource(utmSource)) return result("tiktok");
  }

  // Klaviyo owns any medium (email, sms, flows all tag as klaviyo).
  if (isKlaviyoSource(utmSource)) return result("klaviyo");

  // 4. Organic / direct: no visit, no UTMs, or a known source on a non-paid medium.
  if (!lastVisit) return result("organic_direct");
  if (!hasUtms) return result("organic_direct");
  if (isRecognizedSource(utmSource)) return result("organic_direct");

  // 5. UTMs present that match no rule — mistagged links surface here.
  return result("unattributed");
}
