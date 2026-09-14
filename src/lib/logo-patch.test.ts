// Spec §12's four hard sourcing rules, pinned. `resolveLogoPatch` lives in
// `trigger/generate-variation.ts` and takes every input it reads as a
// parameter; vitest only collects tests under `src/`, so the test comes to the
// function rather than the other way round. The two vision calls and the matte
// are faked; everything else — the ladder, the gates, the logging — is real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePng } from "./image-mask";
import type { StudioContextImage, StudioContextLibrary } from "./studio-context";

const generateObject = vi.fn();
const matteProduct = vi.fn();

vi.mock("@/db", () => ({ db: {} }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateObject: (...args: unknown[]) => generateObject(...args),
}));
vi.mock("@/lib/image-matte", () => ({
  matteProduct: (...args: unknown[]) => matteProduct(...args),
}));
vi.mock("@trigger.dev/sdk", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metadata: { set: vi.fn() },
  tags: { add: vi.fn() },
  task: (config: unknown) => config,
}));

const { resolveLogoPatch } = await import("../../trigger/generate-variation");

/** An opaque PNG, so `prepareLogoAsset` takes the matte path rather than the alpha trim. */
function png(width: number, height: number, rgb: [number, number, number]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return encodePng(width, height, rgba);
}

const sourceBytes = png(40, 40, [255, 255, 255]);
const assetBytes = png(20, 10, [0, 0, 255]);
const cutBytes = png(8, 4, [0, 0, 0]);
const sourceMark = { x: 0.1, y: 0.1, w: 0.2, h: 0.06 };

function library(...images: Array<Partial<StudioContextImage>>): StudioContextLibrary {
  return {
    core: [],
    reference: [],
    images: images.map((image, index) => ({
      id: `logo-${index + 1}`,
      title: "Logo",
      description: "",
      kind: "logo",
      imageUrl: `https://example.test/logo-${index + 1}.png`,
      createdAt: new Date(2026, 0, index + 1),
      ...image,
    })) as StudioContextImage[],
  };
}

const fetchBytes = vi.fn<(url: string) => Promise<Uint8Array>>(async () => assetBytes);

function matched() {
  generateObject.mockResolvedValue({
    object: { wordmark: "same", icon: "same", orientation: "same", colourway: "same", note: "" },
  });
}

function mismatched() {
  generateObject.mockResolvedValue({
    object: { wordmark: "different", icon: "different", orientation: "same", colourway: "same", note: "" },
  });
}

