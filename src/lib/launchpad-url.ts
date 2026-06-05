import type { LaunchpadValidationIssue } from "@/lib/launchpad-ledger";

export const REQUIRED_LAUNCHPAD_UTM_PARAMETERS = [
  "utm_source",
  "utm_medium",
] as const;

export type LaunchpadUrlPreview = {
  defaultUrl: string | null;
  overrideUrl: string | null;
  finalUrl: string | null;
  source: "item_override" | "batch_default" | "none";
  protocol: string | null;
  isHttps: boolean;
  requiredUtmParameters: readonly string[];
  utmParameters: Record<string, string>;
  missingRequiredUtmParameters: string[];
};

export type LaunchpadUrlPreviewResult = {
  preview: LaunchpadUrlPreview;
  issues: LaunchpadValidationIssue[];
};

export function normalizeLaunchpadUrlText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseLaunchpadUrlPreview(input: {
  defaultUrl?: string | null;
  overrideUrl?: string | null;
  field?: string;
  requiredUtmParameters?: readonly string[];
}): LaunchpadUrlPreviewResult {
  const defaultUrl = normalizeLaunchpadUrlText(input.defaultUrl);
  const overrideUrl = normalizeLaunchpadUrlText(input.overrideUrl);
  const finalUrl = overrideUrl ?? defaultUrl;
  const source = overrideUrl ? "item_override" : defaultUrl ? "batch_default" : "none";
  const requiredUtmParameters = input.requiredUtmParameters ?? REQUIRED_LAUNCHPAD_UTM_PARAMETERS;
  const field = input.field ?? "destinationUrl";
  const issues: LaunchpadValidationIssue[] = [];
  const preview: LaunchpadUrlPreview = {
    defaultUrl,
    overrideUrl,
    finalUrl,
    source,
    protocol: null,
    isHttps: false,
    requiredUtmParameters,
    utmParameters: {},
    missingRequiredUtmParameters: [...requiredUtmParameters],
  };

  if (!finalUrl) {
    issues.push({
      code: "DESTINATION_URL_REQUIRED",
      message: "A Launchpad item requires a destination URL",
      field,
    });
    return { preview, issues };
  }

  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    issues.push({
      code: "INVALID_DESTINATION_URL",
      message: "Destination URL must be a valid HTTPS URL",
      field,
      details: { destinationUrl: finalUrl },
    });
    return { preview, issues };
  }

  preview.protocol = parsed.protocol;
  preview.isHttps = parsed.protocol === "https:";
  preview.utmParameters = Object.fromEntries(
    Array.from(parsed.searchParams.entries()).filter(([key]) => key.startsWith("utm_")),
  );
  preview.missingRequiredUtmParameters = requiredUtmParameters.filter(
    (param) => !normalizeLaunchpadUrlText(parsed.searchParams.get(param)),
  );

  if (!preview.isHttps) {
    issues.push({
      code: "INVALID_DESTINATION_URL",
      message: "Destination URL must use HTTPS",
      field,
      details: { destinationUrl: finalUrl, protocol: parsed.protocol },
    });
  }

  if (preview.missingRequiredUtmParameters.length > 0) {
    issues.push({
      code: "MISSING_REQUIRED_UTM_PARAMETERS",
      message: "Destination URL is missing required UTM parameters",
      field,
      details: {
        destinationUrl: finalUrl,
        requiredUtmParameters,
        missingRequiredUtmParameters: preview.missingRequiredUtmParameters,
      },
    });
  }

  return { preview, issues };
}

export function assertHttpsLaunchpadUrl(value: string | null | undefined) {
  const result = parseLaunchpadUrlPreview({ defaultUrl: value });
  const invalidIssue = result.issues.find((issue) => issue.code === "INVALID_DESTINATION_URL");
  if (invalidIssue) return invalidIssue;
  return null;
}
