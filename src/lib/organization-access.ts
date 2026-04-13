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

export function canAccessMemberPath(
  role: OrgRole | null | undefined,
  pathname: string,
) {
  if (role !== "member") {
    return true;
  }

  return pathname === "/" || pathname.startsWith("/creatives") || pathname.startsWith("/teams");
}
