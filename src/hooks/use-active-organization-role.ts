"use client";

import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { isOrgRole, type OrgRole } from "@/lib/organization-access";

export function useActiveOrganizationRole(): {
  role: OrgRole | null;
  isPending: boolean;
} {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: activeOrg, isPending: activeOrgPending } =
    authClient.useActiveOrganization();

  const orgId = activeOrg?.id;

  const fullOrgQuery = useQuery({
    queryKey: ["org-full", orgId],
    queryFn: async () => {
      if (!orgId) {
        return null;
      }

      const { data } = await authClient.organization.getFullOrganization({
        query: { organizationId: orgId },
      });

      return data;
    },
    enabled: !!orgId && !!session?.user?.id,
  });

  const currentUserRole = fullOrgQuery.data?.members?.find(
    (member: { userId: string; role: string }) =>
      member.userId === session?.user?.id,
  )?.role;

  return {
    role: isOrgRole(currentUserRole) ? currentUserRole : null,
    isPending:
      sessionPending ||
      activeOrgPending ||
      (!!orgId && !!session?.user?.id && fullOrgQuery.isLoading),
  };
}
