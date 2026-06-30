export type FeatureFlag = "launchpad" | "recommendations";
export type FeatureFlagMap = Record<FeatureFlag, boolean>;

export function isLaunchpadEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return env.ADSOLUTE_LAUNCHPAD_ENABLED === "true";
}

export function isRecommendationsEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return env.ADSOLUTE_RECOMMENDATIONS_ENABLED === "true";
}

export function getFeatureFlags(
  env: Record<string, string | undefined> = process.env,
): FeatureFlagMap {
  return {
    launchpad: isLaunchpadEnabled(env),
    recommendations: isRecommendationsEnabled(env),
  };
}

export function isFeatureEnabled(
  flag: FeatureFlag,
  env: Record<string, string | undefined> = process.env,
) {
  return getFeatureFlags(env)[flag];
}
