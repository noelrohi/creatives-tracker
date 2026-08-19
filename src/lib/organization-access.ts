import { featureFlagDefs } from "@/lib/feature-flags";

export const ORG_ROLE_VALUES = ["owner", "admin", "member"] as const;

export type OrgRole = (typeof ORG_ROLE_VALUES)[number];

export function isOrgRole(value: string | null | undefined): value is OrgRole {
  return ORG_ROLE_VALUES.includes(value as OrgRole);
}

export function isPrivilegedOrgRole(
  role: OrgRole | null | undefined,
): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

/**
 * Read-only surfaces members may reach. Flag-gated views live here too: the
 * sidebar shows them to every role once the org enables the flag, so leaving
 * them out makes the nav item bounce straight back to "/".
 */
const MEMBER_PATH_PREFIXES = [
  "/creatives",
  "/teams",
  "/mer",
  "/campaigns",
  ...featureFlagDefs.map((def) => def.href),
];

export function canAccessMemberPath(
  role: OrgRole | null | undefined,
  pathname: string,
) {
  if (role !== "member") {
    return true;
  }

  return (
    pathname === "/" ||
    MEMBER_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  );
}
