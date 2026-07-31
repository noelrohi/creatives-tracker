import { describe, expect, it } from "vitest";
import {
  AI_SOURCES,
  assignBucket,
  BUCKET_RULE_VERSION,
  isPaidLookingMedium,
  isUntrackedSourceName,
  PAID_LOOKING_MEDIUM_REGEX_SOURCE,
  PAID_MEDIUMS,
  type BucketInput,
  type BucketLastVisit,
} from "@/lib/attribution-bucket";

const SYNCED = new Set(["120210000000123", "120219999999888"]);
/** Ad set id → the campaign it belongs to, as the ingest loads them. */
const SYNCED_AD_SETS = new Map([
  ["23851234567890111", "120210000000123"],
  ["23859876543210222", "120219999999888"],
]);

function input(overrides: Partial<BucketInput> = {}): BucketInput {
  return {
    orderSourceName: "web",
    journeyReady: true,
    lastVisit: null,
    syncedMetaCampaignIds: SYNCED,
    syncedMetaAdSets: SYNCED_AD_SETS,
    ...overrides,
  };
}

function visit(
  utm: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    term?: string | null;
  },
  extra: Partial<NonNullable<BucketLastVisit>> = {},
): BucketLastVisit {
  return {
    utmSource: utm.source ?? null,
    utmMedium: utm.medium ?? null,
    utmCampaign: utm.campaign ?? null,
    utmTerm: utm.term ?? null,
    referrerUrl: null,
    source: null,
    ...extra,
  };
}

