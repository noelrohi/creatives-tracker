import { describe, expect, it } from "vitest";
import {
  contentHash,
  journeyLandingPage,
  landingPageFamily,
  landingPageProvenance,
  normalizeLandingPageUrl,
  planLandingPageClassification,
  stripHtmlToText,
} from "@/lib/landing-page";

const STORE_DOMAIN = "reviv-skin.myshopify.com";

describe("normalizeLandingPageUrl (§5.2)", () => {
  it("keeps host and path, dropping scheme, query, fragment and trailing slash", () => {
    expect(
      normalizeLandingPageUrl(
        "https://revivskin.com/pages/reviv-for-wrinkles-v4/?utm_source=facebook&fbclid=IwAR-abc#hero",
      ),
    ).toBe("revivskin.com/pages/reviv-for-wrinkles-v4");
  });

  it("lowercases host and path", () => {
    expect(normalizeLandingPageUrl("HTTPS://RevivSkin.com/Pages/Wrinkles")).toBe(
      "revivskin.com/pages/wrinkles",
    );
  });

  it("drops a www. prefix so both sources land on one row", () => {
    expect(normalizeLandingPageUrl("http://www.revivskin.com/pages/quiz")).toBe(
      "revivskin.com/pages/quiz",
    );
  });

  it("reduces a bare host to the host alone", () => {
    expect(normalizeLandingPageUrl("https://revivskin.com/")).toBe(
      "revivskin.com",
    );
  });

  // Journey values are frequently path-only.
  it("resolves a relative path against the store domain", () => {
    expect(
      normalizeLandingPageUrl("/pages/reviv-for-wrinkles-v4?fbclid=abc", STORE_DOMAIN),
    ).toBe("reviv-skin.myshopify.com/pages/reviv-for-wrinkles-v4");
    expect(normalizeLandingPageUrl("pages/quiz", STORE_DOMAIN)).toBe(
      "reviv-skin.myshopify.com/pages/quiz",
    );
  });

  it("normalizes a scheme-less host the same way", () => {
    expect(normalizeLandingPageUrl("www.revivskin.com/pages/quiz/")).toBe(
      "revivskin.com/pages/quiz",
    );
    expect(normalizeLandingPageUrl("//revivskin.com/pages/quiz")).toBe(
      "revivskin.com/pages/quiz",
    );
  });

  it("returns null for values it cannot resolve", () => {
    expect(normalizeLandingPageUrl("/pages/quiz")).toBeNull();
    expect(normalizeLandingPageUrl("")).toBeNull();
    expect(normalizeLandingPageUrl(null)).toBeNull();
    expect(normalizeLandingPageUrl("mailto:hi@revivskin.com")).toBeNull();
    expect(normalizeLandingPageUrl("javascript:void(0)", STORE_DOMAIN)).toBeNull();
  });

  it("normalizes the same page identically from either source", () => {
    const fromAd = normalizeLandingPageUrl(
      "https://www.revivskin.com/pages/Wrinkles-v4/?utm_content=120210000000456",
    );
    const fromJourney = normalizeLandingPageUrl(
      "/pages/wrinkles-v4?fbclid=IwAR-abc",
      "www.revivskin.com",
    );
    expect(fromAd).toBe(fromJourney);
  });
});

describe("landingPageFamily (§5.2)", () => {
  it("strips a trailing -vN from the last segment", () => {
    expect(landingPageFamily("/pages/reviv-for-wrinkles-v4")).toBe(
      "/pages/reviv-for-wrinkles",
    );
    expect(landingPageFamily("revivskin.com/pages/reviv-for-wrinkles-v10")).toBe(
      "revivskin.com/pages/reviv-for-wrinkles",
    );
  });

  it("leaves a versionless path as its own family", () => {
    expect(landingPageFamily("revivskin.com/pages/quiz")).toBe(
      "revivskin.com/pages/quiz",
    );
    expect(landingPageFamily("revivskin.com")).toBe("revivskin.com");
  });

  // Only a digit suffix is a version — `-vitamin-c` is part of the name.
  it("does not strip a non-version suffix", () => {
    expect(landingPageFamily("revivskin.com/pages/serum-vitamin-c")).toBe(
      "revivskin.com/pages/serum-vitamin-c",
    );
    expect(landingPageFamily("revivskin.com/pages/wrinkles-v4b")).toBe(
      "revivskin.com/pages/wrinkles-v4b",
    );
  });

  it("rolls every variant of a page onto one key", () => {
    const family = landingPageFamily("revivskin.com/pages/wrinkles-v4");
    expect(landingPageFamily("revivskin.com/pages/wrinkles-v5")).toBe(family);
  });
});

