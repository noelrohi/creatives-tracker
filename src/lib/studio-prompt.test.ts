import { describe, expect, it } from "vitest";
import {
  isSupportedStudioSize,
  studioDimensions,
  studioSizeFor,
} from "./studio-prompt";

describe("Studio image dimensions", () => {
  it("maps the primary aspect-ratio presets to model dimensions", () => {
    expect(studioSizeFor("square")).toBe("1024x1024");
    expect(studioSizeFor("widescreen")).toBe("1536x864");
    expect(studioSizeFor("vertical")).toBe("864x1536");
  });

  it.each(["1536x864", "1024x1536", "2048x2048", "3840x2160"])(
    "accepts supported custom size %s",
    (size) => expect(isSupportedStudioSize(size)).toBe(true),
  );

  it.each([
    "1537x864",
    "4096x2160",
    "3840x1024",
    "512x512",
    "3840x3840",
  ])("rejects unsupported custom size %s", (size) => {
    expect(isSupportedStudioSize(size)).toBe(false);
  });

  it("returns custom dimensions unchanged", () => {
    expect(studioDimensions("1280x800")).toEqual({ width: 1280, height: 800 });
  });
});