describe("assignBucket", () => {
  it("bumps the rule version whenever the tables below change", () => {
    expect(BUCKET_RULE_VERSION).toBe(4);
  });

  describe("rule 1 — untracked", () => {
    it("buckets POS orders as untracked", () => {
      expect(assignBucket(input({ orderSourceName: "pos" })).bucket).toBe(
        "untracked",
      );
    });

    it("buckets draft and subscription orders as untracked", () => {
      expect(
        assignBucket(input({ orderSourceName: "shopify_draft_order" })).bucket,
      ).toBe("untracked");
      expect(
        assignBucket(input({ orderSourceName: "subscription_contract" })).bucket,
      ).toBe("untracked");
    });

    // §4.1: "order types that can never carry journey data: POS, draft,
    // subscription-renewal" — every other channel does get a journey.
    it("does not treat other non-web channels as untracked", () => {
      for (const sourceName of ["shop_app", "iphone", "android", "1830279"]) {
        expect(
          assignBucket(
            input({
              orderSourceName: sourceName,
              lastVisit: visit({ source: "facebook", medium: "paid" }),
            }),
          ).bucket,
        ).toBe("meta");
      }
    });

    it("leaves a non-web order with an unresolved journey pending", () => {
      expect(
        assignBucket(
          input({ orderSourceName: "shop_app", journeyReady: false }),
        ).bucket,
      ).toBeNull();
    });

    it("buckets a missing source name through the journey, not as untracked", () => {
      expect(
        assignBucket(
          input({
            orderSourceName: null,
            lastVisit: visit({ source: "klaviyo", medium: "email" }),
          }),
        ).bucket,
      ).toBe("klaviyo");
    });

    it("wins over a paid UTM journey", () => {
      const result = assignBucket(
        input({
          orderSourceName: "pos",
          lastVisit: visit({
            source: "facebook",
            medium: "paid",
            campaign: "120210000000123",
          }),
        }),
      );
      expect(result.bucket).toBe("untracked");
      expect(result.metaVerified).toBe(false);
    });
  });

  describe("rule 2 — pending", () => {
    it("returns a null bucket when the journey is not ready", () => {
      const result = assignBucket(
        input({
          journeyReady: false,
          lastVisit: visit({ source: "facebook", medium: "paid" }),
        }),
      );
      expect(result).toEqual({
        bucket: null,
        metaVerified: false,
        metaCampaignId: null,
        verificationPending: false,
      });
    });
  });

  describe("rule 3 — paid UTM buckets", () => {
    it("verifies a meta paid click against synced campaign ids", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "facebook",
            medium: "paid",
            campaign: "120210000000123",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: true,
        metaCampaignId: "120210000000123",
        verificationPending: false,
      });
    });

    // The ad set id in utm_term is the reliable side of the link, and an ad
    // set names its campaign — so a matched term verifies the order.
    it("verifies through the ad set in utm_term when there is no campaign tag", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "facebook",
            medium: "paid",
            term: "23851234567890111",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: true,
        metaCampaignId: "120210000000123",
        verificationPending: false,
      });
    });

    it("matches a term with a click id glued onto the end", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "fb_reviv3",
            medium: "paid",
            term: "23859876543210222?fbclid=IwAR-abc123",
          }),
        }),
      );
      expect(result.metaVerified).toBe(true);
      expect(result.metaCampaignId).toBe("120219999999888");
    });

    // The case this rule exists for: about a fifth of these links carry the
    // campaign's name where its id belongs, and a name never matches an id.
    it("verifies through the term when the campaign tag is a name", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "instagram",
            medium: "paid_social",
            campaign: "summer-sale-retarget",
            term: "23851234567890111",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: true,
        metaCampaignId: "120210000000123",
        verificationPending: false,
      });
    });

    it("keeps a matching campaign id ahead of the term", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "facebook",
            medium: "paid",
            campaign: "120210000000123",
            term: "23859876543210222",
          }),
        }),
      );
      expect(result.metaCampaignId).toBe("120210000000123");
      expect(result.metaVerified).toBe(true);
    });

    it("leaves a term matching nothing pending when a campaign tag is present", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "facebook",
            medium: "paid",
            campaign: "spring-prospecting",
            term: "23850000000000999",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: false,
        metaCampaignId: null,
        verificationPending: true,
      });
    });

    it("leaves a term matching nothing as plain meta when no campaign tag is present", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "facebook",
            medium: "paid",
            term: "23850000000000999",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: false,
        metaCampaignId: null,
        verificationPending: false,
      });
    });

    it("flags a numeric campaign we have not synced as verification pending", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "instagram",
            medium: "cpc",
            campaign: "120219999999777",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: false,
        metaCampaignId: null,
        verificationPending: true,
      });
    });

    // §4.3: "A campaign ID we haven't synced yet still lands in Meta, flagged
    // verification pending" — named campaigns included.
    it("flags a named unmatched campaign as verification pending too", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "meta",
            medium: "paid_social",
            campaign: "summer-sale-retarget",
          }),
        }),
      );
      expect(result).toEqual({
        bucket: "meta",
        metaVerified: false,
        metaCampaignId: null,
        verificationPending: true,
      });
    });

    it("accepts a paid meta click with no campaign at all", () => {
      const result = assignBucket(
        input({ lastVisit: visit({ source: "fb", medium: "ppc" }) }),
      );
      expect(result.bucket).toBe("meta");
      expect(result.verificationPending).toBe(false);
    });

    it("recognizes every meta source alias", () => {
      for (const source of ["facebook", "instagram", "fb", "ig", "meta"]) {
        expect(
          assignBucket(input({ lastVisit: visit({ source, medium: "paid" }) }))
            .bucket,
        ).toBe("meta");
      }
    });

    // Link builders name the source after the campaign, not the platform.
    it("recognizes prefixed meta sources", () => {
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "fb_reviv3", medium: "paid" }) }),
        ).bucket,
      ).toBe("meta");
      expect(
        assignBucket(
          input({
            lastVisit: visit({
              source: "meta-websitekeyinfo",
              medium: "paid_social",
            }),
          }),
        ).bucket,
      ).toBe("meta");
    });

    // Delimiter forms only, so an unrelated word starting "fb" or "meta"
    // cannot be claimed as Meta traffic.
    it("does not claim words that merely start with fb or meta", () => {
      for (const source of ["fbook", "metabolism", "metaphor"]) {
        expect(
          assignBucket(input({ lastVisit: visit({ source, medium: "cpc" }) }))
            .bucket,
        ).toBe("unattributed");
      }
    });

    it("buckets google paid clicks", () => {
      for (const source of ["google", "adwords"]) {
        expect(
          assignBucket(input({ lastVisit: visit({ source, medium: "cpc" }) }))
            .bucket,
        ).toBe("google");
      }
    });

    // Google Shopping's free listing feed is unpaid, but it is Google traffic.
    it("buckets the google product feed as google", () => {
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "google", medium: "product_sync" }) }),
        ).bucket,
      ).toBe("google");
    });

    // The feed rule is gated on the medium as well as the source, so Google
    // does not get to own every medium: organic search stays organic.
    it("leaves organic google search as organic_direct", () => {
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "google", medium: "organic" }) }),
        ).bucket,
      ).toBe("organic_direct");
    });

    it("buckets tiktok paid clicks", () => {
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "tiktok", medium: "paid_social" }) }),
        ).bucket,
      ).toBe("tiktok");
    });

    it("never marks google campaigns as meta-verified", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "google",
            medium: "cpc",
            campaign: "120210000000123",
          }),
        }),
      );
      expect(result.bucket).toBe("google");
      expect(result.metaVerified).toBe(false);
      expect(result.metaCampaignId).toBeNull();
    });

    it("buckets klaviyo on any medium", () => {
      for (const medium of ["email", "sms", "cpc", null]) {
        expect(
          assignBucket(
            input({ lastVisit: visit({ source: "klaviyo", medium }) }),
          ).bucket,
        ).toBe("klaviyo");
      }
    });

    // An assistant tags its links however it likes: chatgpt.com arrives with no
    // medium at all and with `feed`, and both are the same traffic.
    it("buckets an AI assistant on any medium", () => {
      for (const medium of [null, "feed", "referral"]) {
        expect(
          assignBucket(
            input({ lastVisit: visit({ source: "chatgpt.com", medium }) }),
          ).bucket,
        ).toBe("ai");
      }
    });

    it("recognizes every AI source", () => {
      for (const source of AI_SOURCES) {
        expect(
          assignBucket(input({ lastVisit: visit({ source }) })).bucket,
        ).toBe("ai");
      }
    });

    it("matches sources and mediums case-insensitively", () => {
      const result = assignBucket(
        input({
          lastVisit: visit({
            source: "FaceBook",
            medium: "  PAID_SOCIAL ",
            campaign: "120219999999888",
          }),
        }),
      );
      expect(result.bucket).toBe("meta");
      expect(result.metaVerified).toBe(true);
      expect(result.metaCampaignId).toBe("120219999999888");
    });
  });

  describe("rule 4 — organic_direct", () => {
    it("buckets an organic referrer with no UTMs as organic_direct", () => {
      expect(
        assignBucket(
          input({
            lastVisit: visit(
              {},
              {
                referrerUrl: "https://www.google.com/",
                source: "google",
              },
            ),
          }),
        ).bucket,
      ).toBe("organic_direct");
    });

    // §4.4: "organic-medium traffic from a recognized source (including
    // organic-medium Meta/Google/TikTok)".
    it("buckets organic-medium traffic from a recognized source as organic_direct", () => {
      expect(
        assignBucket(
          input({
            lastVisit: visit({ source: "facebook", medium: "organic" }),
          }),
        ).bucket,
      ).toBe("organic_direct");
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "google", medium: "referral" }) }),
        ).bucket,
      ).toBe("organic_direct");
    });

    it("buckets an organic medium from an unrecognized source as organic_direct", () => {
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "partner-blog", medium: "referral" }) }),
        ).bucket,
      ).toBe("organic_direct");
    });
  });

  describe("rule 5 — unattributed", () => {
    // §4.5: "journey missing where it should exist" — a ready journey with no
    // visit at all is "we can't tell", never "came on their own".
    it("surfaces a ready journey that carries no visit", () => {
      expect(assignBucket(input({ lastVisit: null })).bucket).toBe(
        "unattributed",
      );
    });

    // §4.5: "Mistagged links deliberately surface here so they get noticed."
    it("surfaces a recognized source whose paid medium fails the gate", () => {
      for (const medium of ["paid-social", "Paid Social", "facebook_ads", "cpc-lowercase"]) {
        expect(
          assignBucket(
            input({
              lastVisit: visit({
                source: "facebook",
                medium,
                campaign: "120210000000123",
              }),
            }),
          ).bucket,
        ).toBe("unattributed");
      }
    });

    it("surfaces a recognized source tagged with no medium at all", () => {
      expect(
        assignBucket(input({ lastVisit: visit({ source: "tiktok" }) })).bucket,
      ).toBe("unattributed");
    });

    // Deliberate: `feedback` is 1,205 orders and $93,845 over three months,
    // always the bare homepage with no referrer and no medium, at every hour
    // of the day. Nobody has identified what writes it, so it stays unknown
    // rather than being guessed into a channel. Do not "fix" this.
    it("leaves feedback traffic unattributed on purpose", () => {
      expect(
        assignBucket(input({ lastVisit: visit({ source: "feedback" }) })).bucket,
      ).toBe("unattributed");
    });

    it("surfaces mistagged UTMs", () => {
      expect(
        assignBucket(
          input({
            lastVisit: visit({ source: "newsletter", medium: "banner" }),
          }),
        ).bucket,
      ).toBe("unattributed");
    });

    it("surfaces an unrecognized source on a paid medium", () => {
      expect(
        assignBucket(
          input({ lastVisit: visit({ source: "taboola", medium: "cpc" }) }),
        ).bucket,
      ).toBe("unattributed");
    });

    it("surfaces a medium-only tag", () => {
      expect(
        assignBucket(input({ lastVisit: visit({ medium: "cpc" }) })).bucket,
      ).toBe("unattributed");
    });
  });
});

