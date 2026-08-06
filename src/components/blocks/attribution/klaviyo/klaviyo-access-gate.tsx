"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { isPrivilegedOrgRole } from "@/lib/organization-access";

/**
 * No-flash route guard layered over the protected layout's OrgGuard: a
 * resolved non-privileged role is redirected before any playground
 * content renders. Children never render first.
 */
export function KlaviyoAccessGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { role, isPending } = useActiveOrganizationRole();
  const privileged = isPrivilegedOrgRole(role);

  useEffect(() => {
    if (!isPending && !privileged) {
      router.replace("/");
    }
  }, [isPending, privileged, router]);

  if (isPending || !privileged) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Checking access…
      </div>
    );
  }
  return <>{children}</>;
}
