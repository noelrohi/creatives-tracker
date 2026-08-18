import { differenceInCalendarDays } from "date-fns";

/** Avatar initials: first letter of the first two words. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Calendar days since `date`, or null when there is no date or it lies in the
 * future (a clock-skewed start date reads as "unknown", never as negative).
 */
export function daysSince(date: Date | null): number | null {
  if (!date) return null;
  const days = differenceInCalendarDays(new Date(), date);
  return days >= 0 ? days : null;
}

/** Resolved format (§8 vocabulary) → label, as list items read: "Image, Video". */
export const RESOLVED_FORMAT_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  carousel: "Carousel",
};

/** Resolved format → the word a sentence uses: "images + video + carousels". */
export const RESOLVED_FORMAT_PHRASES: Record<string, string> = {
  image: "images",
  video: "video",
  carousel: "carousels",
};

/** Ad Library display format → label; DCO/DPA are containers, read "Dynamic". */
export const DISPLAY_FORMAT_LABELS: Record<string, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  CAROUSEL: "Carousel",
  DCO: "Dynamic",
  DPA: "Dynamic",
};

/** Test-plan ad format enum → label. */
export const TEST_PLAN_FORMAT_LABELS: Record<string, string> = {
  static: "Image",
  video: "Video",
};