describe("isUntrackedSourceName (§4.1)", () => {
  it("covers POS, draft and subscription orders", () => {
    for (const sourceName of [
      "pos",
      "POS",
      "shopify_draft_order",
      "draft_order",
      "subscription_contract",
      "recharge_subscription",
    ]) {
      expect(isUntrackedSourceName(sourceName)).toBe(true);
    }
  });

  it("leaves every other channel to normal bucketing", () => {
    for (const sourceName of ["web", "shop_app", "iphone", "android", "1830279", null]) {
      expect(isUntrackedSourceName(sourceName)).toBe(false);
    }
  });
});

// §8 rule 3: "5+ orders in one day with paid-looking UTMs matching no rule".
// The bucket rule files those orders as unattributed (§4.5), and the findings
// query has to be able to find them again — same pattern on both sides.
describe("paid-looking mediums (§8 rule 3)", () => {
  const MISTAGS = [
    "paid-social",
    "Paid Social",
    "paidsocial",
    "facebook_ads",
    "cpc-lowercase",
    "display",
    "sem",
  ];

  it("recognizes mistags that fail the paid-medium gate", () => {
    for (const medium of MISTAGS) {
      expect(isPaidLookingMedium(medium)).toBe(true);
      expect(
        assignBucket(input({ lastVisit: visit({ source: "facebook", medium }) }))
          .bucket,
      ).toBe("unattributed");
    }
  });

  it("still recognizes the exact paid mediums", () => {
    for (const medium of PAID_MEDIUMS) {
      expect(isPaidLookingMedium(medium)).toBe(true);
    }
  });

  it("leaves organic and untagged mediums alone", () => {
    for (const medium of ["organic", "referral", "email", "social", null, ""]) {
      expect(isPaidLookingMedium(medium)).toBe(false);
    }
  });

  it("keeps the SQL pattern in step with the predicate", () => {
    const pattern = new RegExp(PAID_LOOKING_MEDIUM_REGEX_SOURCE);
    for (const medium of [...MISTAGS, ...PAID_MEDIUMS]) {
      expect(pattern.test(medium.toLowerCase())).toBe(
        isPaidLookingMedium(medium),
      );
    }
    for (const medium of ["organic", "referral", "email"]) {
      expect(pattern.test(medium)).toBe(false);
    }
  });
});
