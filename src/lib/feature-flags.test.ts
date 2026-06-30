import { describe, expect, it } from "vitest";
import { getFeatureFlags, isLaunchpadEnabled } from "@/lib/feature-flags";

describe("feature flags", () => {
  it("keeps Launchpad disabled by default", () => {
    expect(isLaunchpadEnabled({})).toBe(false);
    expect(isLaunchpadEnabled({ ADSOLUTE_LAUNCHPAD_ENABLED: "false" })).toBe(
      false,
    );
  });

  it("enables Launchpad only when explicitly set to true", () => {
    expect(isLaunchpadEnabled({ ADSOLUTE_LAUNCHPAD_ENABLED: "true" })).toBe(
      true,
    );
  });

  it("returns a centralized feature map for gated navigation and routes", () => {
    expect(
      getFeatureFlags({
        ADSOLUTE_LAUNCHPAD_ENABLED: "true",
        ADSOLUTE_RECOMMENDATIONS_ENABLED: "true",
      }),
    ).toEqual({ launchpad: true, recommendations: true });
  });
});
