// Where a preserved brand mark may sit in a generated variation. Pure: the
// locator and the compositor supply boxes, this module only decides.
import type { ProductRegion } from "@/lib/image-mask";
import { clampRegion } from "@/lib/image-mask";
import { STUDIO_FORMATS, type StudioFormat } from "@/lib/studio-prompt";
import type { KeepPlacement } from "@/lib/variation-agent-types";

export type SafeArea = { top: number; right: number; bottom: number; left: number };

const SIDE_INSET = 0.06;
/** A feed's own chrome sits over the top and bottom of anything taller than square. */
const TALL_BAND = 0.12;

/**
 * Normalized insets the mark must stay inside, resolved by aspect rather than
 * by name: `StudioFormat` admits raw "WxH" strings as well as the presets, so
 * a lookup table over the union would not compile and would miss those sizes.
 */
export function safeAreaFor(format: StudioFormat): SafeArea {
  const size = (STUDIO_FORMATS as Record<string, string>)[format] ?? format;
  const match = /^(\d+)x(\d+)$/.exec(size);
  const tall = match ? Number(match[2]) > Number(match[1]) : false;
  return {
    top: tall ? TALL_BAND : SIDE_INSET,
    right: SIDE_INSET,
    bottom: tall ? TALL_BAND : SIDE_INSET,
    left: SIDE_INSET,
  };
}

/** A pasted mark may not exceed this multiple of the width it had in the source. */
export const LOGO_SCALE_CAP = 1.25;
/** Below this share of canvas width a mark is not legible at feed size. */
export const LOGO_MIN_WIDTH = 0.04;
/** WCAG-style ratio the mark must reach against the background behind it. */
export const LOGO_CONTRAST_FLOOR = 3;

// Guards against float noise (e.g. 0.1 + 0.2 !== 0.3, or 1 - 0.12 - 0.06 then
// + 0.06 !== 1 - 0.12) turning a legitimate boundary position into a false
// rejection or a false overlap. `corners()` builds right/bottom candidates as
// `1 - safe.X - size`, and re-adding `size` does not round-trip exactly for
// every size, so `insideSafeArea` needs the same tolerance on its upper
// bounds as `overlaps` needs on its edge-contact check. Normalized regions
// never differ by less than this on purpose, so it never masks a real
// rejection or intersection.
const EDGE_EPSILON = 1e-9;

export function insideSafeArea(box: ProductRegion, format: StudioFormat): boolean {
  const safe = safeAreaFor(format);
  return (
    box.x >= safe.left &&
    box.y >= safe.top &&
    box.x + box.w <= 1 - safe.right + EDGE_EPSILON &&
    box.y + box.h <= 1 - safe.bottom + EDGE_EPSILON
  );
}

export function overlaps(a: ProductRegion, b: ProductRegion): boolean {
  return (
    a.x < b.x + b.w - EDGE_EPSILON &&
    b.x < a.x + a.w - EDGE_EPSILON &&
    a.y < b.y + b.h - EDGE_EPSILON &&
    b.y < a.y + a.h - EDGE_EPSILON
  );
}

/** sRGB relative luminance, the WCAG definition. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The four corners of the safe area, as boxes of `size`, nearest-first from `from`. */
function corners(size: { w: number; h: number }, format: StudioFormat, from: ProductRegion): ProductRegion[] {
  const safe = safeAreaFor(format);
  const left = safe.left;
  const right = 1 - safe.right - size.w;
  const top = safe.top;
  const bottom = 1 - safe.bottom - size.h;
  const candidates = [
    { x: left, y: top, w: size.w, h: size.h },
    { x: right, y: top, w: size.w, h: size.h },
    { x: left, y: bottom, w: size.w, h: size.h },
    { x: right, y: bottom, w: size.w, h: size.h },
  ];
  const distance = (box: ProductRegion) => (box.x - from.x) ** 2 + (box.y - from.y) ** 2;
  return candidates.sort((a, b) => distance(a) - distance(b));
}

/**
 * Picks where the real mark goes, in this order: over a mark the model drew
 * anyway (it must be covered, or the ad ships two logos); the source's own
 * position when the new layout still admits it, so the variation reads as a
 * sibling of its source; otherwise the nearest safe-area corner that clears
 * the copy. Null when nothing legal is left, which the caller treats as a
 * failed run rather than a bad paste.
 */
export function chooseLogoPlacement(input: {
  drawn: ProductRegion | null;
  sourceBox: ProductRegion;
  copyRegions: ProductRegion[];
  format: StudioFormat;
}): { box: ProductRegion; placement: KeepPlacement } | null {
  if (input.drawn) return { box: clampRegion(input.drawn), placement: "drawn" };
  const size = { w: input.sourceBox.w, h: input.sourceBox.h };
  const clear = (box: ProductRegion) =>
    insideSafeArea(box, input.format) && !input.copyRegions.some((copy) => overlaps(box, copy));
  if (clear(input.sourceBox)) {
    return { box: clampRegion(input.sourceBox), placement: "source_position" };
  }
  const anchor = corners(size, input.format, input.sourceBox).find(clear);
  return anchor ? { box: clampRegion(anchor), placement: "anchor" } : null;
}
