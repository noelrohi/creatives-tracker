import { describe, expect, it } from "vitest";
import { isLaunchpadEnabled } from "@/lib/feature-flags";

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
});
