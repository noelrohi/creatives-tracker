import { describe, expect, it } from "vitest";
import {
  assignBucket,
  BUCKET_RULE_VERSION,
  type BucketInput,
  type BucketLastVisit,
} from "@/lib/attribution-bucket";

const SYNCED = new Set(["120210000000123", "120219999999888"]);

function input(overrides: Partial<BucketInput> = {}): BucketInput {
  return {
    orderSourceName: "web",
    journeyReady: true,
    lastVisit: null,
    syncedMetaCampaignIds: SYNCED,
    ...overrides,
  };
}

function visit(
  utm: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
  },
  extra: Partial<NonNullable<BucketLastVisit>> = {},
): BucketLastVisit {
  return {
    utmSource: utm.source ?? null,
    utmMedium: utm.medium ?? null,
    utmCampaign: utm.campaign ?? null,
    referrerUrl: null,
    source: null,
    ...extra,
  };
}

describe("assignBucket", () => {
  it("pins the rule version at 1", () => {
    expect(BUCKET_RULE_VERSION).toBe(1);
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

    it("buckets a missing source name as untracked", () => {
      expect(assignBucket(input({ orderSourceName: null })).bucket).toBe(
        "untracked",
      );
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

    it("keeps a non-numeric unmatched campaign in meta without flags", () => {
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
        verificationPending: false,
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

    it("buckets google paid clicks", () => {
      for (const source of ["google", "adwords"]) {
        expect(
          assignBucket(input({ lastVisit: visit({ source, medium: "cpc" }) }))
            .bucket,
        ).toBe("google");
      }
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
    it("buckets a ready journey with no last visit as organic_direct", () => {
      expect(assignBucket(input({ lastVisit: null })).bucket).toBe(
        "organic_direct",
      );
    });

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

    it("buckets a recognized source on a non-paid medium as organic_direct", () => {
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

    it("buckets a recognized source with no medium as organic_direct", () => {
      expect(
        assignBucket(input({ lastVisit: visit({ source: "tiktok" }) })).bucket,
      ).toBe("organic_direct");
    });
  });

  describe("rule 5 — unattributed", () => {
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
