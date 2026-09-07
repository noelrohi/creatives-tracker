/**
 * Single source of truth for org-scoped feature flags: the settings page
 * renders one row per definition, the sidebar renders the enabled ones.
 * A flag missing from the stored jsonb is off. A definition with `href: null`
 * gates a surface inside an existing page (a tab, a button) and gets no nav item.
 */
export const featureFlagDefs = [
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
  {
    key: "creativeVariations",
    label: "Creative variations",
    description:
      "Adds a Variations tab to static image creatives, where the agent makes one new variation from the source ad and the workspace's context library. Needs Image Studio.",
    badge: "Beta",
    href: null,
    icon: "solar:layers-minimalistic-linear",
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
