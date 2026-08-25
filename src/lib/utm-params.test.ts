import { describe, expect, it } from "vitest";
import { getUtmParams } from "./utm-params";

describe("getUtmParams", () => {
  it("returns only UTM parameters in their conventional order", () => {
    expect(
      getUtmParams(
        "https://example.com/product?variant=123&utm_campaign=sale&utm_source=facebook",
        null,
      ),
    ).toEqual([
      { key: "utm_source", value: "facebook" },
      { key: "utm_campaign", value: "sale" },
    ]);
  });

  it("prefers Meta URL tags and preserves decoded templates", () => {
    expect(
      getUtmParams(
        "https://example.com/product?utm_source=legacy&utm_medium=paid_social",
        "utm_source=meta&utm_campaign=%7B%7Badset.name%7D%7D&utm_content=%7B%7Bad.name%7D%7D",
      ),
    ).toEqual([
      { key: "utm_source", value: "meta" },
      { key: "utm_medium", value: "paid_social" },
      { key: "utm_campaign", value: "{{adset.name}}" },
      { key: "utm_content", value: "{{ad.name}}" },
    ]);
  });

  it.each([
    [null, null],
    ["https://example.com/product?pb=0", null],
    ["not a url", "fbclid=abc"],
  ])("returns no values when no UTMs are set", (url, urlTags) => {
    expect(getUtmParams(url, urlTags)).toEqual([]);
  });
});
