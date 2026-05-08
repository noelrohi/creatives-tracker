import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export type EffectiveAdStatus = "active" | "paused" | "archived";

const VALID_STATUSES = new Set<EffectiveAdStatus>([
  "active",
  "paused",
  "archived",
]);

function normalizeStatus(value?: string | null): EffectiveAdStatus | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return VALID_STATUSES.has(normalized as EffectiveAdStatus)
    ? normalized as EffectiveAdStatus
    : null;
}

/**
 * The ad is only truly runnable when both the ad and its parent ad set are active.
 * Historical metrics still belong to the ad, but action-oriented UI should use
 * this effective status so an active ad in a paused ad set is not treated as live.
 */
export function resolveEffectiveAdStatus(input: {
  adStatus?: string | null;
  adSetStatus?: string | null;
}): EffectiveAdStatus | null {
  const adStatus = normalizeStatus(input.adStatus);
  if (!adStatus) return null;

  const adSetStatus = normalizeStatus(input.adSetStatus);
  if (adStatus === "active" && adSetStatus && adSetStatus !== "active") {
    return "paused";
  }

  return adStatus;
}

export function isEffectivelyActive(input: {
  adStatus?: string | null;
  adSetStatus?: string | null;
}) {
  return resolveEffectiveAdStatus(input) === "active";
}

export function effectiveAdStatusSql(
  adStatus: SQLWrapper,
  adSetStatus: SQLWrapper,
): SQL<EffectiveAdStatus> {
  return sql<EffectiveAdStatus>`CASE
    WHEN ${adStatus} = 'active' AND coalesce(${adSetStatus}::text, 'active') != 'active' THEN 'paused'
    ELSE ${adStatus}::text
  END`;
}

export function effectiveAdActiveSql(
  adStatus: SQLWrapper,
  adSetStatus: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`${adStatus} = 'active' AND coalesce(${adSetStatus}::text, 'active') = 'active'`;
}
