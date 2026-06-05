import { describe, expect, it } from "vitest";
import { parseLaunchpadUrlPreview } from "@/lib/launchpad-url";

describe("Launchpad URL planning", () => {
  it("uses item override before batch default and summarizes UTMs", () => {
    const result = parseLaunchpadUrlPreview({
      defaultUrl: "https://example.com/default?utm_source=meta&utm_medium=paid_social",
      overrideUrl: "https://example.com/override?utm_source=meta&utm_campaign=test",
    });

    expect(result.preview).toMatchObject({
      finalUrl: "https://example.com/override?utm_source=meta&utm_campaign=test",
      source: "item_override",
      isHttps: true,
      utmParameters: {
        utm_source: "meta",
        utm_campaign: "test",
      },
      missingRequiredUtmParameters: ["utm_medium"],
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "MISSING_REQUIRED_UTM_PARAMETERS",
    ]);
  });

  it("blocks missing, malformed, and non-HTTPS URLs", () => {
    expect(parseLaunchpadUrlPreview({ defaultUrl: "" }).issues[0]?.code).toBe(
      "DESTINATION_URL_REQUIRED",
    );
    expect(parseLaunchpadUrlPreview({ defaultUrl: "not a url" }).issues[0]?.code).toBe(
      "INVALID_DESTINATION_URL",
    );
    expect(parseLaunchpadUrlPreview({ defaultUrl: "http://example.com" }).issues[0]?.code).toBe(
      "INVALID_DESTINATION_URL",
    );
  });
});
