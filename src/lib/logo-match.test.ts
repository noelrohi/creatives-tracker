import { describe, expect, it } from "vitest";
import { assetIsSameLockup, buildLogoMatchPrompt, logoMatchSchema } from "./logo-match";

const verdict = (over: Partial<Parameters<typeof assetIsSameLockup>[0]> = {}) => ({
  wordmark: "same" as const,
  icon: "same" as const,
  orientation: "same" as const,
  colourway: "same" as const,
  note: "",
  ...over,
});

describe("assetIsSameLockup", () => {
  it("accepts the asset when the wordmark and icon composition agree", () => {
    expect(assetIsSameLockup(verdict())).toBe(true);
    expect(assetIsSameLockup(verdict({ wordmark: "absent_in_both", icon: "same" }))).toBe(true);
  });

  it("accepts a variant that differs only in orientation or colourway", () => {
    // Those are exactly the variants the contrast step chooses between, so
    // they must not disqualify the asset.
    expect(assetIsSameLockup(verdict({ orientation: "different" }))).toBe(true);
    expect(assetIsSameLockup(verdict({ colourway: "different" }))).toBe(true);
  });

  it("rejects a different mark", () => {
    expect(assetIsSameLockup(verdict({ wordmark: "different" }))).toBe(false);
    expect(assetIsSameLockup(verdict({ icon: "different" }))).toBe(false);
  });

  it("accepts a lockup when neither shows the element", () => {
    expect(assetIsSameLockup(verdict({ icon: "absent_in_both", wordmark: "same" }))).toBe(true);
  });

  it("rejects a verdict that recognises neither the wordmark nor the icon", () => {
    // "absent in both" on every feature is what an unreadable crop answers.
    // Nothing was recognised, so nothing was verified, and an unverified
    // asset must not be stamped over the ad.
    expect(
      assetIsSameLockup(verdict({ wordmark: "absent_in_both", icon: "absent_in_both" })),
    ).toBe(false);
  });
});

describe("buildLogoMatchPrompt", () => {
  it("asks for each feature separately rather than one similarity score", () => {
    const prompt = buildLogoMatchPrompt("Reviv");
    expect(prompt).toContain("Reviv");
    for (const feature of ["wordmark", "icon", "orientation", "colourway"]) {
      expect(prompt).toContain(feature);
    }
    expect(prompt.toLowerCase()).not.toContain("confidence");
  });
});

describe("logoMatchSchema", () => {
  it("rejects an unknown verdict", () => {
    expect(logoMatchSchema.safeParse({ ...verdict(), wordmark: "maybe" }).success).toBe(false);
  });
});
