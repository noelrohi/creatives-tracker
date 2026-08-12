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
  },
  {
    key: "creativeInsights",
    label: "Creative insights",
    description:
      "Shows Creative insights, which breaks performance down by creative.",
    badge: "New",
    href: "/insights",
    icon: "solar:chart-square-linear",
  },
] as const;

export type FeatureFlagKey = (typeof featureFlagDefs)[number]["key"];
export type FeatureFlags = Partial<Record<FeatureFlagKey, boolean>>;

export const featureFlagKeys = featureFlagDefs.map((def) => def.key) as [
  FeatureFlagKey,
  ...FeatureFlagKey[],
];
