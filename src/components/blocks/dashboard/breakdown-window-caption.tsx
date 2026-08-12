import { BREAKDOWN_RETENTION_DAYS } from "@/lib/retention/policy";

/**
 * The caption a demographics section shows when its range was clamped to the
 * breakdown retention window — the "never silently partial" contract.
 */
export function BreakdownWindowCaption({
  from,
  to,
  hasWindow,
}: {
  from: string;
  to: string;
  hasWindow: boolean;
}) {
  return (
    <p className="text-[11px] text-muted-foreground/70">
      {hasWindow
        ? `Demographic detail covers ${from}–${to}. Breakdown data is kept for ${BREAKDOWN_RETENTION_DAYS} days.`
        : `No demographic detail for this range. Breakdown data is kept for ${BREAKDOWN_RETENTION_DAYS} days.`}
    </p>
  );
}
