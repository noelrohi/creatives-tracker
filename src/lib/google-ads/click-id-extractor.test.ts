import { describe, expect, it } from "vitest";
import { extractClickIdObservation } from "@/lib/google-ads/click-id-extractor";

function journey(landingPage: string | null, referrerUrl: string | null = null) {
  return { ready: true, lastVisit: { landingPage, referrerUrl } };
}

describe("extractClickIdObservation", () => {
  it("finds a gclid on the landing page", () => {
    const observation = extractClickIdObservation(
      journey("https://shop.example.com/products/x?utm_source=google&gclid=Cj0abc"),
    );
    expect(observation.kinds).toEqual(["gclid"]);
    expect(observation.journeyMissing).toBe(false);
    expect(observation.paramKeys).toContain("gclid");
    expect(observation.paramKeys).toContain("utm_source");
  });

  it("finds wbraid and gbraid and never returns values", () => {
    const observation = extractClickIdObservation(
      journey("https://shop.example.com/?wbraid=W1&gbraid=G1"),
    );
    expect(observation.kinds).toEqual(["gbraid", "wbraid"]);
    expect(JSON.stringify(observation)).not.toContain("W1");
  });

  it("checks the referrer when the landing page has none", () => {
    const observation = extractClickIdObservation(
      journey("https://shop.example.com/", "https://shop.example.com/?gclid=Cj0z"),
    );
    expect(observation.kinds).toEqual(["gclid"]);
  });

  it("falls back to query-string parsing for a relative landing page", () => {
    const observation = extractClickIdObservation(journey("/products/x?gclid=Cj0rel"));
    expect(observation.kinds).toEqual(["gclid"]);
    expect(observation.parseFailed).toBe(false);
  });

  it("reports a missing journey", () => {
    expect(extractClickIdObservation(null).journeyMissing).toBe(true);
    expect(extractClickIdObservation({}).journeyMissing).toBe(true);
    expect(extractClickIdObservation({ lastVisit: null }).journeyMissing).toBe(true);
  });

  it("ignores non-string URL fields", () => {
    const observation = extractClickIdObservation({
      lastVisit: { landingPage: 42, referrerUrl: {} },
    });
    expect(observation.journeyMissing).toBe(false);
    expect(observation.kinds).toEqual([]);
  });

  it("degrades gracefully on a garbage URL instead of throwing", () => {
    // `new URL` throws on the space in the host; the query-string fallback
    // then parses everything after the first "?" via URLSearchParams, which
    // (empirically, in Node) never throws — so this never hits parseFailed.
    // Here the fallback's remainder is empty, yielding no keys at all.
    const observation = extractClickIdObservation(journey("http://exa mple.com/%zz?"));
    expect(observation.parseFailed).toBe(false);
    expect(observation.kinds).toEqual([]);
    expect(observation.paramKeys).toEqual([]);
  });
});
