export function isLaunchpadEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return env.ADSOLUTE_LAUNCHPAD_ENABLED === "true";
}
