export function canonicalizeImportedDeliveryStatus(
  value?: string | null,
): string | undefined {
  if (!value) return undefined;

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  return normalized || undefined;
}

export function normalizeImportedAdStatus(
  delivery?: string | null,
): "active" | "paused" | "archived" {
  const normalized = canonicalizeImportedDeliveryStatus(delivery);

  if (!normalized) return "active";
  if (normalized === "active") return "active";

  if (
    normalized === "archived"
    || normalized === "deleted"
  ) {
    return "archived";
  }

  return "paused";
}

export function resolveMetaDeliveryStatus(statuses: {
  effectiveStatus?: string | null;
  configuredStatus?: string | null;
}): string | undefined {
  return canonicalizeImportedDeliveryStatus(statuses.effectiveStatus)
    ?? canonicalizeImportedDeliveryStatus(statuses.configuredStatus);
}