describe("journeyLandingPage", () => {
  it("reads the landing page off the stored journey", () => {
    expect(
      journeyLandingPage({
        lastVisit: { landingPage: "https://revivskin.com/pages/quiz" },
      }),
    ).toBe("https://revivskin.com/pages/quiz");
  });

  it("returns null when the journey carries no visit or no landing page", () => {
    expect(journeyLandingPage(null)).toBeNull();
    expect(journeyLandingPage({ lastVisit: null })).toBeNull();
    expect(journeyLandingPage({ lastVisit: { landingPage: null } })).toBeNull();
  });
});

describe("stripHtmlToText", () => {
  const html = `
    <html><head>
      <title> Reviv for Wrinkles </title>
      <meta name="description" content="The 8-week routine">
      <style>.hero{color:red}</style>
      <script>window.x = 1</script>
    </head>
    <body><h1>Why creams don&#39;t work</h1><p>Week&nbsp;1 &amp; beyond</p></body></html>`;

  it("keeps the title, description and visible copy", () => {
    expect(stripHtmlToText(html)).toBe(
      "Reviv for Wrinkles The 8-week routine Why creams don't work Week 1 & beyond",
    );
  });

  it("drops scripts, styles and comments", () => {
    const text = stripHtmlToText(html);
    expect(text).not.toContain("window.x");
    expect(text).not.toContain("color:red");
    expect(stripHtmlToText("<body><!-- hidden -->shown</body>")).toBe("shown");
  });

  it("keeps words either side of a tag apart", () => {
    expect(stripHtmlToText("<body><p>one</p><p>two</p></body>")).toBe("one two");
  });
});

describe("contentHash", () => {
  it("is stable for the same text and different for changed text", () => {
    expect(contentHash("copy")).toBe(contentHash("copy"));
    expect(contentHash("copy")).not.toBe(contentHash("copy "));
    expect(contentHash("copy")).toHaveLength(64);
  });
});

// §5.4: AI suggests, a human confirms, and a confirmation is never silently
// overwritten.
describe("planLandingPageClassification (§5.4)", () => {
  it("classifies a page nobody has classified yet", () => {
    expect(
      planLandingPageClassification({
        status: null,
        priorHash: null,
        newHash: "hash-1",
      }),
    ).toBe("classify");
  });

  it("re-suggests freely over a suggested page whose copy changed", () => {
    expect(
      planLandingPageClassification({
        status: "suggested",
        priorHash: "hash-1",
        newHash: "hash-2",
      }),
    ).toBe("classify");
  });

  it("marks a confirmed page stale when its copy changes", () => {
    expect(
      planLandingPageClassification({
        status: "confirmed",
        priorHash: "hash-1",
        newHash: "hash-2",
      }),
    ).toBe("mark_stale");
  });

  it("leaves a confirmed page alone while its copy is unchanged", () => {
    expect(
      planLandingPageClassification({
        status: "confirmed",
        priorHash: "hash-1",
        newHash: "hash-1",
      }),
    ).toBe("touch");
  });

  // A page confirmed before anyone fetched it has no hash to compare against;
  // recording the first one is bookkeeping, not a content change.
  it("does not unsettle a confirmation that never had a hash", () => {
    expect(
      planLandingPageClassification({
        status: "confirmed",
        priorHash: null,
        newHash: "hash-1",
      }),
    ).toBe("touch");
  });

  it("keeps a stale page stale until a human confirms", () => {
    expect(
      planLandingPageClassification({
        status: "stale",
        priorHash: "hash-1",
        newHash: "hash-3",
      }),
    ).toBe("touch");
  });

  it("skips the model call whenever the hash is unchanged", () => {
    for (const status of ["suggested", "confirmed", "stale", null] as const) {
      expect(
        planLandingPageClassification({
          status,
          priorHash: "hash-1",
          newHash: "hash-1",
        }),
      ).toBe("touch");
    }
  });
});

describe("landingPageProvenance (§5.1)", () => {
  const seen = new Date("2026-08-01T00:00:00Z");

  it("derives provenance from the two first-seen columns", () => {
    expect(
      landingPageProvenance({
        firstSeenInAdsAt: seen,
        firstSeenInJourneysAt: seen,
      }),
    ).toBe("both");
    expect(
      landingPageProvenance({
        firstSeenInAdsAt: seen,
        firstSeenInJourneysAt: null,
      }),
    ).toBe("ad_linked");
    expect(
      landingPageProvenance({
        firstSeenInAdsAt: null,
        firstSeenInJourneysAt: seen,
      }),
    ).toBe("journey_only");
    expect(
      landingPageProvenance({
        firstSeenInAdsAt: null,
        firstSeenInJourneysAt: null,
      }),
    ).toBe("unknown");
  });
});
