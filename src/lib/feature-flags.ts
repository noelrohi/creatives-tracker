/**
 * Single source of truth for org-scoped feature flags: the settings page
 * renders one row per definition, the sidebar renders the enabled ones.
 * A flag missing from the stored jsonb is off.
 */
export const featureFlagDefs = [
  {
    key: "attribution",
    label: "Attribution",
    description:
      "Shows the Attribution view, where revenue is credited back to campaigns.",
    badge: "Beta",
    href: "/attribution",
    icon: "solar:pie-chart-2-linear",
    group: "analyze",
  },
  {
    key: "creativeInsights",
    label: "Creative insights",
    description:
      "Shows Creative insights, which breaks performance down by creative.",
    badge: "New",
    href: "/insights",
    icon: "solar:chart-square-linear",
    group: "analyze",
  },
  {
    key: "competitorSignals",
    label: "Competitors",
    description:
      "Shows Competitor signals, where public Meta Ad Library activity is tracked per competitor.",
    badge: "Beta",
    href: "/competitors",
    icon: "solar:radar-2-linear",
    group: "analyze",
  },
  {
    key: "imageStudio",
    label: "Image Studio",
    description:
      "Shows Image Studio, where briefs are composed into generated ad images.",
    badge: "Beta",
    href: "/studio",
    icon: "solar:magic-stick-3-linear",
    group: "tools",
  },
] as const;

export type FeatureFlagDef = (typeof featureFlagDefs)[number];
export type FeatureFlagKey = FeatureFlagDef["key"];
export type FeatureFlagGroup = FeatureFlagDef["group"];
export type FeatureFlags = Partial<Record<FeatureFlagKey, boolean>>;

export const featureFlagKeys = featureFlagDefs.map((def) => def.key) as [
  FeatureFlagKey,
  ...FeatureFlagKey[],
];
