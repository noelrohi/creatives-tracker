import { describe, expect, it } from "vitest";
import { buildAdName, extractAdNameId } from "@/lib/studio-ad-name";

describe("Studio ad names", () => {
  it("builds a searchable name from the brand, angle, and UUID slice", () => {
    expect(
      buildAdName({
        brandName: "Revív Skin Co.",
        angle: "Nobody talks about this",
        variantId: "A1B2C3d4-e5f6-7890-abcd-ef1234567890",
      }),
    ).toBe("REVIV-SKIN-CO-ST-nobody-talks-about-this-a1b2c3");
  });

  it("uses stable fallbacks for missing brand and angle", () => {
    expect(
      buildAdName({
        brandName: "!!!",
        angle: null,
        variantId: "12345678-1234-1234-1234-123456789abc",
      }),
    ).toBe("STUDIO-ST-untagged-123456");
  });

  it("extracts only ids from valid Studio templates", () => {
    expect(extractAdNameId("REVIV-ST-price-anchor-abcdef")).toBe("abcdef");
    expect(extractAdNameId("regular-ad-abcdef")).toBeNull();
    expect(extractAdNameId("REVIV-ST-angle-abcde")).toBeNull();
  });
});