function resolve(overrides: Partial<Parameters<typeof resolveLogoPatch>[0]> = {}) {
  return resolveLogoPatch({
    sourceBytes,
    sourceMark,
    sourceKind: "creative",
    sourceIsOwnCreative: true,
    rebrand: false,
    brandName: "OurBrand",
    library: library({}),
    fetchBytes,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchBytes.mockResolvedValue(assetBytes);
  matteProduct.mockResolvedValue({
    patch: cutBytes,
    box: { left: 4, top: 4, width: 8, height: 4 },
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    matted: true,
    coverage: 0.6,
  });
});

describe("resolveLogoPatch", () => {
  it("returns none when no mark was located, without touching the library", async () => {
    // The source ad simply had no logo: there is nothing to preserve, and
    // adding one the original never had is a different change.
    await expect(resolve({ sourceMark: null })).resolves.toEqual({ kind: "none" });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("fails immediately when the cap makes the mark too narrow to be legible", async () => {
    // `pasteLogo` caps the paste at 1.25x the source width, so a mark under
    // 0.032 of the canvas can never reach the 0.04 floor at any placement.
    // Every attempt would fail identically at full image-model cost, so the
    // run ends here instead — before the asset is even fetched.
    await expect(
      resolve({ sourceMark: { x: 0.1, y: 0.1, w: 0.03, h: 0.02 } }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("still resolves a mark just wide enough to clear the floor once capped", async () => {
    // 0.033 * 1.25 = 0.041, over the floor: the boundary must not take the
    // early exit, or the check would fail runs it was never meant to touch.
    matched();
    await expect(
      resolve({ sourceMark: { x: 0.1, y: 0.1, w: 0.033, h: 0.02 } }),
    ).resolves.toMatchObject({ kind: "patch", patchSource: "asset" });
  });

  it("prefers the brand's asset over a cut of the source when the lockup agrees", async () => {
    matched();
    const result = await resolve();
    expect(result).toMatchObject({ kind: "patch", patchSource: "asset", assetImageId: "logo-1" });
    // The source's own mark was never cut: the asset is the higher-fidelity rung.
    expect(matteProduct).not.toHaveBeenCalledWith(expect.objectContaining({ source: sourceBytes }));
  });

  it("carries every usable asset as a variant, newest first", async () => {
    matched();
    const result = await resolve({
      library: library(
        { id: "old", imageUrl: "https://example.test/old.png", createdAt: new Date(2026, 0, 1) },
        { id: "new", imageUrl: "https://example.test/new.png", createdAt: new Date(2026, 5, 1) },
      ),
    });
    expect(result).toMatchObject({ kind: "patch", assetImageId: "new" });
    expect(result.kind === "patch" && result.variants.map((v) => v.imageId)).toEqual(["new", "old"]);
  });

  it("falls to the source cut when the lockup verdict is 'different'", async () => {
    mismatched();
    const result = await resolve();
    expect(result).toMatchObject({ kind: "patch", patchSource: "source", assetImageId: null });
    expect(matteProduct).toHaveBeenCalledWith(expect.objectContaining({ source: sourceBytes }));
  });

  it("never cuts a source that is not the advertiser's own creative", async () => {
    // I1's gate: a creative the org marked as somebody else's, or one a Studio
    // variation was published to, carries a mark we did not make.
    mismatched();
    await expect(resolve({ sourceIsOwnCreative: false })).resolves.toEqual({ kind: "unavailable" });
    expect(matteProduct).not.toHaveBeenCalledWith(expect.objectContaining({ source: sourceBytes }));
  });

  it("never cuts a competitor source, and takes the asset without a lockup check", async () => {
    // §9's inversion: the competitor's mark must not survive, so the asset
    // stands in for it and the lockup check — which would correctly report two
    // different marks — is skipped.
    const result = await resolve({
      sourceKind: "competitor_ad",
      sourceIsOwnCreative: false,
      rebrand: true,
    });
    expect(result).toMatchObject({ kind: "patch", patchSource: "asset", assetImageId: "logo-1" });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("fails a rebrand that has no asset rather than cutting the competitor's mark", async () => {
    await expect(
      resolve({
        sourceKind: "competitor_ad",
        sourceIsOwnCreative: false,
        rebrand: true,
        library: library(),
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(matteProduct).not.toHaveBeenCalled();
  });

  it("fails rather than pasting a mark that would not cut cleanly", async () => {
    // An unmatted cut is a rectangle of the source's own background, which
    // pastes a boxed mark over the new scene.
    mismatched();
    matteProduct.mockResolvedValue({
      patch: cutBytes,
      box: { left: 4, top: 4, width: 8, height: 4 },
      region: sourceMark,
      matted: false,
      coverage: 0.02,
    });
    await expect(resolve()).resolves.toEqual({ kind: "unavailable" });
  });

  it("treats a failed lockup call as a different mark", async () => {
    // Standing an unverified mark in for the advertiser's own is the mistake
    // this feature exists to prevent, so the ladder falls through instead.
    generateObject.mockRejectedValue(new Error("vision call failed"));
    const result = await resolve();
    expect(result).toMatchObject({ kind: "patch", patchSource: "source" });
  });

  it("skips an unreachable asset instead of losing the rest of the library", async () => {
    matched();
    fetchBytes.mockImplementation(async (url: string) =>
      url.endsWith("broken.png") ? Promise.reject(new Error("404")) : assetBytes,
    );
    const result = await resolve({
      library: library(
        { id: "good", imageUrl: "https://example.test/good.png", createdAt: new Date(2026, 0, 1) },
        { id: "broken", imageUrl: "https://example.test/broken.png", createdAt: new Date(2026, 5, 1) },
      ),
    });
    expect(result).toMatchObject({ kind: "patch", patchSource: "asset", assetImageId: "good" });
  });
});
