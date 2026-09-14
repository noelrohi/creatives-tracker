import { describe, expect, it } from "vitest";
import { IMAGE_BLOCKED_REASONS, isImageBlockedReason } from "./studio-failure";

describe("isImageBlockedReason", () => {
  it("is true for the reasons the image model itself refused", () => {
    for (const reason of IMAGE_BLOCKED_REASONS) expect(isImageBlockedReason(reason)).toBe(true);
  });

  it("is false for failures a retry without the image cannot fix", () => {
    // No mark could be resolved: the logo step reads the source bytes either
    // way, so dropping the layout reference re-fails on the same branch.
    expect(isImageBlockedReason("logo_unavailable")).toBe(false);
    // A prompt-safety stop, not an image block.
    expect(isImageBlockedReason("claims")).toBe(false);
    expect(isImageBlockedReason("review")).toBe(false);
    expect(isImageBlockedReason(null)).toBe(false);
    expect(isImageBlockedReason(undefined)).toBe(false);
    expect(isImageBlockedReason("")).toBe(false);
  });
});
