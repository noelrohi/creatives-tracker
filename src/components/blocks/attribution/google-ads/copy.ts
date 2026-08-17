export const googleAdsRevenue = {
  title: "Google Ads revenue · Google",
  freshness: (age: string) => `Google facts as of ${age}`,
  awaitingAccess: "awaiting Google API access",
  noRangeData: "no Google data for this range yet",
  kpi: {
    bucket: "Google bucket",
    feed: "free listings feed",
    paid: "paid (UTM-tagged)",
    spend: "Spend (Google)",
    says: "Google says",
    saysCaption: "their conversion value, sliced to this range",
    roasClaims: "Google claims",
    roasConfirm: "we confirm",
    mixedCurrency: "mixed currencies — not comparable",
  },
  table: {
    heading: "By campaign — Google says vs we confirm",
    oursOnly: "ours only (no matching Google campaign)",
    untagged: "(untagged)",
    feedFootnote:
      "Free-listings feed revenue is excluded here — it belongs to no paid campaign.",
    calendarCaption:
      "Google days are the ad account's calendar; ours are the store's — day-boundary orders can differ.",
  },
  insight: {
    untaggedPaid:
      "Google reports paid conversions but no paid-tagged revenue reaches our google bucket — paid revenue is likely landing in other buckets. Add UTM tracking templates to paid campaigns.",
    delta: (says: string, confirm: string) =>
      `Google says ${says}; our paid-tagged revenue confirms ${confirm}. The difference is unconfirmed by our books.`,
  },
} as const;
