import { describe, expect, it } from "vitest";
import { getQueryParamKeys, getQueryParamValue } from "./query-param-keys";

describe("getQueryParamKeys", () => {
  it("returns unique query parameter keys in alphabetical order", () => {
    expect(
      getQueryParamKeys(
        "https://example.com/product?utm_source=meta&fbclid=abc&utm_campaign=sale&utm_source=facebook",
      ),
    ).toBe("fbclid, utm_campaign, utm_source");
  });

  it("includes Meta URL tag keys alongside landing URL keys", () => {
    expect(
      getQueryParamKeys(
        "https://example.com/product?variant=123",
        "utm_source=meta&utm_campaign=%7B%7Bcampaign.name%7D%7D",
      ),
    ).toBe("utm_campaign, utm_source, variant");
  });

  it.each([
    [null],
    ["https://example.com/product"],
    ["not a url"],
  ])("returns null when the URL has no usable query keys: %s", (url) => {
    expect(getQueryParamKeys(url)).toBeNull();
  });
});

describe("getQueryParamValue", () => {
  it("prefers Meta URL tags over a value embedded in the landing URL", () => {
    expect(
      getQueryParamValue(
        "https://example.com/product?utm_source=legacy",
        "utm_source=meta",
        "utm_source",
      ),
    ).toBe("meta");
  });

  it("falls back to the landing URL and preserves decoded Meta templates", () => {
    expect(
      getQueryParamValue(
        "https://example.com/product?utm_medium=paid_social",
        "?utm_campaign=%7B%7Bcampaign.name%7D%7D",
        "utm_campaign",
      ),
    ).toBe("{{campaign.name}}");
    expect(
      getQueryParamValue(
        "https://example.com/product?utm_medium=paid_social",
        null,
        "utm_medium",
      ),
    ).toBe("paid_social");
  });
});
