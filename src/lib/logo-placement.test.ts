import { describe, expect, it } from "vitest";
import {
  chooseLogoPlacement,
  contrastRatio,
  insideSafeArea,
  overlaps,
  relativeLuminance,
  safeAreaFor,
} from "./logo-placement";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("safeAreaFor", () => {
  it("reserves a deeper band top and bottom on anything taller than square", () => {
    expect(safeAreaFor("square")).toEqual({ top: 0.06, right: 0.06, bottom: 0.06, left: 0.06 });
    expect(safeAreaFor("portrait")).toEqual({ top: 0.12, right: 0.06, bottom: 0.12, left: 0.06 });
    // StudioFormat also admits raw sizes; those classify by aspect, not by name.
    expect(safeAreaFor("1024x1536")).toEqual(safeAreaFor("portrait"));
    expect(safeAreaFor("1536x1024")).toEqual(safeAreaFor("square"));
  });
});

describe("insideSafeArea", () => {
  it("keeps a mark clear of the platform's own UI bands", () => {
    expect(insideSafeArea(box(0.07, 0.07, 0.2, 0.08), "square")).toBe(true);
    expect(insideSafeArea(box(0.02, 0.07, 0.2, 0.08), "square")).toBe(false);
    // Portrait reserves 12% top and bottom for the platform's chrome.
    expect(insideSafeArea(box(0.07, 0.08, 0.2, 0.08), "portrait")).toBe(false);
    expect(insideSafeArea(box(0.07, 0.13, 0.2, 0.08), "portrait")).toBe(true);
    expect(insideSafeArea(box(0.07, 0.84, 0.2, 0.08), "portrait")).toBe(false);
  });
});

describe("overlaps", () => {
  it("is true only when the rectangles actually intersect", () => {
    expect(overlaps(box(0.1, 0.1, 0.2, 0.2), box(0.25, 0.25, 0.2, 0.2))).toBe(true);
    expect(overlaps(box(0.1, 0.1, 0.2, 0.2), box(0.31, 0.1, 0.2, 0.2))).toBe(false);
    // Edge contact is not an overlap.
    expect(overlaps(box(0.1, 0.1, 0.2, 0.2), box(0.3, 0.1, 0.2, 0.2))).toBe(false);
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG extremes", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 1);
    expect(contrastRatio([128, 128, 128], [128, 128, 128])).toBeCloseTo(1, 5);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
  });
});

describe("insideSafeArea edge tolerance", () => {
  it("treats the boundary position corners() computes for a bottom-edge mark as inside", () => {
    // corners() places a bottom-edge box at y = 1 - safe.bottom - h, then
    // insideSafeArea re-adds h and compares to 1 - safe.bottom. That
    // subtract-then-add does not round-trip for every h in IEEE-754 — h =
    // 0.06 against portrait's 0.12 band is a concrete repro (found by
    // brute-forcing corners() outputs against insideSafeArea: ~2.8% of
    // mark sizes on the 0.12 band land exactly on this boundary).
    const safe = safeAreaFor("portrait");
    const h = 0.06;
    const bottomEdgeBox = box(safe.left, 1 - safe.bottom - h, 0.2, h);
    expect(insideSafeArea(bottomEdgeBox, "portrait")).toBe(true);
  });
});

describe("chooseLogoPlacement", () => {
  const sourceBox = box(0.06, 0.06, 0.2, 0.08);

  it("covers a drawn mark, because leaving it would ship two logos", () => {
    const drawn = box(0.7, 0.8, 0.22, 0.09);
    expect(chooseLogoPlacement({ drawn, sourceBox, copyRegions: [], format: "square" })).toEqual({
      box: drawn,
      placement: "drawn",
    });
  });

  it("reuses the source's own position when the new layout still fits it", () => {
    expect(
      chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [box(0.1, 0.5, 0.8, 0.2)], format: "square" }),
    ).toEqual({ box: sourceBox, placement: "source_position" });
  });

  it("moves to an anchor when the source's position now collides with copy", () => {
    const result = chooseLogoPlacement({
      drawn: null,
      sourceBox,
      copyRegions: [box(0.04, 0.04, 0.5, 0.2)],
      format: "square",
    });
    expect(result?.placement).toBe("anchor");
    expect(overlaps(result!.box, box(0.04, 0.04, 0.5, 0.2))).toBe(false);
    expect(insideSafeArea(result!.box, "square")).toBe(true);
  });

  it("moves to an anchor when the source's position falls outside the new format's safe area", () => {
    // A square source mark at 6% down lands inside portrait's 12% top band.
    const result = chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [], format: "portrait" });
    expect(result?.placement).toBe("anchor");
    expect(insideSafeArea(result!.box, "portrait")).toBe(true);
  });

  it("keeps the mark's size and aspect whichever rule chose the box", () => {
    const result = chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [box(0.04, 0.04, 0.5, 0.2)], format: "square" });
    expect(result!.box.w).toBeCloseTo(sourceBox.w, 5);
    expect(result!.box.h).toBeCloseTo(sourceBox.h, 5);
  });

  it("gives up when every corner is taken", () => {
    // Copy covering the whole safe area leaves nowhere legal to sit.
    expect(
      chooseLogoPlacement({ drawn: null, sourceBox, copyRegions: [box(0, 0, 1, 1)], format: "square" }),
    ).toBeNull();
  });

  it("picks the safe-area corner nearest the source box, not just any legal one", () => {
    // The source sits near the bottom-right; a full-width band blocks only its
    // own y-range, leaving all four corners individually legal. An inverted
    // (or otherwise wrong) distance comparator would still find *a* clear
    // corner and pass a placement==="anchor" assertion, so pin the identity
    // of the corner chosen instead of just its legality.
    const nearBottomRight = box(0.7, 0.7, 0.2, 0.08);
    const blocksOnlySourceRow = box(0, 0.68, 1, 0.12);
    const result = chooseLogoPlacement({
      drawn: null,
      sourceBox: nearBottomRight,
      copyRegions: [blocksOnlySourceRow],
      format: "square",
    });
    const safe = safeAreaFor("square");
    const expectedBox = {
      x: 1 - safe.right - nearBottomRight.w,
      y: 1 - safe.bottom - nearBottomRight.h,
      w: nearBottomRight.w,
      h: nearBottomRight.h,
    };
    expect(result).toEqual({ box: expectedBox, placement: "anchor" });
  });
});
