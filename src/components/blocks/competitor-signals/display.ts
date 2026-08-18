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

/** Ad Library display format → label; DCO/DPA are containers, read "Dynamic". */
export const DISPLAY_FORMAT_LABELS: Record<string, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  CAROUSEL: "Carousel",
  DCO: "Dynamic",
  DPA: "Dynamic",
};
