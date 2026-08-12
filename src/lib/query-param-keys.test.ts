import { describe, expect, it } from "vitest";
import { getQueryParamKeys } from "./query-param-keys";

describe("getQueryParamKeys", () => {
  it("returns unique query parameter keys in alphabetical order", () => {
    expect(
      getQueryParamKeys(
        "https://example.com/product?utm_source=meta&fbclid=abc&utm_campaign=sale&utm_source=facebook",
      ),
    ).toBe("fbclid, utm_campaign, utm_source");
  });

  it.each([
    [null],
    ["https://example.com/product"],
    ["not a url"],
  ])("returns null when the URL has no usable query keys: %s", (url) => {
    expect(getQueryParamKeys(url)).toBeNull();
  });
});
