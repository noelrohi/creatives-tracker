"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { canAccessMemberPath } from "@/lib/organization-access";
import { authClient } from "@/lib/auth-client";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";

export function OrgGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending: sessionPending } =
    authClient.useSession();
  const { data: orgs, isPending: orgsPending } =
    authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { role, isPending: rolePending } = useActiveOrganizationRole();

  useEffect(() => {
    if (sessionPending || orgsPending || rolePending) return;

    // Not signed in — middleware handles redirect, but just in case
    if (!session) return;

    // No orgs at all — redirect to sign-up to create one
    if (orgs && orgs.length === 0) {
      if (pathname !== "/create-organization") {
        router.push("/create-organization");
      }
      return;
    }

    // Has orgs but no active org — set the first one as active
    if (orgs && orgs.length > 0 && !activeOrg) {
      void (async () => {
        await authClient.organization.setActive({ organizationId: orgs[0].id });
        router.refresh();
      })();
    }

    if (activeOrg && !canAccessMemberPath(role, pathname)) {
      router.replace("/");
    }
  }, [
    activeOrg,
    orgs,
    orgsPending,
    pathname,
    role,
    rolePending,
    router,
    session,
    sessionPending,
  ]);

  // Still loading
  if (sessionPending || orgsPending || rolePending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (pathname === "/create-organization" && orgs && orgs.length === 0) {
    return <>{children}</>;
  }

  // No active org yet (setting it)
  if (!activeOrg && orgs && orgs.length > 0) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (activeOrg && !canAccessMemberPath(role, pathname)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
